import {CodexPermissions} from '../codex-permissions.js';
import {gitSshCommand,startGitCredentialServer} from '../git-helper.js';
import { WorkerClient } from '../client.js';
import { Executor } from '../executor.js';
import { agentEnvironmentPath, loadWorkerConfig, resolveAgentPaths, updateWorkerConfig } from '../environment.js';
import {fetchComputerRelease} from './releases.js';
import { applyComputerUpdate, confirmComputerUpdate } from './update.js';
import { execFile } from 'node:child_process';
import type { ComputerPaths } from './paths.js';
import { DevelopmentService } from '../development/service.js';
import {runtimeMaintenance} from '../config-maintenance.js';
import {runCodex} from '../codex.js';
import {runOpenCode} from '../opencode.js';
import {join} from 'node:path';
import {runtimeDevelopmentRoots,codebasePreparation as createCodebasePreparation} from '../development/runtime-roots.js';
import {CheckpointStore} from '../checkpoints.js';
import {WorkerDeliveryService} from '../delivery.js';
import {WorkerConfigController} from '../config-controller.js';
import {attachAssistantEngine} from '../agent-engines/runtime.js';

export async function runComputerDaemon(options: { paths: ComputerPaths }): Promise<void> {
  const config = await loadWorkerConfig(options.paths.state);
  const agentPaths = await resolveAgentPaths({ agentPaths: config.agent_paths, refreshMissing: true });
  if (JSON.stringify(agentPaths) !== JSON.stringify(config.agent_paths ?? {})) {
    await updateWorkerConfig(options.paths.state, current=>({ ...current, agent_paths: agentPaths }));
  }
  process.env.PATH = agentEnvironmentPath(agentPaths);
  const codexPermissions=new CodexPermissions(options.paths.state);
  const configController=new WorkerConfigController(options.paths.state);
  const rootPolicy = runtimeDevelopmentRoots(options.paths.state, config);
  let client!: WorkerClient;
  const development = new DevelopmentService({ managedConfig:true, codexPermissions, rootPolicy, gitSshCommand:gitSshCommand(options.paths.state), roots: config.development_roots, agentPaths, maxSessions: config.capacity });
  const maintenance=runtimeMaintenance(options.paths.state,configController);
  const ssh=gitSshCommand(options.paths.state);const codebasePreparation=createCodebasePreparation(options.paths.state,rootPolicy,ssh);
  let codexEngine!:ReturnType<typeof attachAssistantEngine>;
  client = new WorkerClient({ stateDir: options.paths.state, configController, development, codebasePreparation, nativeAudit:()=>codexEngine.audit(), ...(maintenance?{maintenance}:{}) });
  codexEngine=attachAssistantEngine({client,stateDir:options.paths.state,workerId:config.worker_id,executable:agentPaths.codex,rootPolicy,gitSshCommand:ssh,sandboxMode:()=>codexPermissions.mode()});
  const checkpoints=new CheckpointStore(client.state.db);
  const delivery=new WorkerDeliveryService({state:client.state,checkpoints,stateDir:options.paths.state,isExecutionActive:id=>client.state.activeAttemptIds().includes(id)});
  for(const item of client.state.recoverInterrupted())client.state.appendEvent({type:'event',attempt_id:item.attemptId,lease_epoch:item.leaseEpoch,sequence:client.state.nextSequence(item.attemptId),event:{type:'unknown',reason:'Worker restarted without verified completion'}});
  const gitHelper = await startGitCredentialServer(options.paths.state);
  const executor = new Executor({
    codexPermissions, gitSshCommand: ssh,
    state: client.state,
    stateDir: options.paths.state,
    rootPolicy,
    agentPaths,checkpoints,delivery,
    emitLive: (id,epoch,text) => client.sendLiveProgress(id,epoch,text),
    emit: async event => { client.state.appendEvent(event); await client.send(event).catch(() => undefined); },
  });
  configController.onApplied((config,revision)=>{development.applyConfig(config,revision);executor.updateConfig(config.agent_paths,config.codex_sandbox);codexEngine.applyConfig(config);});
  client.onRecovery=command=>delivery.handle(command);
  client.onImported=ack=>delivery.markImported(ack.execution_id,ack.delivery_id,ack.package_sha256);
  client.onOffer = () => true;
  client.onStart = async (assignment, leaseMs) => { await executor.runAttempt(assignment, leaseMs); };
  client.onCancel = async (id, reason) => { await executor.stop(id, reason); };
  client.onLease = (id, epoch, leaseMs) => { executor.renewLease(id, epoch, leaseMs); };
  let stopping = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve; });
  const stop = async () => { if (stopping) return; stopping = true; try { await development.stopAll(); await executor.stopAll('computer-shutdown'); await delivery.close(); await codexEngine.close(); await gitHelper.close(); client.stop(); } finally { resolveShutdown(); } };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  try{await client.connect();}catch(error){await codexEngine.close();await gitHelper.close();client.stop();throw error;}
  await confirmComputerUpdate(options.paths);
  const checkUpdate = async () => {
    try {
      const {manifest, download} = await fetchComputerRelease(config);
      const result = await applyComputerUpdate({
        paths: options.paths,
        manifest,
        download,
        activeAttemptIds: () => [...delivery.activeRecoveryIds(), ...Array.from({ length: client.executionLoad() }, (_, index) => `execution-slot-${index}`)],
      });
      if (result.status === 'updated') {
        await new Promise<void>((resolve, reject) => execFile('systemctl', ['--user', 'restart', 'luoshu-computer.service'], error => error ? reject(error) : resolve()));
      }
    } catch { /* keep the current version; doctor exposes update failures separately in a later pass */ }
  };
  void checkUpdate();
  const updateTimer = setInterval(() => void checkUpdate(), 24 * 60 * 60 * 1000);
  await shutdown;
  clearInterval(updateTimer);
}
