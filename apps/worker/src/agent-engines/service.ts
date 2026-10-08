import {engineWireRequestSchema,type EngineWireResponse,type EngineSubmission,type EngineEventPayload,type EngineWireEvent,type CodexSandboxMode,type EngineInteractionOutcome} from '@luoshu/protocol';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {CodexAppServerClient,CodexRpcServerRequest} from './codex-rpc.js';
import {CodexSessionService} from './codex-session.js';
import type {CodexSessionStore} from './codex-session.js';
import {CodexTurnProjection} from './codex-events.js';
import {CodexInteractions} from './codex-interactions.js';
import {CodexTaskTools} from './codex-task-tools.js';
import {CodexTitleTools} from './codex-title-tools.js';
import {CodexKnowledgeTools} from './codex-knowledge-tools.js';
import {NativeKnowledgeSources} from './native-knowledge-sources.js';
import type {NativeRunFiles} from './native-files.js';
import type {NativeCodebases,PreparedNativeCodebases} from './native-codebases.js';
import type {NativeCodebaseReceipt} from '@luoshu/protocol';
import type {NativePolicy} from './codex-policy.js';
import {nativePermissions} from './native-permissions.js';
import {containsDirectory,type DevelopmentRootPolicy} from '../development/root-policy.js';
import {nativeCommandReceipt} from './native-command-receipt.js';
import {NativeCheckWindow} from './native-check-window.js';
import {fingerprintNativeTree} from './native-check-snapshot.js';
import {parseNativeCheckTool,sameCheckTargets,type NativeCheckTarget,type NativeDeliveredCheck} from '@luoshu/protocol';

interface Options {workspacePath:(id:string,session?:string)=>Promise<string|null>;recoverClient?:(workerId:string)=>Promise<CodexAppServerClient>|CodexAppServerClient;unloadIdle?:()=>Promise<boolean>;quiesce?:()=>Promise<void>;files?:NativeRunFiles;codebases?:NativeCodebases;cleanupOwned?:(session:string,current:()=>void)=>Promise<void>;finalizeCleanup?:(session:string)=>void;rootPolicy?:DevelopmentRootPolicy;generation?:()=>number;emit?:(event:EngineWireEvent)=>void|Promise<void>;authorized?:()=>boolean;capacity?:()=>number;otherActiveCount?:()=>number;sandboxMode?:()=>Promise<CodexSandboxMode>|CodexSandboxMode}
interface ActiveTurn {submission:EngineSubmission;threadId:string;turnId:string|null;acknowledged:Promise<void>;releaseAcknowledgement:()=>void;projection:CodexTurnProjection|null;interactions:CodexInteractions|null;taskTools?:CodexTaskTools;titleTools?:CodexTitleTools;knowledgeTools?:CodexKnowledgeTools;checks?:NativeCheckWindow;early:{method:string;params:unknown}[];generation:number;deadline:number;leaseTimer?:ReturnType<typeof setTimeout>;stopped:boolean}

