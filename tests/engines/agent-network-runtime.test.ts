import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../../src/engines/service.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {nativeApprovalPolicy} from '../../src/engines/codex-policy.js';

const binding={role:'main' as const,session_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,device_id:'worker',agent:'codex' as const,adapter_version:1 as const}};
const input=[{type:'text' as const,text:'Decide using the advertised runtime capabilities.'}];
const outputSchema={type:'object',properties:{text:{type:'string'},calls:{type:'array',maxItems:0,items:{type:'object'}}},required:['text','calls'],additionalProperties:false};
const submission={submission_id:'submission',run_id:'run',engine_session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null,output_schema:outputSchema};
function fixture(options:{capacity?:()=>number;otherActiveCount?:()=>number}={}){
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];
 const thread=async(p:any)=>({id:p.threadId??'native',activePermissionProfile:{id:p.permissionScope.id,extends:null},runtimeWorkspaceRoots:p.permissionScope.runtimeWorkspaceRoots,policy:{cwd:p.cwd,model:'fixture',modelProvider:'fixture',reasoningEffort:null,approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'dangerFullAccess',networkAccess:true}}});
 const rpc:any={initialize:async()=>({}),runtimeExecutable:async()=>'/opt/codex',assertPermissionProfileAvailable:async()=>{},startThread:vi.fn(thread),resumeThread:vi.fn(thread),startTurn:vi.fn(async()=>({id:'turn'})),interruptTurn:async()=>{},unsubscribeThread:async()=>({status:'unsubscribed'})};
 const prepareFiles=vi.fn(async()=>({inputs:'/fixture/inputs',outputs:'/fixture/outputs'}));
 const service=new CodexEngineService(store,'worker',()=>rpc,{...options,workspacePath:async()=>'/fixture/workspace',sandboxMode:()=> 'danger-full-access',emit:e=>{events.push(e);},files:{pending:()=>[],activeCount:()=>0,assertSubmissionAllowed(){},hasIntent:()=>false,prepare:prepareFiles} as any});
 return{db,store,rpc,service,events,prepareFiles,prepare:()=>service.handle({action:'session_prepare',request_id:'prepare',engine_session_id:'session',binding,execution_workspace_id:'workspace',developer_instructions:'Core instructions'}),submit:()=>service.handle({action:'submit',request_id:'submit',submission,input,lease_ms:120000}),close:async()=>{await service.close();db.close();}};
}
test.each(['main','subagent'] as const)('native %s keeps local tools and uses the required decision format',async role=>{
 const f=fixture(),target={...binding,role};try{
  await f.service.handle({action:'session_prepare',request_id:'prepare',engine_session_id:'session',binding:target,execution_workspace_id:'workspace'});
  await f.service.handle({action:'submit',request_id:'submit',submission:{...submission,binding:target},input,lease_ms:120000});
  const thread=f.rpc.startThread.mock.calls[0][0];
  expect(thread.dynamicTools.length).toBeGreaterThan(0);
  expect(thread.permissionScope.config.network.enabled).toBe(true);
  expect(f.rpc.startTurn.mock.calls[0][0]).toMatchObject({outputSchema});
  expect(f.prepareFiles).toHaveBeenCalledOnce();
  await f.service.handle({action:'submit',request_id:'replay',submission:{...submission,binding:target},input,lease_ms:120000});
  expect(f.rpc.startTurn).toHaveBeenCalledOnce();
 }finally{await f.close();}
});
test.each(['completed','failed','interrupted'])('native renewal acknowledges a durable %s result without reopening execution',async status=>{
 const f=fixture();try{
  await f.prepare();await f.submit();
  f.service.notification('turn/completed',{threadId:'native',turn:{id:'turn',status,items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({text:'Answer',calls:[]})}]}});
  const control={request_id:'renew',engine_session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
  expect(f.store.activeCount()).toBe(0);
  await expect(f.service.handle({action:'renew',...control,lease_ms:120000})).resolves.toEqual({action:'renew',...control});
  const result=await f.service.handle({action:'result',...control,request_id:'result'});
  expect(result).toMatchObject({result:{status:status==='interrupted'?'cancelled':status}});
  expect(f.store.activeCount()).toBe(0);expect(f.rpc.startTurn).toHaveBeenCalledTimes(1);
  await expect(f.service.handle({action:'renew',...control,run_id:'foreign',lease_ms:120000})).rejects.toThrow(/identity/);
 }finally{await f.close();}
});
test('native Agent capacity refusal explicitly proves no submission started and can be retried after capacity returns',async()=>{
 let occupied=1;const f=fixture({capacity:()=>1,otherActiveCount:()=>occupied});try{
  await f.prepare();
  await expect(f.submit()).rejects.toMatchObject({code:'DEVICE_AGENT_CAPACITY_UNAVAILABLE',retryable:true});
  expect(f.store.submission('submission')).toBeUndefined();expect(f.rpc.startTurn).not.toHaveBeenCalled();
  occupied=0;await f.submit();expect(f.rpc.startTurn).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
});
