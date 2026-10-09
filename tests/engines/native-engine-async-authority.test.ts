import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../../src/engines/service.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {NativeRunFiles} from '../../src/engines/native-files.js';
import {withNativePolicy} from '../helpers/native-policy.js';
import * as outputFiles from '../../src/runtime/files.js';

function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return{promise,release};}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-authority-')),db=new Database(':memory:'),store=new CodexSessionStore(db);
 let generation=1,authorized=true;const calls:string[]=[];
 const rpc:any={initialize:async()=>{calls.push('initialize');return{};},startThread:async()=>{calls.push('thread/start');return{id:'thread'};},resumeThread:async()=>{calls.push('thread/resume');return{id:'thread'};},startTurn:async()=>{calls.push('turn/start');return{id:'turn'};},interruptTurn:async()=>{calls.push('turn/interrupt');},backgroundTerminals:async()=>{calls.push('background/list');return{data:[],nextCursor:null};},terminateBackgroundTerminal:async()=>{calls.push('background/terminate');return{terminated:true};}};
 const files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id))),workspace={path:async()=>root};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:()=>workspace.path(),files,generation:()=>generation,authorized:()=>authorized});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'test'}];
 const prepare={action:'session_prepare',request_id:'prepare',session_id:'session',workspace_id:'workspace',binding};
 const submit={action:'submit',request_id:'submit',lease_ms:120000,submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],task_id:null,task_revision:null,input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex')},input};
 const control={request_id:'control',session_id:'session',run_id:'run',submission_id:'submission',authorization_revision:1};
 const terminal=()=>service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
 return{db,store,rpc,calls,files,workspace,service,prepare,submit,control,terminal,change:()=>generation++,revoke:()=>{authorized=false;},close:async()=>{await service.disconnect();db.close();await rm(root,{recursive:true,force:true});}};
}

test('generation change during workspace resolution cannot create a native thread',async()=>{
 const f=await fixture(),gate=barrier();try{
  let entered=false;const path=f.workspace.path;f.workspace.path=async()=>{entered=true;await gate.promise;return path();};
  const pending=f.service.handle(f.prepare);void pending.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  f.change();gate.release();await expect(pending).rejects.toThrow(/authority|generation|connection/i);expect(f.calls).not.toContain('thread/start');
 }finally{gate.release();await f.close();}
});

test.each(['generation','disconnect'] as const)('%s during thread policy revalidation cannot start a turn',async loss=>{
 const f=await fixture(),gate=barrier();try{
  await f.service.handle(f.prepare);let entered=false;
  f.rpc.assertPermissionProfileAvailable=async()=>{entered=true;await gate.promise;};
  const pending=f.service.handle(f.submit);void pending.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  if(loss==='generation')f.change();else await f.service.disconnect();
  gate.release();await expect(pending).rejects.toThrow(/authority|generation|connection/i);expect(f.calls).not.toContain('turn/start');
  expect(f.store.submission('submission')?.status).toBe('unknown');
 }finally{gate.release();await f.close();}
});

test('generation change while turn start is in flight saves exact late identity and interrupts without replay',async()=>{
 const f=await fixture(),gate=barrier();try{
  await f.service.handle(f.prepare);let entered=false;const start=f.rpc.startTurn;
  f.rpc.startTurn=async()=>{entered=true;await gate.promise;return start();};
  const pending=f.service.handle(f.submit);void pending.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  f.change();gate.release();await expect(pending).rejects.toThrow(/authority|generation|connection/i);
  expect(f.store.submission('submission')).toMatchObject({thread_id:'thread',turn_id:'turn',status:'unknown'});
  expect(f.calls.filter(c=>c==='turn/start')).toHaveLength(1);expect(f.calls).toContain('turn/interrupt');
 }finally{gate.release();await f.close();}
});

