#!/usr/bin/env node
import {codexSandboxModeSchema} from '../protocol/index.js';
import {CodexPermissions} from './codex-permissions.js';
import { pairWorker, WorkerClient } from './client.js';
import { loadWorkerConfig, buildEnvironmentReport, updateWorkerConfig } from './environment.js';
import {gitSshCommand,startGitCredentialServer} from './git-helper.js';
import { Executor } from './executor.js';
import { DevelopmentService } from '../development/service.js';
import {runtimeMaintenance} from './config-maintenance.js';
import {WorkerConfigController} from './config-controller.js';
import {runCodex} from './codex.js';
import {runOpenCode} from './opencode.js';
import {join} from 'node:path';
import {runtimeDevelopmentRoots,codebasePreparation as createCodebasePreparation} from '../development/runtime-roots.js';
import {CheckpointStore} from './checkpoints.js';
import {WorkerDeliveryService} from './delivery.js';
import {attachAssistantEngine} from '../engines/runtime.js';

function args(argv:string[],allowed:string[]):Record<string,string>{const out:Record<string,string>={};for(let i=0;i<argv.length;i++){const key=argv[i]?.slice(2);if(!argv[i]?.startsWith('--')||!allowed.includes(key!)||Object.hasOwn(out,key!))throw new Error(`Unknown or repeated argument ${argv[i]}`);const value=argv[++i];if(value===undefined||value.startsWith('--'))throw new Error(`Missing value for --${key}`);out[key!]=value;}return out;}
async function main():Promise<void>{
 const [command,...rest]=process.argv.slice(2);
 if(command==='join'){
  const a=args(rest,['url','code','name','state','capacity','codex-path','opencode-path','maintenance-root','development-root','codex-sandbox']);
  if(!a.url||!a.code||!a.name||!a.state)throw new Error('join requires --url --code --name --state');
  if(a['maintenance-root']&&!a['maintenance-root'].startsWith('/'))throw new Error('Maintenance root must be absolute');
  console.log(JSON.stringify(await pairWorker({stateDir:a.state,url:a.url,code:a.code,name:a.name,codexSandbox:codexSandboxModeSchema.parse(a['codex-sandbox']??'workspace-write'),capacity:Number(a.capacity??'1'),codexPath:a['codex-path'],opencodePath:a['opencode-path'],...(a['development-root']?{developmentRoots:[a['development-root']]}:{}),maintenanceRoots:a['maintenance-root']?[a['maintenance-root']]:[]})));return;
 }
 if(command==='agents'){
  const a=args(rest,['state','codex-path','opencode-path']);const mutating=a['codex-path']!==undefined||a['opencode-path']!==undefined;
  if(!a.state){if(mutating)throw new Error('Agent path changes require --state');console.log(JSON.stringify(await buildEnvironmentReport({name:'local',capacity:1})));return;}
  const config=await loadWorkerConfig(a.state);const paths={...config.agent_paths,...(a['codex-path']?{codex:a['codex-path']}:{}),...(a['opencode-path']?{opencode:a['opencode-path']}:{})};
  if(mutating)await updateWorkerConfig(a.state,current=>({...current,agent_paths:{...current.agent_paths,...(a['codex-path']?{codex:a['codex-path']}:{}),...(a['opencode-path']?{opencode:a['opencode-path']}:{})}}));
  console.log(JSON.stringify(await buildEnvironmentReport({name:config.name,capacity:config.capacity,agentPaths:paths})));return;
 }
 if(command==='run'){
  const a=args(rest,['state']);if(!a.state)throw new Error('run requires --state');const config=await loadWorkerConfig(a.state),ssh=gitSshCommand(a.state);const codexPermissions=new CodexPermissions(a.state),configController=new WorkerConfigController(a.state);const rootPolicy=runtimeDevelopmentRoots(a.state,config);let client!: WorkerClient;let codexEngine!:ReturnType<typeof attachAssistantEngine>;const development=new DevelopmentService({managedConfig:true,codexPermissions,rootPolicy,gitSshCommand:ssh,roots:config.development_roots,agentPaths:config.agent_paths,maxSessions:config.capacity});const maintenance=runtimeMaintenance(a.state,configController);const codebasePreparation=createCodebasePreparation(a.state,rootPolicy,ssh);client=new WorkerClient({stateDir:a.state,configController,development,codebasePreparation,nativeAudit:()=>codexEngine.audit(),...(maintenance?{maintenance}:{})});const checkpoints=new CheckpointStore(client.state.db),delivery=new WorkerDeliveryService({state:client.state,checkpoints,stateDir:a.state,isExecutionActive:id=>client.state.activeAttemptIds().includes(id)}),interrupted=client.state.recoverInterrupted();
  const helper=await startGitCredentialServer(a.state);
  const executor=new Executor({codexPermissions,gitSshCommand:ssh,rootPolicy,state:client.state,stateDir:a.state,agentPaths:config.agent_paths,checkpoints,delivery,emitLive:(id,epoch,text)=>client.sendLiveProgress(id,epoch,text),emit:async event=>{client.state.appendEvent(event);try{await client.send(event);}catch{}}});
  configController.onApplied((config,revision)=>{development.applyConfig(config,revision);executor.updateConfig(config.agent_paths,config.codex_sandbox);});
  codexEngine=attachAssistantEngine({client,stateDir:a.state,workerId:config.worker_id,executable:config.agent_paths?.codex,rootPolicy,gitSshCommand:ssh,sandboxMode:()=>codexPermissions.mode()});
  configController.onApplied((next,revision)=>codexEngine.applyConfig(next));
  let shuttingDown=false;const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await development.stopAll();await executor.stopAll('worker-shutdown');await delivery.close();await codexEngine.close();await helper.close();client.stop();};process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  client.onRecovery=command=>delivery.handle(command);
  client.onImported=ack=>delivery.markImported(ack.execution_id,ack.delivery_id,ack.package_sha256);
  client.onOffer=()=>!shuttingDown;client.onStart=async(assignment,leaseMs)=>{await executor.runAttempt(assignment,leaseMs);};client.onLease=(id,epoch,leaseMs)=>{executor.renewLease(id,epoch,leaseMs);};client.onCancel=async(id,reason)=>{await executor.stop(id,reason);};
  for(const item of interrupted)client.state.appendEvent({type:'event',attempt_id:item.attemptId,lease_epoch:item.leaseEpoch,sequence:client.state.nextSequence(item.attemptId),event:{type:'unknown',reason:'Worker restarted without a verifiable supervised process'}});
  try{await client.connect();}catch(error){await shutdown();throw error;}return;
 }
 throw new Error('Usage: worker join|agents|run');
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
