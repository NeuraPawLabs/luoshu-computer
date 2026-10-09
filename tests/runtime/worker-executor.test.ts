import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import {execFile} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Executor } from '../../src/runtime/executor.js';
import { WorkerState } from '../../src/runtime/state.js';
import { CheckpointStore } from '../../src/runtime/checkpoints.js';
import { WorkerDeliveryService } from '../../src/runtime/delivery.js';
import {assignmentSchema,type Assignment} from '../../src/protocol/index.js';
import {promisify} from 'node:util';

const command=promisify(execFile);
const assignment:Assignment={attempt_id:'execution_1',lease_epoch:1,agent:'codex',instruction:'Summarize input',input_files:[],codebases:[],timeout_seconds:30};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(){const dir=await mkdtemp(join(tmpdir(),'luoshu-executor-'));const state=new WorkerState(join(dir,'db'));state.recordStart(assignment.attempt_id,1,assignment);return{dir,state};}
test('lease renewal moves the live process deadline and rejects the wrong epoch',async()=>{
 const {dir,state}=await setup();let aborted=false;
 const executor=new Executor({state,stateDir:dir,leaseGraceMs:0,emit:event=>state.appendEvent(event),agents:{codex:async input=>{await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return{exitCode:130,summary:'cancelled',checks:[],events:[],argv:[]};}}});
 const running=executor.runAttempt(assignment,120);await delay(50);expect(executor.renewLease(assignment.attempt_id,2,200)).toBe(false);expect(executor.renewLease(assignment.attempt_id,1,200)).toBe(true);await delay(100);expect(aborted).toBe(false);expect((await running).status).toBe('cancelled');expect(aborted).toBe(true);expect(state.unackedEvents().map(e=>e.sequence)).toEqual([1,2]);state.close();
});
test('stop waits for the supervised adapter to exit before returning',async()=>{
 const {dir,state}=await setup();let exited=false,started=false;
 const executor=new Executor({state,stateDir:dir,emit:event=>state.appendEvent(event),agents:{codex:async input=>{started=true;await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>setTimeout(()=>{exited=true;resolve();},30),{once:true}));return{exitCode:130,summary:'cancelled',checks:[],events:[],argv:[]};}}});
 const running=executor.runAttempt(assignment,5000);while(!started)await delay(5);expect((await executor.stop(assignment.attempt_id,'cancelled')).stopped).toBe(true);expect(exited).toBe(true);expect((await running).status).toBe('cancelled');state.close();
});
test('executes the exact pinned agent with private inputs and bounded output instructions',async()=>{
 const {dir,state}=await setup();let prompt='';const executor=new Executor({state,stateDir:dir,emit:event=>state.appendEvent(event),agents:{codex:async()=>{throw new Error('wrong agent');},opencode:async input=>{prompt=input.prompt;expect(await readFile(join(input.cwd,'inputs','资料.txt'),'utf8')).toBe('hello');await writeFile(join(input.cwd,'outputs','结果.txt'),'done');input.onProgress?.('working');return{exitCode:0,summary:'finished',checks:[],events:[],argv:[],sessionId:'session-1'};}}});
 state.db.prepare('UPDATE worker_executions SET assignment_json=? WHERE attempt_id=?').run(JSON.stringify({...assignment,agent:'opencode',input_files:[{name:'资料.txt',mime_type:'text/plain',content_base64:'aGVsbG8='}]}),assignment.attempt_id);
 const result=await executor.runAttempt({...assignment,agent:'opencode',input_files:[{name:'资料.txt',mime_type:'text/plain',content_base64:'aGVsbG8='}]},5000);
 expect(result).toMatchObject({status:'succeeded',agent:'opencode',session_id:'session-1',files:[{name:'结果.txt',content_base64:'ZG9uZQ=='}]});expect(prompt).toContain(assignment.instruction);expect(prompt).toMatch(/outputs.*4.*10 MiB.*ZIP/i);expect(state.unackedEvents().map(e=>e.event.type)).toEqual(['started','agent_finished','delivery_ready']);state.close();
});

