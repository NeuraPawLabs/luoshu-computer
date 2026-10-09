import type {WorkerClient} from '../runtime/client.js';
import {CodexAppServerPool} from './codex-pool.js';
import {CodexSessionStore} from './session-store.js';
import {CodexEngineService} from './service.js';
import type {CodexAppServerClient} from './codex-rpc.js';
import type {CodexSandboxMode} from '../protocol/index.js';
import {NativeRunFiles} from './native-files.js';
import {NativeCodebases} from './native-codebases.js';
import type {DevelopmentRootPolicy} from '../development/root-policy.js';

/** One wiring path for CLI and installed computer daemon. Readiness stays
 * unavailable until Core delivery, leases and native task tools are wired. */
export function attachAssistantEngine(options:{client:WorkerClient;stateDir:string;workerId:string;executable?:string;rootPolicy?:DevelopmentRootPolicy;gitSshCommand?:string;rpcFactory?:(id:string)=>CodexAppServerClient;sandboxMode?:()=>Promise<CodexSandboxMode>|CodexSandboxMode}){
 let service!:CodexEngineService,closed=false;
 const {client}=options,store=new CodexSessionStore(client.state.db),codebases=new NativeCodebases(client.state.db,{stateDir:options.stateDir,allowedRoots:()=>options.rootPolicy?.roots()??[],gitSshCommand:options.gitSshCommand,isPreparationCancelled:identity=>{try{return store.preparationState(store.metadata(identity.session_id,identity.submission_id))==='cancelling';}catch{return false;}}});
 const files=new NativeRunFiles(client.state.db,identity=>{const submission=store.submission(identity.submission_id);if(!submission||submission.session_key!==identity.session_id||!store.result(identity.session_id,identity.submission_id))return false;return store.metadata(identity.session_id,identity.submission_id).run_id===identity.run_id;},(identity,assertCurrent)=>service.codebaseReceipts(identity,assertCurrent),(identity)=>Promise.resolve(service.commandReceipts(identity)),(identity,sha,current)=>service.checkEvidence(identity,sha,current),(identity,outputs,current)=>codebases.collectDocumentation(identity,outputs,current));
 const pool=new CodexAppServerPool({stateDir:options.stateDir,db:client.state.db,executable:options.executable,rpcFactory:options.rpcFactory,onClosed:()=>service.nativeConnectionLost(),onNotification:(_id,method,params)=>service.notification(method,params),onInteraction:(_id,request)=>service.serverRequest(request)});
 service=new CodexEngineService(store,options.workerId,id=>pool.client(id),{
  workspacePath:(id,session)=>pool.workspacePath(id,session),generation:()=>client.assistantEngineConnection.generation,
  recoverClient:id=>pool.recoverClient(id),
  unloadIdle:()=>pool.unloadIfIdle(options.workerId,()=>store.activeCount()+files.activeCount()),
  quiesce:()=>pool.quiesce(options.workerId),
  files,codebases,rootPolicy:options.rootPolicy,sandboxMode:options.sandboxMode,
  cleanupOwned:async(session,current)=>{await pool.assertWorkspace(session,store.session(session)?.cwd,current);await files.cleanupSession(session,current);current();await codebases.cleanupSession(session,current);current();await pool.cleanupWorkspace(session,store.session(session)?.cwd,current);current();},
  finalizeCleanup:session=>{files.purgeSessionData(session);codebases.purgeSessionData(session);pool.purgeWorkspace(session);},
  authorized:()=>!closed&&client.assistantEngineConnection.authenticated,
  capacity:()=>client.executionCapacity,otherActiveCount:()=>client.executionLoad('native'),
  emit:event=>{
   const connection=client.assistantEngineConnection;
   if(!connection.authenticated||connection.generation!==event.worker_generation)throw Error('Native event connection authority expired');
   return client.send(event);
  },
 });
 client.onAssistantEngineRequest=request=>service.handle(request);
 client.assistantEngineActiveCount=()=>store.activeCount()+files.activeCount();
 const unloadIdle=()=>service.releaseIdle();
 client.onAssistantEngineDisconnected=()=>service.disconnect();
 let closing:Promise<void>|undefined;
 return{service,store,unloadIdle,audit:()=>pool.audit(options.workerId),applyConfig(config:{agent_paths?:Partial<Record<'codex'|'opencode',string>>}){pool.setExecutable(config.agent_paths?.codex);},close(){if(closing)return closing;closed=true;closing=(async()=>{await service.close();await pool.close();client.onAssistantEngineRequest=undefined;client.onAssistantEngineDisconnected=undefined;})();return closing;}};
}
