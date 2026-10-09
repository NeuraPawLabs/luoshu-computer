import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { agentIdSchema, idSchema, reportSchema, PROTOCOL_VERSION, type AgentId, type WorkerReport, codexSandboxModeSchema, type CodexSandboxMode } from '@luoshu/protocol';
import { COMPUTER_VERSION } from './computer/version.js';
import {assertSystemdUserAvailable} from './agent-engines/native-systemd-supervisor.js';
import {lockWorkerConfig} from './config-lock.js';
import {validateComputerReleaseSource} from './computer/releases.js';

const execFileAsync = promisify(execFile);
const TOOLS = { git: ['--version'], node: ['--version'], codex: ['--version'], opencode: ['--version'] } as const;

export interface EnvironmentOptions { name: string; capacity: number; computerVersion?: string; probe?: (tool: keyof typeof TOOLS) => Promise<string | undefined>; agentPaths?: Partial<Record<AgentId,string>>; supervisorAvailable?:()=>Promise<boolean>; nativeAudit?:()=>Promise<'ready'|'login_required'|'permissions_unavailable'|'protocol_unsupported'> }
export interface WorkerConfig { release_repository?: string; release_url?: string; release_public_key?: string; worker_id: string; url: string; name: string; capacity: number; agent_paths?: Partial<Record<AgentId,string>>; development_roots?: string[]; development_roots_revision?: string; maintenance_roots?: string[]; codex_sandbox?: CodexSandboxMode; codex_settings_revision?: string; worker_config_revision?: string }
export interface WorkerIdentity { publicKey: string; privateKey: string }

async function defaultProbe(tool: keyof typeof TOOLS): Promise<string | undefined> {
  try { return (await execFileAsync(tool, TOOLS[tool], { timeout: 5_000, maxBuffer: 16_384 })).stdout.trim(); }
  catch { return undefined; }
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/** Resolve Agent binaries so the systemd service does not depend on an interactive shell PATH. */
export async function resolveAgentPaths(options: { agentPaths?: Partial<Record<AgentId, string>>; envPath?: string; home?: string; refreshMissing?: boolean } = {}): Promise<Partial<Record<AgentId, string>>> {
  const home = options.home ?? process.env.HOME ?? '';
  const directories = (options.envPath ?? process.env.PATH ?? '').split(':').filter(Boolean);
  if (home) {
    directories.push(join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, 'n', 'bin'), join(home, '.opencode', 'bin'));
    try {
      const versions = await readdir(join(home, '.nvm', 'versions', 'node'), { withFileTypes: true });
      for (const version of versions.filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) directories.push(join(home, '.nvm', 'versions', 'node', version.name, 'bin'));
    } catch { /* NVM is optional. */ }
  }
  const result: Partial<Record<AgentId, string>> = {};
  for (const agent of ['codex', 'opencode'] as AgentId[]) {
    const configured = options.agentPaths?.[agent];
    if (configured && !options.refreshMissing || configured && await executable(resolve(configured))) { result[agent] = resolve(configured); continue; }
    for (const directory of directories) {
      const candidate = join(directory, agent);
      if (await executable(candidate)) { result[agent] = candidate; break; }
    }
  }
  return result;
}

export function agentEnvironmentPath(agentPaths: Partial<Record<AgentId, string>>, currentPath = process.env.PATH ?? ''): string {
  return [...new Set([...Object.values(agentPaths).filter((value): value is string => Boolean(value)).map(path => dirname(path)), ...currentPath.split(':').filter(Boolean)])].join(':');
}

function version(value: string): string { return value.match(/\d+(?:\.\d+){0,3}/)?.[0] ?? value.slice(0, 120); }

export async function buildEnvironmentReport(options: EnvironmentOptions): Promise<WorkerReport> {
  const probe = options.probe ?? (async (tool:keyof typeof TOOLS)=>{ const path=options.agentPaths?.[tool as AgentId]; if(!path)return defaultProbe(tool); try{return (await execFileAsync(path,TOOLS[tool],{timeout:5_000,maxBuffer:16_384})).stdout.trim();}catch{return undefined;} });
  const entries = await Promise.all((Object.keys(TOOLS) as (keyof typeof TOOLS)[]).map(async tool => [tool, await probe(tool)] as const));
  const tools: Record<string, string> = {};
  for (const [tool, found] of entries) if (found) tools[tool] = version(found);
  const ids:AgentId[]=['codex','opencode'];
  const agents=ids.map(id=>({id, ...(tools[id]?{version:tools[id]}:{}), detected:Boolean(tools[id])}));
  const codex=agents.find(agent=>agent.id==='codex');let supervisorReady=false;if(process.platform==='linux'&&codex?.detected){try{if(options.supervisorAvailable)supervisorReady=await options.supervisorAvailable();else{await assertSystemdUserAvailable();supervisorReady=true;}}catch{/* Report the capability precisely; do not fall back to a process group. */}}
  const audit=supervisorReady?(options.nativeAudit?await options.nativeAudit().catch(()=> 'permissions_unavailable' as const):'permissions_unavailable' as const):null;
  const adapter=codex?.detected&&!supervisorReady?{version:tools.codex,status:'unavailable' as const,reason:'supervisor_unavailable' as const,features:[] as const}:codex?.detected&&audit!=='ready'?{version:tools.codex,status:'unavailable' as const,reason:audit==='login_required'?'login_required' as const:audit==='protocol_unsupported'?'protocol_unsupported' as const:'permissions_unavailable' as const,features:[] as const}:codex?.detected?{version:tools.codex,status:'ready' as const,reason:null,adapter_version:1 as const,features:['session_resume','turn_status','turn_interrupt','interaction_response','structured_events','attachments','task_operations','delivery'] as const}:null;
  const assistant_engines=codex?.detected&&adapter?[{agent:'codex' as const,agent_version:adapter.version,adapter_version:adapter.status==='ready'?1:null,status:adapter.status,reason:adapter.reason,features:[...adapter.features]}]:[];
  return reportSchema.parse({ name: options.name, os: platform(), arch: arch(), tools, capacity: options.capacity, revision: 1, protocol_version:PROTOCOL_VERSION, computer_version: options.computerVersion ?? COMPUTER_VERSION, agents,assistant_engines,...(tools.git?{maintenance_git:true}:{}) });
}

