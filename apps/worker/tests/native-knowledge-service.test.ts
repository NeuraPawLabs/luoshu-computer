import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/session-store.js';
import {CodexSessionService} from '../src/agent-engines/codex-session.js';
import {withNativePolicy} from './helpers/native-policy.js';
import type {EngineWireEvent,KnowledgeReadResult} from '@luoshu/protocol';
import type {PreparedNativeCodebases} from '../src/agent-engines/native-codebases.js';

const codebase='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:2,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}};
const control={request_id:'knowledge-receipt',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,turn_id:'turn',call_id:'native-call'};
const page={success:true,value:{snapshot_id:'snapshot',run_id:'run',scopes:[],entries:[],next_offset:null}};
const candidate={success:true,value:{id:'candidate',revision:1,status:'candidate'}};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const business={scope:{kind:'project',id:codebase},entry_id:null,expected_revision:0,title:'Business',summary:'Context',kind:'business',body:'Private context',sources:[]};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(options:{transport?:(event:EngineWireEvent)=>void|Promise<void>;resources?:boolean;capacity?:number}={}){
 const root=await mkdtemp(join(tmpdir(),'native-knowledge-service-')),cwd=join(root,'workspace'),resources=join(root,'resources'),checkout=join(resources,'checkout');await mkdir(join(checkout,'.git'),{recursive:true});await mkdir(cwd);await writeFile(join(checkout,'index.txt'),'Current file');await writeFile(join(checkout,'.git','HEAD'),'a'.repeat(40)+'\n');
 const prepared={assignments:[{id:codebase,root_path:'.',base_commit:'a'.repeat(40)}],workspace:{path:resources,targets:resources,references:resources,codebases:[{id:codebase,alias:'app',access_mode:'write',repository_path:checkout,checkout_path:checkout,base_commit:'a'.repeat(40),branch:'luoshu/feature/run-app',read_isolation:null}]},read:[],write:[checkout]} as PreparedNativeCodebases;
 let resourceLookup:()=>Promise<PreparedNativeCodebases>=async()=>prepared,authorized=true,generation=1;
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:EngineWireEvent[]=[],starts:any[]=[],resumes:any[]=[],turns:any[]=[];
 const native:any={initialize:async()=>({}),startThread:async(params:any)=>{starts.push(params);return{id:'thread'};},resumeThread:async(params:any)=>{resumes.push(params);return{id:'thread'};},startTurn:async(params:any)=>{turns.push(params);return{id:'turn'};},interruptTurn:async()=>{},readThread:async()=>({thread:{id:'thread',turns:[{id:'turn',status:'completed',items:[]}]}})};
 const rpc=withNativePolicy(native),service=new CodexEngineService(store,'worker',()=>rpc,{workspacePath:async()=>cwd,emit:event=>{events.push(event);return options.transport?.(event);},authorized:()=>authorized,generation:()=>generation,capacity:()=>options.capacity??1,...(options.resources?{codebases:{prepared:async()=>resourceLookup()} as any}:{})});
 await service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
 const input=[{type:'text',text:JSON.stringify({luoshu_knowledge_context:{snapshot_id:'snapshot',run_id:'run',scopes:[],entries:[]}})}];
 await service.handle({action:'submit',request_id:'submit',lease_ms:120000,submission:{session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:sha(JSON.stringify(input)),task_id:null,task_revision:null,...(options.resources?{codebases:[{id:codebase,alias:'app',access_mode:'write',source:{kind:'local',path:checkout},root_path:'.',default_branch:'main'}]}:{})},input});
 const call=(patch:Record<string,unknown>={},args:unknown={})=>service.serverRequest({id:7,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'native-call',tool:'luoshu_knowledge_list',arguments:args,...patch}}) as Promise<any>;
 return{root,cwd,checkout,prepared,db,store,service,rpc,events,starts,resumes,turns,call,setAuthorized:(value:boolean)=>authorized=value,setGeneration:(value:number)=>generation=value,setLookup:(value:()=>Promise<PreparedNativeCodebases>)=>resourceLookup=value,cleanup:async()=>{authorized=true;generation=1;await service.close();db.close();await rm(root,{recursive:true,force:true});}};
}