/** Worker-side allowlisted adapter. It is not a generic App Server proxy. */
export class CodexEngineService {
 private epoch=0;
 private closing=false;
 private closed=false;
 private closePromise?:Promise<void>;
 private readonly requests=new Set<Promise<unknown>>();
 private readonly sessionPreparations=new Map<string,Set<Promise<unknown>>>();
 private readonly preparations=new Map<string,Set<Promise<unknown>>>();
 private readonly preparationTimers=new Map<string,ReturnType<typeof setTimeout>>();
 private readonly rootActivities=new Map<string,()=>void>();
 private readonly rootSubmissions=new Map<string,EngineSubmission>();
 private readonly unsubscribeRoots:()=>void;
 private readonly sessions:CodexSessionService;
 private readonly active=new Map<string,ActiveTurn>();
 // Public confirmations only, retained in memory across terminal inspection.
 private readonly interactionReceipts=new Map<string,{sessionId:string;outcomes:EngineInteractionOutcome[]}>();
 private readonly terminalControls=new Map<string,Promise<unknown>>();
 private idleTimer?:ReturnType<typeof setTimeout>;
 private idleRelease?:Promise<boolean>;
 private cleanupBarrier?:Promise<void>;
 private cleanupFailure?:unknown;
 private cleanupQueue:Promise<void>=Promise.resolve();
 private cleanupRequests=0;
 private clearIdleTimer(){if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=undefined;}
 private idleEligible(){return !this.closing&&!this.closed&&!this.requests.size&&!this.active.size&&!this.terminalControls.size&&!this.sessionPreparations.size&&!this.rootActivities.size&&!this.preparationTimers.size&&this.store.canUnload()&&!(this.options.files?.pending().length);}
 private scheduleIdle(){
  this.clearIdleTimer();if(!this.options.unloadIdle||this.idleRelease||!this.sessions.hasClients||!this.idleEligible())return;
  this.idleTimer=setTimeout(()=>{this.idleTimer=undefined;void this.releaseIdle().catch(()=>{/* Failed release fences further admission. */});},60000);this.idleTimer.unref();
 }
 releaseIdle():Promise<boolean>{
  if(this.idleRelease)return this.idleRelease;
  if(!this.options.unloadIdle||!this.sessions.hasClients||!this.idleEligible())return Promise.resolve(false);
  this.clearIdleTimer();
  const work=Promise.resolve().then(async()=>{
   const released=await this.options.unloadIdle!();if(released)this.sessions.releaseClients();return released;
  });this.idleRelease=work;
  void work.then(()=>{if(this.idleRelease===work)this.idleRelease=undefined;},()=>{/* Retain failed fence until service restart. */});
  return work;
 }
 private async terminalControl<T>(session:string,operation:()=>Promise<T>):Promise<T>{
  const previous=this.terminalControls.get(session);
  const current=(previous?previous.catch(()=>undefined):Promise.resolve()).then(operation);
  this.terminalControls.set(session,current);
  try{return await current;}finally{if(this.terminalControls.get(session)===current)this.terminalControls.delete(session);}
 }
 constructor(private readonly store:CodexSessionStore,private readonly workerId:string,rpc:(workerId:string)=>Promise<CodexAppServerClient>|CodexAppServerClient,private readonly options:Options={workspacePath:async()=>null}){
  this.sessions=new CodexSessionService(store,rpc,{...options,sandboxMode:options.sandboxMode,onRecoveredTurn:(row,turn)=>{
   const projection=new CodexTurnProjection(row.thread_id!,row.turn_id!),events=projection.consume('turn/completed',{threadId:row.thread_id,turn});
   const state=events.find(e=>e.kind==='turn.status');if(!state||state.kind!=='turn.status'||!['completed','failed','cancelled'].includes(state.state))throw Error('Native terminal result is unavailable');
   const final=projection.finalReply();
   store.finishResult(row.session_key,row.submission_id,{status:state.state as 'completed'|'failed'|'cancelled',replies:final?[final]:[],reason:state.reason},(turn.items??[]).flatMap(item=>{const receipt=nativeCommandReceipt(row.thread_id!,row.turn_id!,item);return receipt?[receipt]:[];}));
   const active=this.active.get(row.thread_id!);active?.checks?.close();active?.interactions?.close();active?.taskTools?.close();active?.titleTools?.close();active?.knowledgeTools?.close();if(active?.leaseTimer)clearTimeout(active.leaseTimer);this.active.delete(row.thread_id!);
  }});
  this.unsubscribeRoots=options.rootPolicy?.subscribe(()=>{
   const roots=options.rootPolicy!.roots();
   for(const s of this.rootSubmissions.values())if(s.codebases?.some(c=>c.source.kind==='local'&&!roots.some(r=>containsDirectory(r,c.source.kind==='local'?c.source.path:''))))this.stopRevokedRoots(s);
  })??(()=>{});
  for(const identity of options.files?.pending()??[]){
   const s=this.store.metadata(identity.session_id,identity.submission_id);this.reserveRoots(s,true);
   if(!this.store.submission(s.submission_id)){
    if(this.store.preparationState(s)==='cancelling')this.stopRevokedRoots(s);
    else{const deadline=this.store.preparationDeadline(s.submission_id);if(deadline!==null)this.armPreparationLease(s,deadline);}
   }
  }
 }
 private clearPreparationLease(id:string){const timer=this.preparationTimers.get(id);if(timer)clearTimeout(timer);this.preparationTimers.delete(id);}
 private armPreparationLease(s:EngineSubmission,deadline:number){
  this.clearPreparationLease(s.submission_id);
  const expire=()=>{this.clearPreparationLease(s.submission_id);if(!this.store.submission(s.submission_id))this.stopRevokedRoots(s);};
  if(Date.now()>=deadline){expire();return;}
  const timer=setTimeout(expire,deadline-Date.now());timer.unref();this.preparationTimers.set(s.submission_id,timer);
 }
 private assertPreparationAuthority(id:string){
  this.store.assertPreparationAllowed(id);if(this.store.submission(id))return;
  const deadline=this.store.preparationDeadline(id);if(deadline!==null&&Date.now()>=deadline)throw Error('Native preparation lease expired');
 }
 private stopRevokedRoots(s:EngineSubmission){const work=this.stopRootWork(s);this.requests.add(work);void work.catch(()=>{/* Unknown execution remains locked. */}).finally(()=>this.requests.delete(work));}
 private reserveRoots(submission:EngineSubmission,restoring=false){
  if(!this.options.rootPolicy||!submission.codebases?.length||this.rootActivities.has(submission.submission_id))return;
  const paths=submission.codebases.flatMap(c=>c.source.kind==='local'?[c.source.path]:[]);
  const method=restoring?'retainUnresolved':'acquire';
  const release=this.options.rootPolicy[method]('native:'+submission.submission_id,'preparation',paths,()=>this.stopRootWork(submission));
  this.rootActivities.set(submission.submission_id,release);this.rootSubmissions.set(submission.submission_id,submission);
  if(restoring&&paths.some(p=>!this.options.rootPolicy!.roots().some(r=>containsDirectory(r,p))))this.stopRevokedRoots(submission);
 }
 private releaseRoots(id:string){this.rootActivities.get(id)?.();this.rootActivities.delete(id);this.rootSubmissions.delete(id);}
 private async stopRootWork(submission:EngineSubmission){
  const row=this.store.submission(submission.submission_id);
  if(!row){
   this.clearPreparationLease(submission.submission_id);
   this.store.cancelPreparation(submission);
   await this.options.codebases?.cancel({session_id:submission.session_id,run_id:submission.run_id,submission_id:submission.submission_id});
   await Promise.allSettled([...(this.preparations.get(submission.submission_id)??[])]);
   this.options.files?.cancelPreparation({session_id:submission.session_id,run_id:submission.run_id,submission_id:submission.submission_id});
   this.releaseRoots(submission.submission_id);return;
  }
  const active=row.thread_id?this.active.get(row.thread_id):undefined;
  if(active&&active.submission.submission_id===submission.submission_id)await this.stop(active);
  else if(row.turn_id&&!this.store.result(submission.session_id,submission.submission_id))await this.sessions.interrupt(submission.session_id,row.turn_id);
  // Interrupt acknowledgement alone is not quiescence or completed delivery.
 }
 async handle(raw:unknown):Promise<EngineWireResponse>{
  const generation=this.options.generation?.()??1,epoch=this.epoch;
  const assertCurrent=()=>{if(this.closing||this.closed)throw Error('Codex engine is closing');if(this.options.authorized?.()===false||generation!==(this.options.generation?.()??1)||epoch!==this.epoch)throw Error('Codex engine connection authority or generation changed');};
  assertCurrent();if(this.idleRelease)await this.idleRelease;assertCurrent();
  while(this.cleanupBarrier){await this.cleanupBarrier.catch(()=>{});assertCurrent();}
  if(this.cleanupFailure&&engineWireRequestSchema.parse(raw).action!=='session_close')throw this.cleanupFailure;
  this.clearIdleTimer();
  assertCurrent();const request=engineWireRequestSchema.parse(raw),id=request.action==='workspace_prepare'?request.submission.submission_id:request.action==='session_prepare'?request.resources?.submission_id:undefined;
  const preparingSession=request.action==='workspace_prepare'?request.submission.session_id:request.action==='session_prepare'?request.session_id:undefined;
  const closingSession=request.action==='session_close';
  let releaseCleanup:()=>void=()=>{};const previousCleanup=this.cleanupQueue;
  if(closingSession){this.cleanupRequests++;this.cleanupQueue=new Promise<void>(resolve=>releaseCleanup=resolve);}
  const operation=this.executeRequest(request,assertCurrent,closingSession?previousCleanup:undefined);this.requests.add(operation);
  if(preparingSession){const pending=this.sessionPreparations.get(preparingSession)??new Set();pending.add(operation);this.sessionPreparations.set(preparingSession,pending);}
  if(id){const pending=this.preparations.get(id)??new Set();pending.add(operation);this.preparations.set(id,pending);}
  try{const response=await operation;assertCurrent();return response;}finally{this.requests.delete(operation);if(closingSession){this.cleanupRequests--;releaseCleanup();}if(preparingSession){const pending=this.sessionPreparations.get(preparingSession);pending?.delete(operation);if(!pending?.size)this.sessionPreparations.delete(preparingSession);}if(id){const pending=this.preparations.get(id);pending?.delete(operation);if(!pending?.size)this.preparations.delete(id);}this.scheduleIdle();}
 }
 private async executeRequest(raw:unknown,assertCurrent:()=>void,cleanupReady:Promise<void>=Promise.resolve()):Promise<EngineWireResponse>{
  assertCurrent();
  const request=engineWireRequestSchema.parse(raw);
  if(request.action==='session_close'){
   if(request.binding.engine.kind!=='device'||request.binding.engine.worker_id!==this.workerId)throw Error('Foreign Worker binding');
   this.store.revokeSession(request.session_id,{...request.binding,engine:request.binding.engine});
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):undefined;
   // Revoke pending tool/approval handlers before terminalControl yields.
   const stopping=state?this.stop(state):Promise.resolve();
   return cleanupReady.then(()=>this.terminalControl(request.session_id,async()=>{
    await stopping;assertCurrent();if(this.store.closedBinding(request.session_id)?.closed_at!=null)return{...request,state:'closed' as const};
    await Promise.allSettled([...(this.sessionPreparations.get(request.session_id)??[])]);assertCurrent();
    const active=this.store.active(request.session_id);
    if(active)throw Error('Codex session has an active or unresolved native turn');
    if(this.options.files?.pending().some(i=>i.session_id===request.session_id))throw Error('Native delivery or preparation is pending; cleanup cannot discard it');
    if(!this.store.unsubscribed(request.session_id)){
     const threadId=this.store.session(request.session_id)?.thread_id??null;
     await this.sessions.unsubscribe(request.session_id,assertCurrent);assertCurrent();this.store.finishSessionUnsubscribe(request.session_id,threadId);
    }
    const cleanupCurrent=()=>{assertCurrent();if(!this.store.unsubscribed(request.session_id)||this.store.active(request.session_id))throw Error('Native cleanup binding or execution changed');};
    const remove=async()=>{
     cleanupCurrent();await this.options.cleanupOwned?.(request.session_id,cleanupCurrent);cleanupCurrent();
     this.store.finishSessionClose(request.session_id,()=>{cleanupCurrent();this.options.finalizeCleanup?.(request.session_id);cleanupCurrent();});
     for(const [id,value] of this.interactionReceipts)if(value.sessionId===request.session_id)this.interactionReceipts.delete(id);
    };
    if(this.options.cleanupOwned){
     if(!this.options.quiesce)throw Error('Native cleanup quiescence is unavailable');
     if(this.cleanupBarrier||this.requests.size>this.cleanupRequests||this.active.size||this.sessionPreparations.size||this.rootActivities.size||this.preparationTimers.size||!this.store.canUnload(true)||this.options.files?.pending().length)throw Error('Native cleanup quiescence is pending; shared process is busy');
     const work=Promise.resolve().then(async()=>{
      try{await this.options.quiesce!();this.sessions.releaseClients();this.cleanupFailure=undefined;}
      catch(error){this.cleanupFailure=error;throw error;}
      cleanupCurrent();await remove();
     });this.cleanupBarrier=work;
     try{await work;}finally{if(this.cleanupBarrier===work)this.cleanupBarrier=undefined;}
    }else await remove();
    return{...request,state:'closed' as const};
   }));
  }
  if(['session_prepare','workspace_prepare','submit','workspace_renew','renew','task_response','title_response','knowledge_response','interaction_response'].includes(request.action)){
   const session='submission'in request?request.submission.session_id:request.session_id;
   const authority=assertCurrent;assertCurrent=()=>{authority();this.store.assertSessionOpen(session);};assertCurrent();
  }
  if(request.action==='workspace_renew'){
   const s=request.submission;if(s.binding.engine.kind!=='device'||s.binding.engine.worker_id!==this.workerId)throw Error('Native renewal targets another Worker');
   this.armPreparationLease(s,this.store.renewPreparation(s,request.lease_ms));
   return{action:'workspace_renew',request_id:request.request_id,session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id,authorization_revision:s.binding.authorization_revision};
  }
  if(request.action==='workspace_inspect'){
   const s=request.submission;if(s.binding.engine.kind!=='device'||s.binding.engine.worker_id!==this.workerId)throw Error('Native inspection targets another Worker');
   const saved=this.store.preparationState(s),drained=!this.preparations.get(s.submission_id)?.size&&(this.options.files?.preparationCancelled(s.session_id,s.run_id,s.submission_id)??true);
   const session=this.store.session(s.session_id);
   return{action:'workspace_inspect',request_id:request.request_id,session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id,authorization_revision:s.binding.authorization_revision,state:saved==='cancelling'&&drained?'cancelled':saved,session_state:session?.native_status??'missing',native:session?.thread_id?{thread_id:session.thread_id,session_tree_id:session.session_tree_id}:null};
  }
  if(request.action==='workspace_cancel'){
   const s=request.submission;
   if(s.binding.engine.kind!=='device'||s.binding.engine.worker_id!==this.workerId)throw Error('Native cancellation targets another Worker');
   this.store.cancelPreparation(s);
   this.clearPreparationLease(s.submission_id);
   await this.options.codebases?.cancel({session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id});
   await Promise.allSettled([...(this.preparations.get(s.submission_id)??[])]);assertCurrent();
   this.options.files?.cancelPreparation({session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id});
   this.releaseRoots(s.submission_id);
   const session=this.store.session(s.session_id);
   return{action:'workspace_cancel',request_id:request.request_id,session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id,authorization_revision:s.binding.authorization_revision,session_state:session?.native_status??'missing',native:session?.thread_id?{thread_id:session.thread_id,session_tree_id:session.session_tree_id}:null};
  }
  const preparationId=request.action==='workspace_prepare'?request.submission.submission_id:request.action==='session_prepare'?request.resources?.submission_id:undefined;
  if(preparationId){const authority=assertCurrent;assertCurrent=()=>{authority();this.assertPreparationAuthority(preparationId);};assertCurrent();}
  if(request.action==='workspace_prepare'){
   const s=request.submission,binding=s.binding;
   if(binding.engine.kind!=='device'||binding.engine.worker_id!==this.workerId)throw Error('Native preparation targets another Worker');
   if(!s.codebases?.length||!this.options.files||!this.options.codebases)throw Error('Native Codebase preparation is unavailable');
   const hash=s.input_files_sha256,files=request.input_files;
   if(hash?createHash('sha256').update(JSON.stringify(files)).digest('hex')!==hash:files.length>0)throw Error('Native input file digest mismatch');
   if(!this.store.submission(s.submission_id))await this.sessions.assertCurrentRuntime(this.workerId,assertCurrent);
   const cwd=await this.options.workspacePath(request.workspace_id,s.session_id);assertCurrent();if(!cwd)throw Error('Native workspace unavailable');
   this.options.files.assertSubmissionAllowed(s.session_id,s.run_id,s.submission_id);
   const reserved=this.options.files.hasIntent(s.session_id,s.run_id,s.submission_id);
   if(!reserved&&this.store.activeCount()+this.options.files.activeCount()+(this.options.otherActiveCount?.()??0)>=(this.options.capacity?.()??1))throw Error('Worker assistant engine capacity is full');
   this.store.ensure({...binding,engine:binding.engine},s.session_id,cwd,request.developer_instructions);
   this.store.registerSubmission(s);
   if(!this.store.submission(s.submission_id))this.armPreparationLease(s,this.store.renewPreparation(s,request.lease_ms));
   if(!this.options.files.cached(s.session_id,s.run_id,s.submission_id))this.reserveRoots(s);
   const identity={session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id};
   let prepared:PreparedNativeCodebases;
   if(this.store.submission(s.submission_id))prepared=await this.options.codebases.prepared(identity,assertCurrent);
   else{
    await this.options.files.prepare({cwd,...identity,input_files:files});assertCurrent();
    prepared=await this.options.codebases.prepare({...identity,codebases:s.codebases},assertCurrent);
   }
   assertCurrent();
   return{action:'workspace_prepare',request_id:request.request_id,session_id:s.session_id,submission_id:s.submission_id,run_id:s.run_id,authorization_revision:binding.authorization_revision,codebases:prepared.workspace.codebases.map(c=>({codebase_id:c.id,base_commit:c.base_commit,branch:c.branch,checkout_path:c.checkout_path}))};
  }
  if(request.action==='session_inspect'){
   if(request.binding.engine.kind!=='device'||request.binding.engine.worker_id!==this.workerId)throw Error('Foreign Worker binding');
   const session=this.store.session(request.session_id);
   if(session&&!isDeepStrictEqual(this.store.binding(request.session_id),request.binding))throw Error('Native session inspection binding mismatch');
   return{...request,state:session?.native_status??'missing',native:session?.thread_id?{thread_id:session.thread_id,session_tree_id:session.session_tree_id}:null};
  }
   if(request.action==='session_prepare'){
   if(request.binding.engine.kind!=='device'||request.binding.engine.worker_id!==this.workerId)throw Error('Engine request targets another Worker');
   let resources:PreparedNativeCodebases|undefined;
   if(request.resources){
    const metadata=this.store.metadata(request.session_id,request.resources.submission_id);
    if(!isDeepStrictEqual(metadata.binding,request.binding)||metadata.run_id!==request.resources.run_id||!metadata.codebases?.length||!this.options.codebases)throw Error('Native resource preparation identity mismatch');
    resources=await this.options.codebases.prepared({session_id:request.session_id,...request.resources},assertCurrent);assertCurrent();
   }
   const sessionId=request.session_id,binding=request.binding;if(binding.engine.kind!=='device')throw Error('Builtin engine cannot use device transport');const deviceBinding={...binding,engine:binding.engine};const native=await this.sessions.prepare({session_key:sessionId,binding:deviceBinding,workspace_id:request.workspace_id,developer_instructions:request.developer_instructions,...(resources?{resources:{read:resources.read,write:resources.write,resourceRoot:resources.workspace.path}}:{})},assertCurrent);
   return{action:'session_prepare',request_id:request.request_id,session_id:sessionId,native:{thread_id:native.thread_id,session_tree_id:native.session_tree_id}};
  }
  if(request.action==='submit'){
   if(this.preparations.get(request.submission.submission_id)?.size)throw Error('Native workspace preparation is pending');
   if(createHash('sha256').update(JSON.stringify(request.input)).digest('hex')!==request.submission.input_sha256)throw Error('Codex submission input digest mismatch');
   const files=request.input_files??[],filesHash=request.submission.input_files_sha256;
   if(filesHash?createHash('sha256').update(JSON.stringify(files)).digest('hex')!==filesHash:files.length>0)throw Error('Native input file digest mismatch');
   if(files.length&&!this.options.files)throw Error('Native input file service unavailable');
   const binding=request.submission.binding; if(binding.engine.kind!=='device'||binding.engine.worker_id!==this.workerId)throw Error('Engine request targets another Worker');
   const session=this.store.session(request.submission.session_id);if(!session?.thread_id)throw Error('Codex session is not prepared');
   this.options.files?.assertSubmissionAllowed(request.submission.session_id,request.submission.run_id,request.submission.submission_id);
   if(!this.store.submission(request.submission.submission_id)&&!this.options.files?.hasIntent(request.submission.session_id,request.submission.run_id,request.submission.submission_id)&&this.store.activeCount()+(this.options.files?.activeCount()??0)+(this.options.otherActiveCount?.()??0)>=(this.options.capacity?.()??1))throw Error('Worker assistant engine capacity is full');
   this.store.registerSubmission(request.submission);
   if(request.submission.codebases?.length&&!this.store.submission(request.submission.submission_id))this.assertPreparationAuthority(request.submission.submission_id);
   let releaseAcknowledgement!:()=>void;const acknowledged=new Promise<void>(resolve=>releaseAcknowledgement=resolve);
   const state:ActiveTurn={submission:request.submission,threadId:session.thread_id,turnId:null,acknowledged,releaseAcknowledgement,projection:null,interactions:null,early:[],generation:this.options.generation?.()??1,deadline:Date.now()+request.lease_ms,stopped:false};
   const previous=this.active.get(session.thread_id);
   if(previous&&previous.submission.submission_id!==request.submission.submission_id)throw Error('Codex session is active');
   if(!previous&&!this.store.submission(request.submission.submission_id)){this.active.set(session.thread_id,state);this.renewLease(state,request.lease_ms);}
   let result:{thread_id:string;turn_id:string},resources:PreparedNativeCodebases|undefined;
   try{result=await this.sessions.submit({session_key:request.submission.session_id,binding:{...binding,engine:binding.engine},cwd:session.cwd,input:request.input,input_sha256:request.submission.input_sha256,submission_id:request.submission.submission_id,assertCurrent:()=>{assertCurrent();if(state.stopped||Date.now()>=state.deadline)throw Error('Native execution authority expired');},prepareResources:async()=>resources?{read:resources.read,write:resources.write,resourceRoot:resources.workspace.path}:{read:[],write:[]},prepareInput:async()=>{
    if(request.submission.codebases?.length){
     if(!this.options.codebases)throw Error('Native Codebase preparation is unavailable');
     resources=await this.options.codebases.prepared({session_id:request.submission.session_id,submission_id:request.submission.submission_id,run_id:request.submission.run_id},assertCurrent);assertCurrent();
    }
    if(!this.options.files)return request.input;
    const paths=await this.options.files.prepare({cwd:session.cwd,session_id:request.submission.session_id,run_id:request.submission.run_id,submission_id:request.submission.submission_id,input_files:files});
    if(state.stopped||Date.now()>=state.deadline||this.options.authorized?.()===false||state.generation!==(this.options.generation?.()??1))throw Error('Native file preparation authority expired');
    return[{type:'text',text:JSON.stringify({luoshu_run:{run_id:request.submission.run_id,inputs:paths.inputs,input_files:files.map(f=>f.name),outputs:paths.outputs,...(resources?{codebases:resources.workspace.codebases.map(c=>({...c,commit_owner:c.access_mode==='read'?null:resources!.assignments.find(a=>a.id===c.id)!.root_path==='.'?'agent':'worker'}))}:{})},instructions:'Place this Run deliverables under its outputs directory. Subdirectories are supported and delivered as ZIP archives. Do not reuse earlier Run outputs as new deliverables. For Codebases with commit_owner=worker, edit only checkout_path; do not access parent repository metadata or commit. Worker delivery will snapshot those scoped file changes into the assigned branch.'})},...request.input];
   }});}
   catch(error){if(this.store.submission(request.submission.submission_id))this.clearPreparationLease(request.submission.submission_id);state.stopped=true;state.releaseAcknowledgement();if(this.active.get(state.threadId)===state){if(state.leaseTimer)clearTimeout(state.leaseTimer);this.active.delete(state.threadId);}throw error;}
   this.clearPreparationLease(request.submission.submission_id);
   if(this.active.get(state.threadId)===state){
    state.turnId=result.turn_id;state.projection=new CodexTurnProjection(result.thread_id,result.turn_id);
    const interactionAuthorized=()=>!state.stopped&&Date.now()<state.deadline&&this.options.authorized?.()!==false&&this.active.get(state.threadId)===state&&state.generation===(this.options.generation?.()??1);
    state.interactions=new CodexInteractions(result.thread_id,result.turn_id,e=>this.publish(state,e),interactionAuthorized,params=>{
     const current=()=>{assertCurrent();if(!interactionAuthorized())throw Error('Codex interaction steering authority expired');};
     return this.sessions.steer({session_key:state.submission.session_id,submission_id:state.submission.submission_id,thread_id:params.threadId,turn_id:params.expectedTurnId,input:params.input},current);
    });
    state.taskTools=new CodexTaskTools(result.thread_id,result.turn_id,()=>!state.stopped&&Date.now()<state.deadline&&this.options.authorized?.()!==false&&this.active.get(state.threadId)===state&&state.generation===(this.options.generation?.()??1),(id,operation)=>this.publish(state,{kind:'task.request',request_id:id,operation}));
    const titleAuthorized=()=>{
     try{
      assertCurrent();const row=this.store.submission(state.submission.submission_id);
      return interactionAuthorized()&&row?.status==='running'&&row.session_key===state.submission.session_id&&row.thread_id===result.thread_id&&row.turn_id===result.turn_id;
     }catch{return false;}
    };
    state.titleTools=new CodexTitleTools(result.thread_id,result.turn_id,titleAuthorized,(id,update)=>this.publishTitleRequest(state,{kind:'conversation.title.request',request_id:id,update}));
    const knowledgeCurrent=()=>{
     assertCurrent();const session=this.store.session(state.submission.session_id),row=this.store.active(state.submission.session_id);
     if(!titleAuthorized()||session?.thread_id!==result.thread_id||row?.submission_id!==state.submission.submission_id||state.threadId!==result.thread_id||state.turnId!==result.turn_id)throw Error('Native knowledge tool authority expired');
    };
    const knowledgeSources=new NativeKnowledgeSources({current:knowledgeCurrent,codebaseIds:state.submission.codebases?.map(cb=>cb.id)??[],prepared:async()=>{
     knowledgeCurrent();const metadata=this.store.metadata(state.submission.session_id,state.submission.submission_id);
     if(!isDeepStrictEqual(metadata,state.submission)||!metadata.codebases?.length||!this.options.codebases)throw Error('Native knowledge Codebase resource identity unavailable');
     const resources=await this.options.codebases.prepared({session_id:metadata.session_id,submission_id:metadata.submission_id,run_id:metadata.run_id},knowledgeCurrent);knowledgeCurrent();return resources;
    }});
    state.knowledgeTools=new CodexKnowledgeTools(result.thread_id,result.turn_id,()=>{try{knowledgeCurrent();return true;}catch{return false;}},(id,operation)=>this.publishKnowledgeRequest(state,{kind:'knowledge.request',request_id:id,operation}),knowledgeSources);
    const checkCurrent=()=>{assertCurrent();if(state.stopped||Date.now()>=state.deadline||this.active.get(state.threadId)!==state||this.store.submission(state.submission.submission_id)?.status!=='running')throw Error('Native check authority expired');};
    const identity={session_id:state.submission.session_id,submission_id:state.submission.submission_id,run_id:state.submission.run_id};
    state.checks=new NativeCheckWindow({thread:result.thread_id,turn:result.turn_id,assertCurrent:checkCurrent,quiescent:()=>this.sessions.assertCheckQuiescent(identity.session_id,identity.submission_id,checkCurrent),snapshot:()=>this.checkContent(identity,checkCurrent),commands:()=>this.commandReceipts(identity),save:r=>this.store.recordCheck(identity.session_id,identity.submission_id,r)});
    state.releaseAcknowledgement();
    for(const early of state.early)this.notification(early.method,early.params);state.early=[];
    if(state.stopped&&this.active.get(state.threadId)===state)await this.stop(state);
   }
   return{action:'submit',request_id:request.request_id,session_id:request.submission.session_id,turn_id:result.turn_id};
  }
  const metadata=this.store.metadata(request.session_id,request.submission_id);
  if(metadata.run_id!==request.run_id||metadata.binding.authorization_revision!==request.authorization_revision||metadata.binding.engine.kind!=='device'||metadata.binding.engine.worker_id!==this.workerId)throw Error('Codex control request identity mismatch');
  if(request.action==='inspect'){
   const row=this.store.submission(request.submission_id),session=this.store.session(request.session_id);
   if(!row||row.session_key!==request.session_id)throw Error('Native submission identity missing');
   const state=row.thread_id?this.active.get(row.thread_id):null;
   const attached=Boolean(state&&!state.stopped&&Date.now()<state.deadline&&state.submission.submission_id===request.submission_id&&state.generation===(this.options.generation?.()??1)&&state.turnId===row.turn_id);
   return{...request,native:row.thread_id?{thread_id:row.thread_id,turn_id:row.turn_id}:session?.thread_id?{thread_id:session.thread_id,turn_id:null}:null,state:row.status,attached,event_sequence:this.store.eventSequence(row.submission_id),interactions:attached?state!.interactions?.snapshot()??[]:[],interaction_outcomes:structuredClone(this.interactionReceipts.get(row.submission_id)?.outcomes??[])};
  }
  if(request.action==='collect_result'){
   if(!this.options.files||!this.store.result(request.session_id,request.submission_id))throw Error('Native delivery requires a terminal execution and file service');
   const cached=this.options.files.cached(request.session_id,request.run_id,request.submission_id);if(cached)return{...request,delivery:cached};
   return this.terminalControl(request.session_id,async()=>{
    assertCurrent();
    const cached=this.options.files!.cached(request.session_id,request.run_id,request.submission_id);if(cached)return{...request,delivery:cached};
    await this.sessions.assertQuiescent(request.session_id,request.submission_id,assertCurrent);assertCurrent();
    const delivery=await this.options.files!.collect(request.session_id,request.run_id,request.submission_id,assertCurrent);assertCurrent();this.releaseRoots(request.submission_id);return{...request,delivery};
   });
  }
  if(request.action==='renew'||request.action==='result'){
   if(request.action==='result')return{...request,result:this.store.result(request.session_id,request.submission_id)};
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):undefined;
   if(!state||state.stopped||Date.now()>=state.deadline||state.submission.submission_id!==request.submission_id||state.generation!==(this.options.generation?.()??1))throw Error('Codex lease expired or generation changed');
   this.renewLease(state,request.lease_ms);const {lease_ms:_lease,...reply}=request;return reply;
  }
  if(request.action==='interrupt'){
   if(this.store.binding(request.session_id).engine.worker_id!==this.workerId)throw Error('Foreign Worker binding');
   if(this.store.submission(request.submission_id)?.turn_id!==request.turn_id)throw Error('Codex control turn identity mismatch');
   if(this.store.result(request.session_id,request.submission_id)){
    if(!this.options.files)throw Error('Native terminal background control requires delivery ownership');
    if(this.options.files.cached(request.session_id,request.run_id,request.submission_id))return request;
    return this.terminalControl(request.session_id,async()=>{
     assertCurrent();
     if(this.options.files!.cached(request.session_id,request.run_id,request.submission_id))return request;
     this.options.files!.assertSubmissionAllowed(request.session_id,request.run_id,request.submission_id);
     await this.sessions.stopBackground(request.session_id,request.submission_id,assertCurrent);return request;
    });
   }
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):null;
   if(state&&state.submission.submission_id===request.submission_id){state.stopped=true;state.checks?.close();state.releaseAcknowledgement();if(state.leaseTimer)clearTimeout(state.leaseTimer);state.interactions?.close();state.taskTools?.close();state.titleTools?.close();state.knowledgeTools?.close();}
   await this.sessions.interrupt(request.session_id,request.turn_id,assertCurrent);return request;
  }
  if(request.action==='task_response'){
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):null;
   if(!state?.taskTools||state.turnId!==request.turn_id||state.submission.submission_id!==request.submission_id)throw Error('Codex task result has no authorized native call');
   state.taskTools.respond(request.call_id,request.result);const {result:_result,...response}=request;return response;
  }
  if(request.action==='title_response'){
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):null;
   if(!state?.titleTools||state.turnId!==request.turn_id||state.submission.session_id!==request.session_id||state.submission.submission_id!==request.submission_id)throw Error('Codex title result has no authorized native call');
   state.titleTools.respond(request.call_id,request.result);const {result:_result,...response}=request;return response;
  }
  if(request.action==='knowledge_response'){
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):null;
   if(!state?.knowledgeTools||state.turnId!==request.turn_id||state.submission.session_id!==request.session_id||state.submission.submission_id!==request.submission_id)throw Error('Codex knowledge result has no authorized native call');
   if(request.result.success&&'run_id'in request.result.value&&request.result.value.run_id!==state.submission.run_id)throw Error('Codex knowledge page Run identity mismatch');
   await state.knowledgeTools.respond(request.call_id,request.result);assertCurrent();const {result:_result,...response}=request;return response;
  }
  if(request.action==='interaction_response'){
   const session=this.store.session(request.session_id),state=session?.thread_id?this.active.get(session.thread_id):null;
   if(!state?.interactions||state.turnId!==request.turn_id||state.submission.session_id!==request.session_id||state.submission.submission_id!==request.submission_id)throw Error('Codex interaction has no authorized native request handler');
   await state.interactions.respond(request.interaction_id,request.response);
   const {response:_response,...receipt}=request;return receipt;
  }
  if(this.store.binding(request.session_id).engine.worker_id!==this.workerId)throw Error('Foreign Worker binding');
  const active=this.store.active(request.session_id);if(active&&active.submission_id!==request.submission_id)throw Error('Codex reconciliation targets another submission');
  return{...request,status:await this.sessions.reconcile(request.session_id,assertCurrent)};
 }
 notification(method:string,raw:unknown):void{
  if(this.closed)return;
  if(!raw||typeof raw!=='object')return;const params=raw as Record<string,unknown>;
  if(method==='thread/closed'&&typeof params.threadId==='string'){
   this.sessions.threadClosed(params.threadId);
   const state=this.active.get(params.threadId);
   if(state){
    state.stopped=true;state.releaseAcknowledgement();if(state.leaseTimer)clearTimeout(state.leaseTimer);
    state.checks?.close();state.interactions?.close();state.taskTools?.close();state.titleTools?.close();state.knowledgeTools?.close();
    this.store.unknown(state.submission.submission_id);this.active.delete(state.threadId);
    if(state.turnId)this.publish(state,{kind:'turn.status',state:'unknown',reason:'原生 Agent 线程已关闭，请核对原执行结果'});
    this.scheduleIdle();
   }
   return;
  }
  const state=typeof params.threadId==='string'?this.active.get(params.threadId):undefined;if(!state)return;
  if(!state.turnId){state.early.push({method,params:raw});return;}
  state.checks?.observe(method,raw);
  if(method==='serverRequest/resolved'&&(typeof params.requestId==='string'||typeof params.requestId==='number')){state.interactions?.resolved(params.requestId);return;}
  if(method==='item/completed'&&params.turnId===state.turnId){
   state.interactions?.observeMessageQuestions(params.item);
   const receipt=nativeCommandReceipt(state.threadId,state.turnId,params.item);if(receipt)this.store.recordCommand(state.submission.session_id,state.submission.submission_id,receipt);
  }
  for(const event of state.projection!.consume(method,raw)){
   if(event.kind==='turn.status'&&['completed','failed','cancelled'].includes(event.state)){
    const items=(params.turn as {items?:unknown[]}|undefined)?.items??[];
    const final=state.projection!.finalReply();
    this.store.finishResult(state.submission.session_id,state.submission.submission_id,{status:event.state as 'completed'|'failed'|'cancelled',replies:final?[final]:[],reason:event.reason},items.flatMap(item=>{const receipt=nativeCommandReceipt(state.threadId,state.turnId!,item);return receipt?[receipt]:[];}));
    state.checks?.close();state.interactions?.close();state.taskTools?.close();state.titleTools?.close();state.knowledgeTools?.close();if(state.leaseTimer)clearTimeout(state.leaseTimer);this.active.delete(state.threadId);
   }
   this.publish(state,event);
  }
  this.scheduleIdle();
 }
 async serverRequest(request:CodexRpcServerRequest):Promise<unknown>{
  const params=request.params as {threadId?:string;turnId?:string}|undefined,state=params?.threadId?this.active.get(params.threadId):undefined;
  const tool=(request.params as {tool?:unknown}|undefined)?.tool,knowledge=request.method==='item/tool/call'&&typeof tool==='string'&&tool.startsWith('luoshu_knowledge_');
  if(state&&!state.turnId)await state.acknowledged;
  if(!state?.interactions||state.stopped||this.active.get(state.threadId)!==state||state.turnId!==params?.turnId){
   if(knowledge)return{success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:'Knowledge operation is no longer authorized for this native turn'})}]};
   throw Error('Codex request has no acknowledged authorized turn');
  }
  if(request.method==='item/tool/call'){
   const p=request.params as {tool?:string;callId?:string;arguments?:unknown;namespace?:unknown};
   if(knowledge){
    if(!state.knowledgeTools)return{success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:'Native knowledge bridge unavailable'})}]};
    const work=state.knowledgeTools.handle(request);this.requests.add(work);try{return await work;}finally{this.requests.delete(work);}
   }
   if(p.tool==='luoshu_conversation_title'){
    if(!state.titleTools)throw Error('Native title bridge unavailable');
    return state.titleTools.handle(request);
   }
   if(p.tool?.startsWith('luoshu_check_')){
    const work=(async()=>{
     try{
      if(!state.checks||typeof p.callId!=='string'||!p.callId||p.callId.length>200||p.namespace!=null)throw Error('Native check call identity invalid');
      const op=parseNativeCheckTool(p.tool!,p.arguments),result=op.action==='begin'?await state.checks.begin(p.callId,op.purpose):await state.checks.end(p.callId,op.check_id);
      return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
     }catch{return{success:false,contentItems:[{type:'inputText',text:'Check not recorded: finish other tools, use unchanged authorized content and a current check ID.'}]};}
    })();this.requests.add(work);try{return await work;}finally{this.requests.delete(work);}
   }
   if(!state.taskTools)throw Error('Native task bridge unavailable');
   return state.taskTools.handle(request);
  }
  return state.interactions.handle(request);
 }
 result(sessionId:string,submissionId:string){return this.store.result(sessionId,submissionId);}
 commandReceipts(identity:{session_id:string;run_id:string;submission_id:string}){const metadata=this.store.metadata(identity.session_id,identity.submission_id);if(metadata.run_id!==identity.run_id)throw Error('Native command receipt identity mismatch');return this.store.commandReceipts(identity.session_id,identity.submission_id);}
 private async checkContent(identity:{session_id:string;run_id:string;submission_id:string},current:()=>void):Promise<NativeCheckTarget[]>{
  current();const s=this.store.metadata(identity.session_id,identity.submission_id);if(s.run_id!==identity.run_id||!this.options.files)throw Error('Native check resource identity missing');
  const content:NativeCheckTarget[]=[{kind:'outputs',sha256:await this.options.files.fingerprint(identity,current)}];
  if(s.codebases?.length){
   if(!this.options.codebases)throw Error('Native check Codebase service missing');const prepared=await this.options.codebases.prepared(identity,current);
   for(const cb of prepared.workspace.codebases){current();content.push({kind:'codebase',codebase_id:cb.id,sha256:await fingerprintNativeTree(cb.checkout_path,current)});}
  }
  current();return content;
 }
 async checkEvidence(identity:{session_id:string;run_id:string;submission_id:string},outputSha:string,current:()=>void):Promise<{content:NativeCheckTarget[];checks:NativeDeliveredCheck[]}>{
  const content=await this.checkContent(identity,current);current();if(content.find(t=>t.kind==='outputs')?.sha256!==outputSha)throw Error('Native check output changed before delivery');
  return{content,checks:this.store.checkReceipts(identity.session_id,identity.submission_id).map(c=>({...c,binding:sameCheckTargets(c.after,content)?'current':'changed'}))};
 }
 async codebaseReceipts(identity:{session_id:string;run_id:string;submission_id:string},assertCurrent:()=>void=()=>{}):Promise<NativeCodebaseReceipt[]>{
  assertCurrent();
  const metadata=this.store.metadata(identity.session_id,identity.submission_id);if(metadata.run_id!==identity.run_id)throw Error('Native Codebase receipt identity mismatch');
  if(!metadata.codebases?.length)return[];
  if(!this.options.codebases)throw Error('Native Codebase service unavailable');
  const resources=await this.options.codebases.prepared(identity,assertCurrent);assertCurrent();
  const pinned=this.store.submissionPolicy(identity.submission_id),session=this.store.session(identity.session_id),row=this.store.submission(identity.submission_id);
  const policy=JSON.parse(session?.policy_json??'null') as NativePolicy|null;
  if(!pinned||!policy||pinned.thread_id!==row?.thread_id||pinned.thread_id!==session?.thread_id||!this.store.result(identity.session_id,identity.submission_id)||!isDeepStrictEqual(pinned.policy,policy))throw Error('Native Codebase execution policy evidence differs');
  const fullAccess=Boolean(pinned.policy.permissions.config.network.enabled&&pinned.policy.permissions.config.filesystem[':root']==='write');
  const expected=nativePermissions({session:identity.session_id,cwd:session.cwd,runtime:pinned.policy.permissions.runtime,mode:fullAccess?'danger-full-access':'workspace-write',read:resources.read,write:resources.write,resourceRoot:resources.workspace.path});
  if(!isDeepStrictEqual(expected,pinned.policy.permissions))throw Error('Native Codebase read/write isolation policy differs from prepared scope');
  return this.options.codebases.collect(identity,true,assertCurrent);
 }
 nativeConnectionLost():void{
  if(this.closed)return;this.epoch++;
  for(const state of this.active.values()){
   state.stopped=true;state.releaseAcknowledgement();if(state.leaseTimer)clearTimeout(state.leaseTimer);
   state.checks?.close();state.interactions?.close();state.taskTools?.close();state.titleTools?.close();state.knowledgeTools?.close();
   this.store.unknown(state.submission.submission_id);
   if(state.turnId)this.publish(state,{kind:'turn.status',state:'unknown',reason:'原生 Agent 进程连接已中断，请核对原执行结果'});
  }
  this.active.clear();
 }
 async disconnect():Promise<void>{
  if(this.closed)return;this.epoch++;
  const preparing=(this.options.files?.pending()??[]).filter(i=>!this.store.submission(i.submission_id)).map(i=>this.store.metadata(i.session_id,i.submission_id));
  await Promise.all([...this.active.values()].map(state=>this.stop(state)).concat(preparing.map(s=>this.stopRootWork(s))));
 }
 close():Promise<void>{
  if(this.closePromise)return this.closePromise;
  this.closing=true;this.clearIdleTimer();this.unsubscribeRoots();for(const id of this.preparationTimers.keys())this.clearPreparationLease(id);
  this.closePromise=(async()=>{await this.idleRelease?.catch(()=>{});await this.disconnect();await Promise.allSettled([...this.requests,...this.terminalControls.values()]);this.nativeConnectionLost();for(const id of this.rootActivities.keys())this.releaseRoots(id);this.closed=true;})();
  return this.closePromise;
 }
 private async stop(state:ActiveTurn):Promise<void>{
  state.stopped=true;state.checks?.close();state.releaseAcknowledgement();if(state.leaseTimer)clearTimeout(state.leaseTimer);state.interactions?.close();state.taskTools?.close();state.titleTools?.close();state.knowledgeTools?.close();
  if(state.turnId){try{await this.sessions.interrupt(state.submission.session_id,state.turnId);}catch{this.store.unknown(state.submission.submission_id);}}
  else this.store.unknown(state.submission.submission_id);
 }
 private renewLease(state:ActiveTurn,duration:number){
  if(state.leaseTimer)clearTimeout(state.leaseTimer);state.deadline=Date.now()+duration;
  state.leaseTimer=setTimeout(()=>{void this.stop(state).catch(()=>this.store.unknown(state.submission.submission_id));},duration);state.leaseTimer.unref();
 }
 private publish(state:ActiveTurn,event:EngineEventPayload){
  if(event.kind==='interaction.resolved'){
   const id=state.submission.submission_id,entry=this.interactionReceipts.get(id)??{sessionId:state.submission.session_id,outcomes:[]};
   entry.outcomes.push({request_id:event.request_id,resolution:event.resolution});this.interactionReceipts.set(id,entry);
  }
  const packet=this.eventPacket(state,event);
  try{void Promise.resolve(this.options.emit?.(packet)).catch(()=>{/* Durable final result remains available for reconciliation. */});}catch{/* Durable final result remains available for reconciliation. */}
 }
 private publishTitleRequest(state:ActiveTurn,event:Extract<EngineEventPayload,{kind:'conversation.title.request'}>):void|Promise<void>{
  if(!this.options.emit)throw Error('Native title transport unavailable');
  return this.options.emit(this.eventPacket(state,event));
 }
 private publishKnowledgeRequest(state:ActiveTurn,event:Extract<EngineEventPayload,{kind:'knowledge.request'}>):void|Promise<void>{
  if(!this.options.emit)throw Error('Native knowledge transport unavailable');
  return this.options.emit(this.eventPacket(state,event));
 }
 private eventPacket(state:ActiveTurn,event:EngineEventPayload):EngineWireEvent{
  const sequence=this.store.nextEvent(state.submission.submission_id),s=state.submission;
  return{type:'assistant_engine_event',event_id:randomUUID(),session_id:s.session_id,worker_generation:state.generation,event_sequence:sequence,source:{conversation_id:s.binding.conversation_id,agent_id:s.binding.agent_id,actor_id:s.binding.actor_id,session_id:s.session_id,run_id:s.run_id,submission_id:s.submission_id,authorization_revision:s.binding.authorization_revision,worker_id:this.workerId,worker_generation:state.generation,native:{thread_id:state.threadId,turn_id:state.turnId!,item_id:'item_id'in event?event.item_id:null}},event};
 }
}
