import {mkdtemp,mkdir,writeFile,readFile,readlink,symlink,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import {updateComputerLauncher} from '../../src/cli/launcher.js';

const exec=promisify(execFile);
test.each(['installer','updater'])('%s launcher only consumes rollback attempts when starting the daemon',async kind=>{
 const home=await mkdtemp(join(tmpdir(),'luoshu-launcher-'));
 try{
  const root=join(home,'.local/share/luoshu-computer'),build=join(root,'versions/new'),old=join(root,'versions/old');
  for(const dir of [build,old]){await mkdir(join(dir,'runtime'),{recursive:true});await writeFile(join(dir,'runtime/node'),'#!/bin/sh\nexit 0\n',{mode:0o755});}
  await symlink(build,join(root,'current'));await writeFile(join(root,'rollback-version'),old);
  const path=join(home,'launcher');
  if(kind==='installer'){
    const template=await readFile(new URL('../../scripts/templates/install-computer.sh',import.meta.url),'utf8');
    const launcher=template.split("<<'LAUNCHER'\n")[1].split('\nLAUNCHER')[0];await writeFile(path,launcher,{mode:0o755});
  }else await updateComputerLauncher({root,state:join(root,'state'),versions:join(root,'versions'),current:join(root,'current'),executable:path,service:join(home,'service')});
  await exec(path,['status'],{env:{...process.env,HOME:home}});
  await expect(access(join(root,'update-attempted'))).rejects.toMatchObject({code:'ENOENT'});
  await exec(path,['daemon'],{env:{...process.env,HOME:home}});await access(join(root,'update-attempted'));
  await exec(path,['doctor'],{env:{...process.env,HOME:home}});expect(await readlink(join(root,'current'))).toBe(build);
  await exec(path,['daemon'],{env:{...process.env,HOME:home}});expect(await readlink(join(root,'current'))).toBe(old);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('updater launcher starts a flat build and still starts a legacy build after rollback',async()=>{
 const home=await mkdtemp(join(tmpdir(),'launcher-flat-'));
 try{
  const root=join(home,'.local/share/luoshu-computer'),build=join(root,'versions/new'),old=join(root,'versions/old'),log=join(home,'entry');
  for(const dir of [build,old]){await mkdir(join(dir,'runtime'),{recursive:true});await writeFile(join(dir,'runtime/node'),`#!/bin/sh\nprintf '%s' "$1" > '${log}'\n`,{mode:0o755});}
  await mkdir(join(build,'app/dist'),{recursive:true});await writeFile(join(build,'app/dist/main.js'),'flat entry');
  await mkdir(join(old,'app/apps/worker/dist'),{recursive:true});await writeFile(join(old,'app/apps/worker/dist/computer-main.js'),'legacy entry');
  await symlink(build,join(root,'current'));const executable=join(home,'launcher');
  await updateComputerLauncher({root,state:join(root,'state'),versions:join(root,'versions'),current:join(root,'current'),executable,service:join(home,'service')});
  await exec(executable,['status']);expect(await readFile(log,'utf8')).toBe(join(root,'current/app/dist/main.js'));
  await writeFile(join(root,'rollback-version'),old);await writeFile(join(root,'update-attempted'),'');await exec(executable,['daemon']);
  expect(await readlink(join(root,'current'))).toBe(old);expect(await readFile(log,'utf8')).toBe(join(root,'current/app/apps/worker/dist/computer-main.js'));
 }finally{await rm(home,{recursive:true,force:true});}
});