test('new native threads register three knowledge tools alongside Task Check and title with one turn',async()=>{
 const f=await fixture();try{
  expect(f.starts[0].dynamicTools.map((tool:any)=>tool.name)).toEqual(expect.arrayContaining(['luoshu_knowledge_list','luoshu_knowledge_read','luoshu_knowledge_propose','luoshu_conversation_title','luoshu_task_create','luoshu_check_begin','luoshu_check_end']));
  expect(f.starts).toHaveLength(1);expect(f.turns).toHaveLength(1);expect(f.turns[0].input[0].text).toContain('luoshu_knowledge_context');
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  const sessions=new CodexSessionService(f.store,()=>f.rpc,{workspacePath:async()=>f.cwd});await sessions.prepare({session_key:'session',binding:binding as any,workspace_id:'workspace'});
  expect(f.resumes).toHaveLength(1);expect(f.resumes[0]).not.toHaveProperty('dynamicTools');expect(f.starts).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('knowledge list metadata preserves execution controls and response acknowledgement excludes results',async()=>{
 const f=await fixture();try{
  const pending=f.call(),duplicate=f.call();await flush();
  expect(f.events).toMatchObject([{session_id:'session',worker_generation:1,source:{conversation_id:'room',agent_id:'agent',actor_id:'alice',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,worker_id:'worker',worker_generation:1,native:{thread_id:'thread',turn_id:'turn',item_id:null}},event:{kind:'knowledge.request',request_id:'native-call',operation:{action:'list',offset:0}}}]);
  const ack={action:'knowledge_response',...control};expect(await f.service.handle({...ack,result:page})).toEqual(ack);
  expect(await pending).toEqual({success:true,contentItems:[{type:'inputText',text:JSON.stringify(page.value)}]});expect(await duplicate).toEqual(await pending);
  expect(await f.service.handle({...ack,result:page})).toEqual(ack);expect(await f.call()).toEqual(await pending);
  await expect(f.service.handle({...ack,result:{success:false,error:'conflicting result'}})).rejects.toThrow(/conflict/i);
  expect(await f.call({}, {offset:2})).toMatchObject({success:false});expect(f.events).toHaveLength(1);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('native knowledge rejects foreign receipt controls and store status without stopping the native turn',async()=>{
 const f=await fixture();try{
  const pending=f.call();await flush();
  for(const patch of [{session_id:'foreign'},{submission_id:'foreign'},{run_id:'foreign'},{authorization_revision:1},{turn_id:'foreign'},{call_id:'foreign'}])await expect(f.service.handle({action:'knowledge_response',...control,result:page,...patch})).rejects.toThrow();
  f.setAuthorized(false);await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow(/authority/i);expect(await f.call({callId:'revoked'})).toMatchObject({success:false});f.setAuthorized(true);
  f.setGeneration(2);await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow(/authority/i);f.setGeneration(1);
  f.store.unknown('submission');expect(await f.call({callId:'unknown'})).toMatchObject({success:false});await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow(/authority/i);
  await f.service.disconnect();expect((await pending).success).toBe(false);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test.each(['throw','reject'] as const)('native knowledge transport %s fails one cached metadata result and leaves Run healthy',async failure=>{
 let attempts=0;const f=await fixture({transport:event=>{if(event.event.kind!=='knowledge.request')return;attempts++;if(failure==='throw')throw Error('offline');return Promise.reject(Error('offline'));}});
 try{
  const pending=f.call(),duplicate=f.call();const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport|unknown/i);expect(await duplicate).toEqual(reply);expect(await f.call()).toEqual(reply);expect(attempts).toBe(1);
  await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow(/conflict/i);
  await f.service.handle({action:'renew',request_id:'renew',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,lease_ms:120000});expect(f.store.submission('submission')?.status).toBe('running');expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test.each(['completed','failed','interrupted','recovered','disconnect','process-loss','interrupt','session-revocation','service-close'] as const)('native knowledge pending calls close on %s and fence late responses',async mode=>{
 const f=await fixture();try{
  const pending=f.call();await flush();
  if(['completed','failed','interrupted'].includes(mode))f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:mode,items:[]}});
  else if(mode==='recovered')await f.service.handle({action:'reconcile',request_id:'reconcile',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2});
  else if(mode==='disconnect')await f.service.disconnect();else if(mode==='process-loss')f.service.nativeConnectionLost();
  else if(mode==='interrupt')await f.service.handle({action:'interrupt',request_id:'interrupt',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:2,turn_id:'turn'});
  else if(mode==='session-revocation')await expect(f.service.handle({action:'session_close',request_id:'close',session_id:'session',binding})).rejects.toThrow(/active|unresolved/i);else await f.service.close();
  const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/unknown/i);
  await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow();
  expect(await f.call({callId:'late'})).toMatchObject({success:false});
 }finally{await f.cleanup();}
});

test('Worker enriches scoped source references and verifies factual reads before returning the body',async()=>{
 const f=await fixture({resources:true});try{
  const proposal={...business,scope:{kind:'codebase',id:codebase},kind:'analysis',sources:[{codebase_id:codebase,path:'index.txt'}]},pending=f.call({tool:'luoshu_knowledge_propose'},proposal);
  await expect.poll(()=>f.events.length).toBe(1);const operation=(f.events[0].event as any).operation;
  expect(operation).toMatchObject({action:'propose',proposal:{sources:[{codebase_id:codebase,path:'index.txt',commit_sha:'a'.repeat(40),content_sha256:sha('Current file')}]}});
  await f.service.handle({action:'knowledge_response',...control,result:candidate});expect((await pending).success).toBe(true);
  const read:KnowledgeReadResult={entry:{id:'entry',revision:1,scope:{kind:'codebase',id:codebase},title:'API',summary:'Summary',kind:'analysis',sources:operation.proposal.sources},body:'Private factual body'};
  const readCall=(id:string)=>f.call({callId:id,tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1});
  const matched=readCall('matched');await flush();await f.service.handle({action:'knowledge_response',...control,call_id:'matched',result:{success:true,value:read}});expect(JSON.parse((await matched).contentItems[0].text)).toEqual(read);
  await writeFile(join(f.checkout,'index.txt'),'Later change');const stale=readCall('stale');await flush();await f.service.handle({action:'knowledge_response',...control,call_id:'stale',result:{success:true,value:read}});expect((await stale).success).toBe(false);expect((await stale).contentItems[0].text).not.toContain(read.body);
  const wrong=readCall('wrong');await flush();await f.service.handle({action:'knowledge_response',...control,call_id:'wrong',result:{success:true,value:{...read,entry:{...read.entry,sources:[{...read.entry.sources[0],codebase_id:foreign}]}}}});expect((await wrong).success).toBe(false);
  const proposedWrong=await f.call({callId:'foreign-proposal',tool:'luoshu_knowledge_propose'},{...proposal,scope:{kind:'project',id:codebase},sources:[{codebase_id:foreign,path:'index.txt'}]});expect(proposedWrong.success).toBe(false);
  const note=f.call({callId:'business',tool:'luoshu_knowledge_propose'},business);await flush();await f.service.handle({action:'knowledge_response',...control,call_id:'business',result:candidate});expect((await note).success).toBe(true);
  expect(f.events.every(event=>event.event.kind==='knowledge.request')).toBe(true);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test.each(['authority','generation','status','disconnect'] as const)('delayed source lookup rechecks native %s and never emits a revoked proposal',async mode=>{
 const f=await fixture({resources:true});try{
  let release!:(resources:PreparedNativeCodebases)=>void,began=false;const waiting=new Promise<PreparedNativeCodebases>(resolve=>release=resolve);f.setLookup(()=>{began=true;return waiting;});
  const pending=f.call({tool:'luoshu_knowledge_propose'},{...business,scope:{kind:'codebase',id:codebase},kind:'analysis',sources:[{codebase_id:codebase,path:'index.txt'}]});
  await flush();expect(began).toBe(true);
  if(mode==='authority')f.setAuthorized(false);else if(mode==='generation')f.setGeneration(2);else if(mode==='status')f.store.unknown('submission');else await f.service.disconnect();release(f.prepared);
  expect((await pending).success).toBe(false);expect(f.events).toEqual([]);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('service shutdown drains a knowledge response whose source verification has not settled',async()=>{
 const f=await fixture({resources:true});let release!:(resources:PreparedNativeCodebases)=>void;
 try{
  let began=false,closed=false,responseState='pending';const waiting=new Promise<PreparedNativeCodebases>(resolve=>release=resolve);f.setLookup(()=>{began=true;return waiting;});
  const read:KnowledgeReadResult={entry:{id:'entry',revision:1,scope:{kind:'codebase',id:codebase},title:'API',summary:'Summary',kind:'analysis',sources:[{codebase_id:codebase,path:'index.txt',commit_sha:'a'.repeat(40),content_sha256:sha('Current file')}]},body:'Private factual body'};
  const pending=f.call({tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1});await flush();
  const response=f.service.handle({action:'knowledge_response',...control,result:{success:true,value:read}}),responseOutcome=response.then(()=>{responseState='fulfilled';},()=>{responseState='rejected';});await flush();expect(began).toBe(true);
  const closing=f.service.close();void closing.then(()=>{closed=true;});await flush();expect(closed).toBe(true);expect(responseState).not.toBe('pending');await responseOutcome;await closing;
  const reply=await pending;expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/unknown/i);expect(reply.contentItems[0].text).not.toContain(read.body);
  release(f.prepared);await flush();expect(await pending).toEqual(reply);expect(f.turns).toHaveLength(1);
 }finally{release?.(f.prepared);await f.cleanup();}
});

test('closing an active native thread revokes its pending knowledge Task title and interaction authority',async()=>{
 const f=await fixture();try{
  const replies:any[]=[],knowledge=f.call(),title=f.call({callId:'title',tool:'luoshu_conversation_title'},{title:'Topic',expected_version:1}),task=f.call({callId:'task',tool:'luoshu_task_create'},{title:'Task',goal:'Goal'});
  for(const pending of [knowledge,title,task])void pending.then(reply=>{replies.push(reply);});
  let interactionSettled=false;const approval=f.service.serverRequest({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'cmd',command:'check'}}),approvalOutcome=approval.then(()=>{interactionSettled=true;},()=>{interactionSettled=true;});
  await flush();expect(f.events.some(event=>event.event.kind==='knowledge.request')).toBe(true);expect(f.events.some(event=>event.event.kind==='task.request')).toBe(true);expect(f.events.some(event=>event.event.kind==='conversation.title.request')).toBe(true);expect(f.events.some(event=>event.event.kind==='waiting_approval')).toBe(true);
  f.service.notification('thread/closed',{threadId:'thread'});await flush();expect(replies).toHaveLength(3);expect(replies.every(reply=>reply.success===false)).toBe(true);expect(interactionSettled).toBe(true);await approvalOutcome;
  expect(f.store.submission('submission')?.status).toBe('unknown');expect(f.service.result('session','submission')).toBeNull();expect(f.events.filter(event=>event.event.kind==='turn.status')).toMatchObject([{source:{native:{thread_id:'thread',turn_id:'turn'}},event:{kind:'turn.status',state:'unknown'}}]);
  await expect(f.service.handle({action:'knowledge_response',...control,result:page})).rejects.toThrow();await expect(f.service.handle({action:'title_response',...control,call_id:'title',result:{success:true,updated:true,title:'Topic',version:2}})).rejects.toThrow();await expect(f.service.handle({action:'task_response',...control,call_id:'task',result:{success:false,error:'late'}})).rejects.toThrow();
  expect(await f.call({callId:'late'})).toMatchObject({success:false});f.service.notification('thread/closed',{threadId:'thread'});expect(f.events.filter(event=>event.event.kind==='turn.status')).toHaveLength(1);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});

test('active native thread closure leaves unrelated running and terminal threads unchanged',async()=>{
 const f=await fixture({capacity:2});try{
  const interrupted:any[]=[];f.rpc.interruptTurn=async params=>{interrupted.push(params);};f.rpc.startThread=async params=>{f.starts.push(params);return{id:'other-thread'};};f.rpc.startTurn=async params=>{f.turns.push(params);return{id:'other-turn'};};
  await f.service.handle({action:'session_prepare',request_id:'other-prepare',session_id:'other-session',binding,workspace_id:'other-workspace'});
  const input=[{type:'text',text:'Other running chat'}];await f.service.handle({action:'submit',request_id:'other-submit',lease_ms:120000,submission:{session_id:'other-session',submission_id:'other-submission',run_id:'other-run',batch_id:'other-batch',binding,input_message_ids:['other-message'],context_message_ids:[],input_sha256:sha(JSON.stringify(input)),task_id:null,task_revision:null},input});
  const pending=f.call(),other=f.service.serverRequest({id:'other-call',method:'item/tool/call',params:{threadId:'other-thread',turnId:'other-turn',callId:'other-call',tool:'luoshu_knowledge_list',arguments:{}}}) as Promise<any>;let first:any;void pending.then(reply=>{first=reply;});
  f.service.notification('thread/closed',{threadId:'unrelated-stale-thread'});await flush();expect(first).toBeUndefined();expect(f.store.submission('submission')?.status).toBe('running');expect(f.store.submission('other-submission')?.status).toBe('running');
  f.service.notification('thread/closed',{threadId:'thread'});await flush();expect(first?.success).toBe(false);expect(f.store.submission('other-submission')?.status).toBe('running');expect(interrupted).toEqual([]);
  const ack={action:'knowledge_response',...control,session_id:'other-session',submission_id:'other-submission',run_id:'other-run',turn_id:'other-turn',call_id:'other-call'};await f.service.handle({...ack,result:{success:true,value:{...page.value,snapshot_id:'other-snapshot',run_id:'other-run'}}});expect((await other).success).toBe(true);
  f.service.notification('turn/completed',{threadId:'other-thread',turn:{id:'other-turn',status:'completed',items:[]}});const result=f.service.result('other-session','other-submission');f.service.notification('thread/closed',{threadId:'other-thread'});
  expect(f.store.submission('other-submission')?.status).toBe('completed');expect(f.service.result('other-session','other-submission')).toEqual(result);expect(f.events.filter(event=>event.event.kind==='turn.status'&&event.event.state==='unknown')).toHaveLength(1);expect(f.turns).toHaveLength(2);
 }finally{await f.cleanup();}
});

test('native paged knowledge reads preserve continuation fields and verify sources on every page',async()=>{
 const f=await fixture({resources:true});try{
  const entry:KnowledgeReadResult['entry']={id:'entry',revision:1,scope:{kind:'codebase',id:codebase},title:'API',summary:'Summary',kind:'analysis',sources:[{codebase_id:codebase,path:'index.txt',commit_sha:'a'.repeat(40),content_sha256:sha('Current file')}]};
  const first=f.call({callId:'first-page',tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1,body_offset:0});await flush();
  const value={entry,body:'First page',body_offset:0,next_body_offset:10,body_total_chars:21};await f.service.handle({action:'knowledge_response',...control,call_id:'first-page',result:{success:true,value}});expect(JSON.parse((await first).contentItems[0].text)).toEqual(value);
  await writeFile(join(f.checkout,'index.txt'),'Changed between pages');const second=f.call({callId:'second-page',tool:'luoshu_knowledge_read'},{snapshot_id:'snapshot',entry_id:'entry',revision:1,body_offset:10});await flush();
  await f.service.handle({action:'knowledge_response',...control,call_id:'second-page',result:{success:true,value:{entry,body:'Second page',body_offset:10,next_body_offset:null,body_total_chars:21}}});expect((await second).success).toBe(false);expect((await second).contentItems[0].text).not.toContain('Second page');
  expect(f.events.map(event=>(event.event as any).operation)).toEqual([{action:'read',snapshot_id:'snapshot',entry_id:'entry',revision:1,body_offset:0},{action:'read',snapshot_id:'snapshot',entry_id:'entry',revision:1,body_offset:10}]);expect(f.turns).toHaveLength(1);
 }finally{await f.cleanup();}
});
