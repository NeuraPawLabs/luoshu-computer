import {validateComputerReleaseSource} from './computer/releases.js';
import {codexSandboxModeSchema, type CodexSandboxMode} from '@luoshu/protocol';
import { createPrivateKey, sign } from 'node:crypto';
import WebSocket from 'ws';
import { buildEnvironmentReport, createIdentity, loadIdentity, loadWorkerConfig, resolveAgentPaths, saveWorkerConfig, validateWorkerConfig, type WorkerConfig } from './environment.js';
import { WorkerState } from './state.js';
import { idSchema, maintenanceResultSchema, reportSchema, serverMessageSchema, MAX_WIRE_BYTES, PROTOCOL_VERSION, type Assignment, type MaintenanceRequest, type MaintenanceResult, type ServerMessage, type WorkerMessage, type WorkerReport, type AgentId, type CodebasePrepareRequest, type CodebasePrepareResult } from '@luoshu/protocol';
import type { DevelopmentService } from './development/service.js';
import { LocalGitCredentialStore } from './git-credentials.js';
import { validateDevelopmentRoots } from './development/root-policy.js';
import type {RecoveryCommand,RecoveryResponse,ImportedAck} from '@luoshu/protocol';
import {WorkerConfigController} from './config-controller.js';
import {engineWireResponseSchema,type EngineWireRequest,type EngineWireResponse} from '@luoshu/protocol';

export interface WorkerClientOptions {
  stateDir: string;
  config?: WorkerConfig;
  report?: WorkerReport;
  wsFactory?: (url: string) => WebSocket;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  development?: DevelopmentService;
  maintenance?: {execute:(request:MaintenanceRequest,signal:AbortSignal)=>Promise<MaintenanceResult>};
  codebasePreparation?: {prepare:(request:CodebasePrepareRequest)=>Promise<CodebasePrepareResult[]>};
  configController?: WorkerConfigController;
  onAssistantEngineRequest?: (request:EngineWireRequest)=>Promise<EngineWireResponse>;
  nativeAudit?:()=>Promise<'ready'|'login_required'|'permissions_unavailable'|'protocol_unsupported'>;
}

export class WorkerClient {
  readonly stateDir: string;
  readonly state: WorkerState;
  private config?: WorkerConfig;
  private report?: WorkerReport;
  private readonly suppliedReport?:WorkerReport;
  private readonly suppliedConfig?:WorkerConfig;
  private authenticated=false;
  private liveProgressSupported=false;
  private liveProgressPending=0;
  private authSent=false;
  private ws?: WebSocket;
  private generation = 0;
  private stopped = false;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly development?: DevelopmentService;
  private readonly maintenance?: WorkerClientOptions['maintenance'];
  private readonly codebasePreparation?:WorkerClientOptions['codebasePreparation'];
  private readonly configController?: WorkerConfigController;
  private readonly nativeAudit?:WorkerClientOptions['nativeAudit'];
  onAssistantEngineRequest?: WorkerClientOptions['onAssistantEngineRequest'];
  onAssistantEngineDisconnected?:()=>Promise<void>|void;
  assistantEngineActiveCount:()=>number=()=>0;
  get assistantEngineConnection(){return{authenticated:this.authenticated&&!this.stopped,generation:this.generation};}
  private readonly unsubscribeConfig?:()=>void;
  private configReportDirty=false;
  private readonly maintenanceControllers=new Map<string,AbortController>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private welcomeResolver?: () => void;
  private readonly assignments = new Map<string, Assignment>();
  private readonly accepted = new Set<string>();
  onOffer?: (assignment: Assignment) => Promise<boolean> | boolean;
  onStart?: (assignment: Assignment, leaseMs: number) => Promise<void> | void;
  onCancel?: (attemptId: string, reason: string) => Promise<void> | void;
  onLease?: (attemptId: string, leaseEpoch: number, leaseMs: number) => Promise<void> | void;
  onMessage?: (message: ServerMessage) => void;
  onRecovery?: (command:RecoveryCommand)=>Promise<RecoveryResponse>;
  onImported?: (ack:ImportedAck)=>Promise<void>|void;

