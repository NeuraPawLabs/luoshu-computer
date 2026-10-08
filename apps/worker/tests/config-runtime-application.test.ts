import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {saveWorkerConfig,updateWorkerConfig} from '../src/environment.js';
import {WorkerConfigController} from '../src/config-controller.js';
import {DevelopmentService} from '../src/development/service.js';
import {readFile} from 'node:fs/promises';
import {CodexPermissions} from '../src/codex-permissions.js';
import {Executor} from '../src/executor.js';
import {WorkerState} from '../src/state.js';

test('applied config changes admission and new session paths without stopping existing sessions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-config-runtime-')),bin=join(root,'bin'),a=join(root,'a'),b=join(root,'b'),agent=join(bin,'codex');await Promise.all([mkdir(bin),mkdir(a),mkdir(b)]);await writeFile(agent,'#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);',{mode:0o700});
 await saveWorkerConfig(root,{worker_id:'worker_1',url:'https://example.test',name:'desk',capacity:2,agent_paths:{codex:agent},development_roots:[a],maintenance_roots:[],codex_sandbox:'workspace-write'});
 const controller=new WorkerConfigController(root),service=new DevelopmentService({rootPolicy:undefined,roots:[a],agentPaths:{codex:agent},maxSessions:2});
 try{
  await service.handle({action:'open',session_id:'existing',agent:'codex',cwd:a,mode:'new',cols:80,rows:24});
  const revision='44444444-4444-4444-8444-444444444444';const config={name:'desk-2',capacity:1,agent_paths:{codex:agent},development_roots:[b],maintenance_roots:[],codex_sandbox:'workspace-write' as const};
  controller.onApplied(async applied=>service.applyConfig(applied,revision));await controller.apply({request_id:'config-runtime',revision,expected_revision:(await controller.state()).revision,config});
  expect(service.sessions.read('existing',0).session.status).toBe('running');
  await expect(service.handle({action:'open',session_id:'outside',agent:'codex',cwd:a,mode:'new',cols:80,rows:24})).rejects.toThrow(/allowed root/);
  await expect(service.handle({action:'open',session_id:'new',agent:'codex',cwd:b,mode:'new',cols:80,rows:24})).rejects.toThrow(/capacity/);
  await service.sessions.stop('existing');await service.handle({action:'open',session_id:'new',agent:'codex',cwd:b,mode:'new',cols:80,rows:24});
  await service.stopAll();
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});

test('later task launches use new executable and mode while a running task keeps its snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'config-executor-')),first=join(root,'first'),second=join(root,'second');
 await writeFile(first,'#!/bin/sh\nexit 0\n',{mode:0o700});await writeFile(second,'#!/bin/sh\nexit 0\n',{mode:0o700});
 await saveWorkerConfig(root,{worker_id:'w',url:'https://example.test',name:'device',capacity:2,agent_paths:{codex:first}});
 const state=new WorkerState(join(root,'worker.db')),controller=new WorkerConfigController(root),inputs:any[]=[];let finish!:()=>void;
 const executor=new Executor({state,stateDir:root,agentPaths:{codex:first},codexPermissions:new CodexPermissions(root),emit:()=>{},agents:{codex:async input=>{inputs.push(input);if(inputs.length===1)await new Promise<void>(resolve=>finish=resolve);return{exitCode:0,summary:'done',checks:[],events:[],argv:[]};}}});
 controller.onApplied(config=>executor.updateConfig(config.agent_paths));
 const assignment={attempt_id:'first',lease_epoch:1,agent:'codex' as const,instruction:'inspect',input_files:[],codebases:[],timeout_seconds:30};
 state.recordStart('first',1,assignment);const running=executor.runAttempt(assignment,10000);
 try{
  await expect.poll(()=>inputs.length).toBe(1);const before=await controller.state();
  const result=await controller.apply({request_id:'edit',revision:crypto.randomUUID(),expected_revision:before.revision,config:{...before.config,agent_paths:{codex:second},codex_sandbox:'danger-full-access'}});expect(result.status).toBe('applied');
  const next={...assignment,attempt_id:'second'};state.recordStart('second',1,next);await executor.runAttempt(next,10000);
  expect(inputs.map(input=>[input.executable,input.sandboxMode])).toEqual([[first,'workspace-write'],[second,'danger-full-access']]);expect(inputs[0].signal.aborted).toBe(false);
 }finally{finish?.();await running;await executor.stopAll('cleanup');await executor.delivery.close();state.close();await rm(root,{recursive:true,force:true});}
});

