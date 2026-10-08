import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {engineWireMessageSchema} from '@luoshu/protocol';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/codex-session.js';
import {withNativePolicy} from './helpers/native-policy.js';

async function fixture(steer?: (params:any)=>Promise<{turnId:string}>){
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[],calls:any[]=[];
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>{calls.push('turn/start');return{id:'turn'};},interruptTurn:async()=>{},steerTurn:async(params:any)=>{calls.push(['turn/steer',params]);return steer?steer(params):{turnId:params.expectedTurnId};}};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc) as any,{workspacePath:async()=>'/fixture',emit:event=>events.push(event)});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'hello'}];
 await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
 await service.handle({action:'submit',request_id:'submit',lease_ms:120000,submission:{submission_id:'submission',session_id:'session',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
 const control={request_id:'inspect',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
 return{db,store,service,rpc,events,calls,control,close:async()=>{await service.disconnect();db.close();}};
}
const item={id:'question-item',type:'agentMessage',phase:'commentary',text:'选择目录。',questions:[{title:'目录',options:['src','tests']}]};
const complete=(service:CodexEngineService)=>service.notification('item/completed',{threadId:'thread',turnId:'turn',item});

test('live message questions remain nonblocking through native progress and service awaits exact steer acknowledgement',async()=>{
 let acknowledge!:(value:{turnId:string})=>void;
 const f=await fixture(()=>new Promise(resolve=>acknowledge=resolve));
 try{
  complete(f.service);complete(f.service);
  f.service.notification('item/started',{threadId:'thread',turnId:'turn',item:{id:'continued',type:'agentMessage',phase:'commentary',text:''}});
  f.service.notification('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'continued',delta:'继续处理中。'});
  const prompts=f.events.filter(e=>e.event.kind==='waiting_input');expect(prompts).toHaveLength(1);expect(prompts[0].event.is_blocking).toBe(false);
  const before=await f.service.handle({action:'inspect',...f.control});expect(before).toMatchObject({state:'running',attached:true,interactions:[prompts[0].event],interaction_outcomes:[]});
  expect(engineWireMessageSchema.safeParse({type:'assistant_engine_response',response:before}).success).toBe(true);
  let responded=false;
  const responding=f.service.handle({action:'interaction_response',...f.control,turn_id:'turn',interaction_id:prompts[0].event.request_id,response:{kind:'input',answers:{'question-item:0':['tests']}}}).then(result=>{responded=true;return result;});
  await expect.poll(()=>Boolean(acknowledge)).toBe(true);expect(responded).toBe(false);expect(f.events.some(e=>e.event.kind==='interaction.resolved')).toBe(false);
  acknowledge({turnId:'turn'});await responding;
  expect(f.calls.filter(call=>call==='turn/start')).toHaveLength(1);expect(f.calls.at(-1)).toMatchObject(['turn/steer',{threadId:'thread',expectedTurnId:'turn'}]);
  expect(await f.service.handle({action:'inspect',...f.control})).toMatchObject({interactions:[],interaction_outcomes:[{request_id:prompts[0].event.request_id,resolution:'answered'}]});
 }finally{await f.close();}
});

test('native request answer stays unconfirmed until cleanup and exact outcome survives terminal inspection without persistence',async()=>{
 const f=await fixture();
 try{
  const request=f.service.serverRequest({id:'native-original',method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'native-question',isBlocking:true,questions:[{id:'native-q',question:'Continue?',options:null}]}});void request.catch(()=>{});
  const prompt=f.events.find(e=>e.event.kind==='waiting_input').event;
  await f.service.handle({action:'interaction_response',...f.control,turn_id:'turn',interaction_id:prompt.request_id,response:{kind:'input',answers:{'native-q':['yes']}}});await expect(request).resolves.toEqual({answers:{'native-q':{answers:['yes']}}});
  expect(await f.service.handle({action:'inspect',...f.control})).toMatchObject({interactions:[],interaction_outcomes:[]});
  f.service.notification('serverRequest/resolved',{threadId:'thread',requestId:'native-original'});
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  expect(await f.service.handle({action:'inspect',...f.control})).toMatchObject({state:'completed',attached:false,interactions:[],interaction_outcomes:[{request_id:prompt.request_id,resolution:'answered'}]});
  for(const table of ['codex_native_sessions','codex_native_submissions'])expect(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(prompt.request_id);
 }finally{await f.close();}
});

test('terminal snapshot message questions never create or resurrect input prompts',async()=>{
 const f=await fixture();
 try{
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[item]}});
  complete(f.service);expect(f.events.some(e=>e.event.kind==='waiting_input')).toBe(false);
  expect(await f.service.handle({action:'inspect',...f.control})).toMatchObject({state:'completed',interactions:[],interaction_outcomes:[]});
 }finally{await f.close();}
});

test('lost message-answer steering becomes unknown and cannot blindly resend',async()=>{
 const f=await fixture(async()=>{throw Object.assign(Error('lost response'),{code:'CODEX_RPC_UNKNOWN'});});
 try{
  complete(f.service);const prompt=f.events.find(e=>e.event.kind==='waiting_input').event;
  const response={action:'interaction_response',...f.control,turn_id:'turn',interaction_id:prompt.request_id,response:{kind:'input',answers:{'question-item:0':['tests']}}};
  await expect(f.service.handle(response)).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
  expect(await f.service.handle({action:'inspect',...f.control})).toMatchObject({state:'unknown',interactions:[],interaction_outcomes:[]});
  await expect(f.service.handle(response)).rejects.toThrow();expect(f.calls.filter(call=>Array.isArray(call)&&call[0]==='turn/steer')).toHaveLength(1);
  expect(f.events.some(e=>e.event.kind==='interaction.resolved'&&e.event.resolution==='answered')).toBe(false);
 }finally{await f.close();}
});

test.each(['live','recovered'])('%s completion journals only the last native authoritative answer',async mode=>{
 const f=await fixture(),first={id:'first',type:'agentMessage',phase:'final_answer',text:'Earlier answer'},last={id:'last',type:'agentMessage',phase:'final_answer',text:'Last answer'},turn={id:'turn',status:'completed',items:[last,first]};
 try{
  if(mode==='live'){
   for(const answer of [first,last])f.service.notification('item/completed',{threadId:'thread',turnId:'turn',item:answer});
   f.service.notification('turn/completed',{threadId:'thread',turn});
  }else{
   f.rpc.readThread=async()=>({thread:{id:'thread',turns:[turn]}});
   await f.service.handle({action:'reconcile',...f.control});
  }
  expect(f.service.result('session','submission')).toMatchObject({status:'completed',replies:[{item_id:'first',text:'Earlier answer'}]});
  expect(f.service.result('session','submission')!.replies).toHaveLength(1);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM codex_native_turn_results').all())).not.toContain('Last answer');
 }finally{await f.close();}
});
