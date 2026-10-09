import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {expect,test} from 'vitest';
import {runGitCommand} from '../../src/runtime/git-command.js';

test('Git abort terminates its own blocked SSH helper before settling, without touching another child',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-git-abort-')),helper=join(root,'ssh'),pidFile=join(root,'pid');
 const controller=new AbortController(),other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});let pending:Promise<string>|undefined;
 try{
  await writeFile(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700});
  pending=runGitCommand(['ls-remote','--heads','ssh://fixture.invalid/project.git'],{cwd:root,gitSshCommand:helper,signal:controller.signal});void pending.catch(()=>{});
  await expect.poll(()=>readFile(pidFile,'utf8').catch(()=>null)).not.toBeNull();
  const pid=Number(await readFile(pidFile,'utf8'));controller.abort();
  await expect(pending).rejects.toThrow(/cancel|abort/i);
  await expect.poll(async()=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z';}catch{return true;}}).toBe(true);
  expect(other.exitCode).toBeNull();expect(other.signalCode).toBeNull();
 }finally{controller.abort();await pending?.catch(()=>{});const exited=new Promise(resolve=>other.once('close',resolve));other.kill('SIGKILL');await exited;await rm(root,{recursive:true,force:true});}
});

test('Worker death reaps the Git SSH helper through the guardian process group',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-git-guardian-')),helper=join(root,'ssh'),pidFile=join(root,'pid'),parentScript=join(root,'parent.mjs');
 try{
  await writeFile(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700});
  const moduleUrl=new URL('../../src/runtime/git-command.ts',import.meta.url).href;
  await writeFile(parentScript,`import {runGitCommand} from ${JSON.stringify(moduleUrl)};runGitCommand(['ls-remote','--heads','ssh://fixture.invalid/project.git'],{cwd:${JSON.stringify(root)},gitSshCommand:${JSON.stringify(helper)}}).catch(()=>{});\n`,{mode:0o600});
  const parent=spawn(process.execPath,['--import','tsx',parentScript],{cwd:process.cwd(),stdio:'ignore'});
  await expect.poll(()=>readFile(pidFile,'utf8').catch(()=>null),{timeout:5000}).not.toBeNull();const pid=Number(await readFile(pidFile,'utf8'));parent.kill('SIGKILL');
  await expect.poll(async()=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z';}catch{return true;}},{timeout:5000}).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an already-cancelled Git command does not create helper processes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-git-preabort-')),marker=join(root,'marker'),helper=join(root,'ssh');
 try{
  await writeFile(helper,`#!/bin/sh\nprintf started > '${marker}'\n`,{mode:0o700});
  const controller=new AbortController();controller.abort();
  await expect(runGitCommand(['ls-remote','ssh://fixture.invalid/project'],{cwd:root,gitSshCommand:helper,signal:controller.signal})).rejects.toThrow(/cancel|abort/i);
  await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Git runner preserves real stdout and nonzero exit failure',async()=>{
 expect(await runGitCommand(['--version'],{})).toMatch(/^git version /);
 await expect(runGitCommand(['definitely-not-a-git-command'],{})).rejects.toThrow(/Git.*failed/i);
});
test('Git plumbing preserves raw binary delimiters and hashes exact stdin without shell/filter execution',async()=>{
 const input=Buffer.from('raw\u0000bytes\n');
 const expected=(await import('node:crypto')).createHash('sha1').update(Buffer.from('blob '+input.length+'\0')).update(input).digest('hex');
 expect(await runGitCommand(['hash-object','--stdin','--no-filters'],{input,isolated:true})).toBe(expected);
 const root=await mkdtemp(join(tmpdir(),'luoshu-git-raw-'));
 try{
  await runGitCommand(['init','-b','main',root],{});await writeFile(join(root,' leading.txt'),'test');
  expect(await runGitCommand(['ls-files','--others','-z'],{cwd:root,raw:true})).toBe(' leading.txt\0');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Git spawn failure settles without waiting for nonexistent output',async()=>{
 await expect(runGitCommand(['--version'],{cwd:'/nonexistent-luoshu-git-fixture-directory'})).rejects.toMatchObject({code:'ENOENT'});
});
test('oversized Git transport output stops its process and does not leak stderr content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-git-overflow-')),helper=join(root,'ssh');
 try{
  await writeFile(helper,`#!${process.execPath}\nprocess.stderr.write('PRIVATE_FIXTURE_DIAGNOSTIC');process.stderr.write(Buffer.alloc(3*1024*1024,120));setInterval(()=>{},1000);\n`,{mode:0o700});
  await expect(runGitCommand(['ls-remote','ssh://fixture.invalid/project'],{cwd:root,gitSshCommand:helper})).rejects.toThrow('Git command output exceeds transport capacity');
 }finally{await rm(root,{recursive:true,force:true});}
});
