import {expect,test} from 'vitest';
import type {EngineTitleResult,EngineTitleUpdate} from '../../src/protocol/index.js';
import type {CodexRpcServerRequest} from '../../src/engines/codex-rpc.js';
import {CodexTitleTools} from '../../src/engines/codex-title-tools.js';

type Reply={success:boolean;contentItems:{type:'inputText';text:string}[]};
interface Bridge {handle:(request:CodexRpcServerRequest)=>Promise<Reply>;respond:(id:string,result:EngineTitleResult)=>void;close:()=>void}
async function bridge(authorized:()=>boolean=()=>true,emit:(id:string,update:EngineTitleUpdate)=>void|Promise<void>=()=>{}){
 return new CodexTitleTools('thread','turn',authorized,emit) as Bridge;
}
const request=(patch:Record<string,unknown>={},argumentsValue:unknown={title:'公司研究',expected_version:1}):CodexRpcServerRequest=>({id:17,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:'luoshu_conversation_title',arguments:argumentsValue,...patch}});
const result:EngineTitleResult={success:true,updated:true,title:'公司研究',version:2};

test('native title calls emit metadata once and replay the same pending and cached receipt',async()=>{
 const emitted:unknown[]=[],tools=await bridge(()=>true,(id,update)=>emitted.push({id,update}));
 const pending=tools.handle(request()),duplicate=tools.handle({...request(),id:99});
 expect(emitted).toEqual([{id:'call',update:{title:'公司研究',expected_version:1}}]);
 tools.respond('call',result);
 const reply={success:true,contentItems:[{type:'inputText',text:JSON.stringify({updated:true,title:'公司研究',version:2})}]};
 expect(await pending).toEqual(reply);expect(await duplicate).toEqual(reply);expect(await tools.handle(request())).toEqual(reply);
 tools.respond('call',{...result});
 expect(()=>tools.respond('call',{...result,updated:false})).toThrow(/conflict/i);
 expect(()=>tools.respond('missing',result)).toThrow(/not found/i);
 expect(await tools.handle(request({}, {title:'Different',expected_version:1}))).toMatchObject({success:false});
 expect(emitted).toHaveLength(1);tools.close();
});

test('native title calls reject foreign identities, namespaces, methods and caller authority',async()=>{
 const emitted:unknown[]=[],tools=await bridge(()=>true,(id,update)=>emitted.push({id,update}));
 for(const patch of [{threadId:'foreign'},{turnId:'foreign'},{callId:''},{callId:'x'.repeat(201)},{namespace:'caller'},{tool:'luoshu_task_create'},{owner_id:'alice'},{path:'/tmp'}])expect(await tools.handle(request(patch))).toMatchObject({success:false});
 expect(await tools.handle({...request(),method:'unscoped/tool/call'})).toMatchObject({success:false});
 for(const args of [{title:' ',expected_version:1},{title:'x'.repeat(121),expected_version:1},{title:'topic',expected_version:-1},{title:'topic',expected_version:1,owner_id:'alice'},{title:'topic',expected_version:1,path:'/tmp'}])expect(await tools.handle(request({},args))).toMatchObject({success:false});
 expect(emitted).toEqual([]);
 const pending=tools.handle(request({namespace:null}));tools.respond('call',{success:false,error:'Stale version'});
 expect(await pending).toEqual({success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:'Stale version'})}]});tools.close();
});

test('native title close resolves pending results as unknown and fences replies and new calls',async()=>{
 const tools=await bridge(),pending=tools.handle(request());tools.close();tools.close();
 expect(await pending).toMatchObject({success:false});expect(JSON.parse((await pending).contentItems[0].text).error).toMatch(/unknown/i);
 expect(()=>tools.respond('call',result)).toThrow(/expired|closed/i);
 expect(await tools.handle(request())).toMatchObject({success:false});
});

test('native title authorization is live and invalid receipts cannot resolve calls',async()=>{
 let authorized=true;const tools=await bridge(()=>authorized),pending=tools.handle(request());
 expect(()=>tools.respond('call',{success:true,updated:true,title:'topic',version:-1})).toThrow();
 authorized=false;expect(()=>tools.respond('call',result)).toThrow(/authority|authorized/i);
 expect(await tools.handle(request({callId:'another'}))).toMatchObject({success:false});tools.close();expect(await pending).toMatchObject({success:false});
});

test('native title transport failure resolves a failure receipt without hanging',async()=>{
 const tools=await bridge(()=>true,()=>{throw Error('offline');});
 const reply=await tools.handle(request());expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport/i);tools.close();
});

test('async native title send rejection resolves duplicates once and fences a late confirmation',async()=>{
 let reject!:(reason:Error)=>void,attempts=0;
 const sent=new Promise<void>((_resolve,r)=>reject=r);void sent.catch(()=>{});
 const tools=await bridge(()=>true,()=>{attempts++;return sent;}),pending=tools.handle(request()),duplicate=tools.handle(request());let reply:Reply|undefined;
 void pending.then(value=>reply=value);
 reject(Error('socket failed'));await new Promise<void>(resolve=>setImmediate(resolve));
 expect(reply?.success).toBe(false);expect(JSON.parse(reply!.contentItems[0].text).error).toMatch(/transport|unknown/i);
 expect(await duplicate).toEqual(reply);expect(await tools.handle(request())).toEqual(reply);expect(attempts).toBe(1);
 expect(()=>tools.respond('call',result)).toThrow(/conflict/i);tools.close();
});

test('native title close settles a call even while its transport never settles',async()=>{
 const tools=await bridge(()=>true,()=>new Promise<void>(()=>{})),pending=tools.handle(request());
 tools.close();const reply=await pending;
 expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/unknown/i);
});

test('a confirmed native title receipt stays authoritative if the transport later rejects',async()=>{
 let reject!:(reason:Error)=>void;
 const sent=new Promise<void>((_resolve,r)=>reject=r),tools=await bridge(()=>true,()=>sent),pending=tools.handle(request());
 tools.respond('call',result);reject(Error('late socket rejection'));
 await new Promise<void>(resolve=>setImmediate(resolve));
 expect((await pending).success).toBe(true);expect(await tools.handle(request())).toEqual(await pending);tools.respond('call',result);tools.close();
});
