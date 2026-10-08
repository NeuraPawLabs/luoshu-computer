import {expect,test} from 'vitest';
import * as protocol from '../src/index.js';

test('conversation title updates are trimmed, versioned and strict metadata',()=>{
 expect(protocol.conversationTitleUpdateSchema.parse({title:' 公司研究 ',expected_version:0})).toEqual({title:'公司研究',expected_version:0});
 for(const invalid of [{title:' ',expected_version:0},{title:'x'.repeat(121),expected_version:0},{title:'topic',expected_version:-1},{title:'topic',expected_version:1.2},{title:'topic'},{title:'topic',expected_version:0,owner_id:'alice'},{title:'topic',expected_version:0,path:'/tmp'}]){
  expect(protocol.conversationTitleUpdateSchema.safeParse(invalid).success).toBe(false);
 }
});

test('conversation title results distinguish strict success and failure receipts',()=>{
 for(const result of [{success:true,updated:true,title:'公司研究',version:1},{success:true,updated:false,title:'Manual title',version:2},{success:false,error:'Stale title version'}])expect(protocol.engineTitleResultSchema.safeParse(result).success).toBe(true);
 for(const invalid of [{success:true,title:'topic',version:1},{success:true,updated:true,title:'topic',version:-1},{success:true,updated:true,title:'topic',version:1.2},{success:false,error:3},{success:false,error:'denied',owner_id:'alice'},{success:true,updated:true,title:'topic',version:1,path:'/tmp'}])expect(protocol.engineTitleResultSchema.safeParse(invalid).success).toBe(false);
});

test('native title tool only accepts title metadata and explains ordinary-turn naming',()=>{
 const tools=protocol.nativeTitleTools();
 expect(tools).toHaveLength(1);
 expect(tools[0]).toMatchObject({type:'function',name:'luoshu_conversation_title',inputSchema:{type:'object',additionalProperties:false,required:['title','expected_version']}});
 expect(tools[0].description).toMatch(/substantive topic/i);
 expect(tools[0].description).toMatch(/metadata only/i);
 expect(tools[0].description).toMatch(/already-needed work calls/i);
 expect(tools[0].description).toMatch(/separate naming turn/i);
 expect(protocol.parseNativeTitleTool('luoshu_conversation_title',{title:' topic ',expected_version:0})).toEqual({title:'topic',expected_version:0});
 expect(()=>protocol.parseNativeTitleTool('luoshu_task_create',{title:'topic',expected_version:0})).toThrow(/unsupported/i);
 for(const extra of [{owner_id:'alice'},{path:'/tmp'},{conversation_id:'room'},{action:'create'}])expect(()=>protocol.parseNativeTitleTool('luoshu_conversation_title',{title:'topic',expected_version:0,...extra})).toThrow();
});

test('title requests append to the event union without changing reply result schemas',()=>{
 const event={kind:'conversation.title.request',request_id:'native-call',update:{title:'公司研究',expected_version:1}};
 expect(protocol.engineEventPayloadSchema.safeParse(event).success).toBe(true);
 expect(protocol.engineEventPayloadSchema.options[1].shape.kind.value).toBe('reply.final');
 for(const invalid of [{...event,request_id:''},{...event,update:{...event.update,expected_version:-1}},{...event,owner_id:'alice'}])expect(protocol.engineEventPayloadSchema.safeParse(invalid).success).toBe(false);
});

test('title response wire requires every control identity and exact result receipt',()=>{
 const control={request_id:'request',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,turn_id:'native-turn',call_id:'native-call'};
 const request={action:'title_response',...control,result:{success:true,updated:true,title:'公司研究',version:2}};
 expect(protocol.engineWireRequestSchema.safeParse(request).success).toBe(true);
 expect(protocol.engineWireResponseSchema.safeParse({action:'title_response',...control}).success).toBe(true);
 for(const field of Object.keys(control)){
  const missing={...request} as Record<string,unknown>;delete missing[field];
  expect(protocol.engineWireRequestSchema.safeParse(missing).success).toBe(false);
 }
 for(const extra of [{owner_id:'alice'},{path:'/tmp'},{thread_id:'caller-thread'}])expect(protocol.engineWireRequestSchema.safeParse({...request,...extra}).success).toBe(false);
 expect(protocol.engineWireResponseSchema.safeParse(request).success).toBe(false);
});
