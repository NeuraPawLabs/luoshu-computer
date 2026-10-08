import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {WorkerClient} from '../src/client.js';
import {attachAssistantEngine} from '../src/agent-engines/runtime.js';
import {DevelopmentRootPolicy} from '../src/development/root-policy.js';
import {removeCodebaseWorkspace} from '../src/codebase-workspace.js';
import {withNativePolicy} from './helpers/native-policy.js';
import type {EngineWireEvent,EngineSubmission,KnowledgeReadResult} from '@luoshu/protocol';

const exec=promisify(execFile),codebase='11111111-1111-4111-8111-111111111111';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'worker',agent:'codex' as const,adapter_version:1 as const}};
const control={request_id:'receipt',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn'};
async function fixture(access?:'read'|'write',transport?:(event:EngineWireEvent)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'native-knowledge-runtime-')),state=join(root,'state'),source=join(root,'source');await mkdir(state);await mkdir(source);
 const git=async(args:string[],cwd=source)=>(await exec('git',args,{cwd})).stdout.trim();
 await git(['init','-b','main']);await writeFile(join(source,'index.txt'),'Actual source content');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=f@invalid','commit','-m','initial']);const base=await git(['rev-parse','HEAD']);
 const client=new WorkerClient({stateDir:state}),connection=vi.spyOn(client,'assistantEngineConnection','get').mockReturnValue({authenticated:true,generation:1}),events:EngineWireEvent[]=[],starts:any[]=[],turns:any[]=[];
 const sent=vi.spyOn(client,'send').mockImplementation(async packet=>{events.push(packet as EngineWireEvent);await transport?.(packet as EngineWireEvent);});let exited=false;
 const native:any={get hasExited(){return exited;},initialize:async()=>({}),startThread:async(params:any)=>{starts.push(params);return{id:'thread'};},resumeThread:async()=>({id:'thread'}),startTurn:async(params:any)=>{turns.push(params);return{id:'turn'};},interruptTurn:async()=>{},close:async()=>{exited=true;}};
 const engine=attachAssistantEngine({client,stateDir:state,workerId:'worker',rootPolicy:new DevelopmentRootPolicy({roots:[source]}),rpcFactory:()=>withNativePolicy(native)});
 const input=[{type:'text' as const,text:JSON.stringify({luoshu_knowledge_context:{snapshot_id:'snapshot',run_id:'run',scopes:[{kind:'codebase',id:codebase}],entries:[]}})}],submission:EngineSubmission={session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:sha(JSON.stringify(input)),task_id:null,task_revision:null,...(access?{codebases:[{id:codebase,alias:'app',access_mode:access,source:{kind:'local',path:source},root_path:'.',default_branch:'main'}]}:{})};
 let checkout:string|undefined;
 if(access){const prepared=await engine.service.handle({action:'workspace_prepare',request_id:'workspace',workspace_id:'workspace',submission,input_files:[],lease_ms:120000});if(prepared.action!=='workspace_prepare')throw Error('Expected Codebase preparation');checkout=prepared.codebases[0]!.checkout_path;}
 await engine.service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace',...(access?{resources:{run_id:'run',submission_id:'submission'}}:{})});
 await engine.service.handle({action:'submit',request_id:'submit',lease_ms:120000,submission,input});
 const call=(id:string,tool:string,args:unknown)=>engine.service.serverRequest({id,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:id,tool,arguments:args}}) as Promise<any>;
 return{root,source,checkout,git,base,client,engine,events,starts,turns,sent,call,cleanup:async()=>{await engine.close();sent.mockRestore();connection.mockRestore();client.stop();if(checkout)await removeCodebaseWorkspace(checkout);await rm(root,{recursive:true,force:true});}};
}

