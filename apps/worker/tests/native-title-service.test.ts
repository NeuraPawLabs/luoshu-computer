import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/session-store.js';
import {withNativePolicy} from './helpers/native-policy.js';
import type {EngineWireEvent} from '@luoshu/protocol';

const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:2,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
const control={request_id:'title-receipt',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,turn_id:'turn',call_id:'native-call'};
const result={success:true,updated:true,title:'公司研究',version:2};
async function fixture(transport?:(event:EngineWireEvent)=>void|Promise<void>){
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[],starts:any[]=[],turns:any[]=[];let authorized=true,generation=1;
 const rpc:any={initialize:async()=>({}),startThread:async(params:any)=>{starts.push(params);return{id:'thread'};},resumeThread:async()=>({id:'thread'}),startTurn:async(params:any)=>{turns.push(params);return{id:'turn'};},interruptTurn:async()=>{},readThread:async()=>({thread:{id:'thread',turns:[{id:'turn',status:'completed',items:[]}]}})};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:event=>{events.push(event);return transport?.(event);},authorized:()=>authorized,generation:()=>generation});
 await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
 const input=[{type:'text',text:JSON.stringify({luoshu_conversation_context:{title_source:'provisional',title_version:1}})}];
 await service.handle({action:'submit',request_id:'submit',lease_ms:120000,submission:{session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
 const call=(patch:Record<string,unknown>={},args:unknown={title:'公司研究',expected_version:1})=>service.serverRequest({id:7,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'native-call',tool:'luoshu_conversation_title',arguments:args,...patch}}) as Promise<any>;
 return{db,store,service,events,starts,turns,call,setAuthorized:(value:boolean)=>authorized=value,setGeneration:(value:number)=>generation=value,cleanup:async()=>{authorized=true;generation=1;await service.close();db.close();}};
}

test('new native threads register title metadata alongside Task and Check without a naming turn',async()=>{
 const f=await fixture();try{
  expect(f.starts[0].dynamicTools.map((tool:any)=>tool.name)).toEqual(expect.arrayContaining(['luoshu_conversation_title','luoshu_task_create','luoshu_check_begin','luoshu_check_end']));
  expect(f.starts).toHaveLength(1);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('native title request and result preserve exact controls and duplicate receipts',async()=>{
 const f=await fixture();try{
  const pending=f.call(),duplicate=f.call();
  expect(f.events).toMatchObject([{session_id:'session',worker_generation:1,source:{conversation_id:'room',agent_id:'agent',actor_id:'alice',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,worker_id:'worker',worker_generation:1,native:{thread_id:'thread',turn_id:'turn',item_id:null}},event:{kind:'conversation.title.request',request_id:'native-call',update:{title:'公司研究',expected_version:1}}}]);
  const ack={action:'title_response',...control};
  expect(await f.service.handle({...ack,result})).toEqual(ack);
  expect(await pending).toEqual({success:true,contentItems:[{type:'inputText',text:JSON.stringify({updated:true,title:'公司研究',version:2})}]});expect(await duplicate).toEqual(await pending);
  expect(await f.service.handle({...ack,result})).toEqual(ack);expect(await f.call()).toEqual(await pending);
  await expect(f.service.handle({...ack,result:{...result,updated:false}})).rejects.toThrow(/conflict/i);
  expect(await f.call({}, {title:'conflict',expected_version:1})).toMatchObject({success:false});
  expect(f.events.filter(e=>e.event.kind==='conversation.title.request')).toHaveLength(1);expect(f.events.some(e=>e.event.kind==='task.request')).toBe(false);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('native title results reject foreign execution controls and live authority changes',async()=>{
 const f=await fixture();try{
  const pending=f.call();
  for(const patch of [{session_id:'foreign'},{submission_id:'foreign'},{run_id:'foreign'},{authorization_revision:1},{turn_id:'foreign'},{call_id:'foreign'}])await expect(f.service.handle({action:'title_response',...control,result,...patch})).rejects.toThrow();
  f.setAuthorized(false);await expect(f.service.handle({action:'title_response',...control,result})).rejects.toThrow(/authority/i);
  f.setAuthorized(true);f.setGeneration(2);await expect(f.service.handle({action:'title_response',...control,result})).rejects.toThrow(/authority/i);
  f.setGeneration(1);await f.service.handle({action:'title_response',...control,result});expect((await pending).success).toBe(true);
 }finally{await f.cleanup();}
});

test.each(['throw','reject'] as const)('native title transport %s resolves one cached failure while the execution lease stays healthy',async failure=>{
 let attempts=0;
 const f=await fixture(event=>{
  if(event.event.kind!=='conversation.title.request')return;
  attempts++;
  if(failure==='throw')throw Error('title send failed');
  const rejected=Promise.reject(Error('title send failed'));void rejected.catch(()=>{});return rejected;
 });
 try{
  let reply:any,duplicateReply:any;
  const pending=f.call(),duplicate=f.call();void pending.then(value=>reply=value);void duplicate.then(value=>duplicateReply=value);
  await f.service.handle({action:'renew',request_id:'healthy-lease',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,lease_ms:120000});
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(reply?.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport|unknown/i);
  expect(duplicateReply).toEqual(reply);expect(await f.call()).toEqual(reply);expect(attempts).toBe(1);
  await expect(f.service.handle({action:'title_response',...control,result})).rejects.toThrow(/conflict/i);
  expect(f.store.submission('submission')?.status).toBe('running');
 }finally{await f.cleanup();}
});

test.each(['completed','failed','interrupted','recovered','disconnect','process-loss','interrupt','session-revocation','service-close'] as const)('native title pending calls close on %s and reject late receipts',async mode=>{
 const f=await fixture();try{
  const pending=f.call();
  if(['completed','failed','interrupted'].includes(mode))f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:mode,items:[]}});
  else if(mode==='recovered')await f.service.handle({action:'reconcile',request_id:'reconcile',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2});
  else if(mode==='disconnect')await f.service.disconnect();
  else if(mode==='process-loss')f.service.nativeConnectionLost();
  else if(mode==='interrupt')await f.service.handle({action:'interrupt',request_id:'interrupt',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,turn_id:'turn'});
  else if(mode==='session-revocation')await expect(f.service.handle({action:'session_close',request_id:'close',session_id:'session',binding})).rejects.toThrow(/active|unresolved/i);
  else await f.service.close();
  const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/unknown/i);
  await expect(f.service.handle({action:'title_response',...control,result})).rejects.toThrow();
 }finally{await f.cleanup();}
});