test('returns a generated project directory as one ZIP file', async () => {
 const {dir,state}=await setup();
 const executor=new Executor({state,stateDir:dir,emit:event=>state.appendEvent(event),agents:{codex:async input=>{await mkdir(join(input.cwd,'outputs','classroom-lottery','src'),{recursive:true});await writeFile(join(input.cwd,'outputs','classroom-lottery','src','main.ts'),'export const ok = true;');await writeFile(join(input.cwd,'outputs','classroom-lottery','.gitignore'),'node_modules');return{exitCode:0,summary:'generated',checks:[],events:[],argv:[]};}}});
 const result=await executor.runAttempt(assignment,5000);
 expect(result.status).toBe('succeeded');expect(result.files).toHaveLength(1);expect(result.files?.[0]).toMatchObject({name:'classroom-lottery.zip',mime_type:'application/zip'});state.close();
});

test('Agent completion evidence survives a delivery collection failure without rerunning Agent', async () => {
 const {dir,state}=await setup();let calls=0;
 const checkpoints=new CheckpointStore(state.db),delivery=new WorkerDeliveryService({state,checkpoints,stateDir:dir,isExecutionActive:id=>state.activeAttemptIds().includes(id)});
 const executor=new Executor({state,stateDir:dir,checkpoints,delivery,emit:event=>state.appendEvent(event),agents:{codex:async input=>{calls++;await writeFile(join(input.cwd,'outputs','result.txt'),'done');await import('node:fs/promises').then(fs=>fs.symlink('/does-not-exist',join(input.cwd,'outputs','bad.txt')));return{exitCode:0,summary:'finished',checks:[{command:'check',exit_code:0,output:'private'}],events:[],argv:[]};}}});
 try{
  const result=await executor.runAttempt(assignment,5000);expect(calls).toBe(1);
  expect(result.status).toBe('blocked');
  expect(checkpoints.read(assignment.attempt_id)?.evidence?.exit_code).toBe(0);
  expect(state.unackedEvents().map(e=>e.event.type)).toEqual(['started','agent_finished','delivery_failed']);
  await import('node:fs/promises').then(fs=>fs.unlink(join(dir,'workspaces',assignment.attempt_id,'outputs','bad.txt')));
  const packet=await delivery.collect(assignment.attempt_id,'execution_result');
  expect(packet.files[0].name).toBe('result.txt');expect(calls).toBe(1);
  expect(packet.verification_binding).toBe('unbound');
 }finally{await delivery.close();state.close();}
});

test('tells the Agent directory and archive limits before execution',async()=>{
 const {dir,state}=await setup();let prompt='';
 const executor=new Executor({state,stateDir:dir,emit:()=>{},agents:{codex:async input=>{
  prompt=input.prompt;return{exitCode:0,summary:'done',checks:[],events:[],argv:[]};
 }}});
 try{
  await executor.runAttempt(assignment,5000);
  expect(prompt).toContain('10 MiB uncompressed');
  expect(prompt).toContain('10000');
  expect(prompt).toContain('ZIP');
 }finally{state.close();}
});
test('streams executor progress live without putting it in the durable worker outbox',async()=>{
 const {dir,state}=await setup();const live:string[]=[];
 const executor=new Executor({state,stateDir:dir,emit:event=>state.appendEvent(event),emitLive:(_id,_epoch,text)=>live.push(text),agents:{codex:async input=>{input.onProgress?.('command output');return{exitCode:0,summary:'done',checks:[],events:[],argv:[]};}}});
 await executor.runAttempt(assignment,5000);expect(live).toEqual(['command output']);expect(state.unackedEvents().map(e=>e.event.type)).toEqual(['started','agent_finished','delivery_ready']);state.close();
});
test('timeout cancels the adapter even while its lease is valid',async()=>{
 const {dir,state}=await setup();let exited=false;const executor=new Executor({state,stateDir:dir,leaseGraceMs:0,emit:()=>undefined,agents:{codex:async input=>{await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>setTimeout(()=>{exited=true;resolve();},30),{once:true}));return{exitCode:130,summary:'cancelled',checks:[],events:[],argv:[]};}}});
 state.db.prepare('UPDATE worker_executions SET assignment_json=? WHERE attempt_id=?').run(JSON.stringify({...assignment,timeout_seconds:1}),assignment.attempt_id);
 const result=await executor.runAttempt({...assignment,timeout_seconds:1},5000);expect(exited).toBe(true);expect(result.status).toBe('cancelled');state.close();
});

