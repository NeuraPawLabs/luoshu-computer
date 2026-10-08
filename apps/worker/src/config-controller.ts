import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {redact} from '@luoshu/config/security';
import {workerMutableConfigSchema, type WorkerConfigRequest, type WorkerConfigResponse, type WorkerMutableConfig} from '@luoshu/protocol';
import {loadWorkerConfig, updateWorkerConfig, type WorkerConfig} from './environment.js';
import {validateDevelopmentRoots} from './development/root-policy.js';

export function mutableConfig(config: WorkerConfig): WorkerMutableConfig {
  return workerMutableConfigSchema.parse({name:config.name, capacity:config.capacity, agent_paths:config.agent_paths??{},
    development_roots:config.development_roots??null, maintenance_roots:config.maintenance_roots??config.development_roots??[],
    codex_sandbox:config.codex_sandbox??'workspace-write'});
}
function stateOf(config:WorkerConfig) {
  const value=mutableConfig(config);
  // Include content to detect edits by a local CLI or an older config editor.
  const revision=createHash('sha256').update(JSON.stringify([config.worker_config_revision??'',value])).digest('hex');
  return {revision,config:value};
}
export class WorkerConfigController {
  private readonly listeners=new Set<(config:WorkerMutableConfig,revision:string)=>void|Promise<void>>();
  private tail:Promise<unknown>=Promise.resolve();
  private appliedRevision:string|undefined;
  constructor(private readonly stateDir:string) {}
  state(){
    const work=this.tail.catch(()=>{}).then(async()=>{
      const current=await loadWorkerConfig(this.stateDir),value=stateOf(current);
      await this.reconcile(value);
      return {...value,request_revision:current.worker_config_revision??null};
    });this.tail=work;return work;
  }
  private async reconcile(value:ReturnType<typeof stateOf>){
    if(this.appliedRevision===value.revision)return;
    for(const listener of this.listeners)await listener(structuredClone(value.config),value.revision);
    this.appliedRevision=value.revision;
  }
  onApplied(listener:(config:WorkerMutableConfig,revision:string)=>void|Promise<void>){this.listeners.add(listener);this.appliedRevision=undefined;return()=>this.listeners.delete(listener);}
  apply(request:Omit<WorkerConfigRequest,'type'>):Promise<WorkerConfigResponse>{
    const work=this.tail.catch(()=>{}).then(()=>this.applyOnce(request));this.tail=work;return work;
  }
  private async applyOnce(request:Omit<WorkerConfigRequest,'type'>):Promise<WorkerConfigResponse>{
    try {
      const config=workerMutableConfigSchema.parse(request.config);
      validateDevelopmentRoots(config.development_roots??[homedir()]);validateDevelopmentRoots(config.maintenance_roots);
      for(const [agent,path] of Object.entries(config.agent_paths))if(path){
        if(!(await stat(path)).isFile())throw Error(`${agent} executable is not a file: ${path}`);
        await access(path,constants.X_OK).catch(()=>{throw Error(`${agent} executable is not available: ${path}`);});
      }
      const result=await updateWorkerConfig(this.stateDir,current=>{
        if(current.worker_config_revision===request.revision){
          if(JSON.stringify(mutableConfig(current))!==JSON.stringify(config))throw Error('Worker 配置版本与内容不一致');
          return current;
        }
        if(stateOf(current).revision!==request.expected_revision)throw Error('Worker 本地配置已改变，请重新读取后保存');
        const {development_roots:_old,...rest}=current;
        const {development_roots,...next}=config;
        return {...rest,...next,...(development_roots===null?{}:{development_roots}),worker_config_revision:request.revision,
          development_roots_revision:request.revision,codex_settings_revision:request.revision};
      });
      const applied=stateOf(result);
      await this.reconcile(applied);
      return {type:'worker_config_response',request_id:request.request_id,revision:request.revision,status:'applied',applied_revision:applied.revision,config:applied.config};
    }catch(error){
      const applied=stateOf(await loadWorkerConfig(this.stateDir));
      await this.reconcile(applied);
      return {type:'worker_config_response',request_id:request.request_id,revision:request.revision,status:'failed',applied_revision:applied.revision,config:applied.config,error:redact(error instanceof Error?error.message:String(error)).slice(0,2000)};
    }
  }
}
