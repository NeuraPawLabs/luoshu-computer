import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {expect,test,vi} from 'vitest';
import * as commands from '../../src/runtime/git-command.js';
import {NativeCodebases} from '../../src/engines/native-codebases.js';
const exec=promisify(execFile);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-subtree-')),source=join(root,'source'),state=join(root,'state');await mkdir(join(source,'app'),{recursive:true});await mkdir(state);
 const git=async(args:string[],cwd=source)=>(await exec('git',args,{cwd})).stdout.trim();
 await git(['init','-b','main']);await writeFile(join(source,'app','index.txt'),'base');await writeFile(join(source,'app','remove.txt'),'remove');await writeFile(join(source,'private.txt'),'sibling secret');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=f@invalid','commit','-m','initial']);const base=await git(['rev-parse','HEAD']);
 const dbPath=join(root,'state.db'),db=new Database(dbPath),options={stateDir:state,allowedRoots:()=>[source]},service=new NativeCodebases(db,options),input={session_id:'session',run_id:'run',submission_id:'submission',codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'write' as const,source:{kind:'local' as const,path:source},root_path:'app',default_branch:'main'}]};
 const prepared=await service.prepare(input),repo=prepared.workspace.codebases[0].repository_path,checkout=prepared.write[0];
 return{root,source,state,dbPath,db,options,service,input,base,repo,checkout,git,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}