test('unlimited assignment has no execution timer but manual stop and lease safety remain active',async()=>{
 expect(assignmentSchema.parse({...assignment,timeout_seconds:null}).timeout_seconds).toBeNull();
 const {dir,state}=await setup();let signal:AbortSignal|undefined;
 const executor=new Executor({state,stateDir:dir,leaseGraceMs:0,emit:()=>{},agents:{codex:async input=>{signal=input.signal;await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));return{exitCode:130,summary:'stopped',checks:[],events:[],argv:[]};}}});
 try{const pending=executor.runAttempt(assignment,10000);await expect.poll(()=>Boolean(signal)).toBe(true);await delay(40);expect(signal?.aborted).toBe(false);await executor.stop(assignment.attempt_id,'user');expect((await pending).status).toBe('cancelled');}finally{await executor.stopAll('cleanup');state.close();}
});
test('unlimited assignment still stops when its lease expires',async()=>{
 const {dir,state}=await setup();let reason:unknown;
 const executor=new Executor({state,stateDir:dir,leaseGraceMs:0,emit:()=>{},agents:{codex:async input=>{await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>{reason=input.signal.reason;resolve();},{once:true}));return{exitCode:130,summary:'stopped',checks:[],events:[],argv:[]};}}});
 try{expect((await executor.runAttempt(assignment,120)).status).toBe('cancelled');expect(reason).toBe('lease-expired');}finally{await executor.stopAll('cleanup');state.close();}
});
test.each([false,true,'codebase'] as const)('executes pinned write and read Codebases and reports the exact commit set after collection failure: %s',async failCollection=>{
 const {dir,state}=await setup();
 const repository=async(name:string)=>{const {mkdir}=await import('node:fs/promises'),path=join(dir,name);await mkdir(path);await command('git',['init','-b','main'],{cwd:path});await command('git',['config','user.email','worker@test'],{cwd:path});await command('git',['config','user.name','Worker Test'],{cwd:path});await writeFile(join(path,'index.txt'),name);await command('git',['add','.'],{cwd:path});await command('git',['commit','-m','initial'],{cwd:path});return{path,commit:(await command('git',['rev-parse','HEAD'],{cwd:path})).stdout.trim()};};
 const web=await repository('web-source'),api=await repository('api-source');let prompt='';
 const codeAssignment:Assignment={...assignment,attempt_id:'execution_codebases',run_id:'run_1',codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'web',access_mode:'write',source:{kind:'local',path:web.path},root_path:'.',default_branch:'main',base_commit:web.commit,branch:'luoshu/feature/web'},{id:'22222222-2222-4222-8222-222222222222',alias:'api',access_mode:'read',source:{kind:'local',path:api.path},root_path:'.',default_branch:'main',base_commit:api.commit,branch:null}]};
 let calls=0;
 const executor=new Executor({state,stateDir:dir,developmentRoots:[dir],emit:event=>state.appendEvent(event),agents:{codex:async input=>{calls++;prompt=input.prompt;const target=join(input.cwd,'web');await writeFile(join(target,'index.txt'),'changed');await command('git',['add','.'],{cwd:target});await command('git',['-c','user.name=Worker Test','-c','user.email=worker@test','commit','-m','change'],{cwd:target});if(failCollection==='codebase'){const{rename}=await import('node:fs/promises');await rename(join(target,'.git'),join(target,'.git-held'));}else if(failCollection){const{symlink}=await import('node:fs/promises');await symlink('missing',join(dir,'workspaces',codeAssignment.attempt_id,'outputs','bad'));}return{exitCode:0,summary:'changed',checks:[],events:[],argv:[]};}}});
 state.recordStart(codeAssignment.attempt_id,1,codeAssignment);
 let result=await executor.runAttempt(codeAssignment,5000);
 if(failCollection){
  expect(result.status).toBe('blocked');
  if(failCollection==='codebase'){const{rename}=await import('node:fs/promises');const target=join(dir,'runs','run_1','targets','web');await rename(join(target,'.git-held'),join(target,'.git'));}
  else {const{unlink}=await import('node:fs/promises');await unlink(join(dir,'workspaces',codeAssignment.attempt_id,'outputs','bad'));}
  const packet=await executor.delivery.collect(codeAssignment.attempt_id,'execution_result');
  result={...result,status:'succeeded',codebases:packet.evidence!.codebases};
 }
 expect(calls).toBe(1);
 expect(prompt).toMatch(/web.*write|write.*web/i);expect(prompt).toMatch(/api.*read|read.*api/i);expect(result.status).toBe('succeeded');expect(result.codebases).toEqual(expect.arrayContaining([expect.objectContaining({codebase_id:codeAssignment.codebases[0]!.id,result:'changed'}),expect.objectContaining({codebase_id:codeAssignment.codebases[1]!.id,result:'unchanged',read_isolation:'enforced'})]));state.close();
});
