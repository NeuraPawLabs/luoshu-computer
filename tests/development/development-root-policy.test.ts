import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DevelopmentRootPolicy } from '../../src/development/root-policy.js';
import { DevelopmentService } from '../../src/development/service.js';
import { saveWorkerConfig, loadWorkerConfig } from '../../src/runtime/environment.js';
import { runtimeDevelopmentRoots, codebasePreparation } from '../../src/development/runtime-roots.js';
import { Executor } from '../../src/runtime/executor.js';
import { WorkerState } from '../../src/runtime/state.js';
import { execFileSync } from 'node:child_process';
import type { Assignment } from '../../src/protocol/index.js';
import { homedir } from 'node:os';
import { resolveCodebaseAssignments, prepareCodebaseWorkspace } from '../../src/runtime/codebase-workspace.js';
import { pairWorker } from '../../src/runtime/client.js';
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path,{recursive:true,force:true}); });
async function fixture() { const root=await mkdtemp(join(tmpdir(),'roots-policy-'));cleanup.push(root);const a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);return{root,a,b}; }
test('defaults to home, applies additions without stopping work, and explicit empty roots disable access',async()=>{
 const {root,a,b}=await fixture();let persisted:unknown;
 const policy=new DevelopmentRootPolicy({home:root,persist:async roots=>{persisted=roots;}});
 expect(policy.state().roots).toEqual([root]);
 await policy.update([a],randomUUID(),[]);
 const lease=policy.acquire('session:1','session',[a],async()=>{throw Error('must stay running');});
 expect((await policy.update([a,b],randomUUID(),[])).status).toBe('applied');expect(persisted).toEqual([a,b]);
 lease();await policy.update([],randomUUID(),[]);expect(policy.state().roots).toEqual([]);expect(()=>policy.acquire('session:2','session',[a])).toThrow(/allowed|允许/);
});
test('narrowing lists affected work and stops only explicitly confirmed ids before applying',async()=>{
 const {root,a,b}=await fixture();const policy=new DevelopmentRootPolicy({home:root,persist:async()=>{}});let stopped=false;
 let release=()=>{};release=policy.acquire('session:a','session',[a],async()=>{stopped=true;release();});
 const keep=policy.acquire('task:b','task',[b],async()=>{throw Error('unaffected task');});
 const revision=randomUUID();const first=await policy.update([b],revision,[]);
 expect(first).toMatchObject({status:'blocked',blockers:[{id:'session:a',path:a,stoppable:true}]});expect(stopped).toBe(false);expect(policy.state().roots).toEqual([root]);
 const next=await policy.update([b],revision,['session:a']);expect(next.status).toBe('applied');expect(stopped).toBe(true);keep();
});
test('invalid paths and failed persistence retain policy; changing policy blocks new starts',async()=>{
 const {root,a,b}=await fixture();let fail=true,unblock=()=>{};let hold:Promise<void>|undefined;
 const policy=new DevelopmentRootPolicy({home:root,persist:async()=>{if(fail)throw Error('disk full');await hold;}});
 await expect(policy.update([a],randomUUID(),[])).rejects.toThrow('disk full');expect(policy.state().roots).toEqual([root]);
 await symlink(b,join(root,'linked'));await expect(policy.update([join(root,'linked')],randomUUID(),[])).rejects.toThrow(/symbolic|Symbolic/);
 fail=false;hold=new Promise<void>(resolve=>{unblock=resolve;});const pending=policy.update([a],randomUUID(),[]);
 expect(()=>policy.acquire('task:new','task',[b])).toThrow(/updat|更新/);unblock();await pending;
});

test('live roots update persists without restart and stops only the confirmed PTY',async()=>{
 const {root,a,b}=await fixture(),stateDir=join(root,'state');await mkdir(stateDir);
 const config={worker_id:'worker-1',url:'https://example.test',name:'test',capacity:2,development_roots:[a]};
 await saveWorkerConfig(stateDir,config);
 const policy=runtimeDevelopmentRoots(stateDir,config),agent=join(root,'agent');
 await writeFile(agent,'#!/usr/bin/env node\nprocess.stdin.resume();process.stdout.write("ready");\n',{mode:0o755});
 const service=new DevelopmentService({rootPolicy:policy,agentPaths:{codex:agent}});
 const open=async(id:string,cwd:string)=>service.handle({action:'open',session_id:id,agent:'codex',mode:'new',cwd,cols:80,rows:24});
 try{
  await expect(open('denied',b)).rejects.toThrow(/allowed/);
  await service.handle({action:'roots_update',roots:[a,b],revision:randomUUID(),stop_ids:[]});
  await open('first',a);await open('second',b);
  const revision=randomUUID(),blocked=await service.handle({action:'roots_update',roots:[b],revision,stop_ids:[]});
  expect(blocked).toMatchObject({status:'blocked',blockers:[{id:'session:first',path:a}]});
  expect(service.sessions.read('first',0).session.status).toBe('running');
  await service.handle({action:'roots_update',roots:[b],revision,stop_ids:['session:first']});
  expect(service.sessions.read('first',0).session.status).toBe('exited');
  expect(service.sessions.read('second',0).session.status).toBe('running');
  expect(await service.handle({action:'roots'})).toEqual({action:'roots',roots:[b]});
  const saved=await loadWorkerConfig(stateDir);expect(saved).toMatchObject({development_roots:[b],development_roots_revision:revision,maintenance_roots:[a]});
  expect(runtimeDevelopmentRoots(stateDir,saved).state().roots).toEqual([b]);
 }finally{await service.stopAll();}
});