test.each(['collect_result','interrupt'] as const)('old %s cannot act after background list crosses a generation',async action=>{
 const f=await fixture(),gate=barrier();try{
  await f.service.handle(f.prepare);await f.service.handle(f.submit);f.terminal();let entered=false;
  f.rpc.backgroundTerminals=async()=>{entered=true;await gate.promise;return{data:action==='interrupt'?[{processId:'owned',itemId:'item'}]:[],nextCursor:null};};
  const collect=vi.spyOn(f.files,'collect');
  const pending=f.service.handle({action,...f.control,...(action==='interrupt'?{turn_id:'turn'}:{})});void pending.catch(()=>{});
  await expect.poll(()=>entered).toBe(true);f.change();gate.release();await expect(pending).rejects.toThrow(/authority|generation|connection/i);
  expect(f.calls).not.toContain('background/terminate');expect(collect).not.toHaveBeenCalled();expect(f.files.cached('session','run','submission')).toBeNull();
 }finally{gate.release();await f.close();}
});

test('close drains an in-flight preparation and rejects new requests without creating a thread',async()=>{
 const f=await fixture(),gate=barrier();try{
  let entered=false;const path=f.workspace.path;f.workspace.path=async()=>{entered=true;await gate.promise;return path();};
  const pending=f.service.handle(f.prepare);void pending.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  let closed=false;const closing=f.service.close().then(()=>{closed=true;}),again=f.service.close();
  await new Promise(r=>setImmediate(r));expect(closed).toBe(false);
  await expect(f.service.handle(f.prepare)).rejects.toThrow(/clos|shut/i);
  gate.release();await expect(pending).rejects.toThrow(/authority|clos|connection/i);await Promise.all([closing,again]);
  expect(f.calls).not.toContain('thread/start');
 }finally{gate.release();await f.close();}
});

test.each(['generation','close'] as const)('%s during file collection cannot publish a delivery packet',async loss=>{
 const f=await fixture(),gate=barrier();let closing:Promise<void>|undefined;
 const collect=outputFiles.collectOutputSnapshot;let entered=false;
 const spy=vi.spyOn(outputFiles,'collectOutputSnapshot').mockImplementation(async(...args)=>{const snapshot=await collect(...args);entered=true;await gate.promise;return snapshot;});
 try{
  await f.service.handle(f.prepare);await f.service.handle(f.submit);f.terminal();
  const pending=f.service.handle({action:'collect_result',...f.control});void pending.catch(()=>{});
  await expect.poll(()=>entered).toBe(true);
  let finished=false;if(loss==='generation')f.change();else closing=f.service.close().then(()=>{finished=true;});
  await new Promise(r=>setImmediate(r));expect(finished).toBe(false);
  gate.release();await expect(pending).rejects.toThrow(/authority|generation|clos/i);await closing;
  expect(f.files.cached('session','run','submission')).toBeNull();
  expect(()=>f.files.assertSubmissionAllowed('session','next','next')).toThrow(/delivery.*pending/i);
 }finally{gate.release();await closing;spy.mockRestore();await f.close();}
});

test('queued terminal control keeps original authority rather than adopting the new connection',async()=>{
 const f=await fixture(),gate=barrier();try{
  await f.service.handle(f.prepare);await f.service.handle(f.submit);f.terminal();let entered=false,lists=0;
  f.rpc.backgroundTerminals=async()=>{lists++;entered=true;await gate.promise;return{data:[],nextCursor:null};};
  const first=f.service.handle({action:'collect_result',...f.control});void first.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  const queued=f.service.handle({action:'interrupt',...f.control,request_id:'queued',turn_id:'turn'});void queued.catch(()=>{});
  f.change();gate.release();await expect(first).rejects.toThrow(/generation/);await expect(queued).rejects.toThrow(/generation/);
  expect(lists).toBe(1);expect(f.calls).not.toContain('background/terminate');
 }finally{gate.release();await f.close();}
});

test('stale reconciliation cannot save final result or unlock unknown execution',async()=>{
 const f=await fixture(),gate=barrier();try{
  await f.service.handle(f.prepare);await f.service.handle(f.submit);f.service.nativeConnectionLost();let entered=false;
  f.rpc.readThread=async()=>{entered=true;await gate.promise;return{thread:{id:'thread',turns:[{id:'turn',status:'completed',items:[]}]}};};
  const pending=f.service.handle({action:'reconcile',...f.control});void pending.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  f.change();gate.release();await expect(pending).rejects.toThrow(/generation/);
  expect(f.store.result('session','submission')).toBeNull();expect(f.store.active('session')?.status).toBe('unknown');
 }finally{gate.release();await f.close();}
});