  constructor(options: WorkerClientOptions) {
    this.stateDir = options.stateDir; this.config = options.config; this.suppliedConfig=options.config; this.suppliedReport=options.report;
    this.state = new WorkerState(`${options.stateDir}/worker.db`); this.configController = options.configController;this.nativeAudit=options.nativeAudit;
    this.unsubscribeConfig=this.configController?.onApplied(config=>{this.configReportDirty=true;if(this.config)this.config={...this.config,...config,development_roots:config.development_roots??undefined};});
    this.wsFactory = options.wsFactory ?? (url => new WebSocket(url,{maxPayload:MAX_WIRE_BYTES}));
    this.reconnectMinMs = options.reconnectMinMs ?? 1000; this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
    this.development = options.development;this.maintenance=options.maintenance;this.codebasePreparation=options.codebasePreparation;this.onAssistantEngineRequest=options.onAssistantEngineRequest;
    this.development?.sessions.setExternalOccupancy(()=>this.executionLoad('development'));
    this.development?.setOutputSink(event => { if((this.ws?.bufferedAmount??0)>1024*1024){this.ws?.close(1013,'Development output backpressure');return;}void this.send(event).catch(() => undefined); });
  }

  async connect(url?: string): Promise<void> {
    if(this.authenticated){this.authenticated=false;for(const controller of this.maintenanceControllers.values())controller.abort('connection-lost');await this.onAssistantEngineDisconnected?.();}
    this.config=validateWorkerConfig(this.suppliedConfig??await loadWorkerConfig(this.stateDir));
    url ??= this.config.url;
    if (!url) throw new Error('Worker URL is required');
    assertSecureUrl(url);
    this.stopped = false;
    if(this.configController)await this.configController.state();
    const identity = await loadIdentity(this.stateDir); const config = this.config;
    const report = this.suppliedReport ?? await buildEnvironmentReport({name:config.name,capacity:config.capacity,agentPaths:config.agent_paths,nativeAudit:this.nativeAudit});
    this.report=reportSchema.parse({...report,...(this.development||this.codebasePreparation?{development:true}:{}),...(this.maintenance&&report.tools.git?{maintenance_git:true}:{}),git_credentials:await new LocalGitCredentialStore(this.stateDir).status()});
    this.report={...this.report,tools:{...this.report.tools,'luoshu.live_progress':'1',...(this.configController?{'luoshu.worker_config':'1'}:{}),...(this.development?.codexPermissions?{'luoshu.codex_permissions':'1'}:{}),...(this.development?.rootPolicy.writable?{'luoshu.development_roots':'1'}:{})}};
    this.authenticated=false;this.authSent=false;this.liveProgressSupported=false;this.assignments.clear();this.accepted.clear();
    const ws = this.wsFactory(url.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws/worker'); this.ws = ws;
    const welcomed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('Worker authentication timed out'));},15_000);timer.unref();this.welcomeResolver=()=>{clearTimeout(timer);resolve();};ws.once('close',()=>{clearTimeout(timer);reject(new Error('Worker connection closed before authentication'));});});
    ws.on('message', raw => { const text=raw.toString();if(Buffer.byteLength(text)>MAX_WIRE_BYTES)return; if(this.ws===ws)void this.handleMessage(text, identity.privateKey, config).catch(()=>undefined); });
    ws.on('close', () => { if(this.ws!==ws)return;this.authenticated=false;void Promise.resolve(this.onAssistantEngineDisconnected?.()).catch(()=>undefined);for(const controller of this.maintenanceControllers.values())controller.abort('connection-lost'); if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); if (!this.stopped) this.scheduleReconnect(url); }); ws.on('error', () => undefined);
    await welcomed;
  }

  async reconnect(): Promise<void> { if (this.config?.url) await this.connect(this.config.url); }
  stop(): void { this.stopped = true;this.unsubscribeConfig?.();for(const controller of this.maintenanceControllers.values())controller.abort('worker-stopped');this.maintenanceControllers.clear(); if (this.reconnectTimer) clearTimeout(this.reconnectTimer); if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.ws?.close(); this.state.close(); }
  async send(message: WorkerMessage): Promise<void> { if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Worker is offline'); const payload=JSON.stringify(message);if(Buffer.byteLength(payload)>MAX_WIRE_BYTES)throw new Error('Worker message exceeds wire limit'); this.ws.send(payload); }
  pendingAssignmentCount(): number { return this.assignments.size; }
  get executionCapacity(): number { return this.config?.capacity ?? this.suppliedConfig?.capacity ?? 1; }
  executionLoad(exclude?:'native'|'development'): number {
    const ids=new Set<string>();
    // An offered assignment and its started execution are one reservation.
    for(const id of this.state.activeAttemptIds())ids.add(`execution:${id}`);
    for(const id of this.assignments.keys())ids.add(`execution:${id}`);
    for(const id of this.maintenanceControllers.keys())ids.add(`maintenance:${id}`);
    if(exclude!=='development')for(const id of this.development?.sessions.occupiedIds()??[])ids.add(`development:${id}`);
    if(exclude!=='native')for(let i=0;i<this.assistantEngineActiveCount();i++)ids.add(`native:${i}`);
    return ids.size;
  }
  async sendLiveProgress(attemptId:string,leaseEpoch:number,text:string):Promise<void>{
    if(!this.liveProgressSupported||!text||this.liveProgressPending>=64)return;
    this.liveProgressPending++;
    try{await this.send({type:'live_progress',attempt_id:attemptId,lease_epoch:leaseEpoch,text:text.slice(0,8000)});}catch{/* best effort */}finally{this.liveProgressPending--;}
  }
  private async handleMessage(text: string, privateKeyPem: string, config: WorkerConfig): Promise<void> {
    let message:ServerMessage;try{message=serverMessageSchema.parse(JSON.parse(text));}catch{this.ws?.close(1008,`Invalid protocol v${PROTOCOL_VERSION} message`);return;}
    this.onMessage?.(message);
    if(message.type==='assistant_engine_request'){
      if(!this.authenticated||!this.onAssistantEngineRequest)return;
      const generation=this.generation,socket=this.ws;
      try{const response=engineWireResponseSchema.parse(await this.onAssistantEngineRequest(message.request));if(this.authenticated&&this.generation===generation&&this.ws===socket)await this.send({type:'assistant_engine_response',response});}
      catch(error){if(this.authenticated&&this.generation===generation&&this.ws===socket)await this.send({type:'assistant_engine_error',request_id:message.request.request_id,code:'ENGINE_REQUEST_FAILED',message:String(error instanceof Error?error.message:error).slice(0,2000),retryable:false});}
      return;
    }
    if(message.type==='execution_recovery_request'){
      if(!this.authenticated||message.connection_generation!==this.generation||!this.onRecovery)return;
      const generation=this.generation;
      const response=await this.onRecovery(message);
      if(this.authenticated&&this.generation===generation)await this.send(response);
      return;
    }
    if(message.type==='worker_config_read'){
      if(!this.authenticated||!this.configController)return;
      const generation=this.generation,state=await this.configController.state();
      if(this.authenticated&&generation===this.generation){if(this.configReportDirty)await this.refreshReport();if(this.authenticated&&generation===this.generation)await this.send({type:'worker_config_state',request_id:message.request_id,...state});}
      return;
    }
    if(message.type==='worker_config_request'){
      if(!this.authenticated||!this.configController)return;
      const generation=this.generation,response=await this.configController.apply(message);
      if(this.authenticated&&generation===this.generation){try{await this.refreshReport();}finally{if(this.authenticated&&generation===this.generation)await this.send(response);}}
      return;
    }
    if(message.type==='execution_delivery_imported'){
      if(this.authenticated)await this.onImported?.(message);
      return;
    }
    if (message.type === 'development_request') {
      if (!this.authenticated || !this.development) return;
      try { await this.send({ type: 'development_response', request_id: message.request_id, result: await this.development.handle(message.command) }); }
      catch (error) { await this.send({ type: 'development_response', request_id: message.request_id, error: String(error instanceof Error ? error.message : error).slice(0, 2000) }); }
      return;
    }
    if(message.type==='codebase_prepare_request'){
      if(!this.authenticated)return;
      try{if(!this.codebasePreparation)throw new Error('Codebase preparation is unavailable');const codebases=await this.codebasePreparation.prepare(message);await this.send({type:'codebase_prepare_response',request_id:message.request_id,run_id:message.run_id,codebases});}
      catch(error){await this.send({type:'codebase_prepare_response',request_id:message.request_id,run_id:message.run_id,error:String(error instanceof Error?error.message:error).slice(0,2000)}).catch(()=>undefined);}
      return;
    }
    if(message.type==='maintenance_request'){
      if(!this.authenticated)return;
      if(this.executionLoad()>=this.executionCapacity){await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,error:'Worker capacity is full',execution_unknown:false});return;}
      if(!this.maintenance){await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,error:'Maintenance executor is unavailable',execution_unknown:false});return;}
      if(!this.report?.agents.some(agent=>agent.id===message.agent&&agent.detected)){await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,error:'Maintenance Agent is not detected or authorized on this Worker',execution_unknown:false});return;}
      if(this.maintenanceControllers.has(message.request_id)){await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,error:'Maintenance request is already active',execution_unknown:true});return;}
      const controller=new AbortController();this.maintenanceControllers.set(message.request_id,controller);const timeout=setTimeout(()=>controller.abort('maintenance-timeout'),message.timeout_seconds*1000);timeout.unref();
      try{const result=maintenanceResultSchema.parse(await this.maintenance.execute(message,controller.signal));await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,result});}
      catch(error){await this.send({type:'maintenance_response',request_id:message.request_id,attempt_id:message.attempt_id,lease_epoch:message.lease_epoch,error:String(error instanceof Error?error.message:error).slice(0,2000),execution_unknown:controller.signal.aborted||Boolean(error&&typeof error==='object'&&'executionUnknown'in error)}).catch(()=>undefined);}
      finally{clearTimeout(timeout);this.maintenanceControllers.delete(message.request_id);}
      return;
    }
    if (message.type === 'challenge') {
      if(this.authenticated||this.authSent)return;const workerId=config.worker_id;this.authSent=true;
      const payload = `luoshu:worker:v${PROTOCOL_VERSION}:${message.nonce}:${workerId}`;
      const signature = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64url');
      await this.send({ type: 'auth', worker_id: workerId, signature, report: this.report! });
    } else if (message.type === 'offer') {
      if(!this.authenticated)return;
      if (!this.authorized(message.assignment)) {
        await this.send({ type: 'reject', attempt_id: message.assignment.attempt_id, reason:'Agent is not detected on this device' });
        return;
      }
      const existing=this.assignments.get(message.assignment.attempt_id);
      if(existing){if(this.accepted.has(message.assignment.attempt_id)&&JSON.stringify(existing)===JSON.stringify(message.assignment))await this.send({type:'accept',attempt_id:message.assignment.attempt_id});else await this.send({type:'reject',attempt_id:message.assignment.attempt_id,reason:'Conflicting or pending offer'});return;}
      if(this.executionLoad()>=this.executionCapacity){await this.send({type:'reject',attempt_id:message.assignment.attempt_id,reason:'Worker capacity is full'});return;}
      this.assignments.set(message.assignment.attempt_id, message.assignment);
      const accepted=this.onOffer?await this.onOffer(message.assignment):false;if(!this.authenticated||this.assignments.get(message.assignment.attempt_id)!==message.assignment)return;if(accepted)this.accepted.add(message.assignment.attempt_id);else this.assignments.delete(message.assignment.attempt_id);
      await this.send(accepted ? { type: 'accept', attempt_id: message.assignment.attempt_id } : { type: 'reject', attempt_id: message.assignment.attempt_id, reason: 'No local executor available' });
    } else if (message.type === 'start') {
      if(!this.authenticated)return;
      const offered = this.assignments.get(message.assignment.attempt_id);
      if (!this.accepted.has(message.assignment.attempt_id) || !offered || JSON.stringify(offered) !== JSON.stringify(message.assignment) || !this.authorized(message.assignment)) {
        await this.send({ type:'reject', attempt_id:message.assignment.attempt_id, reason:'Start did not match an accepted, detected Agent offer' }); return;
      }
      const accepted = this.state.recordStart(message.assignment.attempt_id, message.assignment.lease_epoch, message.assignment);
      if (!accepted) {for(const event of this.state.unackedEventsFor(message.assignment.attempt_id))await this.send(event);return;}
      this.state.setDeadline(message.assignment.attempt_id,message.assignment.lease_epoch, Date.now() + message.lease_ms);
      try{await this.onStart?.(message.assignment,message.lease_ms);}finally{this.accepted.delete(message.assignment.attempt_id);this.assignments.delete(message.assignment.attempt_id);}
    } else if (message.type === 'lease') {
      if(!this.authenticated)return;
      if(this.state.setDeadline(message.attempt_id,message.lease_epoch, Date.now() + message.lease_ms))await this.onLease?.(message.attempt_id, message.lease_epoch, message.lease_ms);
    } else if(message.type==='reconciled'){
      if(this.authenticated)this.state.reconcile(message.attempt_id,message.lease_epoch);
    } else if (message.type === 'cancel') {
      if(!this.authenticated)return;this.accepted.delete(message.attempt_id);this.assignments.delete(message.attempt_id);
      if(this.onCancel)await this.onCancel(message.attempt_id, message.reason);else this.state.finish(message.attempt_id,'unknown');
    } else if (message.type === 'ack') {
      if(!this.authenticated)return;
      if (message.accepted) this.state.ack(message.attempt_id, message.sequence);
    } else if (message.type === 'welcome') {
      if(!this.authSent){this.ws?.close(1008,'Authentication challenge required');return;}if(message.worker_id!==config.worker_id||this.authenticated)return;this.authenticated=true;
      this.welcomeResolver?.();this.welcomeResolver=undefined;
      this.generation=message.generation;this.liveProgressSupported=message.live_progress===true;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer=setInterval(()=>{void this.send({type:'heartbeat',active:this.state.activeAttemptIds()}).catch(()=>undefined);},message.heartbeat_ms);
      await this.send({type:'heartbeat',active:this.state.activeAttemptIds()});
      for(const event of this.state.unackedEvents())await this.send(event);
    }
  }

  private async refreshReport():Promise<void>{
    this.config=await loadWorkerConfig(this.stateDir);
    const detected=await buildEnvironmentReport({name:this.config.name,capacity:this.config.capacity,agentPaths:this.config.agent_paths,nativeAudit:this.nativeAudit});
    const previous=this.report!;
    const markers=Object.fromEntries(Object.entries(previous.tools).filter(([key])=>key.startsWith('luoshu.')));
    this.report={...previous,...detected,tools:{...detected.tools,...markers},revision:previous.revision+1};
    await this.send({type:'report',report:this.report});this.configReportDirty=false;
  }

  private authorized(assignment: Assignment): boolean {
    const config=this.config;if(!config)return false;
    const agent=this.report?.agents.find(a=>a.id===assignment.agent);
    return Boolean(agent?.detected);
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * Math.max(1, this.generation));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(url).catch(() => this.scheduleReconnect(url)); }, delay);
  }
}

