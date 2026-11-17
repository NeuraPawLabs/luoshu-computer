import {join} from 'node:path';
import type {MaintenanceRequest,DeviceServiceReport} from '../protocol/index.js';
import type {WorkerConfigController} from './config-controller.js';
import {GitMaintenance} from '../maintenance/git.js';
import {runCodex} from './codex.js';
import {runOpenCode} from './opencode.js';

export function runtimeMaintenance(stateDir:string,controller:WorkerConfigController){
 return {describe:():DeviceServiceReport=>({id:'maintenance',type:'maintenance',version:'1',agent_id:'codex',status:'ready',reason:null,features:['git']}),execute:async(request:MaintenanceRequest,signal:AbortSignal)=>{
  const state=await controller.state(),config=state.desired;
  if(!config.maintenance_roots.length)throw Error('此设备未开放维护目录');
  const git=new GitMaintenance({roots:config.maintenance_roots,worktreeRoot:join(stateDir,'maintenance-worktrees')});
  return git.execute(request,{signal,runAgent:async({cwd,instruction,agent,signal})=>{
   const adapter=agent==='codex'?runCodex:runOpenCode;
   const result=await adapter({cwd,prompt:instruction,signal,executable:config.agent_paths[agent],sandboxMode:config.codex_sandbox});
   return {exitCode:result.exitCode,summary:result.summary};
  }});
 }};
}