export async function createIdentity(stateDir: string): Promise<WorkerIdentity> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = `${stateDir}/identity.json`;
  try { return JSON.parse(await readFile(path, 'utf8')) as WorkerIdentity; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const identity = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return identity;
}

export async function saveWorkerConfig(stateDir: string, config: WorkerConfig): Promise<void> {
  const release=await lockWorkerConfig(stateDir);
  try{await writeWorkerConfig(stateDir,config);}finally{await release();}
}

async function writeWorkerConfig(stateDir:string,config:WorkerConfig):Promise<void> {
  config=validateWorkerConfig(config);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary=`${stateDir}/config.json.new-${randomUUID()}`;await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });await rename(temporary,`${stateDir}/config.json`);
  await chmod(`${stateDir}/config.json`, 0o600);
}

export async function loadWorkerConfig(stateDir: string): Promise<WorkerConfig> {
  return validateWorkerConfig(JSON.parse(await readFile(`${stateDir}/config.json`, 'utf8')));
}

const configUpdates = new Map<string,Promise<unknown>>();
export async function updateWorkerConfig(stateDir:string, update:(current:WorkerConfig)=>WorkerConfig):Promise<WorkerConfig> {
 const key=resolve(stateDir),previous=configUpdates.get(key)??Promise.resolve();
 const work=previous.catch(()=>{}).then(async()=>{
  const release=await lockWorkerConfig(key);
  try{const next=update(await loadWorkerConfig(key));await writeWorkerConfig(key,next);return next;}
  finally{await release();}
 });
 configUpdates.set(key,work);
 try{return await work;}finally{if(configUpdates.get(key)===work)configUpdates.delete(key);}
}

export async function loadIdentity(stateDir: string): Promise<WorkerIdentity> {
  return JSON.parse(await readFile(`${stateDir}/identity.json`, 'utf8')) as WorkerIdentity;
}

export function validateWorkerConfig(value:unknown):WorkerConfig {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Worker configuration');
 const config=value as Record<string,unknown>;
 if(Object.keys(config).some(k=>!['release_repository','release_url','release_public_key','worker_id','url','name','capacity','agent_paths','development_roots','development_roots_revision','maintenance_roots','codex_sandbox','codex_settings_revision','worker_config_revision'].includes(k)))throw new Error('Incompatible Worker configuration; join again without local Agent authorization');
 validateComputerReleaseSource(config);
 if(config.codex_sandbox!==undefined)codexSandboxModeSchema.parse(config.codex_sandbox);
 if(config.codex_settings_revision!==undefined&&typeof config.codex_settings_revision!=='string')throw Error('Invalid Codex settings revision');
 idSchema.parse(config.worker_id);
 if(typeof config.url!=='string'||typeof config.name!=='string'||!config.name||config.name.length>100||!Number.isInteger(config.capacity)||Number(config.capacity)<1||Number(config.capacity)>16)throw new Error('Invalid Worker configuration');
 new URL(config.url);
 if(config.agent_paths!==undefined){if(!config.agent_paths||typeof config.agent_paths!=='object'||Array.isArray(config.agent_paths))throw new Error('Invalid agent paths');for(const [agent,path] of Object.entries(config.agent_paths)){agentIdSchema.parse(agent);if(typeof path!=='string'||!path||path.includes('\0'))throw new Error('Invalid agent path');}}
 if(config.development_roots_revision!==undefined&&typeof config.development_roots_revision!=='string')throw new Error('Invalid development roots revision');
 if(config.worker_config_revision!==undefined&&typeof config.worker_config_revision!=='string')throw Error('Invalid Worker config revision');
 if(config.maintenance_roots!==undefined&&(!Array.isArray(config.maintenance_roots)||config.maintenance_roots.some(path=>typeof path!=='string'||!path.startsWith('/')||path.includes('\0'))))throw new Error('Invalid maintenance roots');
 if(config.development_roots!==undefined){if(!Array.isArray(config.development_roots)||config.development_roots.some(path=>typeof path!=='string'||!path||!path.startsWith('/')||path.includes('\0')))throw new Error('Invalid development roots');}
 return config as unknown as WorkerConfig;
}