export async function pairWorker(options:{stateDir:string;url:string;code:string;name:string;capacity:number;codexPath?:string;opencodePath?:string;developmentRoots?:string[];maintenanceRoots?:string[];codexSandbox?:CodexSandboxMode;releaseUrl?:string;releasePublicKey?:string;fetchImpl?:typeof fetch}):Promise<{workerId:string;status:string}>{
 assertSecureUrl(options.url);
 validateComputerReleaseSource({release_url:options.releaseUrl,release_public_key:options.releasePublicKey});
 if(!Number.isInteger(options.capacity)||options.capacity<1||options.capacity>16)throw new Error('Capacity must be an integer from 1 to 16');
 const codexSandbox=codexSandboxModeSchema.parse(options.codexSandbox??'workspace-write');
 const developmentRoots=options.developmentRoots===undefined?undefined:validateDevelopmentRoots(options.developmentRoots);
 const maintenanceRoots=validateDevelopmentRoots(options.maintenanceRoots??[]);
 const paths=await resolveAgentPaths({agentPaths:{...(options.codexPath?{codex:options.codexPath}:{}),...(options.opencodePath?{opencode:options.opencodePath}:{})}});
 const report=await buildEnvironmentReport({name:options.name,capacity:options.capacity,agentPaths:paths});const identity=await createIdentity(options.stateDir);
 const response=await (options.fetchImpl??fetch)(`${options.url.replace(/\/$/,'')}/api/worker/join`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:options.code,public_key:identity.publicKey,report})});
 if(!response.ok)throw new Error(`Pairing failed (${response.status})`);
 const body=await response.json() as {worker_id:string;status:string};idSchema.parse(body.worker_id);if(body.status!=='pending')throw new Error('Invalid pairing response');
 await saveWorkerConfig(options.stateDir,{worker_id:body.worker_id,url:options.url,name:options.name,capacity:options.capacity,agent_paths:paths,
  ...(options.releaseUrl===undefined?{}:{release_url:options.releaseUrl,release_public_key:options.releasePublicKey}),
  ...(developmentRoots===undefined?{}:{development_roots:developmentRoots}),maintenance_roots:maintenanceRoots,codex_sandbox:codexSandbox});
 return{workerId:body.worker_id,status:body.status};
}

function assertSecureUrl(value: string): void {
  const parsed = new URL(value);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!loopback && parsed.protocol !== 'https:') throw new Error('Worker Coordinator URL must use HTTPS outside loopback');
  if (loopback && !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid Worker Coordinator URL');
}
