import {withNativePolicy} from './helpers/native-policy.js';
import Database from 'better-sqlite3';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/codex-session.js';
import {createHash} from 'node:crypto';

test('approval arriving before turn acknowledgement waits for the exact accepted turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];let release!:(turn:unknown)=>void,service!:CodexEngineService,approval!:Promise<unknown>;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>{
  approval=service.serverRequest({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',itemId:'cmd',command:'check'}});void approval.catch(()=>{});
  return new Promise(r=>release=r);
 },interruptTurn:async()=>{}};
 service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:e=>events.push(e)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  const send=service.handle({action:'submit',request_id:'s',lease_ms:120000,submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  await expect.poll(()=>Boolean(release)).toBe(true);expect(events.filter(e=>e.event.kind==='waiting_approval')).toEqual([]);
  release({id:'turn'});await send;
  await expect.poll(()=>events.some(e=>e.event.kind==='waiting_approval')).toBe(true);
  const request=events.find(e=>e.event.kind==='waiting_approval').event;
  await service.handle({action:'interaction_response',request_id:'answer',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn',interaction_id:request.request_id,response:{kind:'approval',decision:'deny'}});
  await expect(approval).resolves.toEqual({decision:'decline'});
 }finally{await service.disconnect();db.close();}
});

test('Codex engine service exposes only session/turn actions and pins Worker identity',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),calls:any[]=[];const rpc:any={initialize:async()=>({}),startThread:async(input:any)=>{calls.push(input);return{id:'thread-1'};},startTurn:async()=>({id:'turn-1'}),interruptTurn:async()=>{}};const service=new CodexEngineService(store,'worker-1',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace'});
 const binding={conversation_id:'11111111-1111-4111-8111-111111111111',agent_id:'22222222-2222-4222-8222-222222222222',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'worker-1',agent:'codex' as const,adapter_version:1}};
 const response=await service.handle({action:'session_prepare',request_id:'33333333-3333-4333-8333-333333333333',session_id:'44444444-4444-4444-8444-444444444444',binding,workspace_id:'55555555-5555-4555-8555-555555555555'});expect(response).toMatchObject({action:'session_prepare',native:{thread_id:'thread-1'}});expect(calls[0].cwd).toBe('/fixture/workspace');
 await expect(service.handle({action:'session_prepare',request_id:'33333333-3333-4333-8333-333333333333',session_id:'44444444-4444-4444-8444-444444444444',binding:{...binding,engine:{...binding.engine,worker_id:'other'}},workspace_id:'55555555-5555-4555-8555-555555555555'})).rejects.toThrow(/another Worker/);db.close();
});
test('prepared native thread is reused by submit, interrupt uses native identity and cannot fake interaction success',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),calls:any[]=[],rpc:any={initialize:async()=>({}),startThread:async(p:any)=>{calls.push(['thread/start',p]);return{id:'native-thread',sessionId:'tree'};},resumeThread:async(p:any)=>{calls.push(['thread/resume',p]);return{id:p.threadId,sessionId:'tree'};},startTurn:async(p:any)=>{calls.push(['turn/start',p]);return{id:'native-turn',status:'inProgress'};},interruptTurn:async(p:any)=>calls.push(['turn/interrupt',p])};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace'});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 const submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
 try{
  await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
  expect(await service.handle({action:'submit',lease_ms:120000,request_id:'submit',submission,input})).toMatchObject({turn_id:'native-turn'});
  expect(calls.filter(c=>c[0]==='thread/start')).toHaveLength(1);
  await service.handle({action:'interrupt',request_id:'stop',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'native-turn'});
  expect(calls.at(-1)).toEqual(['turn/interrupt',{threadId:'native-thread',turnId:'native-turn'}]);
  expect(store.active('session')?.status).toBe('stopping');
  await expect(service.handle({action:'interrupt',request_id:'wrong',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'other'})).rejects.toThrow();
  await expect(service.handle({action:'interaction_response',request_id:'answer',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'native-turn',interaction_id:'missing',response:{decision:'allow_once'}})).rejects.toThrow();
 }finally{db.close();}
});
test('submit without a prepared session is rejected before calling native methods',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db);let factories=0;const service=new CodexEngineService(store,'worker',()=>{factories++;throw Error('must not spawn');});
 try{const input=[{type:'text',text:'hello'}];await expect(service.handle({action:'submit',lease_ms:120000,request_id:'submit',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding:{conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input})).rejects.toThrow(/prepared|session/i);expect(factories).toBe(0);}finally{db.close();}
});
test('native events bind to exact acknowledged turn; final result survives service restart without raw output',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];let starts=0;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native',sessionId:'tree'}),resumeThread:async()=>({id:'native',sessionId:'tree'}),startTurn:async()=>{starts++;return{id:'turn',status:'inProgress'};},readThread:async()=>({thread:{id:'native',turns:[{id:'turn',status:'completed',items:[]}]}})};
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}],submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace',generation:()=>3,emit:(event:any)=>events.push(event)});
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',lease_ms:120000,request_id:'s',submission,input});
  service.notification('item/started',{threadId:'native',turnId:'turn',item:{id:'cmd',type:'commandExecution',command:'check',status:'inProgress'}});
  service.notification('item/commandExecution/outputDelta',{threadId:'native',turnId:'turn',itemId:'cmd',delta:'RAW_TOOL_CONTENT'});
  service.notification('item/completed',{threadId:'native',turnId:'other',item:{id:'wrong',type:'agentMessage',phase:'final_answer',text:'FOREIGN'}});
  service.notification('turn/completed',{threadId:'native',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'Full native answer'}]}});
  expect(events.some(e=>e.event.kind==='tool.output'&&e.event.text==='RAW_TOOL_CONTENT')).toBe(true);
  expect(events.every(e=>e.source.run_id==='run'&&e.source.native.turn_id==='turn'&&e.source.worker_generation===3)).toBe(true);
  expect(events.map(e=>e.event_sequence)).toEqual(events.map((_,i)=>i+1));
  expect(store.submission('submission')).toMatchObject({status:'completed'});
  const reopened=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace'});
  expect(reopened.result('session','submission')).toMatchObject({status:'completed',replies:[{item_id:'final',text:'Full native answer'}]});
  await reopened.handle({action:'submit',lease_ms:120000,request_id:'repeat',submission,input});expect(starts).toBe(1);
  for(const table of ['codex_native_sessions','codex_native_submissions'])expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('RAW_TOOL_CONTENT');
 }finally{db.close();}
});
test('a terminal notification arriving before turn acknowledgement is applied after exact binding',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];let service:CodexEngineService;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>{service.notification('turn/completed',{threadId:'native',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'fast result'}]}});return{id:'turn'};}};
 service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace',generation:()=>1,emit:(event:any)=>events.push(event)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 try{await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',lease_ms:120000,request_id:'s',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  expect(service.result('session','submission')).toMatchObject({status:'completed',replies:[{text:'fast result'}]});expect(events.at(-1).event.state).toBe('completed');
 }finally{db.close();}
});
test('server approval flows back to the pending native request and completion invalidates it',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[],rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>({id:'turn'})};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace',generation:()=>1,emit:(event:any)=>events.push(event)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',lease_ms:120000,request_id:'s',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const request=service.serverRequest({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',itemId:'cmd',command:'check'}});
  const waiting=events.find(e=>e.event.kind==='waiting_approval');expect(waiting).toBeDefined();
  await service.handle({action:'interaction_response',request_id:'answer',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn',interaction_id:waiting.event.request_id,response:{kind:'approval',decision:'allow_once'}});
  await expect(request).resolves.toEqual({decision:'accept'});
  await expect(service.handle({action:'interaction_response',request_id:'repeat',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn',interaction_id:waiting.event.request_id,response:{kind:'approval',decision:'allow_once'}})).rejects.toThrow();
 }finally{db.close();}
});
test('explicit native interruption revokes pending approvals before its acknowledgement',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[],rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>({id:'turn'}),interruptTurn:async()=>{}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:e=>events.push(e)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',request_id:'s',lease_ms:120000,submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const approval=service.serverRequest({id:8,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',itemId:'cmd',command:'check'}});void approval.catch(()=>{});
  const prompt=events.find(e=>e.event.kind==='waiting_approval').event;
  await service.handle({action:'interrupt',request_id:'stop',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn'});
  await expect(service.handle({action:'interaction_response',request_id:'late',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn',interaction_id:prompt.request_id,response:{kind:'approval',decision:'allow_once'}})).rejects.toThrow(/authorized|expired|closed/);
  await expect(approval).rejects.toThrow();expect(store.active('session')).toBeDefined();
 }finally{await service.disconnect();db.close();}
});
test('restarted service imports only the exact completed native turn when reconciling',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>({id:'turn'}),readThread:async()=>({thread:{id:'native',turns:[{id:'foreign',status:'completed',items:[{id:'leak',type:'agentMessage',text:'FOREIGN',phase:'final_answer'}]},{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'Recovered answer',phase:'final_answer'}]}]}})};
 const options={workspacePath:async()=>'/fixture/workspace'},service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),options),input=[{type:'text',text:'hello'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
 try{
  await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',lease_ms:120000,request_id:'s',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const recovered=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),options);
  await recovered.handle({action:'reconcile',request_id:'r',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1});
  expect(recovered.result('session','submission')).toMatchObject({status:'completed',replies:[{item_id:'answer',text:'Recovered answer'}]});
  expect(store.active('session')).toBeUndefined();
 }finally{db.close();}
});
test('disconnect invalidates approvals, interrupts native turn and never reports stopped before confirmation',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[],interrupts:any[]=[],rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>({id:'native'}),startTurn:async()=>({id:'turn'}),interruptTurn:async(p:any)=>interrupts.push(p)};
 let authorized=true;const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture/workspace',generation:()=>1,authorized:()=>authorized,emit:(e:any)=>events.push(e)}),input=[{type:'text',text:'hello'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
 try{await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});await service.handle({action:'submit',lease_ms:120000,request_id:'s',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const approval=service.serverRequest({id:'pending',method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',itemId:'cmd',command:'check'}});const rejected=expect(approval).rejects.toThrow();
  authorized=false;await service.disconnect();await rejected;expect(interrupts).toEqual([{threadId:'native',turnId:'turn'}]);expect(store.active('session')).toBeDefined();
  await expect(service.handle({action:'session_prepare',request_id:'new',session_id:'new-session',binding,workspace_id:'workspace'})).rejects.toThrow(/authority|authorized/);
  expect(events.some(e=>e.event.kind==='turn.status'&&e.event.state==='cancelled')).toBe(false);
 }finally{db.close();}
});
test('native submissions reserve capacity before awaiting thread policy revalidation',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db);let resumes=0,release!:(v:any)=>void;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'native'}),resumeThread:async()=>{resumes++;return new Promise(r=>release=r);},startTurn:async()=>({id:'turn'})};
 const options={workspacePath:async()=>'/fixture/workspace',capacity:()=>1,otherActiveCount:()=>0},service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),options),input=[{type:'text',text:'hello'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
 try{await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  const submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
  rpc.assertPermissionProfileAvailable=async()=>{resumes++;await new Promise(r=>release=r);};
  const first=service.handle({action:'submit',lease_ms:120000,request_id:'s',submission,input});await expect.poll(()=>resumes).toBe(1);
  store.ensure({...binding,engine:{...binding.engine,kind:'device',agent:'codex',adapter_version:1}},'second','/fixture/workspace');store.beginThread('second');store.attachThread('second','second-native',null);
  await expect(service.handle({action:'submit',lease_ms:120000,request_id:'s2',submission:{...submission,submission_id:'other',session_id:'second'},input})).rejects.toThrow(/capacity/i);
  release({id:'native'});await first;
 }finally{db.close();}
});
test('expired lease requests native interruption and cannot be revived by stale renewal',async()=>{
 vi.useFakeTimers();const db=new Database(':memory:'),store=new CodexSessionStore(db),stops:any[]=[],rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn'}),interruptTurn:async(p:any)=>stops.push(p)};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture'}),input=[{type:'text',text:'once'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
 try{await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  const submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
  await service.handle({action:'submit',request_id:'s',submission,input,lease_ms:100});
  const control={session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
  await expect(service.handle({action:'renew',request_id:'bad',...control,run_id:'foreign',lease_ms:100})).rejects.toThrow();
  await service.handle({action:'renew',request_id:'renew',...control,lease_ms:200});
  await vi.advanceTimersByTimeAsync(120);expect(stops).toEqual([]);await vi.advanceTimersByTimeAsync(100);expect(stops).toEqual([{threadId:'thread',turnId:'turn'}]);
  expect(store.active('session')).toBeDefined();await expect(service.handle({action:'renew',request_id:'late',...control,lease_ms:100})).rejects.toThrow();
  expect(await service.handle({action:'result',request_id:'result',...control})).toMatchObject({result:null});
 }finally{await service.disconnect();db.close();vi.useRealTimers();}
});
test('lease expiry during turn/start retains the late native identity and interrupts it',async()=>{
 vi.useFakeTimers();const db=new Database(':memory:'),store=new CodexSessionStore(db),stops:any[]=[];let release!:(v:any)=>void;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:()=>new Promise(r=>release=r),interruptTurn:async(p:any)=>stops.push(p)};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture'}),input=[{type:'text',text:'once'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
 try{await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
  const pending=service.handle({action:'submit',request_id:'s',submission:{submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input,lease_ms:100});
  await vi.advanceTimersByTimeAsync(110);expect(release).toBeTypeOf('function');release({id:'late-turn'});await expect(pending).rejects.toThrow(/authority expired/i);
  expect(stops).toContainEqual({threadId:'thread',turnId:'late-turn'});expect(store.active('session')).toMatchObject({turn_id:'late-turn',status:'unknown'});
 }finally{await service.disconnect();db.close();vi.useRealTimers();}
});