test('Worker delivers a subdirectory edit without exposing repository metadata to the native Agent',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.checkout,'index.txt'),'edited');await writeFile(join(f.checkout,'new 文件.txt'),'added');await rm(join(f.checkout,'remove.txt'));
  const result=await f.service.collect(f.input,true);
  expect(result).toMatchObject([{access_mode:'write',base_commit:f.base,result:'changed',changed_paths:['index.txt','new 文件.txt','remove.txt']}]);
  expect(result[0].head_commit).not.toBe(f.base);expect(await f.git(['show','HEAD:private.txt'],f.repo)).toBe('sibling secret');
  expect(await readFile(join(f.source,'app','index.txt'),'utf8')).toBe('base');
  expect(await new NativeCodebases(f.db,f.options).collect(f.input,true)).toEqual(result);
  expect(await f.git(['rev-list','--count',f.base+'..HEAD'],f.repo)).toBe('1');expect(await f.git(['status','--porcelain'],f.repo)).toBe('');
 }finally{await f.close();}
});
test('scoped delivery never executes repository clean filters or hooks',async()=>{
 const f=await fixture();try{
  const marker=join(f.root,'must-not-run'),script=join(f.root,'filter');await writeFile(script,`#!/bin/sh\nprintf executed > '${marker}'\ncat\n`,{mode:0o700});
  await f.git(['config','filter.hostile.clean',script],f.repo);
  await writeFile(join(f.checkout,'.gitattributes'),'*.txt filter=hostile\n');await writeFile(join(f.checkout,'index.txt'),'changed');
  await writeFile(join(f.repo,'.git','hooks','pre-commit'),`#!/bin/sh\nprintf hook > '${marker}'\nexit 1\n`,{mode:0o700});
  await writeFile(join(f.repo,'.git','hooks','reference-transaction'),`#!/bin/sh\nprintf ref-hook > '${marker}'\nexit 1\n`,{mode:0o700});
  expect((await f.service.collect(f.input,true))[0].result).toBe('changed');
  await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
  expect(await f.git(['show','HEAD:app/index.txt'],f.repo)).toBe('changed');
 }finally{await f.close();}
});
test.each(['symlink','hardlink','outside','branch','head'] as const)('scoped delivery rejects %s mutation and preserves source',async kind=>{
 const f=await fixture();try{
  if(kind==='symlink')await symlink(join(f.source,'private.txt'),join(f.checkout,'linked'));
  if(kind==='hardlink')await link(join(f.source,'private.txt'),join(f.checkout,'linked'));
  if(kind==='outside')await writeFile(join(f.repo,'private.txt'),'outside mutation');
  if(kind==='branch')await f.git(['switch','-c','wrong'],f.repo);
  if(kind==='head'){await writeFile(join(f.checkout,'index.txt'),'native commit');await f.git(['add','.'],f.repo);await f.git(['-c','user.name=Fixture','-c','user.email=f@invalid','commit','-m','unexpected'],f.repo);}
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/link|scope|branch|HEAD|regular/i);
  expect(await readFile(join(f.source,'private.txt'),'utf8')).toBe('sibling secret');
 }finally{await f.close();}
});
test('sealing rejects changed files on replay rather than creating another commit',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.checkout,'index.txt'),'first');const [receipt]=await f.service.collect(f.input,true);
  await writeFile(join(f.checkout,'index.txt'),'later');await expect(f.service.collect(f.input,true)).rejects.toThrow(/snapshot/);
  expect(await f.git(['rev-parse','HEAD'],f.repo)).toBe(receipt.head_commit);
 }finally{await f.close();}
});
test.each(['before_ref','after_ref'] as const)('interrupted commit publication (%s) recovers the same commit without rerunning Agent',async point=>{
 const f=await fixture(),original=commands.runGitCommand;let fail=true;
 const spy=vi.spyOn(commands,'runGitCommand').mockImplementation(async(args,options)=>{
  if(args[0]==='update-ref'&&fail){fail=false;if(point==='after_ref')await original(args,options);throw Error('publication interrupted');}return original(args,options);
 });
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');await expect(f.service.collect(f.input,true)).rejects.toThrow('publication interrupted');
  const saved=f.db.prepare('SELECT head FROM native_codebase_commits').get() as {head:string};expect(saved.head).toMatch(/^[a-f0-9]{40}$/);
  const [result]=await new NativeCodebases(f.db,f.options).collect(f.input,true);expect(result.head_commit).toBe(saved.head);expect(await f.git(['rev-list','--count',f.base+'..HEAD'],f.repo)).toBe('1');
 }finally{spy.mockRestore();await f.close();}
});
test('index publication refuses an existing lock instead of overwriting it',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.checkout,'index.txt'),'changed');await writeFile(join(f.repo,'.git','index.lock'),'owned by another process');
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/lock/i);
  expect(await readFile(join(f.repo,'.git','index.lock'),'utf8')).toBe('owned by another process');
 }finally{await f.close();}
});
test('a handwritten dead-owner sidecar cannot prove ownership of the current index lock',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.checkout,'index.txt'),'changed');
  const lock=join(f.repo,'.git','index.lock'),marker=lock+'.luoshu-owner';
  await writeFile(lock,'stale lock');await writeFile(marker,JSON.stringify({version:1,kind:'luoshu-native-codebase-index',pid:999999999,starttime:'0',run_id:'run',codebase_id:f.input.codebases[0].id,token:'dead-owner-token'}));
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/lock|ownership/i);
  expect(await readFile(lock,'utf8')).toBe('stale lock');expect(await readFile(marker,'utf8')).toContain('dead-owner-token');
  expect(await f.git(['rev-parse','HEAD'],f.repo)).toBe(f.base);
 }finally{await f.close();}
});
test('a lock with an unbound live-owner sidecar is never removed',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.checkout,'index.txt'),'changed');const lock=join(f.repo,'.git','index.lock'),marker=lock+'.luoshu-owner';
  const stat=await readFile(`/proc/${process.pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  await writeFile(lock,'owned');await writeFile(marker,JSON.stringify({version:1,kind:'luoshu-native-codebase-index',pid:process.pid,starttime:fields[19],run_id:'run',codebase_id:f.input.codebases[0].id,token:'live-owner'}));
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/lock/i);expect(await readFile(lock,'utf8')).toBe('owned');expect(await readFile(marker,'utf8')).toContain('live-owner');
 }finally{await f.close();}
});
async function crashOwner(f:Awaited<ReturnType<typeof fixture>>,stage:string){
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),new URL('../helpers/native-index-crash.ts',import.meta.url).pathname,JSON.stringify({db:f.dbPath,state:f.state,source:f.source,input:f.input,repo:f.repo,stage})],{stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const exited=new Promise<void>(r=>child.once('exit',()=>r()));let timer:ReturnType<typeof setTimeout>;
 try{
  await Promise.race([new Promise<void>((resolve,reject)=>{child.once('message',m=>{if((m as any).stage===stage)resolve();else reject(Error('Unexpected crash stage'));});child.once('exit',()=>reject(Error('Fixture exited before crash boundary: '+output)));}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Crash fixture readiness timeout: '+output)),6000);})]);
 }catch(error){child.kill('SIGKILL');await exited;throw error;}finally{clearTimeout(timer!);}
 return{child,kill:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}};
}
test.each(['reserved','partial','staged','before_link','linked','before_publish','published','anchor_removed'] as const)('actual SIGKILL at %s resumes the same scoped commit from a reopened database',async stage=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof crashOwner>>|undefined;
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');owner=await crashOwner(f,stage);
  const saved=f.db.prepare('SELECT head FROM native_codebase_commits').get() as {head:string};expect(saved.head).toMatch(/^[a-f0-9]{40}$/);
  // A second collector must not steal an actually live owner's publication.
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/owner|active|lock/i);
  await owner.kill();
  const reopened=new Database(f.dbPath);try{
   const [receipt]=await new NativeCodebases(reopened,f.options).collect(f.input,true);
   expect(receipt.head_commit).toBe(saved.head);expect(await f.git(['rev-list','--count',f.base+'..HEAD'],f.repo)).toBe('1');
   expect(await f.git(['status','--porcelain'],f.repo)).toBe('');expect(await readFile(join(f.source,'app','index.txt'),'utf8')).toBe('base');
   expect(reopened.prepare('SELECT * FROM native_index_publications').all()).toEqual([]);
  }finally{reopened.close();}
 }finally{await owner?.kill();await f.close();}
});
test('dead publication journal cannot remove a replacement index.lock',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof crashOwner>>|undefined;
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');owner=await crashOwner(f,'linked');await owner.kill();
  const lock=join(f.repo,'.git','index.lock');await rm(lock);await writeFile(lock,'foreign-lock');
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/lock|ownership/i);
  expect(await readFile(lock,'utf8')).toBe('foreign-lock');expect(await f.git(['rev-parse','HEAD'],f.repo)).toBe(f.base);
 }finally{await owner?.kill();await f.close();}
});
test.each(['bytes','anchor_symlink','anchor_missing','extra_hardlink','binding','malformed_owner','malformed_anchor'] as const)('dead publication with %s damage cannot delete the lock',async damage=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof crashOwner>>|undefined;
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');owner=await crashOwner(f,'linked');await owner.kill();
  const lock=join(f.repo,'.git','index.lock'),row=f.db.prepare('SELECT * FROM native_index_publications').get() as {token:string},anchor=join(f.repo,'.git','.luoshu-index-'+row.token);
  const outsider=join(f.root,'outside');await writeFile(outsider,'PRIVATE_ERROR_CONTENT');
  if(damage==='bytes')await writeFile(lock,'tampered');
  if(damage==='anchor_symlink'){await rm(anchor);await symlink(outsider,anchor);}
  if(damage==='anchor_missing')await rm(anchor);
  if(damage==='extra_hardlink')await link(lock,join(f.root,'extra-link'));
  if(damage==='binding')f.db.prepare("UPDATE native_index_publications SET binding='foreign'").run();
  if(damage==='malformed_owner')f.db.prepare("UPDATE native_index_publications SET owner='PRIVATE_ERROR_CONTENT'").run();
  if(damage==='malformed_anchor')f.db.prepare("UPDATE native_index_publications SET anchor='PRIVATE_ERROR_CONTENT'").run();
  const before=await readFile(lock);
  const attempt=f.service.collect(f.input,true);
  await expect(attempt).rejects.toThrow(/lock|ownership/i);
  await attempt.catch(e=>expect(e.message).not.toContain('PRIVATE_ERROR_CONTENT'));
  expect(await readFile(lock)).toEqual(before);expect(await readFile(outsider,'utf8')).toBe('PRIVATE_ERROR_CONTENT');
 }finally{await owner?.kill();await f.close();}
});
test.each(['recovered_lock_removed','anchor_removed'] as const)('recovery itself can be killed at %s and resumed again',async stage=>{
 const f=await fixture();let first:Awaited<ReturnType<typeof crashOwner>>|undefined,second:Awaited<ReturnType<typeof crashOwner>>|undefined;
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');first=await crashOwner(f,'linked');await first.kill();
  const {head}=f.db.prepare('SELECT head FROM native_codebase_commits').get() as {head:string};
  second=await crashOwner(f,stage);await second.kill();
  const [result]=await f.service.collect(f.input,true);expect(result.head_commit).toBe(head);expect(await f.git(['status','--porcelain'],f.repo)).toBe('');
 }finally{await first?.kill();await second?.kill();await f.close();}
});
test('simultaneous recovery callers publish at most once and do not lose the remaining evidence',async()=>{
 const f=await fixture();let owner:Awaited<ReturnType<typeof crashOwner>>|undefined;
 try{
  await writeFile(join(f.checkout,'index.txt'),'changed');owner=await crashOwner(f,'linked');await owner.kill();
  const results=await Promise.allSettled([new NativeCodebases(f.db,f.options).collect(f.input,true),new NativeCodebases(f.db,f.options).collect(f.input,true)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.git(['rev-list','--count',f.base+'..HEAD'],f.repo)).toBe('1');
  expect(await f.git(['status','--porcelain'],f.repo)).toBe('');expect(f.db.prepare('SELECT * FROM native_index_publications').all()).toEqual([]);
 }finally{await owner?.kill();await f.close();}
});
test('deleted whole subdirectories and file renames are represented without changing sibling content',async()=>{
 const f=await fixture();try{
  const {rename}=await import('node:fs/promises');await mkdir(join(f.checkout,'nested'));await rename(join(f.checkout,'index.txt'),join(f.checkout,'nested','renamed.txt'));
  const [receipt]=await f.service.collect(f.input,true);
  expect(receipt.changed_paths).toEqual(['index.txt','nested/renamed.txt']);expect(await f.git(['show','HEAD:private.txt'],f.repo)).toBe('sibling secret');
 }finally{await f.close();}
});
test('unchanged subtree has no synthetic commit and seals the unchanged snapshot',async()=>{
 const f=await fixture();try{
  const [receipt]=await f.service.collect(f.input,true);expect(receipt).toMatchObject({result:'unchanged',head_commit:f.base,changed_paths:[]});
  expect(await f.git(['rev-list','--count',f.base+'..HEAD'],f.repo)).toBe('0');
  await writeFile(join(f.checkout,'index.txt'),'late');await expect(f.service.collect(f.input,true)).rejects.toThrow(/snapshot/);
 }finally{await f.close();}
});
test('changing HEAD between tree sealing and branch publication cannot overwrite another commit',async()=>{
 const f=await fixture(),original=commands.runGitCommand;let altered=false,other='';
 const spy=vi.spyOn(commands,'runGitCommand').mockImplementation(async(args,options)=>{
  if(args[0]==='update-ref'&&!altered){altered=true;const tree=await f.git(['rev-parse','HEAD^{tree}'],f.repo);other=await f.git(['-c','user.name=Other','-c','user.email=other@invalid','commit-tree',tree,'-p',f.base,'-m','other'],f.repo);await f.git(['update-ref','HEAD',other,f.base],f.repo);}
  return original(args,options);
 });
 try{
  await writeFile(join(f.checkout,'index.txt'),'edit');await expect(f.service.collect(f.input,true)).rejects.toThrow(/Git.*failed/);
  expect(await f.git(['rev-parse','HEAD'],f.repo)).toBe(other);await expect(f.service.collect(f.input,true)).rejects.toThrow(/HEAD/);
 }finally{spy.mockRestore();await f.close();}
});
test('branch switch during object creation cannot publish into the former branch',async()=>{
 const f=await fixture(),original=commands.runGitCommand;let switched=false;
 const spy=vi.spyOn(commands,'runGitCommand').mockImplementation(async(args,options)=>{
  const result=await original(args,options);
  if(args[0]==='commit-tree'&&!switched){switched=true;await f.git(['branch','other',f.base],f.repo);await f.git(['symbolic-ref','HEAD','refs/heads/other'],f.repo);}
  return result;
 });
 try{
  await writeFile(join(f.checkout,'index.txt'),'edit');await expect(f.service.collect(f.input,true)).rejects.toThrow(/branch/i);
  expect(await f.git(['rev-parse','refs/heads/luoshu/feature/run-app'],f.repo)).toBe(f.base);
 }finally{spy.mockRestore();await f.close();}
});
