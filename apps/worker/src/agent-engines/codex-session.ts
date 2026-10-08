import {createHash} from 'node:crypto';
import type {CodexSandboxMode} from '@luoshu/protocol';
import {nativeTaskTools,nativeCheckTools,nativeTitleTools,nativeKnowledgeTools} from '@luoshu/protocol';
import {validateNativePolicy,nativeApprovalPolicy,nativeApprovalPolicySchema,type NativePolicy} from './codex-policy.js';
import {nativePermissions,nativeWritableRoots} from './native-permissions.js';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {CodexAppServerClient} from './codex-rpc.js';
import {CodexSessionStore,type CodexBinding,type SubmissionRow} from './session-store.js';
export {CodexSessionStore,type CodexBinding} from './session-store.js';
export interface NativeResourceScope {read:string[];write:string[];resourceRoot?:string}
export interface CodexSubmission {session_key:string;binding:CodexBinding;cwd:string;input:{type:string;text:string}[];input_sha256:string;submission_id:string;resources?:NativeResourceScope;prepareResources?:()=>Promise<NativeResourceScope>;prepareInput?:()=>Promise<{type:string;text:string}[]>;assertCurrent?:()=>void}
interface NativeReceipt {thread_id:string;turn_id:string}
const unknown=()=>Object.assign(Error('Codex submission is unresolved; reconcile native state before retrying'),{code:'CODEX_SUBMISSION_UNKNOWN'});