test.each(['read','write'] as const)('actual daemon wiring enriches %s checkout evidence and returns source-attributed knowledge without a new model turn',async access=>{
 const f=await fixture(access);try{
  const before=await readFile(join(f.checkout!,'index.txt')),proposal={scope:{kind:'codebase',id:codebase},entry_id:null,expected_revision:0,title:'Original documentation',summary:'Source pointer',kind:'reference',body:'',sources:[{codebase_id:codebase,path:'index.txt'}]},pending=f.call('propose','luoshu_knowledge_propose',proposal);
  await expect.poll(()=>f.events.some(event=>event.event.kind==='knowledge.request')).toBe(true);const event=f.events.find(event=>event.event.kind==='knowledge.request')!;
  if(event.event.kind!=='knowledge.request'||event.event.operation.action!=='propose')throw Error('Expected knowledge proposal');const sources=event.event.operation.proposal.sources;
  expect(sources).toEqual([{codebase_id:codebase,path:'index.txt',commit_sha:f.base,content_sha256:sha(before.toString())}]);expect(event.source).toMatchObject({session_id:'session',submission_id:'submission',run_id:'run',worker_id:'worker',native:{thread_id:'thread',turn_id:'turn'}});
  const ack={action:'knowledge_response',...control,call_id:'propose'};expect(await f.engine.service.handle({...ack,result:{success:true,value:{id:'candidate',revision:1,status:'candidate'}}})).toEqual(ack);expect((await pending).success).toBe(true);
  if(access==='write'){await f.git(['-c','user.name=Fixture','-c','user.email=f@invalid','commit','--allow-empty','-m','same source new HEAD'],f.checkout);expect(await f.git(['rev-parse','HEAD'],f.checkout)).not.toBe(f.base);}
  const read:KnowledgeReadResult={entry:{id:'entry',revision:1,scope:{kind:'codebase',id:codebase},title:proposal.title,summary:proposal.summary,kind:'reference',sources},body:''},reading=f.call('read','luoshu_knowledge_read',{snapshot_id:'snapshot',entry_id:'entry',revision:1});
  await f.engine.service.handle({action:'knowledge_response',...control,call_id:'read',result:{success:true,value:read}});expect(JSON.parse((await reading).contentItems[0].text)).toEqual(read);
  expect(await readFile(join(f.checkout!,'index.txt'))).toEqual(before);expect(await readFile(join(f.source,'index.txt'))).toEqual(before);
  if(access==='read')expect((await stat(join(f.checkout!,'index.txt'))).mode&0o222).toBe(0);
  else{
   await writeFile(join(f.checkout!,'index.txt'),'Changed source');const stale=f.call('stale','luoshu_knowledge_read',{snapshot_id:'snapshot',entry_id:'entry',revision:1});await f.engine.service.handle({action:'knowledge_response',...control,call_id:'stale',result:{success:true,value:{...read,entry:{...read.entry,kind:'analysis'},body:'STALE PRIVATE FACT'}}});
   expect((await stale).success).toBe(false);expect((await stale).contentItems[0].text).not.toContain('STALE PRIVATE FACT');expect(f.engine.store.submission('submission')?.status).toBe('running');
  }
  expect(f.events.every(packet=>packet.event.kind==='knowledge.request')).toBe(true);expect(f.starts).toHaveLength(1);expect(f.turns).toHaveLength(1);
  expect(f.starts[0].dynamicTools.map((tool:any)=>tool.name)).toEqual(expect.arrayContaining(['luoshu_knowledge_list','luoshu_knowledge_read','luoshu_knowledge_propose','luoshu_task_create','luoshu_conversation_title']));
 }finally{await f.cleanup();}
});

test('actual daemon send rejection resolves one cached knowledge failure and normal chat stays running without a Codebase',async()=>{
 const f=await fixture(undefined,async()=>{throw Error('socket write rejected');});try{
  const pending=f.call('list','luoshu_knowledge_list',{}),duplicate=f.call('list','luoshu_knowledge_list',{}),reply=await pending;
  expect(reply.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport|unknown/i);expect(await duplicate).toEqual(reply);expect(await f.call('list','luoshu_knowledge_list',{})).toEqual(reply);expect(f.sent).toHaveBeenCalledTimes(1);
  expect(f.events[0]).toMatchObject({event:{kind:'knowledge.request',request_id:'list',operation:{action:'list',offset:0}}});expect(f.engine.store.submission('submission')?.status).toBe('running');expect(f.turns).toHaveLength(1);
  await f.engine.service.handle({action:'renew',request_id:'renew',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,lease_ms:120000});
 }finally{await f.cleanup();}
});
