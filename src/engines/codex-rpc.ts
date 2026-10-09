import {spawn as spawnProcess,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter,dirname,join} from 'node:path';
import {z} from 'zod';
import {validateNativePolicy,nativeApprovalPolicy,nativeApprovalPolicySchema} from './codex-policy.js';
import type {NativePermissions} from './native-permissions.js';
import {snapshotNativeExecutable,type NativeExecutableSnapshot} from './native-executable.js';
import {assertSystemdUserAvailable,spawnSystemdSupervisor} from './native-systemd-supervisor.js';
import type {NativeUnitLease} from './native-unit-registry.js';

export interface CodexRpcProcess {
 confirmNativeExit?:()=>Promise<void>;
 pid?:number;
 stdin:{write(value:string):boolean;end():void;once?(event:'error'|'close',listener:(...args:any[])=>void):unknown};
 stdout:{on(event:'data',listener:(value:Buffer)=>void):unknown;once?(event:'error'|'close',listener:(...args:any[])=>void):unknown};
 stderr:{on(event:'data',listener:(value:Buffer)=>void):unknown;once?(event:'error'|'close',listener:(...args:any[])=>void):unknown};
 once(event:'error'|'exit'|'close',listener:(...args:any[])=>void):unknown;
 on?(event:'message',listener:(value:unknown)=>void):unknown;
 kill(signal?:NodeJS.Signals):boolean;
}
type RpcId=number|string;
interface RpcResponse {id:RpcId;result?:unknown;error?:{code:number;message:string;data?:unknown}}
interface RpcRequest {id?:RpcId;method:string;params?:unknown}
export interface CodexRpcServerRequest {id:RpcId;method:string;params:unknown}
export interface CodexRpcOptions {spawn?:()=>CodexRpcProcess;executable?:string;cwd?:string;env?:NodeJS.ProcessEnv;nativeLease?:()=>Promise<NativeUnitLease>;requestTimeoutMs?:number;onClosed?:()=>void;onServerRequest?:(request:CodexRpcServerRequest)=>Promise<unknown>;onNotification?:(method:string,params:unknown)=>void}
const unknownError=()=>Object.assign(new Error('Codex request was accepted or may have executed, but its response was lost; reconciliation is required'),{code:'CODEX_RPC_UNKNOWN'});
interface ThreadOptions {cwd:string;permissionScope:NativePermissions;model?:string;modelProvider?:string;config?:Record<string,unknown>;approvalPolicy?:typeof nativeApprovalPolicy;approvalsReviewer?:'user';developerInstructions?:string}
export type NativeAccountRead={requiresOpenaiAuth:boolean;accountPresent:boolean};
// Verified Codex 0.160.x GetAccountResponse. Only this small projection is returned;
// account fields never enter Worker reports or the execution journal.
const nativeAccountSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('apiKey')}).strict(),
 z.object({type:z.literal('chatgpt'),email:z.string().nullable(),planType:z.enum(['free','go','plus','pro','prolite','promax','team','self_serve_business_prolite','self_serve_business_usage_based','business','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','enterprise','edu','edu_plus','edu_pro','unknown'])}).strict(),
 z.object({type:z.literal('amazonBedrock'),usesCodexManagedCredentials:z.boolean().optional()}).strict(),
]);

/** Minimal JSON-RPC transport for the local Codex App Server. It never retries
 * a request after a lost response; the caller must reconcile native state. */
