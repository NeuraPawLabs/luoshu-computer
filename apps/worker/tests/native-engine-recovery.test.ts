import {withNativePolicy} from './helpers/native-policy.js';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {CodexSessionStore} from '../src/agent-engines/session-store.js';
import {CodexEngineService} from '../src/agent-engines/service.js';
test('Worker inspection exposes exact original native turn and pending controls without process output',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];let starts=0;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>{starts++;return{id:'turn'};},interruptTurn:async()=>{}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:e=>events.push(e)}),binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}],control={request_id:'inspect',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
 try{
  await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission:{session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const approval=service.serverRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'cmd',command:'check'}});void approval.catch(()=>{});
  const inspection=await service.handle({action:'inspect',...control});
  expect(inspection).toMatchObject({action:'inspect',native:{thread_id:'thread',turn_id:'turn'},state:'running',attached:true,interactions:[{kind:'waiting_approval',request_id:events[0].event.request_id}],event_sequence:1});
  expect(starts).toBe(1);
  await expect(service.handle({action:'inspect',...control,run_id:'foreign'})).rejects.toThrow(/identity/i);
  await service.disconnect();expect(await service.handle({action:'inspect',...control})).toMatchObject({state:'stopping',attached:false,interactions:[]});
 }finally{await service.disconnect();db.close();}
});
test('native process loss invalidates approvals, reports unknown and keeps the durable execution lock',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn'}),interruptTurn:async()=>{}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:e=>events.push(e)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}],control={request_id:'inspect',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
 try{
  await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
  await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission:{session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const approval=service.serverRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'cmd',command:'check'}}),rejected=expect(approval).rejects.toThrow();
  service.nativeConnectionLost();await rejected;
  expect(await service.handle({action:'inspect',...control})).toMatchObject({state:'unknown',attached:false,interactions:[]});
  expect(events.at(-1)).toMatchObject({event:{kind:'turn.status',state:'unknown'}});
  expect(store.activeCount()).toBe(1);expect(store.result('session','submission')).toBeNull();
 }finally{await service.disconnect();db.close();}
});