test('repository preparation and execution use the same newly applied directory policy',async()=>{
 const {root,a,b}=await fixture(),stateDir=join(root,'state');await mkdir(stateDir);
 const git=(args:string[])=>execFileSync('git',args,{cwd:b,encoding:'utf8'}).trim();git(['init','-b','main']);
 await writeFile(join(b,'index.txt'),'repository');git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);
 const policy=new DevelopmentRootPolicy({roots:[a],persist:async()=>{}}),prepare=codebasePreparation(stateDir,policy);
 const spec={id:randomUUID(),alias:'repo',access_mode:'write' as const,source:{kind:'local' as const,path:b},root_path:'.',default_branch:'main',branch:'luoshu/feature/test'};
 await expect(prepare.prepare({type:'codebase_prepare_request',request_id:'denied',run_id:'run',codebases:[spec]})).rejects.toThrow(/allowed/);
 await policy.update([a,b],randomUUID(),[]);
 const prepared=await prepare.prepare({type:'codebase_prepare_request',request_id:'prepare',run_id:'run',codebases:[spec]});
 const state=new WorkerState(join(stateDir,'worker.db'));
 const assignment:Assignment={attempt_id:'execution',lease_epoch:1,run_id:'run',agent:'codex',instruction:'inspect',input_files:[],timeout_seconds:30,codebases:[{...spec,base_commit:prepared[0].base_commit}]};
 state.recordStart('execution',1,assignment);
 const executor=new Executor({state,stateDir,rootPolicy:policy,emit:event=>state.appendEvent(event),agents:{codex:async input=>{
  expect(await readFile(join(input.cwd,'repo','index.txt'),'utf8')).toBe('repository');return{exitCode:0,summary:'done',checks:[],events:[],argv:[]};
 }}});
 try{expect((await executor.runAttempt(assignment,5000)).status).toBe('succeeded');}finally{await executor.delivery.close();state.close();}
});

test('unconfigured browsing and Codebase preparation share the default home directory',async()=>{
 const root=await mkdtemp(join(homedir(),'.luoshu-roots-test-'));cleanup.push(root);
 const repo=join(root,'repo'),stateDir=join(root,'state');await mkdir(repo);await mkdir(stateDir);
 const git=(args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();git(['init','-b','main']);
 await writeFile(join(repo,'index.txt'),'default home');git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);
 const service=new DevelopmentService();await expect(service.handle({action:'repository',path:repo})).resolves.toMatchObject({repository_path:repo});
 const spec={id:randomUUID(),alias:'repo',access_mode:'write' as const,source:{kind:'local' as const,path:repo},root_path:'.',default_branch:'main',branch:'luoshu/feature/test'};
 const assignments=await resolveCodebaseAssignments({codebases:[spec]});
 const workspace=await prepareCodebaseWorkspace({stateDir,workspaceId:'default',codebases:assignments});
 expect(await readFile(join(workspace.targets,'repo','index.txt'),'utf8')).toBe('default home');
 await expect(resolveCodebaseAssignments({codebases:[spec],allowedRoots:[]})).rejects.toThrow(/allowed/);
});

test('a narrowing update waits for a confirmed running task to finish without aborting other paths',async()=>{
 const {root,a,b}=await fixture(),stateDir=join(root,'state');await mkdir(stateDir);
 const policy=new DevelopmentRootPolicy({roots:[a,b],persist:async()=>{}}),state=new WorkerState(join(stateDir,'worker.db'));
 let started=false,aborted=false;
 const assignment:Assignment={attempt_id:'long-task',lease_epoch:1,agent:'codex',instruction:'work',input_files:[],timeout_seconds:30,codebases:[]};
 const executor=new Executor({state,stateDir,rootPolicy:policy,emit:event=>state.appendEvent(event),agents:{codex:async input=>{
  started=true;await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
  return{exitCode:130,summary:'stopped',checks:[],events:[],argv:[]};
 }}});
 state.recordStart(assignment.attempt_id,1,assignment);
 const running=executor.runAttempt(assignment,5000);
 try{
  await expect.poll(()=>started).toBe(true);
  const revision=randomUUID();expect((await policy.update([b],revision,[])).status).toBe('blocked');expect(aborted).toBe(false);
  expect((await policy.update([b],revision,['task:long-task'])).status).toBe('applied');expect(aborted).toBe(true);expect((await running).status).toBe('cancelled');
 }finally{await executor.stopAll('cleanup');await running;await executor.delivery.close();state.close();}
});

test('setup rejects invalid development roots before consuming the pairing code',async()=>{
 const {root}=await fixture();let calls=0;
 await expect(pairWorker({stateDir:join(root,'state'),url:'https://example.test',code:'pairing-code',name:'test',capacity:1,developmentRoots:[join(root,'missing')],fetchImpl:async()=>{calls++;throw Error('must not pair');}})).rejects.toThrow();
 expect(calls).toBe(0);
});
