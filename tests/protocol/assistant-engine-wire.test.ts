import {expect,test} from 'vitest';
import {engineWireMessageSchema} from '../../src/protocol/index.js';

const binding={conversation_id:'11111111-1111-4111-8111-111111111111',agent_id:'22222222-2222-4222-8222-222222222222',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'33333333-3333-4333-8333-333333333333',agent:'codex' as const,adapter_version:1}};
test('binding cleanup is narrowly scoped and echoes its complete immutable binding',()=>{
 const request={action:'session_close',request_id:'r',session_id:'s',binding};
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request}).success).toBe(true);
 for(const extra of [{path:'/home/user'},{thread_id:'user-native-thread'},{delete_history:true}])expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:{...request,...extra}}).success).toBe(false);
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_response',response:{...request,state:'closed'}}).success).toBe(true);
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_response',response:{action:'session_close',request_id:'r',session_id:'s',state:'closed'}}).success).toBe(false);
});
test('wire only accepts constrained assistant-engine actions and event provenance',()=>{
 const request={type:'assistant_engine_request' as const,request:{action:'submit' as const,lease_ms:120000,request_id:'44444444-4444-4444-8444-444444444444',submission:{submission_id:'55555555-5555-4555-8555-555555555555',batch_id:'66666666-6666-4666-8666-666666666666',run_id:'77777777-7777-4777-8777-777777777777',session_id:'88888888-8888-4888-8888-888888888888',binding,input_message_ids:['99999999-9999-4999-8999-999999999999'],context_message_ids:[],input_sha256:'a'.repeat(64),task_id:null,task_revision:null},input:[{type:'text' as const,text:'hello'}]}};
 expect(engineWireMessageSchema.parse(request)).toEqual(request);
 expect(()=>engineWireMessageSchema.parse({...request,type:'assistant_engine_request',request:{...request.request,action:'shell_exec',command:'id'}})).toThrow();
});
test('lease renewal and result retrieval have explicit Run and submission scope',()=>{
 const control={request_id:'request',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2};
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:{action:'renew',...control,lease_ms:120000}}).success).toBe(true);
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:{action:'result',...control}}).success).toBe(true);
 for(const lease of [0,-1,120001])expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:{action:'renew',...control,lease_ms:lease}}).success).toBe(false);
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:{action:'renew',request_id:'request',session_id:'session',lease_ms:120000}}).success).toBe(false);
});
test('interrupt, reconciliation and interaction replies require the same execution scope',()=>{
 const control={request_id:'request',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2};
 for(const action of [{action:'interrupt',turn_id:'turn'},{action:'reconcile'},{action:'interaction_response',turn_id:'turn',interaction_id:'approval',response:{kind:'approval',decision:'deny'}}]){
  const request={...control,...action};
  expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request}).success).toBe(true);
  for(const field of ['submission_id','run_id','authorization_revision']){
   const missing:Record<string,unknown>={...request};delete missing[field];
   expect(engineWireMessageSchema.safeParse({type:'assistant_engine_request',request:missing}).success).toBe(false);
  }
 }
});
test('wire rejects mismatched source worker generation and unknown event fields',()=>{
 const event={type:'assistant_engine_event',event_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',session_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',worker_generation:1,event_sequence:1,source:{conversation_id:binding.conversation_id,agent_id:binding.agent_id,actor_id:'alice',session_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',run_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',submission_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',authorization_revision:1,worker_id:binding.engine.worker_id,worker_generation:1,native:{thread_id:'thread',turn_id:'turn',item_id:null}},event:{kind:'progress',text:'running'}};
 expect(engineWireMessageSchema.parse(event)).toEqual(event);expect(()=>engineWireMessageSchema.parse({...event,extra:true})).toThrow();
 expect(()=>engineWireMessageSchema.parse({...event,worker_generation:2})).toThrow();
 expect(()=>engineWireMessageSchema.parse({...event,session_id:'other'})).toThrow();
 expect(()=>engineWireMessageSchema.parse({...event,source:{...event.source,worker_id:null,worker_generation:null}})).toThrow();
});

test('inspection requires public interaction outcomes alongside unanswered prompts',()=>{
 const response={action:'inspect',request_id:'request',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,native:{thread_id:'thread',turn_id:'turn'},state:'running',attached:true,event_sequence:3,interactions:[{kind:'waiting_input',request_id:'input',is_blocking:false,questions:[{id:'q',text:'Continue?',options:[]}],expires_at:null}],interaction_outcomes:[{request_id:'prior',resolution:'answered'},{request_id:'cleaned',resolution:'dismissed'}]};
 expect(engineWireMessageSchema.parse({type:'assistant_engine_response',response})).toEqual({type:'assistant_engine_response',response});
 const missing={...response} as Record<string,unknown>;delete missing.interaction_outcomes;
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_response',response:missing}).success).toBe(false);
 expect(engineWireMessageSchema.safeParse({type:'assistant_engine_response',response:{...response,interaction_outcomes:[{request_id:'prior',resolution:'unknown'}]}}).success).toBe(false);
});