export class CodexAppServerClient {
 private process?:CodexRpcProcess;private sequence=0;private buffer='';private decoder=new TextDecoder();private closed=false;private initialized=false;private initializePromise?:Promise<unknown>;private readonly pending=new Map<RpcId,{resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 onNotification?:(method:string,params:unknown)=>void;
 private exited:Promise<void>=Promise.resolve();
 private exitResolve?:()=>void;
 private closeNotified=false;
 private closePromise?:Promise<void>;
 private observedExit=false;
 private confirmExit?:()=>Promise<void>;
 private unitLease?:NativeUnitLease;
 private preparingProcess?:Promise<void>;
 private executablePath?:string;
 private executablePromise?:Promise<NativeExecutableSnapshot>;
 private runtimeChanged=false;
 private systemdCgroup?:string;
 get nativeSystemdCgroup(){return this.systemdCgroup;}
 async runtimeExecutable():Promise<string>{
  const changed=()=>Object.assign(Error('Native Codex executable changed; release the idle client before reloading'),{code:'CODEX_RUNTIME_CHANGED'});
  if(this.runtimeChanged)throw changed();
  const inspect=()=>snapshotNativeExecutable(this.options.executable,this.options.env?.PATH);
  if(!this.executablePromise){
   this.executablePromise=inspect().then(snapshot=>{this.executablePath=snapshot.path;return snapshot;});
   return(await this.executablePromise).path;
  }
  const saved=await this.executablePromise;
  try{const current=await inspect();if(this.runtimeChanged||current.path!==saved.path||current.identity!==saved.identity)throw changed();return saved.path;}
  catch{this.runtimeChanged=true;throw changed();}
 }
 get isClosed(){return this.closed;}
 get hasExited(){return !this.process;}
 private notifyClosed(){if(this.closeNotified)return;this.closeNotified=true;try{this.options.onClosed?.();}catch{/* Native outcome remains unknown even if its observer fails. */}}
 constructor(private readonly options:CodexRpcOptions={}){this.onNotification=options.onNotification;}
 private ensure(){
  if(this.closed)throw new Error('Codex RPC connection is closed');if(this.process)return this.process;
  if(!this.options.spawn&&!this.executablePath)throw Error('Native Codex executable has not been resolved');
  const child:CodexRpcProcess=this.options.spawn?.()??this.spawnGuarded() as unknown as CodexRpcProcess;
  this.process=child;this.exited=new Promise(resolve=>this.exitResolve=resolve);
  child.on?.('message',value=>{if(value&&typeof value==='object'&&(value as any).type==='native_systemd_cgroup'&&typeof (value as any).cgroup==='string')this.systemdCgroup=(value as any).cgroup;});
  const lost=(error:unknown)=>{this.closed=true;this.failPending(error);this.notifyClosed();};
  let pipesClosed=false,checking:Promise<void>|undefined;
  const release=()=>{if(this.process!==child)return;lost(unknownError());this.process=undefined;this.exitResolve?.();};
  this.confirmExit=()=>{
   if(!child.confirmNativeExit){if(pipesClosed)release();return Promise.resolve();}
   if(checking)return checking;
   checking=child.confirmNativeExit().then(()=>{if(pipesClosed)release();}).finally(()=>{checking=undefined;});return checking;
  };
  const finished=()=>{pipesClosed=true;lost(unknownError());if(child.confirmNativeExit)void this.confirmExit!().catch(()=>{});else release();};
  const streams=[child.stdin,child.stdout,child.stderr],closedStreams=new Set<unknown>();
  const checkExit=()=>{if(this.observedExit&&closedStreams.size===streams.length)finished();};
  child.stdout.on('data',value=>this.read(value));child.stderr.on('data',()=>undefined);
  for(const stream of streams){stream.once?.('close',()=>{closedStreams.add(stream);checkExit();});stream.once?.('error',error=>{lost(error);void this.close().catch(()=>undefined);});}
  child.once('error',error=>{lost(error);void this.close().catch(()=>undefined);});
  child.once('exit',()=>{this.observedExit=true;lost(unknownError());if(child.confirmNativeExit)void this.confirmExit!().catch(()=>{});checkExit();});
  // Node can omit close if IPC disconnected during startup. Exit plus all
  // closed pipes is equivalent, but exit alone must not release the fence.
  child.once('close',finished);return child;
 }
 private spawnGuarded(){
  const nativeToolDir=join(dirname(dirname(this.executablePath!)),'codex-path');
  const env={...process.env,...this.options.env,PATH:[nativeToolDir,this.options.env?.PATH??process.env.PATH??''].filter(Boolean).join(delimiter)};
  if(process.platform==='linux'){
   const args=['app-server','--listen','stdio://'];
   // Preflight is intentionally asynchronous in production initialization;
   // spawnSystemdSupervisor itself fails closed if user systemd is unavailable.
   return spawnSystemdSupervisor({executable:this.executablePath!,args,cwd:this.options.cwd,env,lease:this.unitLease});
  }
  const source=import.meta.url.endsWith('.ts'),guardian=fileURLToPath(new URL(source?'./native-guardian.ts':'./native-guardian.js',import.meta.url));
  const args=[...(source?['--import',import.meta.resolve('tsx')]:[]),guardian,this.executablePath!,'app-server','--listen','stdio://'];
  return spawnProcess(process.execPath,args,{cwd:this.options.cwd,env,detached:true,stdio:['pipe','pipe','pipe','ipc']});
 }
 private read(chunk:Buffer){
  if(this.closed)return;
  this.buffer+=this.decoder.decode(chunk,{stream:true});
  let index:number;
  while((index=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;
   let value:Record<string,unknown>;
   try{
    const raw:unknown=JSON.parse(line);
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error();
    value=raw as Record<string,unknown>;
    const hasId=Object.hasOwn(value,'id'),hasMethod=Object.hasOwn(value,'method'),result=Object.hasOwn(value,'result'),error=Object.hasOwn(value,'error');
    if(hasId&&!(typeof value.id==='string'||typeof value.id==='number'&&Number.isSafeInteger(value.id)))throw Error();
    if(hasMethod){if(typeof value.method!=='string'||!value.method||result||error)throw Error();}
    else if(!hasId||result===error)throw Error();
    if(error){const err=value.error as {code?:unknown;message?:unknown}|null;if(!err||typeof err.code!=='number'||typeof err.message!=='string')throw Error();}
   }catch{this.protocolFail('Malformed Codex RPC message');return;}
   if(typeof value.method==='string'){
    if(Object.hasOwn(value,'id'))void this.handleServerRequest(value as unknown as RpcRequest&{id:RpcId}).catch(()=>this.protocolFail('Codex server request response failed'));
    else{try{this.onNotification?.(value.method,value.params);}catch{this.protocolFail('Codex notification handler failed');return;}}
   }else{
    const response=value as unknown as RpcResponse,pending=this.pending.get(response.id);if(!pending)continue;
    this.pending.delete(response.id);clearTimeout(pending.timer);
    if(response.error)pending.reject(Object.assign(new Error(response.error.message),{code:response.error.code,data:response.error.data}));else pending.resolve(response.result);
   }
  }
 }
 private async handleServerRequest(request:RpcRequest&{id:RpcId}){let response:unknown;try{response=await this.options.onServerRequest?.({id:request.id,method:request.method,params:request.params});if(response===undefined)throw Object.assign(new Error('Unsupported Codex server request'),{code:-32601});this.write({id:request.id,result:response});}catch(error){if(this.closed)return;const code=(error as any)?.code;this.write({id:request.id,error:{code:typeof code==='number'?code:-32601,message:code===-32601?'Unsupported Codex server request':error instanceof Error?error.message:'Request denied'}});}}
 private write(value:unknown){if(this.closed)throw new Error('Codex RPC client is closed');this.ensure().stdin.write(JSON.stringify(value)+'\n');}
 private request<T=unknown>(method:string,params?:unknown,allowBeforeInit=false):Promise<T>{if(!allowBeforeInit&&!this.initialized)throw Object.assign(new Error('Codex RPC client is not initialized'),{code:'CODEX_RPC_NOT_INITIALIZED'});const id=++this.sequence;const promise=new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(unknownError());},this.options.requestTimeoutMs??30_000);timer.unref?.();this.pending.set(id,{resolve,reject,timer});});try{this.write({id,method,params});}catch(error){const pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.reject(error);}}return promise;}
 initialize(params:{clientInfo:{name:string;version:string};capabilities?:unknown}):Promise<unknown>{
  if(this.closed)return Promise.reject(Error('Codex RPC client is closed'));if(this.initializePromise)return this.initializePromise;
  if(!this.options.spawn)this.preparingProcess=(async()=>{
   await this.runtimeExecutable();await assertSystemdUserAvailable();
   if(this.closed)throw Error('Codex RPC client is closed');
   this.unitLease=await this.options.nativeLease?.();
   if(this.closed){this.unitLease?.released();this.unitLease=undefined;throw Error('Codex RPC client is closed');}
  })();
  const handshake=this.options.spawn?this.request<unknown>('initialize',params,true):this.preparingProcess!.then(()=>this.request<unknown>('initialize',params,true));
  this.initializePromise=handshake.then(result=>{
   if(this.closed)throw Error('Codex RPC client is closed');
   const metadata=z.object({userAgent:z.string()}).parse(result);
   if(!/^[^\s/]+\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,119}(?:\s|$)/u.test(metadata.userAgent))throw Object.assign(Error('Invalid native Codex protocol handshake'),{code:'CODEX_RPC_PROTOCOL_ERROR'});
   this.write({method:'initialized',params:{}});this.initialized=true;return result;
  }).catch(error=>{this.protocolFail('Codex initialization failed');throw error;});return this.initializePromise;
 }
 private threadParams(params:ThreadOptions){
  const {permissionScope,...rest}=params;
  if(!permissionScope||permissionScope.cwd!==params.cwd||'sandbox'in params)throw Error('Native thread requires an exact named permission scope');
  if(Object.keys(rest.config??{}).some(key=>key==='sandbox_mode'||key.startsWith('sandbox_workspace_write')||key==='permissions'||key.startsWith('permissions.')||key==='default_permissions'))throw Error('Native thread config cannot override host permissions');
  if(Object.keys(rest.config??{}).some(key=>['approval_policy','approvals_reviewer'].some(name=>key===name||key.startsWith(name+'.'))))throw Error('Native thread config cannot override host approval policy');
  return{...rest,approvalPolicy:nativeApprovalPolicySchema.parse(rest.approvalPolicy??nativeApprovalPolicy),approvalsReviewer:'user',permissions:permissionScope.id,runtimeWorkspaceRoots:permissionScope.runtimeWorkspaceRoots,config:{...rest.config,['permissions.'+permissionScope.id]:permissionScope.config}};
 }
 startThread(params:ThreadOptions&{serviceName?:string;dynamicTools?:Array<{type:'function';name:string;description:string;inputSchema:unknown}>}){return this.request<unknown>('thread/start',this.threadParams(params)).then(value=>this.threadObject(value,params.cwd,params.permissionScope));}
 resumeThread(params:ThreadOptions&{threadId:string}){return this.request<unknown>('thread/resume',this.threadParams(params)).then(value=>this.threadObject(value,params.cwd,params.permissionScope));}
 readThread(params:{threadId:string;includeTurns?:boolean}){return this.request<unknown>('thread/read',params);}
 unsubscribeThread(params:{threadId:string}){return this.request<unknown>('thread/unsubscribe',params).then(value=>z.object({status:z.enum(['notLoaded','notSubscribed','unsubscribed'])}).parse(value));}
 async assertPermissionProfileAvailable(cwd:string,id:string):Promise<void>{
  // Do not expose/persist config values; only test the intended profile key.
  const value=await this.request<unknown>('config/read',{cwd,includeLayers:false});
  const parsed=z.object({config:z.object({permissions:z.record(z.string(),z.unknown()).nullish()})}).safeParse(value);
  if(!parsed.success)throw Error('Native effective configuration is unavailable');
  if(Object.hasOwn(parsed.data.config.permissions??{},id))throw Error('Native permission profile name collides with inherited configuration');
 }
 backgroundTerminals(params:{threadId:string;cursor?:string}){return this.request<unknown>('thread/backgroundTerminals/list',params);}
 terminateBackgroundTerminal(params:{threadId:string;processId:string}){return this.request<unknown>('thread/backgroundTerminals/terminate',params).then(value=>z.object({terminated:z.boolean()}).parse(value));}
 startTurn(params:{threadId:string;input:unknown[];runtimeWorkspaceRoots?:string[];permissions?:string}){return this.request<unknown>('turn/start',params).then(value=>this.nativeObject(value,'turn'));}
 steerTurn(params:{threadId:string;expectedTurnId:string;input:unknown[]}):Promise<{turnId:string}>{return this.request<unknown>('turn/steer',params).then(value=>{
  const parsed=z.object({turnId:z.string().min(1)}).safeParse(value);
  if(!parsed.success||parsed.data.turnId!==params.expectedTurnId)throw Object.assign(Error('Invalid Codex steering turn acknowledgement'),{code:'CODEX_RPC_PROTOCOL_ERROR'});
  return parsed.data;
 });}
 interruptTurn(params:{threadId:string;turnId:string}){return this.request('turn/interrupt',params);}
 readAccount():Promise<NativeAccountRead>{return this.request<unknown>('account/read',{refreshToken:false}).then(value=>{
  const parsed=z.object({account:nativeAccountSchema.nullable().optional(),requiresOpenaiAuth:z.boolean()}).safeParse(value);
  if(!parsed.success)throw Object.assign(Error('Invalid Codex account/read response'),{code:'CODEX_PROTOCOL_ERROR'});
  if(parsed.data.requiresOpenaiAuth&&!parsed.data.account)throw Object.assign(Error('Codex authentication is required'),{code:'CODEX_LOGIN_REQUIRED'});
  return{requiresOpenaiAuth:parsed.data.requiresOpenaiAuth,accountPresent:Boolean(parsed.data.account)};
 });}
 private protocolFail(message:string){const error=Object.assign(new Error(message),{code:'CODEX_RPC_PROTOCOL_ERROR'});this.failPending(error);this.closed=true;this.notifyClosed();void this.close().catch(()=>undefined);}
 private failPending(error:unknown){for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();}
 private nativeObject(value:unknown,key:'thread'|'turn'):{id:string;sessionId?:string;status?:string}{
  const record=value&&typeof value==='object'?(value as Record<string,unknown>)[key]:null;
  if(!record||typeof record!=='object'||typeof (record as {id?:unknown}).id!=='string'||!(record as {id:string}).id)throw Object.assign(Error('Invalid Codex native '+key+' response'),{code:'CODEX_RPC_PROTOCOL_ERROR'});
  return record as {id:string;sessionId?:string;status?:string};
 }
 private threadObject(value:unknown,cwd:string,expected:NativePermissions){const native=this.nativeObject(value,'thread'),policy=validateNativePolicy(value,cwd,expected);return{id:native.id,...(native.sessionId?{sessionId:native.sessionId}:{}),policy,activePermissionProfile:{id:expected.id,extends:null},runtimeWorkspaceRoots:expected.runtimeWorkspaceRoots};}
 close():Promise<void>{
  this.closed=true;this.failPending(new Error('Codex RPC client closed'));this.notifyClosed();
  const child=this.process;if(!child)return this.preparingProcess?this.preparingProcess.catch(()=>undefined).then(()=>this.exited):this.exited;
  if(child.confirmNativeExit&&this.observedExit){
   if(this.closePromise)return this.closePromise;
   let deadline:ReturnType<typeof setTimeout>;
   this.closePromise=Promise.race([this.confirmExit!().then(()=>this.exited),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(unknownError()),6000);})]).finally(()=>{clearTimeout(deadline);this.closePromise=undefined;});return this.closePromise;
  }
  if(this.closePromise)return this.closePromise;
  let deadline:ReturnType<typeof setTimeout>;
  this.closePromise=Promise.race([this.exited,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(unknownError()),6000);})]).finally(()=>{clearTimeout(deadline);if(child.confirmNativeExit)this.closePromise=undefined;});
  // Only the live Guardian owns escalation for its group. Never derive a
  // group from an injected child's PID, signal after exit, or kill Guardian
  // before it has reaped children. Timeout retains unknown until actual exit.
  try{child.stdin.end();}catch{/* Closing stdin must not skip the stop signal. */}
  if(!this.observedExit)try{child.kill('SIGTERM');}catch{/* Keep the exit fence. */}
  return this.closePromise;
 }
}
