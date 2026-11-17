import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {loadWorkerConfig,saveWorkerConfig} from '../../src/runtime/environment.js';
import {CodexPermissions} from '../../src/runtime/codex-permissions.js';
import {runtimeDevelopmentRoots} from '../../src/development/runtime-roots.js';
import {DevelopmentService} from '../../src/development/service.js';
import {Executor} from '../../src/runtime/executor.js';
import {WorkerState} from '../../src/runtime/state.js';
import type {Assignment} from '../../src/protocol/index.js';
import {pairWorker} from '../../src/runtime/client.js';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('permission updates persist before acknowledgement and remain independent of live directory edits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-permissions-'));
 const config={worker_id:'worker',url:'https://example.test',name:'device',capacity:1};
 try{
  await saveWorkerConfig(root,config);
  const permissions=new CodexPermissions(root),roots=runtimeDevelopmentRoots(root,config);
  expect(await permissions.state()).toMatchObject({mode:'workspace-write'});
  const revision=(await permissions.state()).revision;
  await Promise.all([permissions.update('danger-full-access',revision),roots.update([root],crypto.randomUUID(),[])]);
  expect(await loadWorkerConfig(root)).toMatchObject({codex_sandbox:'danger-full-access',development_roots:[root]});
  expect(await new CodexPermissions(root).mode()).toBe('danger-full-access');
  await expect(permissions.update('workspace-write',revision)).rejects.toThrow(/配置已改变/);
  expect(await permissions.mode()).toBe('danger-full-access');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pairing stores explicit full access and validates permissions before consuming a pairing code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-permissions-pair-'));let requests=0;
 const options={stateDir:root,url:'https://example.test',code:'one-use',name:'dedicated codex',capacity:1,codexPath:'/missing/codex',opencodePath:'/missing/opencode',fetchImpl:async()=>{requests++;return new Response(JSON.stringify({worker_id:'worker',status:'pending'}));}};
 try{
  await expect(pairWorker({...options,codexSandbox:'invalid' as any})).rejects.toThrow();expect(requests).toBe(0);
  await pairWorker({...options,codexSandbox:'danger-full-access'});
  expect(requests).toBe(1);expect((await loadWorkerConfig(root)).codex_sandbox).toBe('danger-full-access');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an independent CLI config edit cannot restore full access after a concurrent permission downgrade',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-permissions-process-')),ready=join(root,'ready'),release=join(root,'release');
 await saveWorkerConfig(root,{worker_id:'worker',url:'https://example.test',name:'device',capacity:1,codex_sandbox:'danger-full-access'});
 const module=pathToFileURL(join(process.cwd(),'src/runtime/environment.ts')).href;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`
import {updateWorkerConfig} from ${JSON.stringify(module)};
import {writeFileSync,existsSync} from 'node:fs';
await updateWorkerConfig(${JSON.stringify(root)},current=>{
 writeFileSync(${JSON.stringify(ready)},'ready');
 const deadline=Date.now()+5000;
 while(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 return {...current,agent_paths:{codex:'/new/codex'}};
});`],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 const done=new Promise<number|null>(resolve=>child.once('close',resolve));
 try{
  await expect.poll(async()=>{try{return await readFile(ready,'utf8');}catch{return '';}}).toBe('ready');
  const permissions=new CodexPermissions(root);let applied=false;
  const update=permissions.update('workspace-write','').then(result=>{applied=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,50));const appliedBeforeRelease=applied;
  await writeFile(release,'go');expect(await done,stderr).toBe(0);await update;
  expect(appliedBeforeRelease).toBe(false);
  expect(await loadWorkerConfig(root)).toMatchObject({codex_sandbox:'workspace-write',agent_paths:{codex:'/new/codex'}});
 }finally{await writeFile(release,'go');child.kill();await done;await rm(root,{recursive:true,force:true});}
});

test('new and resumed PTYs read changed permissions without restarting or changing running PTYs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-permissions-pty-')),agent=join(root,'codex'),calls=join(root,'calls');
 await saveWorkerConfig(root,{worker_id:'worker',url:'https://example.test',name:'device',capacity:3});
 await writeFile(agent,`#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdin.resume();`,{mode:0o700});
 const permissions=new CodexPermissions(root),service=new DevelopmentService({roots:[root],agentPaths:{codex:agent},codexPermissions:permissions});
 const open={action:'open' as const,agent:'codex' as const,cwd:root,cols:80,rows:24};
 try{
  await service.handle({...open,session_id:'first',mode:'new'});
  await expect.poll(async()=>{try{return (await readFile(calls,'utf8')).trim().split('\n').length;}catch{return 0;}}).toBe(1);
  await service.handle({action:'codex_settings_update',mode:'danger-full-access',expected_revision:(await permissions.state()).revision});
  await service.handle({...open,session_id:'second',mode:'resume',agent_session_id:'native-session'});
  await expect.poll(async()=>(await readFile(calls,'utf8')).trim().split('\n').length).toBe(2);
  const args=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(args[0]).toEqual(expect.arrayContaining(['--sandbox','workspace-write']));
  expect(args[1]).toEqual(expect.arrayContaining(['resume','native-session','--sandbox','danger-full-access','approval_policy="never"']));
  expect(service.sessions.read('first',0).session.status).toBe('running');
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});

test('tasks use current Worker permissions and reject read Codebases before starting unrestricted work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-permissions-task-'));
 await saveWorkerConfig(root,{worker_id:'worker',url:'https://example.test',name:'device',capacity:1,codex_sandbox:'danger-full-access'});
 const state=new WorkerState(join(root,'worker.db')),permissions=new CodexPermissions(root);let calls=0,mode='';
 const executor=new Executor({state,stateDir:root,developmentRoots:[root],codexPermissions:permissions,emit:e=>state.appendEvent(e),agents:{codex:async input=>{calls++;mode=input.sandboxMode??'';return{exitCode:0,summary:'done',checks:[],events:[],argv:[]};}}});
 const assignment:Assignment={attempt_id:'full',lease_epoch:1,agent:'codex',instruction:'inspect',input_files:[],codebases:[],timeout_seconds:30};
 try{
  state.recordStart(assignment.attempt_id,1,assignment);expect((await executor.runAttempt(assignment,10000)).status).toBe('succeeded');expect(mode).toBe('danger-full-access');
  const read:Assignment={...assignment,attempt_id:'read',run_id:'run',codebases:[{id:crypto.randomUUID(),alias:'ref',access_mode:'read',source:{kind:'local',path:root},root_path:'.',default_branch:'main',base_commit:'a'.repeat(40),branch:null}]};
  state.recordStart(read.attempt_id,1,read);const result=await executor.runAttempt(read,10000);
  expect(result.status).toBe('failed');expect(result.error).toContain('只读 Codebase');expect(calls).toBe(1);
 }finally{await executor.stopAll('cleanup');await executor.delivery.close();state.close();await rm(root,{recursive:true,force:true});}
});
