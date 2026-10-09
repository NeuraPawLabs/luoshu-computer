import {mkdir,lstat,realpath,mkdtemp,rmdir} from 'node:fs/promises';
import {resolve,sep,join} from 'node:path';
import {CodexAppServerClient,type CodexRpcServerRequest} from './codex-rpc.js';
import type Database from 'better-sqlite3';
import {NativeUnitRegistry} from './native-unit-registry.js';
import {NativeWorkspaceRoots} from './native-workspace-roots.js';

export interface CodexPoolOptions {
  stateDir:string;
  db?:Database.Database;
  executable?:string;
  rpcFactory?:(workerId:string)=>CodexAppServerClient;
  onClosed?:(workerId:string)=>void;
  onNotification?:(workerId:string,method:string,params:unknown)=>void;
  onInteraction?:(workerId:string,request:CodexRpcServerRequest)=>Promise<unknown>;
  auditCloseTimeoutMs?:number;
}
type AuditStatus='ready'|'login_required'|'permissions_unavailable'|'protocol_unsupported';
interface Audit {client?:CodexAppServerClient;root:string;closing?:Promise<void>}

/** Owns local app-server child processes. The pool never exposes a socket and
 * never accepts arbitrary RPC method names from Core. */
export class CodexAppServerPool {
 private readonly clients=new Map<string,CodexAppServerClient>();
 private readonly audits=new Map<string,Audit>();
 private readonly auditing=new Map<string,Promise<AuditStatus>>();
 private readonly recovering=new Map<string,Promise<CodexAppServerClient>>();
 private readonly unloading=new Map<string,Promise<boolean>>();
 private closing=false;
 private closePromise?:Promise<void>;
 private readonly closedWorkers=new Set<string>();
 private readonly units?:NativeUnitRegistry;
 private readonly roots?:NativeWorkspaceRoots;
 private executable?:string;
 constructor(private readonly options:CodexPoolOptions){this.executable=options.executable;if(options.db){this.units=new NativeUnitRegistry(options.db);this.roots=new NativeWorkspaceRoots(options.db,options.stateDir);}}
 /** Applies a path change to future native clients. Existing clients keep the
  * executable they were initialized with until their session is quiesced. */
 setExecutable(executable?:string):void{this.executable=executable;}
 async workspacePath(id:string,session=id):Promise<string|null>{
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return null;
  if(this.roots)return this.roots.prepare(id,session);
  const base=await realpath(this.options.stateDir),root=resolve(base,'assistant-engine-workspaces'),path=resolve(root,id);
  if(!path.startsWith(root+sep))return null;
  for(const directory of [root,path]){
   try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)throw Error('Unsafe Codex workspace: symbolic links are forbidden');
  }
  return path;
 }
 audit(workerId:string):Promise<AuditStatus>{
  if(this.closing||this.closedWorkers.has(workerId))return Promise.reject(Error('Native process pool is closed'));
  const pending=this.auditing.get(workerId);if(pending)return pending;
  const work=Promise.resolve().then(()=>this.auditOnce(workerId));this.auditing.set(workerId,work);
  void work.then(()=>this.auditing.delete(workerId),()=>this.auditing.delete(workerId));return work;
 }
 private async auditOnce(workerId:string):Promise<AuditStatus>{
  const executable=this.executable;
  const current=()=>{if(this.closing||this.closedWorkers.has(workerId)||this.unloading.has(workerId)||this.executable!==executable)throw Error('Native audit configuration or lifecycle changed');};
  let entry=this.audits.get(workerId),status:AuditStatus='permissions_unavailable';
  try{
   current();if(entry)await this.closeAudit(workerId,entry);current();
   entry={root:''};this.audits.set(workerId,entry);
   entry.root=await mkdtemp(join(this.options.stateDir,'.native-audit-'));current();
   const client=entry.client=this.createClient(workerId,true,entry.root);
   await client.initialize({clientInfo:{name:'luoshu-readiness',version:'0.1.5'},capabilities:{experimentalApi:true}});current();
   await client.readAccount();current();
   // Native extensions/configuration are accepted during development. Check
   // the host profile itself, not whether the user's installation is empty.
   await client.assertPermissionProfileAvailable(entry.root,'luoshu_readiness');current();status='ready';
  }catch(error){const code=(error as {code?:unknown})?.code;status=code==='CODEX_LOGIN_REQUIRED'?'login_required':code==='CODEX_RPC_PROTOCOL_ERROR'?'protocol_unsupported':'permissions_unavailable';}
  if(entry)try{await this.closeAudit(workerId,entry);}catch{return'permissions_unavailable';}
  try{current();return status;}catch{return'permissions_unavailable';}
 }
 private async closeAudit(workerId:string,entry:Audit):Promise<void>{
  const client=entry.client;
  if(client){
   if(!entry.closing){const closing=Promise.resolve().then(()=>client.close());entry.closing=closing;void closing.then(()=>{if(entry.closing===closing)entry.closing=undefined;},()=>{if(entry.closing===closing)entry.closing=undefined;});}
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([entry.closing,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native audit exit remains unconfirmed')),this.options.auditCloseTimeoutMs??6000);})]);}
   finally{clearTimeout(timer);}
   if(!client.hasExited)throw Error('Native audit exit remains unconfirmed');
  }
  // No thread/turn runs in this directory. Never recursively remove an
  // unexpected file left by a failing audit or an external actor.
  if(entry.root)await rmdir(entry.root).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(this.audits.get(workerId)===entry)this.audits.delete(workerId);
 }
 async cleanupWorkspace(session:string,cwd:string|undefined,current:()=>void):Promise<void>{
  if(!this.roots)throw Error('Native workspace ownership registry is unavailable');
  if(this.clients.size||this.recovering.size||this.unloading.size)throw Error('Native workspace cleanup requires quiescence');
  await this.roots.cleanup(session,cwd,current);
 }
 async assertWorkspace(session:string,cwd:string|undefined,current:()=>void):Promise<void>{if(!this.roots)throw Error('Native workspace ownership registry is unavailable');await this.roots.assertOwned(session,cwd,current);}
 purgeWorkspace(session:string):void{if(!this.roots)throw Error('Native workspace ownership registry is unavailable');this.roots.purge(session);}
 client(workerId:string):CodexAppServerClient{
  if(this.closing||this.closedWorkers.has(workerId))throw Error('Native process pool is closed');
  if(this.unloading.has(workerId))throw Error('Native process pool is unloading');
  const existing=this.clients.get(workerId);if(existing)return existing;
  const client=this.createClient(workerId);
  this.clients.set(workerId,client);return client;
 }
 private createClient(workerId:string,audit=false,cwd?:string):CodexAppServerClient{
  const key=audit?`audit:${workerId}`:workerId;
  return this.options.rpcFactory?.(key)??new CodexAppServerClient({executable:this.executable,cwd,nativeLease:this.units?()=>this.units!.acquire(key):undefined,...(audit?{}:{onClosed:()=>{if(!this.unloading.has(workerId))this.options.onClosed?.(workerId);},onNotification:(method:string,params:unknown)=>this.options.onNotification?.(workerId,method,params),onServerRequest:(request:CodexRpcServerRequest)=>this.handleInteraction(workerId,request)})});
 }
 async recoverClient(workerId:string):Promise<CodexAppServerClient>{
  if(this.closing||this.closedWorkers.has(workerId))throw Error('Native process pool is closed');
  if(this.unloading.has(workerId))throw Error('Native process pool is unloading');
  const pending=this.recovering.get(workerId);if(pending)return pending;
  const existing=this.clients.get(workerId);if(!existing?.isClosed)return this.client(workerId);
  const work=(async()=>{await existing.close();if(this.closing||this.closedWorkers.has(workerId))throw Error('Native process pool is closed');if(!existing.hasExited)throw Error('Native process exit remains unconfirmed');if(this.clients.get(workerId)===existing)this.clients.delete(workerId);return this.client(workerId);})();
  this.recovering.set(workerId,work);try{return await work;}finally{this.recovering.delete(workerId);}
 }
 async unloadIfIdle(workerId:string,activeCount:()=>number):Promise<boolean>{
  const pending=this.unloading.get(workerId);if(pending)return pending;
  if(this.closing||this.closedWorkers.has(workerId)||this.recovering.has(workerId)||activeCount()>0)return false;
  const client=this.clients.get(workerId);if(!client)return true;
  const work=Promise.resolve().then(async()=>{
   if(this.closing||activeCount()>0)return false;
   await client.close();if(!client.hasExited)throw Error('Native idle exit remains unconfirmed');
   if(this.clients.get(workerId)===client)this.clients.delete(workerId);return true;
  });
  this.unloading.set(workerId,work);
  try{return await work;}finally{if(this.unloading.get(workerId)===work)this.unloading.delete(workerId);}
 }
 async quiesce(workerId:string):Promise<void>{
  if(this.closing||this.recovering.has(workerId)||this.unloading.has(workerId)||this.audits.has(workerId))throw Error('Native process pool is busy');
  const operation=Promise.resolve().then(async()=>{
   const client=this.clients.get(workerId);
   if(client){await client.close();if(client.hasExited!==true)throw Error('Native cleanup exit remains unconfirmed');if(this.clients.get(workerId)===client)this.clients.delete(workerId);}
   await this.units?.quiesce(workerId);return true;
  });this.unloading.set(workerId,operation);
  try{await operation;}finally{if(this.unloading.get(workerId)===operation)this.unloading.delete(workerId);}
 }
 private async handleInteraction(workerId:string,request:CodexRpcServerRequest):Promise<unknown>{
  const result=await this.options.onInteraction?.(workerId,request);
  if(result!==undefined)return result;
  // Until Core's scoped interaction bridge is installed, reject rather than
  // silently approve a local command/file/network request.
  throw Object.assign(new Error('Codex interaction requires an authorized Core response'),{code:-32010});
 }
 close(workerId?:string):Promise<void>{
  if(!workerId&&this.closePromise)return this.closePromise;
  if(workerId)this.closedWorkers.add(workerId);else this.closing=true;
  const ids=workerId?[workerId]:[...new Set([...this.clients.keys(),...this.recovering.keys(),...this.audits.keys(),...this.auditing.keys()])];
  const operation=(async()=>{
   const settled=await Promise.allSettled(ids.map(async id=>{
    await this.auditing.get(id)?.catch(()=>undefined);
    const results=await Promise.allSettled([
     (async()=>{const entry=this.audits.get(id);if(entry)await this.closeAudit(id,entry);})(),
     (async()=>{const client=this.clients.get(id);if(client){await client.close();if(client.hasExited===false)throw Error('Native process exit remains unconfirmed');this.clients.delete(id);}await this.recovering.get(id)?.catch(()=>undefined);})(),
    ]);for(const result of results)if(result.status==='rejected')throw result.reason;
   }));for(const result of settled)if(result.status==='rejected')throw result.reason;
  })();
  if(!workerId){this.closePromise=operation;void operation.catch(()=>{if(this.closePromise===operation)this.closePromise=undefined;});}return operation;
 }
}