/** One unresolved submission per durable session, independent of connection life. */
export class CodexSessionService {
 private readonly clients=new Map<string,Promise<CodexAppServerClient>>();
 private readonly pending=new Map<string,Promise<NativeReceipt>>();
 private readonly loaded=new Map<string,CodexAppServerClient>();
 get hasClients(){return this.clients.size>0;}
 releaseClients():void{this.clients.clear();this.loaded.clear();}
 threadClosed(threadId:string):void{for(const key of this.loaded.keys())if(this.store.session(key)?.thread_id===threadId)this.loaded.delete(key);}
 async unsubscribe(key:string,assertCurrent:()=>void):Promise<void>{
  assertCurrent();const session=this.store.session(key);
  if(!session?.thread_id){if(session&&session.native_status!=='idle')throw Error('Native thread identity remains unknown');return;}
  const client=await this.client(this.store.binding(key).engine.worker_id,true,assertCurrent);
  await client.unsubscribeThread({threadId:session.thread_id});assertCurrent();this.loaded.delete(key);
 }
 constructor(private readonly store:CodexSessionStore,private readonly rpc:(workerId:string)=>Promise<CodexAppServerClient>|CodexAppServerClient,private readonly workspace:{workspacePath:(id:string,session?:string)=>Promise<string|null>;recoverClient?:(workerId:string)=>Promise<CodexAppServerClient>|CodexAppServerClient;onRecoveredTurn?:(row:SubmissionRow,turn:{id:string;status:string;items?:unknown[];error?:unknown})=>void;sandboxMode?:()=>Promise<CodexSandboxMode>|CodexSandboxMode}={workspacePath:async()=>null}){}
 async assertCurrentRuntime(workerId:string,assertCurrent:()=>void=()=>{}):Promise<void>{
  assertCurrent();const cached=this.clients.get(workerId);if(!cached)return;
  const client=await cached;assertCurrent();await client.runtimeExecutable();assertCurrent();
 }
 private async client(workerId:string,recover=false,assertCurrent:()=>void=()=>{}){
  assertCurrent();
  let value=this.clients.get(workerId);if(!value){value=Promise.resolve().then(()=>this.rpc(workerId));this.clients.set(workerId,value);}
  let client=await value;assertCurrent();
  if(client.isClosed&&recover&&this.workspace.recoverClient){if(this.clients.get(workerId)===value)this.clients.set(workerId,Promise.resolve().then(()=>this.workspace.recoverClient!(workerId)));client=await this.clients.get(workerId)!;}
  assertCurrent();await client.initialize({clientInfo:{name:'luoshu-worker',version:'0.1.5'},capabilities:{experimentalApi:true}});assertCurrent();return client;
 }
 private async loadThread(key:string,client:CodexAppServerClient,submissionId?:string,assertCurrent:()=>void=()=>{},resources?:NativeResourceScope){
  assertCurrent();
  const session=this.store.beginThread(key,submissionId);
  try{
   const saved=session.policy_json?JSON.parse(session.policy_json) as NativePolicy:null;
   if(saved)nativeApprovalPolicySchema.parse(saved.approvalPolicy);
   const runtime=await client.runtimeExecutable();assertCurrent();
   if(saved&&saved.permissions?.runtime!==runtime)throw Error('Native permission scope or runtime changed');
   const clearing=resources&&!resources.resourceRoot&&!resources.read.length&&!resources.write.length&&saved?.permissions.config.filesystem[':workspace_roots'];
   const mode=await this.workspace.sandboxMode?.()??'workspace-write';
   const savedFull=Boolean(saved?.permissions.config.network.enabled&&saved?.permissions.config.filesystem[':root']==='write');
   const modeChanged=saved?((mode==='danger-full-access')!==savedFull):true;
   const permissionScope=clearing?{...saved!.permissions,runtimeWorkspaceRoots:[]}:mode==='danger-full-access'||resources||modeChanged||!saved
    ?nativePermissions({session:key,cwd:session.cwd,runtime,mode,...(resources??{read:[],write:[]})})
    :saved.permissions;
   const changed=Boolean(saved&&!isDeepStrictEqual(saved.permissions,permissionScope));
   await client.assertPermissionProfileAvailable(session.cwd,permissionScope.id);assertCurrent();
   const sameProfile=saved&&permissionScope.id===saved.permissions.id&&isDeepStrictEqual(permissionScope.config,saved.permissions.config);
   if(saved&&sameProfile&&session.thread_id&&this.loaded.get(key)===client){
    // Only runtime roots change. turn/start replaces them atomically before
    // native execution; resuming a loaded thread would keep its old scope.
    const intended=changed?{...saved,permissions:permissionScope,sandbox:{...saved.sandbox,writableRoots:nativeWritableRoots(permissionScope).filter(p=>p!==session.cwd)}}:saved;
    this.store.attachConfiguredThread(key,session.thread_id,session.session_tree_id,intended,changed?saved:undefined);
    return{id:session.thread_id,...(session.session_tree_id?{sessionId:session.session_tree_id}:{}),policy:intended,activePermissionProfile:{id:permissionScope.id,extends:null},runtimeWorkspaceRoots:permissionScope.runtimeWorkspaceRoots};
   }
   const policy={cwd:session.cwd,permissionScope,approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user' as const,developerInstructions:session.developer_instructions,
    ...(saved?{model:saved.model,modelProvider:saved.modelProvider}:{}),config:{...(saved?.reasoningEffort?{model_reasoning_effort:saved.reasoningEffort}:{})}};
   const thread=session.thread_id?await client.resumeThread({threadId:session.thread_id,...policy}):await client.startThread({...policy,serviceName:'luoshu',dynamicTools:[...nativeTaskTools(),...nativeCheckTools(),...nativeTitleTools(),...nativeKnowledgeTools()]});
   const effective=validateNativePolicy({...thread.policy,activePermissionProfile:thread.activePermissionProfile,runtimeWorkspaceRoots:thread.runtimeWorkspaceRoots},session.cwd,permissionScope);
   this.store.attachConfiguredThread(key,thread.id,thread.sessionId??null,effective,changed?saved!:undefined);this.loaded.set(key,client);assertCurrent();return{...thread,policy:effective};
  }catch(error){this.store.unknownThread(key);throw error;}
 }
 async prepare(input:{session_key:string;binding:CodexBinding;workspace_id:string;developer_instructions?:string;resources?:NativeResourceScope},assertCurrent:()=>void=()=>{}):Promise<{thread_id:string;session_tree_id:string|null}>{
  await this.assertCurrentRuntime(input.binding.engine.worker_id,assertCurrent);
  assertCurrent();const cwd=await this.workspace.workspacePath(input.workspace_id,input.session_key);assertCurrent();if(!cwd)throw Error('Codex workspace is unavailable');
  this.store.ensure(input.binding,input.session_key,cwd,input.developer_instructions);
  const thread=await this.loadThread(input.session_key,await this.client(input.binding.engine.worker_id,false,assertCurrent),undefined,assertCurrent,input.resources);
  return{thread_id:thread.id,session_tree_id:thread.sessionId??null};
 }
 async submit(input:CodexSubmission):Promise<NativeReceipt>{
  input.assertCurrent?.();
  if(!/^[a-f0-9]{64}$/.test(input.input_sha256)||createHash('sha256').update(JSON.stringify(input.input)).digest('hex')!==input.input_sha256)throw Error('Codex submission input digest mismatch');
  // Exact journal replays do not execute and must remain available after an
  // installation update. New work checks drift before reserving an intent.
  if(!this.store.submission(input.submission_id))await this.assertCurrentRuntime(input.binding.engine.worker_id,input.assertCurrent);
  input.assertCurrent?.();
  const reserved=this.store.reserve(input.binding,input.session_key,input.cwd,input.submission_id,input.input_sha256);
  if(!reserved.created){
   const pending=this.pending.get(input.submission_id);if(pending)return pending;
   if(reserved.row.status==='unknown'||!reserved.row.turn_id||!reserved.row.thread_id)throw unknown();
   return{thread_id:reserved.row.thread_id,turn_id:reserved.row.turn_id};
  }
  const operation=this.execute(input);this.pending.set(input.submission_id,operation);
  try{return await operation;}finally{this.pending.delete(input.submission_id);}
 }
 private async execute(input:CodexSubmission):Promise<NativeReceipt>{
  const assertCurrent=input.assertCurrent??(()=>{});
  try{
   assertCurrent();
   const nativeInput=input.prepareInput?await input.prepareInput():input.input;
   const resources=input.prepareResources?await input.prepareResources():input.resources??{read:[],write:[]};assertCurrent();
   const client=await this.client(input.binding.engine.worker_id,false,assertCurrent),thread=await this.loadThread(input.session_key,client,input.submission_id,assertCurrent,resources);
   assertCurrent();
   this.store.start(input.submission_id,thread.id);
   const turn=await client.startTurn({threadId:thread.id,input:nativeInput,runtimeWorkspaceRoots:thread.policy.permissions.runtimeWorkspaceRoots,permissions:thread.policy.permissions.id});
   try{assertCurrent();this.store.acknowledge(input.submission_id,thread.id,turn.id);}catch(error){try{this.store.lateAcknowledge(input.submission_id,thread.id,turn.id);}catch{this.store.unknown(input.submission_id);}try{await client.interruptTurn({threadId:thread.id,turnId:turn.id});}catch{/** retain unknown for reconciliation */}throw error;}
   return{thread_id:thread.id,turn_id:turn.id};
  }catch(error){this.store.unknown(input.submission_id);throw error;}
 }
 async interrupt(key:string,turnId:string,assertCurrent:()=>void=()=>{}):Promise<void>{
  assertCurrent();
  const binding=this.store.binding(key),row=this.store.stopping(key,turnId);
  try{const client=await this.client(binding.engine.worker_id,false,assertCurrent);assertCurrent();await client.interruptTurn({threadId:row.thread_id!,turnId});assertCurrent();}catch(error){this.store.unknown(row.submission_id);throw error;}
 }
 async steer(input:{session_key:string;submission_id:string;thread_id:string;turn_id:string;input:Array<{type:'text';text:string}>},assertCurrent:()=>void=()=>{}):Promise<{turnId:string}>{
  const current=()=>{
   assertCurrent();this.store.assertSessionOpen(input.session_key);
   const row=this.store.active(input.session_key),session=this.store.session(input.session_key);
   if(!row||row.status!=='running'||row.submission_id!==input.submission_id||row.thread_id!==input.thread_id||row.turn_id!==input.turn_id||session?.thread_id!==input.thread_id)throw Error('Codex steering scope has no matching active native turn');
  };
  current();const workerId=this.store.binding(input.session_key).engine.worker_id;
  await this.assertCurrentRuntime(workerId,current);
  const client=await this.client(workerId,false,current);current();
  if(this.loaded.get(input.session_key)!==client)throw Error('Codex steering active thread is not loaded');
  try{
   const result=await client.steerTurn({threadId:input.thread_id,expectedTurnId:input.turn_id,input:input.input});
   current();if(result.turnId!==input.turn_id)throw Object.assign(Error('Codex steering turn identity mismatch'),{code:'CODEX_RPC_PROTOCOL_ERROR'});
   return result;
  }catch(error){this.store.unknown(input.submission_id);throw error;}
 }
 async reconcile(key:string,assertCurrent:()=>void=()=>{}):Promise<'idle'|'running'|'unknown'>{
  assertCurrent();
  const session=this.store.session(key);if(!session)throw Error('Codex session is not prepared');
  const row=this.store.active(key);if(!row)return session.native_status==='idle'?'idle':'unknown';
  if(!row.thread_id||!row.turn_id)return 'unknown';
  const client=await this.client(this.store.binding(key).engine.worker_id,true,assertCurrent);assertCurrent();
  const result=await client.readThread({threadId:row.thread_id,includeTurns:true}) as {thread?:{id:string;turns?:{id:string;status:string;items?:unknown[];error?:unknown}[]}};assertCurrent();
  if(result?.thread?.id!==row.thread_id)throw Error('Codex reconciliation thread identity mismatch');
  const turn=result.thread.turns?.find(t=>t.id===row.turn_id);
  if(!turn){this.store.unknown(row.submission_id);return 'unknown';}
  if(turn.status==='inProgress')return 'running';
  if(turn.status==='completed'||turn.status==='failed'||turn.status==='interrupted'){
   this.workspace.onRecoveredTurn?.(row,turn);
   this.store.settle(key,row.thread_id,row.turn_id,turn.status==='interrupted'?'cancelled':turn.status);return 'idle';
  }
  this.store.unknown(row.submission_id);return 'unknown';
 }
 private async terminalClient(key:string,submissionId:string,assertCurrent:()=>void){
  assertCurrent();
  const row=this.store.submission(submissionId),session=this.store.session(key);
  if(!row||row.session_key!==key||!row.thread_id||row.thread_id!==session?.thread_id||!['completed','failed','cancelled'].includes(row.status))throw Error('Native terminal execution required for delivery');
  if(this.store.active(key))throw Error('Native session has another active execution; delivery cannot control it');
  const client=await this.client(this.store.binding(key).engine.worker_id,true,assertCurrent);assertCurrent();
  if(this.loaded.get(key)!==client){
   if(this.store.active(key))throw Error('Native session has another active execution; delivery cannot load it');
   await this.loadThread(key,client,undefined,assertCurrent);
  }
  return{client,threadId:row.thread_id};
 }
 private async backgroundProcesses(client:CodexAppServerClient,threadId:string,assertCurrent:()=>void){
  const pageSchema=z.object({data:z.array(z.object({processId:z.string().min(1),itemId:z.string().min(1)})),nextCursor:z.string().nullable().optional()});
  const processes=new Map<string,{processId:string;itemId:string}>();
  const cursors=new Set<string>();let cursor:string|undefined;
  do{
   assertCurrent();const page=pageSchema.parse(await client.backgroundTerminals({threadId,...(cursor?{cursor}:{})}));assertCurrent();
   for(const process of page.data){if(processes.has(process.processId))throw Error('Native background process identity repeated');processes.set(process.processId,process);}
   cursor=page.nextCursor??undefined;
   if(cursor&&cursors.has(cursor))throw Error('Native background process pagination did not converge');
   if(cursor)cursors.add(cursor);
  }while(cursor);
  return [...processes.values()];
 }
 async assertQuiescent(key:string,submissionId:string,assertCurrent:()=>void=()=>{}):Promise<void>{
  const {client,threadId}=await this.terminalClient(key,submissionId,assertCurrent);
  if((await this.backgroundProcesses(client,threadId,assertCurrent)).length)throw Error('Native background processes are still running; finish or stop them before delivery');
 }
 async assertCheckQuiescent(key:string,submissionId:string,assertCurrent:()=>void){
  assertCurrent();const row=this.store.submission(submissionId),session=this.store.session(key);
  if(row?.session_key!==key||row.status!=='running'||!row.thread_id||row.thread_id!==session?.thread_id||!row.turn_id)throw Error('Native check turn is not active');
  const client=await this.client(this.store.binding(key).engine.worker_id,false,assertCurrent);assertCurrent();
  if(this.loaded.get(key)!==client)throw Error('Native check thread is not loaded');
  if((await this.backgroundProcesses(client,row.thread_id,assertCurrent)).length)throw Error('Native check has active background processes');
 }
 async stopBackground(key:string,submissionId:string,assertCurrent:()=>void=()=>{}):Promise<void>{
  const {client,threadId}=await this.terminalClient(key,submissionId,assertCurrent);
  for(const process of await this.backgroundProcesses(client,threadId,assertCurrent)){
   assertCurrent();
   if(this.store.active(key))throw Error('Native session acquired another execution; background stop denied');
   const result=await client.terminateBackgroundTerminal({threadId,processId:process.processId});
   assertCurrent();
   if(result?.terminated!==true)throw Error('Native background termination is not confirmed');
  }
  if((await this.backgroundProcesses(client,threadId,assertCurrent)).length)throw Error('Native background processes remain; termination is not confirmed');
 }
}
