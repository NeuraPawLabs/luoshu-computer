import {PtyOutputBuffer} from './output-buffer.js';
import type {CodexPermissions} from '../codex-permissions.js';
import * as pty from 'node-pty';
import type {DevelopmentRootPolicy} from './root-policy.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter } from 'node:path';
import { agentIdSchema, type AgentId, type CodexSandboxMode, type DevelopmentOutput, type DevelopmentResult, type DevelopmentSession } from '@luoshu/protocol';

const LEASE_MS = 120_000;
const STOP_GRACE_MS = 2_000;
const SESSION_LIST_LIMIT = 100;
type OpenCommand = Extract<import('@luoshu/protocol').DevelopmentCommand, { action: 'open' }>;

interface SessionRecord { spec: OpenCommand; session: DevelopmentSession; child: pty.IPty; output:PtyOutputBuffer; pendingOutput:string; flushTimer?:ReturnType<typeof setTimeout>; timer: ReturnType<typeof setTimeout>; stopping: boolean; createdAt: number; updatedAt: number; release: () => void }
export interface DevelopmentSessionOptions { codexPermissions?:CodexPermissions; roots?: string[]; rootPolicy?: DevelopmentRootPolicy; agentPaths?: Partial<Record<AgentId, string>>; maxSessions?: number; gitSshCommand?: string; leaseMs?: number; activeCount?: () => number; onOutput?: (event: DevelopmentOutput) => void; }

export class DevelopmentSessions {
  private readonly codexPermissions?:CodexPermissions;
  private readonly rootPolicy?: DevelopmentRootPolicy;
  private readonly opening=new Map<string,{spec:OpenCommand;promise:Promise<Extract<DevelopmentResult,{action:'open'}>>}>();
  private closing=false;
  private readonly records = new Map<string, SessionRecord>();
  private readonly gitSshCommand?: string;
  private paths: Partial<Record<AgentId, string>>;
  private maxSessions: number;
  private sandboxMode?:CodexSandboxMode;
  private readonly leaseMs: number;
  private activeCount: () => number;
  private onOutput?: (event: DevelopmentOutput) => void;
  constructor(options: DevelopmentSessionOptions = {}) { this.codexPermissions=options.codexPermissions; this.rootPolicy=options.rootPolicy; this.gitSshCommand=options.gitSshCommand; this.paths = {...options.agentPaths}; this.maxSessions = options.maxSessions ?? 16; this.leaseMs = options.leaseMs ?? LEASE_MS; this.activeCount = options.activeCount ?? (() => 0); this.onOutput = options.onOutput; }
  setOutputSink(sink: (event: DevelopmentOutput) => void): void { this.onOutput = sink; }
  setExternalOccupancy(count:()=>number):void { this.activeCount=count; }
  updateConfig(agentPaths: Partial<Record<AgentId,string>>, maxSessions: number, sandboxMode?:CodexSandboxMode): void { this.paths = {...agentPaths}; this.maxSessions = maxSessions; this.sandboxMode=sandboxMode; }

