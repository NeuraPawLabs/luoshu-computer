import {expect,test} from 'vitest';
import type {EngineKnowledgeOperation,EngineKnowledgeResult,KnowledgeReadResult,KnowledgeSource} from '@luoshu/protocol';
import type {CodexRpcServerRequest} from '../src/agent-engines/codex-rpc.js';

type Reply={success:boolean;contentItems:{type:'inputText';text:string}[]};
const codebase='11111111-1111-4111-8111-111111111111';
const source:KnowledgeSource={codebase_id:codebase,path:'src/main.ts',commit_sha:'a'.repeat(40),content_sha256:'b'.repeat(64)};
const proposal={scope:{kind:'codebase' as const,id:codebase},entry_id:null,expected_revision:0,title:'API',summary:'Current API',kind:'analysis' as const,body:'API facts',sources:[{codebase_id:codebase,path:'src/main.ts'}]};
const result:EngineKnowledgeResult={success:true,value:{id:'candidate',revision:1,status:'candidate'}};
const read:KnowledgeReadResult={entry:{id:'entry',revision:1,scope:proposal.scope,title:'API',summary:'Current API',kind:'analysis',sources:[source]},body:'API facts'};
const request=(patch:Record<string,unknown>={},args:unknown=proposal):CodexRpcServerRequest=>({id:17,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:'luoshu_knowledge_propose',arguments:args,...patch}});
async function bridge(options:{authorized?:()=>boolean;emit?:(id:string,operation:EngineKnowledgeOperation)=>void|Promise<void>;enrich?:(refs:typeof proposal.sources)=>Promise<KnowledgeSource[]>;verify?:(value:KnowledgeReadResult)=>Promise<void>}={}){
 const implementation=await import('../src/agent-engines/codex-knowledge-tools.js').catch(()=>null);expect(implementation,'Native knowledge bridge exists').not.toBeNull();
 return new implementation!.CodexKnowledgeTools('thread','turn',options.authorized??(()=>true),options.emit??(()=>{}),{enrich:options.enrich??(async()=>[source]),verify:options.verify??(async()=>{})});
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('native knowledge proposals enrich real sources once and replay pending and cached receipts',async()=>{
 const emitted:unknown[]=[],tools=await bridge({emit:(id,operation)=>{emitted.push({id,operation});}}),pending=tools.handle(request()),duplicate=tools.handle({...request(),id:99});
 await flush();expect(emitted).toEqual([{id:'call',operation:{action:'propose',proposal:{...proposal,sources:[source]}}}]);
 await tools.respond('call',result);expect(await pending).toEqual({success:true,contentItems:[{type:'inputText',text:JSON.stringify(result.value)}]});expect(await duplicate).toEqual(await pending);expect(await tools.handle(request())).toEqual(await pending);
 await tools.respond('call',result);await expect(tools.respond('call',{success:false,error:'conflicting receipt'})).rejects.toThrow(/conflict/i);
 expect(await tools.handle(request({}, {...proposal,title:'Conflict'}))).toMatchObject({success:false});expect(emitted).toHaveLength(1);tools.close();
});

test('native knowledge list works without Codebases and read verifies sources before exposing facts',async()=>{
 const emitted:EngineKnowledgeOperation[]=[],tools=await bridge({emit:(_id,op)=>{emitted.push(op);},enrich:async()=>{throw Error('no Codebases');},verify:async()=>{throw Error('source stale');}});
 const listing=tools.handle(request({tool:'luoshu_knowledge_list'},{}));await flush();expect(emitted).toEqual([{action:'list',offset:0}]);
 const page={snapshot_id:'snapshot',run_id:'run',scopes:[],entries:[],next_offset:null};await tools.respond('call',{success:true,value:page});expect(JSON.parse((await listing).contentItems[0].text)).toEqual(page);
 const pending=tools.handle(request({callId:'read',tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1}));await flush();
 await tools.respond('read',{success:true,value:read});const reply=await pending;expect(reply.success).toBe(false);expect(reply.contentItems[0].text).not.toContain('API facts');expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/source|stale|current/i);
 await tools.respond('read',{success:true,value:read});expect(await tools.handle(request({callId:'read',tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1}))).toEqual(reply);tools.close();
});

test('native knowledge rejects foreign identities, namespace, method, arguments and result shapes',async()=>{
 const emitted:unknown[]=[],tools=await bridge({emit:(...value)=>{emitted.push(value);}});
 for(const patch of [{threadId:'foreign'},{turnId:'foreign'},{callId:''},{callId:'x'.repeat(201)},{namespace:'caller'},{tool:'luoshu_task_create'},{owner_id:'alice'}])expect(await tools.handle(request(patch))).toMatchObject({success:false});
 expect(await tools.handle({...request(),method:'other/tool/call'})).toMatchObject({success:false});
 expect(await tools.handle(request({}, {...proposal,sources:[source]}))).toMatchObject({success:false});expect(emitted).toEqual([]);
 const pending=tools.handle(request());await flush();await expect(tools.respond('call',{success:true,value:read})).rejects.toThrow(/shape|operation|result/i);
 await expect(tools.respond('missing',result)).rejects.toThrow(/not found/i);await tools.respond('call',result);expect((await pending).success).toBe(true);tools.close();
});

