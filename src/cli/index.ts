import {codexSandboxModeSchema, type CodexSandboxMode} from '../protocol/index.js';
export type ComputerCommand =
  | { command: 'setup'; releaseUrl?: string; releaseKey?: string; server: string; code: string; name: string; capacity?: number; maintenanceRoot?:string; developmentRoots?:string[]; codexSandbox?:CodexSandboxMode }
  | { command: 'update'; dev?: boolean }
  | { command: 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'uninstall' | 'daemon'; purge?: boolean };

import { resolveComputerPaths } from './paths.js';
import { setupComputer } from './setup.js';
import { computerDoctor, computerStatus, uninstallComputer } from './diagnostics.js';
import { runComputerDaemon } from './daemon.js';
import { buildEnvironmentReport, loadWorkerConfig } from '../runtime/environment.js';
import { WorkerState } from '../runtime/state.js';
import {fetchComputerRelease} from './releases.js';
import { applyComputerUpdate } from './update.js';
import {computerUpdateBlockers} from './update-activity.js';
import { execFile } from 'node:child_process';
import { CodexAppServerPool } from '../engines/codex-pool.js';

const systemd = (action: 'start' | 'stop' | 'restart'): Promise<void> => new Promise((resolve, reject) => {
  execFile('systemctl', ['--user', action, 'luoshu-computer.service'], error => error ? reject(error) : resolve());
});

async function environmentReport(paths:ReturnType<typeof resolveComputerPaths>,config:Awaited<ReturnType<typeof loadWorkerConfig>>){
 const pool=new CodexAppServerPool({stateDir:paths.state,executable:config.agent_paths?.codex});
 try{return await buildEnvironmentReport({name:config.name,capacity:config.capacity,agentPaths:config.agent_paths,nativeAudit:()=>pool.audit(`computer-cli-${config.worker_id}`)});}
 finally{await pool.close().catch(()=>undefined);}
}

function args(argv: string[], allowed: string[]) {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--') || !allowed.includes(token.slice(2)) || Object.hasOwn(output, token.slice(2))) {
      throw new Error(`Unknown or repeated argument ${token ?? ''}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    output[token.slice(2)] = value;
    index += 1;
  }
  return output;
}

export function parseComputerCommand(argv: string[]): ComputerCommand {
  const [command, ...rest] = argv;
  if (command === 'setup') {
    const developmentRoots: string[] = [], others: string[] = [];
    for (let i=0;i<rest.length;i+=2) {
      if(rest[i]==='--development-root') {
        const path=rest[i+1];if(!path?.startsWith('/'))throw Error('Development root must be absolute');
        developmentRoots.push(path);
      } else others.push(...rest.slice(i,i+2));
    }
    if(developmentRoots.length>32)throw Error('At most 32 development roots are allowed');
    const value = args(others, ['server', 'code', 'name','capacity','maintenance-root','codex-sandbox','release-url','release-key']);
    if ((value['release-url'] !== undefined) !== (value['release-key'] !== undefined)) throw new Error('Computer release URL and key file must be specified together');
    if (value['release-url'] === '' || value['release-key'] === '') throw new Error('Computer release URL and key file must not be empty');
    if (!value.server || !value.code || !value.name) throw new Error('setup requires --server --code --name');
    if(value['maintenance-root']&&!value['maintenance-root'].startsWith('/'))throw new Error('Maintenance root must be absolute');
    const capacity = value.capacity === undefined ? undefined : Number(value.capacity);
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)) throw new Error('Capacity must be an integer from 1 to 16');
    return { ...(value['release-url']?{releaseUrl:value['release-url'],releaseKey:value['release-key']}:{}), ...(value['codex-sandbox']?{codexSandbox:codexSandboxModeSchema.parse(value['codex-sandbox'])}:{}), command, server: value.server, code: value.code, name: value.name,...(capacity === undefined ? {} : { capacity }), ...(value['maintenance-root']?{maintenanceRoot:value['maintenance-root']}:{}),...(developmentRoots.length?{developmentRoots}:{}) };
  }
  if (command === 'uninstall') {
    const value = args(rest, ['purge']);
    return { command, ...(value.purge === 'true' ? { purge: true } : {}) };
  }
  if (command === 'update') {
    if (rest.length === 0) return {command};
    if (rest.length === 1 && rest[0] === '--dev') return {command, dev: true};
    throw new Error(`Unknown or repeated argument ${rest[0]}`);
  }
  if (command && ['start', 'stop', 'restart', 'status', 'doctor', 'daemon'].includes(command)) {
    if (rest.length) throw new Error(`Unknown or repeated argument ${rest[0]}`);
    return { command: command as 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'daemon' };
  }
  throw new Error('Commands: setup | start | stop | restart | status | doctor | update | uninstall | daemon');
}

export async function runComputerCli(argv: string[]): Promise<number> {
  const command = parseComputerCommand(argv);
  const paths = resolveComputerPaths();
  if (command.command === 'setup') {
    const result = await setupComputer({ ...command, paths });
    console.log(JSON.stringify(result));
    return 0;
  }
  if (command.command === 'start' || command.command === 'stop' || command.command === 'restart') {
    await systemd(command.command);
    return 0;
  }
  if (command.command === 'status') {
    const config = await loadWorkerConfig(paths.state);
    const report = await environmentReport(paths,config);
    console.log(JSON.stringify(await computerStatus({ paths, report, readConfig: async () => config })));
    return 0;
  }
  if (command.command === 'doctor') {
    let report;
    try {
      const config = await loadWorkerConfig(paths.state);
      report = await environmentReport(paths,config);
    } catch { /* computerDoctor reports the configuration problem */ }
    const checks = await computerDoctor({ paths, report });
    console.log(JSON.stringify(checks));
    return checks.some(check => check.status === 'error') ? 1 : 0;
  }
  if (command.command === 'update') {
    const config = await loadWorkerConfig(paths.state);
    const {manifest, download} = await fetchComputerRelease(config);
    const state = new WorkerState(`${paths.state}/worker.db`);
    try {
      const result = await applyComputerUpdate({
        paths,
        manifest,
        dev: command.dev,
        download,
        activeAttemptIds: () => computerUpdateBlockers(state.db),
      });
      console.log(JSON.stringify(result));
      return 0;
    } finally {state.close();}
  }
  if (command.command === 'uninstall') {
    await uninstallComputer({ paths, purge: command.purge, run: async (program, args) => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => execFile(program, args, error => error ? reject(error) : resolve()));
    }});
    return 0;
  }
  if (command.command === 'daemon') {
    await runComputerDaemon({ paths });
    return 0;
  }
  throw new Error(`Computer command ${command.command} is not implemented yet`);
}