  open(command:OpenCommand):Promise<Extract<DevelopmentResult,{action:'open'}>> {
    const pending=this.opening.get(command.session_id);
    if(pending)return JSON.stringify(pending.spec)===JSON.stringify(command)?pending.promise:Promise.reject(Error('Session ID is already opening with a different specification'));
    if(this.closing)return Promise.reject(Error('Development service is shutting down'));
    const promise=this.openProcess(command);this.opening.set(command.session_id,{spec:command,promise});
    void promise.finally(()=>{if(this.opening.get(command.session_id)?.promise===promise)this.opening.delete(command.session_id);}).catch(()=>{});
    return promise;
  }
  private async openProcess(command: OpenCommand): Promise<Extract<DevelopmentResult, { action: 'open' }>> {
    const existing = this.records.get(command.session_id);
    if (existing) { if (JSON.stringify(existing.spec) !== JSON.stringify(command)) throw new Error('Session ID is already open with a different specification'); return { action: 'open', session: existing.session }; }
    if (this.occupied() >= this.maxSessions || this.activeCount() + this.occupied() >= this.maxSessions) throw new Error('Development session capacity is full');
    agentIdSchema.parse(command.agent);
    const paths={...this.paths},sandboxMode=this.sandboxMode;
    const executable = await this.resolve(command.agent,paths);
    if (command.mode === 'resume' && !command.agent_session_id) throw new Error('A native Agent session is required to resume');
    const args = command.mode === 'resume' ? command.agent === 'codex' ? ['resume', command.agent_session_id!] : ['--session', command.agent_session_id!] : [];
    if(command.agent==='codex'&&(this.codexPermissions||sandboxMode)){const mode=sandboxMode??await this.codexPermissions!.mode();args.push('--sandbox',mode);if(mode==='danger-full-access')args.push('-c','approval_policy="never"');}
    const gitEnv=this.gitSshCommand?{GIT_SSH_COMMAND:this.gitSshCommand,GIT_SSH_VARIANT:'ssh'}:{};
    if(command.agent==='codex'&&this.gitSshCommand)args.push('-c','sandbox_workspace_write.network_access=true',...Object.entries(gitEnv).flatMap(([key,value])=>['-c',`shell_environment_policy.set.${key}=${JSON.stringify(value)}`]));
    const release = this.rootPolicy?.acquire(`session:${command.session_id}`, 'session', [command.cwd], async () => { await this.stop(command.session_id, 'directory-access-removed'); }) ?? (() => {});
    let child: pty.IPty;
    try { child = pty.spawn(executable, args, { name: 'xterm-256color', cols: command.cols, rows: command.rows, cwd: command.cwd, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color', ...gitEnv } as Record<string, string> }); } catch (error) { release(); throw error; }
    const session: DevelopmentSession = { id: command.session_id, agent: command.agent, cwd: command.cwd, mode: command.mode, status: 'running', ...(command.agent_session_id ? { agent_session_id: command.agent_session_id } : {}) };
    const now = Date.now();
    const record = { spec: command, session, child, output:new PtyOutputBuffer(),pendingOutput:'',flushTimer:undefined as ReturnType<typeof setTimeout>|undefined, timer: undefined as unknown as ReturnType<typeof setTimeout>, stopping: false, createdAt: now, updatedAt: now, release };
    record.timer = setTimeout(() => { void this.stop(command.session_id, 'lease-expired'); }, this.leaseMs);
    this.records.set(command.session_id, record);
    child.onData(data => {record.updatedAt=Date.now();record.pendingOutput+=data;if(record.pendingOutput.length>=4096)this.flush(record);else if(!record.flushTimer)record.flushTimer=setTimeout(()=>this.flush(record),8);});
    child.onExit(event => { this.flush(record); record.release(); record.updatedAt = Date.now(); if (record.session.status === 'running') { record.session.status = 'exited'; record.session.exit_code = event.exitCode; record.session.reason = event.signal ? `signal:${event.signal}` : 'process-exited'; } clearTimeout(record.timer); this.emit(record, record.output.nextSequence++, ''); });
    return { action: 'open', session };
  }

  read(id: string, after: number): Extract<DevelopmentResult, { action: 'read' }> {
    const record=this.require(id);this.flush(record);return{action:'read',session:record.session,...record.output.read(after)};
  }
  list(path: string): Extract<DevelopmentResult, { action: 'sessions' }> {
    const matching = [...this.records.values()].filter(record => record.session.cwd === path).sort((left, right) => right.updatedAt - left.updatedAt);
    return { action: 'sessions', path, sessions: matching.slice(0, SESSION_LIST_LIMIT).map(record => ({ id: record.session.id, agent: record.session.agent, cwd: record.session.cwd, title: `${record.session.agent} Agent`, created_at: record.createdAt, updated_at: record.updatedAt })), truncated: matching.length > SESSION_LIST_LIMIT };
  }
  activeSessions(): Extract<DevelopmentResult, { action: 'active_sessions' }> {
    const matching = [...this.records.values()]
      .filter(record => record.session.status === 'running')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      action: 'active_sessions',
      sessions: matching.slice(0, SESSION_LIST_LIMIT).map(record => ({
        id: record.session.id,
        agent: record.session.agent,
        cwd: record.session.cwd,
        title: `${record.session.agent} Agent`,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        status: 'running' as const,
      })),
      truncated: matching.length > SESSION_LIST_LIMIT,
    };
  }
  input(id: string, data: string): Extract<DevelopmentResult, { action: 'input' }> { const record = this.requireRunning(id); const safe = data.replace(/\x1a/g, ''); record.updatedAt = Date.now(); if (safe) record.child.write(safe); return { action: 'input', session: record.session }; }
  resize(id: string, cols: number, rows: number): Extract<DevelopmentResult, { action: 'resize' }> { const record = this.requireRunning(id); record.updatedAt = Date.now(); record.child.resize(cols, rows); return { action: 'resize', session: record.session }; }
  async stop(id: string, reason = 'stopped'): Promise<Extract<DevelopmentResult, { action: 'stop' }>> { const record = this.records.get(id); if (!record) throw new Error('Unknown development session'); if (record.session.status === 'running') { record.stopping = true; record.updatedAt = Date.now(); this.flush(record);record.session.status = 'exited'; record.session.reason = reason; clearTimeout(record.timer); await this.terminate(record.child.pid); record.release(); record.stopping=false; } return { action: 'stop', session: record.session }; }
  renew(ids: string[]): Extract<DevelopmentResult, { action: 'renew' }> { for (const id of ids) { const record = this.records.get(id); if (record?.session.status === 'running') { record.updatedAt = Date.now(); clearTimeout(record.timer); record.timer = setTimeout(() => { void this.stop(id, 'lease-expired'); }, this.leaseMs); } } return { action: 'renew', session_ids: ids.filter(id => this.records.get(id)?.session.status === 'running') }; }
  async shutdown(): Promise<void> { this.closing=true;await Promise.allSettled([...this.opening.values()].map(value=>value.promise));await Promise.all([...this.records.keys()].map(id => this.stop(id, 'worker-shutdown').catch(() => undefined))); }
  active(): number { return [...this.records.values()].filter(record => record.session.status === 'running').length; }
  occupied(): number { return new Set(this.occupiedIds()).size; }
  occupiedIds(): string[] { return [...this.opening.keys(), ...[...this.records.values()].filter(record => record.session.status === 'running' || record.stopping).map(record => record.session.id)]; }

  private require(id: string): SessionRecord { const record = this.records.get(id); if (!record) throw new Error('Unknown development session'); return record; }
  private requireRunning(id: string): SessionRecord { const record = this.require(id); if (record.session.status !== 'running') throw new Error('Development session has exited'); return record; }
  private flush(record:SessionRecord):void {if(record.flushTimer)clearTimeout(record.flushTimer);record.flushTimer=undefined;const data=record.pendingOutput;record.pendingOutput='';for(const chunk of record.output.append(data))this.emit(record,chunk.sequence,chunk.data);}
  private emit(record: SessionRecord, sequence: number, data: string): void { try { this.onOutput?.({ type: 'development_output', session_id: record.session.id, sequence, data, session: { ...record.session } }); } catch { /* read buffer remains authoritative */ } }
  private async resolve(agent: AgentId,paths:Partial<Record<AgentId,string>>): Promise<string> { const configured = paths[agent]; if (configured) { try { await access(configured, constants.X_OK); return configured; } catch { throw new Error(`${agent} executable is not available`); } } const path = process.env.PATH?.split(delimiter) ?? []; for (const dir of path) { const candidate = `${dir}/${agent}`; try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ } } throw new Error(`${agent} executable is not available`); }
  private async terminate(pid: number): Promise<void> { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } } await new Promise(resolve => setTimeout(resolve, STOP_GRACE_MS)); try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } } }
}
