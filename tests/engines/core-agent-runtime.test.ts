import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../../src/engines/service.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {nativeApprovalPolicy} from '../../src/engines/codex-policy.js';
import {buildEnvironmentReport} from '../../src/runtime/environment.js';
import {engineWireRequestSchema} from '../../src/protocol/index.js';
import {coreToolConfig} from '../../src/engines/core-tool-config.js';

const binding={role:'core' as const,conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'worker',agent:'codex' as const,adapter_version:1 as const}};
const input=[{type:'text' as const,text:'Decide using the advertised runtime capabilities.'}];
const outputSchema={type:'object',properties:{text:{type:'string'},calls:{type:'array',maxItems:0,items:{type:'object'}}},required:['text','calls'],additionalProperties:false};
const submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null,output_schema:outputSchema};
function fixture(options:{capacity?:()=>number;otherActiveCount?:()=>number}={}){
 const db=new Database(':memory:'),store=new CodexSessionStore(db),events:any[]=[];
 const thread=async(p:any)=>({id:p.threadId??'native',activePermissionProfile:{id:p.permissionScope.id,extends:null},runtimeWorkspaceRoots:p.permissionScope.runtimeWorkspaceRoots,policy:{cwd:p.cwd,model:'fixture',modelProvider:'fixture',reasoningEffort:null,approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
 const rpc:any={initialize:async()=>({}),runtimeExecutable:async()=>'/opt/codex',assertPermissionProfileAvailable:async()=>{},coreThreadConfig:async()=>coreToolConfig({}),startThread:vi.fn(thread),resumeThread:vi.fn(thread),startTurn:vi.fn(async()=>({id:'turn'})),interruptTurn:async()=>{},unsubscribeThread:async()=>({status:'unsubscribed'})};
 const prepareFiles=vi.fn(async()=>{throw Error('Core must not prepare Worker files');});
 const service=new CodexEngineService(store,'worker',()=>rpc,{...options,workspacePath:async()=>'/fixture/workspace',sandboxMode:()=> 'danger-full-access',emit:e=>{events.push(e);},files:{pending:()=>[],activeCount:()=>0,assertSubmissionAllowed(){},hasIntent:()=>false,prepare:prepareFiles} as any});
 return{db,store,rpc,service,events,prepareFiles,prepare:()=>service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace',developer_instructions:'Core instructions'}),submit:()=>service.handle({action:'submit',request_id:'submit',submission,input,lease_ms:120000}),close:async()=>{await service.close();db.close();}};
}
test('ready devices advertise the Core runtime; failed audits never advertise it',async()=>{
 for(const status of ['ready','permissions_unavailable'] as const){
  const report=await buildEnvironmentReport({name:'fixture',capacity:1,probe:async tool=>tool==='codex'?'codex 0.162.1':undefined,supervisorAvailable:async()=>true,nativeAudit:async()=>status});
  expect(report.assistant_engines?.[0].features.includes('core_agent_runtime' as never)).toBe(status==='ready');
 }
});
test('Core wire requests accept roles, output schemas and full Core instructions',()=>{
 expect(engineWireRequestSchema.safeParse({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace',developer_instructions:'x'.repeat(64000)}).success).toBe(true);
 expect(engineWireRequestSchema.safeParse({action:'submit',request_id:'submit',submission,input,lease_ms:120000}).success).toBe(true);
 expect(engineWireRequestSchema.safeParse({action:'submit',request_id:'submit',submission:{...submission,output_schema:undefined},input,lease_ms:120000}).success).toBe(false);
 expect(engineWireRequestSchema.safeParse({action:'submit',request_id:'submit',submission:{...submission,binding:{...binding,role:'worker'}},input,lease_ms:120000}).success).toBe(false);
});
test('Core uses read-only permissions and no native Worker tools even in full-access device mode',async()=>{
 const f=fixture();try{
  await f.prepare();const p=f.rpc.startThread.mock.calls[0][0];
  expect(p.dynamicTools).toEqual([]);expect(p.permissionScope.config.network.enabled).toBe(false);
  expect(Object.values(p.permissionScope.config.filesystem)).not.toContain('write');
  expect(p.config).toMatchObject({'features.shell_tool':false,'features.apps':false,'features.plugins':false,web_search:'disabled'});
  expect(JSON.parse(f.store.session('session')!.policy_json!).sandbox.type).toBe('readOnly');
 }finally{await f.close();}
});
test('Core passes outputSchema to the native turn without Worker files and persists its structured reply',async()=>{
 const f=fixture();try{
  await f.prepare();await f.submit();
  expect(f.rpc.startTurn.mock.calls[0][0]).toMatchObject({input,outputSchema});expect(f.prepareFiles).not.toHaveBeenCalled();
  const text=JSON.stringify({text:'Answer',calls:[]});
  f.service.notification('turn/completed',{threadId:'native',turn:{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]}});
  expect(f.service.result('session','submission')).toMatchObject({status:'completed',replies:[{text}]});
  await f.submit();expect(f.rpc.startTurn).toHaveBeenCalledTimes(1);
  await expect(f.service.handle({action:'submit',request_id:'changed',submission:{...submission,output_schema:{type:'string'}},input,lease_ms:120000})).rejects.toThrow(/metadata|identity|conflict/i);
 }finally{await f.close();}
});
test.each(['item/tool/call','item/commandExecution/requestApproval','item/permissions/requestApproval','mcpServer/elicitation/request'])('Core rejects native %s without opening a Worker interaction',async method=>{
 const f=fixture();try{
  await f.prepare();await f.submit();
  await expect(f.service.serverRequest({id:'native-request',method,params:{threadId:'native',turnId:'turn',tool:'luoshu_task_create',callId:'call',arguments:{}}})).rejects.toThrow(/Core.*native|native.*Core/i);
  expect(f.events.filter(e=>['task.request','waiting_approval','waiting_input'].includes(e.event.kind))).toEqual([]);
 }finally{await f.close();}
});
test('Core rejects resources and attachments before preparing external work',async()=>{
 const f=fixture();try{
  await expect(f.service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace',resources:{run_id:'run',submission_id:'submission'}})).rejects.toThrow(/Core.*resource/i);
  expect(f.rpc.startThread).not.toHaveBeenCalled();
  await f.prepare();
  await expect(f.service.handle({action:'submit',request_id:'submit',submission,input,input_files:[{name:'input.txt',mime_type:'text/plain',content_base64:'eA=='}],lease_ms:120000})).rejects.toThrow(/Core.*attachment/i);
  expect(f.rpc.startTurn).not.toHaveBeenCalled();expect(f.prepareFiles).not.toHaveBeenCalled();
 }finally{await f.close();}
});
test('Core rejects an effective writable sandbox before a native turn',async()=>{
 const f=fixture();try{
  const real=f.rpc.startThread.getMockImplementation();f.rpc.startThread.mockImplementation(async(p:any)=>({...await real(p),policy:{...((await real(p)).policy),sandbox:{type:'dangerFullAccess',networkAccess:true}}}));
  await expect(f.prepare()).rejects.toThrow(/policy|sandbox|read.only|network/i);expect(f.rpc.startTurn).not.toHaveBeenCalled();
 }finally{await f.close();}
});
test.each(['completed','failed','interrupted'])('Core renewal acknowledges a durable %s result without reopening execution',async status=>{
 const f=fixture();try{
  await f.prepare();await f.submit();
  f.service.notification('turn/completed',{threadId:'native',turn:{id:'turn',status,items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({text:'Answer',calls:[]})}]}});
  const control={request_id:'renew',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1};
  expect(f.store.activeCount()).toBe(0);
  await expect(f.service.handle({action:'renew',...control,lease_ms:120000})).resolves.toEqual({action:'renew',...control});
  const result=await f.service.handle({action:'result',...control,request_id:'result'});
  expect(result).toMatchObject({result:{status:status==='interrupted'?'cancelled':status}});
  expect(f.store.activeCount()).toBe(0);expect(f.rpc.startTurn).toHaveBeenCalledTimes(1);
  await expect(f.service.handle({action:'renew',...control,run_id:'foreign',lease_ms:120000})).rejects.toThrow(/identity/);
 }finally{await f.close();}
});
test('Core capacity refusal explicitly proves no submission started and can be retried after capacity returns',async()=>{
 let occupied=1;const f=fixture({capacity:()=>1,otherActiveCount:()=>occupied});try{
  await f.prepare();
  await expect(f.submit()).rejects.toMatchObject({code:'DEVICE_CORE_CAPACITY_UNAVAILABLE',retryable:true});
  expect(f.store.submission('submission')).toBeUndefined();expect(f.rpc.startTurn).not.toHaveBeenCalled();
  occupied=0;await f.submit();expect(f.rpc.startTurn).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
});