test('new PTYs receive updated Agent paths and sandbox policy and old configuration endpoints cannot bypass managed settings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'config-pty-path-')),first=join(root,'first'),second=join(root,'second'),calls=join(root,'calls');
 for(const [path,label] of [[first,'first'],[second,'second']])await writeFile(path,`#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify([${JSON.stringify(label)},process.argv.slice(2)])+'\\n');process.stdin.resume();`,{mode:0o700});
 await saveWorkerConfig(root,{worker_id:'w',url:'https://example.test',name:'device',capacity:2,agent_paths:{codex:first}});
 const controller=new WorkerConfigController(root),service=new DevelopmentService({managedConfig:true,roots:[root],maxSessions:2,agentPaths:{codex:first},codexPermissions:new CodexPermissions(root)});controller.onApplied((config,revision)=>service.applyConfig(config,revision));
 try{
  const open={action:'open',agent:'codex',cwd:root,mode:'new',cols:80,rows:24};await service.handle({...open,session_id:'one'});
  await expect.poll(async()=>{try{return (await readFile(calls,'utf8')).trim().split('\n').length;}catch{return 0;}}).toBe(1);
  const before=await controller.state();await controller.apply({request_id:'edit',revision:crypto.randomUUID(),expected_revision:before.revision,config:{...before.config,development_roots:[root],agent_paths:{codex:second},codex_sandbox:'danger-full-access'}});
  await service.handle({...open,session_id:'two'});await expect.poll(async()=>(await readFile(calls,'utf8')).trim().split('\n').length).toBe(2);
  const captured=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(captured[0][0]).toBe('first');expect(captured[1][0]).toBe('second');expect(captured[1][1]).toContain('danger-full-access');expect(service.sessions.read('one',0).session.status).toBe('running');
  await expect(service.handle({action:'codex_settings_update',mode:'workspace-write',expected_revision:''})).rejects.toThrow(/统一 Worker/);
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});

test('reading after a local config edit reconciles runtime directory policy before reporting it applied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'config-local-reconcile-')),a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);
 await saveWorkerConfig(root,{worker_id:'w',url:'https://example.test',name:'worker',capacity:1,development_roots:[a]});
 const controller=new WorkerConfigController(root),service=new DevelopmentService({roots:[a]});controller.onApplied((config,revision)=>service.applyConfig(config,revision));
 try{await controller.state();await updateWorkerConfig(root,current=>({...current,development_roots:[b]}));const state=await controller.state();
  expect(state.config.development_roots).toEqual([b]);await expect(service.handle({action:'list',path:b})).resolves.toMatchObject({path:b});await expect(service.handle({action:'list',path:a})).rejects.toThrow(/allowed root/);
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});

test('a rejected stale update also reconciles the local configuration it reports as applied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'config-local-conflict-')),a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);
 await saveWorkerConfig(root,{worker_id:'w',url:'https://example.test',name:'worker',capacity:1,development_roots:[a]});
 const controller=new WorkerConfigController(root),service=new DevelopmentService({roots:[a]});controller.onApplied((config,revision)=>service.applyConfig(config,revision));
 try{const before=await controller.state();await updateWorkerConfig(root,current=>({...current,development_roots:[b]}));
  const response=await controller.apply({request_id:'stale',revision:crypto.randomUUID(),expected_revision:before.revision,config:{...before.config,name:'remote'}});
  expect(response).toMatchObject({status:'failed',config:{development_roots:[b]}});
  await expect(service.handle({action:'list',path:b})).resolves.toMatchObject({path:b});await expect(service.handle({action:'list',path:a})).rejects.toThrow(/allowed root/);
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});
