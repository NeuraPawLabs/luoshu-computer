import {withNativePolicy} from '../helpers/native-policy.js';
import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../../src/engines/service.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {NativeRunFiles} from '../../src/engines/native-files.js';

test('Worker stages Run output location before native turn and collects directories only after terminal completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-delivery-')),db=new Database(':memory:'),store=new CodexSessionStore(db);let starts=0;const inputs:any[]=[];
 const files=new NativeRunFiles(db,identity=>Boolean(store.result(identity.session_id,identity.submission_id)));
 let background=true;const listed:any[]=[];
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async(p:any)=>{starts++;inputs.push(p);return{id:'turn'};},interruptTurn:async()=>{},backgroundTerminals:async(params:any)=>{listed.push(params);return{data:background?[{processId:'still-running',itemId:'cmd'}]:[],nextCursor:null};}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>root,files});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'build'}],control={request_id:'collect',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',request_id:'s',lease_ms:120000,submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  expect(JSON.stringify(inputs[0])).toContain(join(root,'runs','run','outputs'));
  await expect(service.handle({action:'collect_result',...control})).rejects.toThrow(/terminal/i);
  await mkdir(join(root,'runs','run','outputs','lottery'));await writeFile(join(root,'runs','run','outputs','lottery','index.html'),'<h1>Draw</h1>');
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await expect(service.handle({action:'collect_result',...control})).rejects.toThrow(/background|后台/);
  expect(listed).toEqual([{threadId:'thread'}]);expect(store.result('session','submission')).not.toBeNull();
  background=false;
  const first=await service.handle({action:'collect_result',...control});expect(first).toMatchObject({delivery:{files:[{name:'lottery.zip'}]}});
  expect(await service.handle({action:'collect_result',...control})).toEqual(first);expect(starts).toBe(1);
  // A cached immutable packet does not load an App Server or interact with
  // background terminals belonging to a later turn.
  let resumed=false;const resumeCalls:string[]=[];
  const restarted:any={initialize:async()=>({}),resumeThread:async(params:any)=>{resumeCalls.push(params.threadId);resumed=true;return{id:params.threadId};},backgroundTerminals:async()=>{if(!resumed)throw Error('thread is not loaded');return{data:[],nextCursor:null};}};
  const recovered=new CodexEngineService(store,'worker',()=>withNativePolicy(restarted),{workspacePath:async()=>root,files});
  expect(await recovered.handle({action:'collect_result',...control})).toEqual(first);expect(resumeCalls).toEqual([]);expect(starts).toBe(1);
 }finally{await service.disconnect();db.close();await rm(root,{recursive:true,force:true});}
});

test('terminal-turn interrupt stops only its background terminals and delivery waits for confirmed quiescence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-stop-')),db=new Database(':memory:'),store=new CodexSessionStore(db);
 const files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));let running=true,confirmed=false,starts=0;const stopped:unknown[]=[];
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn-'+ ++starts}),interruptTurn:async()=>{throw Error('completed turns cannot be interrupted');},backgroundTerminals:async()=>({data:running?[{processId:'app-process',itemId:'command'}]:[],nextCursor:null}),terminateBackgroundTerminal:async(params:any)=>{stopped.push(params);if(confirmed)running=false;return{terminated:confirmed};}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>root,files});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'build'}];
 const submission=(id:string)=>({action:'submit',request_id:'s-'+id,lease_ms:120000,submission:{submission_id:id,batch_id:'batch-'+id,run_id:'run-'+id,session_id:'session',binding,input_message_ids:['message-'+id],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
 const control={request_id:'stop',session_id:'session',submission_id:'first',run_id:'run-first',authorization_revision:1};
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle(submission('first'));service.notification('turn/completed',{threadId:'thread',turn:{id:'turn-1',status:'completed',items:[]}});
  await expect(service.handle({action:'interrupt',...control,turn_id:'foreign'})).rejects.toThrow(/identity/i);expect(stopped).toEqual([]);
  await expect(service.handle({action:'interrupt',...control,turn_id:'turn-1'})).rejects.toThrow(/background|confirmed/i);
  expect(stopped).toEqual([{threadId:'thread',processId:'app-process'}]);
  await expect(service.handle({action:'collect_result',...control})).rejects.toThrow(/background/i);
  await expect(service.handle(submission('second'))).rejects.toThrow(/delivery.*pending/i);
  confirmed=true;
  let release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve),terminate=rpc.terminateBackgroundTerminal;
  rpc.terminateBackgroundTerminal=async(params:any)=>{await barrier;return terminate(params);};
  const stopping=service.handle({action:'interrupt',...control,turn_id:'turn-1'});void stopping.catch(()=>{});
  const collecting=service.handle({action:'collect_result',...control});void collecting.catch(()=>{});
  release();await stopping;await collecting;
  expect(store.result('session','first')?.status).toBe('completed');
  await service.handle({action:'collect_result',...control});
  await service.handle(submission('second'));running=true;
  const count=stopped.length;await service.handle({action:'interrupt',...control,turn_id:'turn-1'});
  expect(stopped).toHaveLength(count);expect(running).toBe(true);expect(starts).toBe(2);
 }finally{await service.disconnect();db.close();await rm(root,{recursive:true,force:true});}
});

test('durable delivery intent blocks another turn through collection and cached retrieval never touches a newer turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-lock-')),db=new Database(':memory:'),store=new CodexSessionStore(db);
 const files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));let starts=0,lists=0;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn-'+ ++starts}),interruptTurn:async()=>{},backgroundTerminals:async()=>{lists++;return{data:[],nextCursor:null};}};
 const options={workspacePath:async()=>root,files},service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),options);
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'build'}];
 const submission=(id:string)=>({action:'submit',request_id:'s-'+id,lease_ms:120000,submission:{submission_id:id,batch_id:'batch-'+id,run_id:'run-'+id,session_id:'session',binding,input_message_ids:['message-'+id],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
 const control={request_id:'collect',session_id:'session',submission_id:'first',run_id:'run-first',authorization_revision:1};
 let resume!:()=>void;
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle(submission('first'));service.notification('turn/completed',{threadId:'thread',turn:{id:'turn-1',status:'completed',items:[]}});
  await expect(service.handle(submission('next'))).rejects.toThrow(/delivery.*pending/i);expect(starts).toBe(1);
  const restored=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{...options,files:new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)))});
  await expect(restored.handle(submission('next'))).rejects.toThrow(/delivery.*pending/i);
  const collect=files.collect.bind(files),barrier=new Promise<void>(resolve=>resume=resolve);
  const spy=vi.spyOn(files,'collect').mockImplementation(async(...args)=>{await barrier;return collect(...args);});
  const collecting=service.handle({action:'collect_result',...control});
  await expect.poll(()=>spy.mock.calls.length).toBe(1);
  await expect(service.handle(submission('next'))).rejects.toThrow(/delivery.*pending/i);
  resume();const packet=await collecting;spy.mockRestore();
  await service.handle(submission('next'));expect(starts).toBe(2);
  const before=lists;expect(await service.handle({action:'collect_result',...control})).toEqual(packet);expect(lists).toBe(before);
 }finally{resume?.();await service.disconnect();db.close();await rm(root,{recursive:true,force:true});}
});