test('native knowledge enforces Codebase analysis sources and Project business semantics',async()=>{
 const emitted:unknown[]=[],tools=await bridge({emit:(...value)=>{emitted.push(value);}});
 for(const args of [{...proposal,sources:[]},{...proposal,kind:'reference',body:'must be empty'},{...proposal,sources:[{codebase_id:'22222222-2222-4222-8222-222222222222',path:'src/main.ts'}]},{...proposal,kind:'business',sources:[]}])expect(await tools.handle(request({},args))).toMatchObject({success:false});
 expect(emitted).toEqual([]);const business={...proposal,scope:{kind:'project',id:codebase},kind:'business',sources:[]},pending=tools.handle(request({},business));await flush();
 await tools.respond('call',result);expect((await pending).success).toBe(true);tools.close();
});

test.each(['throw','reject'] as const)('native knowledge transport %s resolves one cached unknown failure',async kind=>{
 let attempts=0;const tools=await bridge({emit:()=>{attempts++;if(kind==='throw')throw Error('offline');return Promise.reject(Error('offline'));}}),pending=tools.handle(request()),duplicate=tools.handle(request());
 const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport|unknown/i);expect(await duplicate).toEqual(reply);expect(await tools.handle(request())).toEqual(reply);expect(attempts).toBe(1);
 await expect(tools.respond('call',result)).rejects.toThrow(/conflict/i);tools.close();
});

test('native knowledge close resolves pending calls even while evidence or transport never settles',async()=>{
 for(const stage of ['evidence','transport']){
  const tools=await bridge({enrich:stage==='evidence'?()=>new Promise(()=>{}):async()=>[source],emit:stage==='transport'?()=>new Promise(()=>{}):()=>{}}),pending=tools.handle(request());
  await flush();tools.close();tools.close();expect((await pending).success).toBe(false);expect(JSON.parse((await pending).contentItems[0].text).error).toMatch(/unknown/i);
  await expect(tools.respond('call',result)).rejects.toThrow(/expired|closed/i);expect(await tools.handle(request())).toMatchObject({success:false});
 }
});

test('native knowledge close settles pending response verification and fences its later completion',async()=>{
 let release!:()=>void,began=false,settled='pending';const verification=new Promise<void>(resolve=>release=resolve),tools=await bridge({verify:()=>{began=true;return verification;}});
 const pending=tools.handle(request({tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1}));await flush();
 const response=tools.respond('call',{success:true,value:read}),outcome=response.then(()=>{settled='fulfilled';},()=>{settled='rejected';});
 try{
  await flush();expect(began).toBe(true);tools.close();await flush();expect(settled).not.toBe('pending');await outcome;
  const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/unknown/i);expect(reply.contentItems[0].text).not.toContain(read.body);
  release();await flush();expect(await pending).toEqual(reply);await expect(tools.respond('call',{success:true,value:read})).rejects.toThrow(/expired|closed/i);
 }finally{release();tools.close();await outcome;}
});

test('native knowledge rechecks authorization after delayed proposal evidence and read verification',async()=>{
 let authorized=true,release!:()=>void,emitted=0;
 const evidence=new Promise<void>(resolve=>release=resolve),tools=await bridge({authorized:()=>authorized,enrich:async()=>{await evidence;return[source];},emit:()=>{emitted++;}}),pending=tools.handle(request());
 authorized=false;release();expect((await pending).success).toBe(false);expect(emitted).toBe(0);tools.close();
 authorized=true;const waiting=new Promise<void>(resolve=>release=resolve),reading=await bridge({authorized:()=>authorized,verify:()=>waiting});
 const readCall=reading.handle(request({tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1}));await flush();const response=reading.respond('call',{success:true,value:read});authorized=false;release();
 await expect(response).rejects.toThrow(/authority|authorized/i);reading.close();expect((await readCall).success).toBe(false);
});

test('native knowledge cached confirmation survives a later transport rejection',async()=>{
 let reject!:(reason:Error)=>void;const transport=new Promise<void>((_resolve,r)=>reject=r),tools=await bridge({emit:()=>transport}),pending=tools.handle(request());
 await flush();await tools.respond('call',result);reject(Error('late rejection'));await flush();expect((await pending).success).toBe(true);expect(await tools.handle(request())).toEqual(await pending);tools.close();
});
