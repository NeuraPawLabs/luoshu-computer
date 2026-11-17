import {access, stat, readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {redact} from '../shared/security.js';
import {deviceConfigurationStateSchema,deviceMutableConfigurationSchema,type DeviceConfigurationState,type DeviceMutableConfiguration} from '../protocol/index.js';
import {loadWorkerConfig,saveWorkerConfig,updateWorkerConfig,type WorkerConfig} from './environment.js';
import {validateDevelopmentRoots} from '../development/root-policy.js';

export function mutableConfig(config: WorkerConfig): DeviceMutableConfiguration {
  const roots=config.development_roots;
  const development_policy=roots===undefined?{mode:'home' as const,roots:[] as []}:roots.length===0?{mode:'disabled' as const,roots:[] as []}:{mode:'custom' as const,roots:roots as [string,...string[]]};
  return deviceMutableConfigurationSchema.parse({name:config.name,capacity:config.capacity,agent_paths:config.agent_paths??{},development_policy,maintenance_roots:config.maintenance_roots??[],codex_sandbox:config.codex_sandbox??'workspace-write'});
}
function revisionOf(config:WorkerConfig,value:DeviceMutableConfiguration):string{return createHash('sha256').update(JSON.stringify([config.worker_config_revision??'',value])).digest('hex');}
function stateOf(config:WorkerConfig):DeviceConfigurationState{const value=mutableConfig(config),revision=config.worker_config_revision??`local-${revisionOf(config,value)}`;return{desired_revision:revision,applied_revision:revision,desired:value,applied:value,status:'applied',error:null};}
function localPatch(current:WorkerConfig,config:DeviceMutableConfiguration,revision:string):WorkerConfig {
  const {development_policy,...rest}=config;
  const next:WorkerConfig={...current,name:rest.name,capacity:rest.capacity,agent_paths:rest.agent_paths,maintenance_roots:rest.maintenance_roots,codex_sandbox:rest.codex_sandbox,worker_config_revision:revision,development_roots_revision:revision,codex_settings_revision:revision};
  if(development_policy.mode==='custom')next.development_roots=[...development_policy.roots];
  else if(development_policy.mode==='disabled')next.development_roots=[];
  else delete next.development_roots;
  return next;
}
export class WorkerConfigController {
  private readonly listeners=new Set<(config:DeviceMutableConfiguration,revision:string)=>void|Promise<void>>();
  private tail:Promise<unknown>=Promise.resolve();
  private applied?:DeviceConfigurationState;
  private readonly statePath:string;
  constructor(private readonly stateDir:string) { this.statePath=`${stateDir}/configuration-state.json`; }
  private async persist(state:DeviceConfigurationState):Promise<void>{await mkdir(this.stateDir,{recursive:true,mode:0o700});const temporary=`${this.statePath}.new-${randomUUID()}`;await writeFile(temporary,`${JSON.stringify(state)}\n`,{mode:0o600});await rename(temporary,this.statePath);}
  private async saved():Promise<DeviceConfigurationState|null>{try{return deviceConfigurationStateSchema.parse(JSON.parse(await readFile(this.statePath,'utf8')));}catch{return null;}}
  private async stateFor(config:WorkerConfig):Promise<DeviceConfigurationState> {
    const value=stateOf(config),saved=await this.saved();
    if(saved && JSON.stringify(saved.applied)===JSON.stringify(value.applied))return saved;
    if(this.applied && JSON.stringify(this.applied.applied)!==JSON.stringify(value.applied)) { const revision=`local-${revisionOf(config,value.applied!)}`; return {...value,desired_revision:revision,applied_revision:revision}; }
    return value;
  }
  state():Promise<DeviceConfigurationState>{const work=this.tail.catch(()=>{}).then(async()=>{const current=await loadWorkerConfig(this.stateDir),value=await this.stateFor(current);if(!this.applied||this.applied.desired_revision!==value.desired_revision||JSON.stringify(this.applied.applied)!==JSON.stringify(value.applied)){await this.reconcile(value);this.applied=value;await this.persist(value);}return structuredClone(this.applied!);});this.tail=work;return work;}
  private async reconcile(state:DeviceConfigurationState){const config=state.status==='applied'?state.desired:state.applied??state.desired;const revision=state.status==='applied'?state.desired_revision:state.applied_revision??state.desired_revision;for(const listener of this.listeners)await listener(structuredClone(config),revision);}
  onApplied(listener:(config:DeviceMutableConfiguration,revision:string)=>void|Promise<void>){this.listeners.add(listener);this.applied=undefined;return()=>this.listeners.delete(listener);}
  apply(request:any):Promise<DeviceConfigurationState>{const work=this.tail.catch(()=>{}).then(()=>this.applyOnce(request));this.tail=work;return work as Promise<DeviceConfigurationState>;}
  private async applyOnce(request:any):Promise<DeviceConfigurationState>{
    const desiredRevision=String(request.desired_revision??request.revision??'');const expectedRevision=String(request.expected_revision??'');let before:WorkerConfig|undefined;let previous:DeviceConfigurationState|undefined;
    try{
      if(!desiredRevision)throw Error('Missing desired revision');
      const config=deviceMutableConfigurationSchema.parse(request.config);
      if(config.development_policy.mode==='custom')validateDevelopmentRoots([...config.development_policy.roots]);
      validateDevelopmentRoots(config.maintenance_roots);
      for(const [agent,path] of Object.entries(config.agent_paths))if(path){if(!(await stat(path)).isFile())throw Error(`${agent} executable is not a file: ${path}`);await access(path,constants.X_OK).catch(()=>{throw Error(`${agent} executable is not available: ${path}`);});}
      before=await loadWorkerConfig(this.stateDir);previous=await this.stateFor(before);
      const expectedApplied=previous.applied_revision??previous.desired_revision;
      if(expectedRevision!==expectedApplied&&expectedRevision!==previous.desired_revision)throw Error('Worker local configuration changed; reread before saving');
      if(previous.desired_revision===desiredRevision&&JSON.stringify(previous.desired)===JSON.stringify(config)&&previous.status==='applied')return previous;
      const pending:DeviceConfigurationState={desired_revision:desiredRevision,applied_revision:previous.applied_revision,desired:config,applied:previous.applied,status:'pending',error:null};
      await this.persist(pending);this.applied=pending;
      const next=localPatch(before,config,desiredRevision);await updateWorkerConfig(this.stateDir,()=>next);
      try{for(const listener of this.listeners)await listener(structuredClone(config),desiredRevision);}
      catch(error){await saveWorkerConfig(this.stateDir,before);throw Object.assign(error instanceof Error?error:new Error(String(error)),{configurationBlocked:true});}
      const applied=stateOf(next);this.applied=applied;await this.persist(applied);return structuredClone(applied);
    }catch(error){
      const current=before??await loadWorkerConfig(this.stateDir),applied=await this.stateFor(current),message=redact(error instanceof Error?error.message:String(error)).slice(0,2000);
      const desired=request.config&&deviceMutableConfigurationSchema.safeParse(request.config).success?deviceMutableConfigurationSchema.parse(request.config):applied.desired;
      const failed:DeviceConfigurationState={desired_revision:desiredRevision||applied.desired_revision,applied_revision:applied.applied_revision,desired,applied:applied.applied,status:(error as {configurationBlocked?:boolean})?.configurationBlocked?'blocked':'failed',error:message};
      await this.reconcile(failed);this.applied=failed;await this.persist(failed);return failed;
    }
  }
}
