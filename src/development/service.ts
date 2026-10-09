import type {CodexPermissions} from '../runtime/codex-permissions.js';
import { DevelopmentFiles } from './files.js';
import { DevelopmentSessions } from './sessions.js';
import { DevelopmentAgentSessions, type DevelopmentAgentSessionOptions } from './agent-sessions.js';
import { developmentCommandSchema, type DevelopmentCommand, type DevelopmentOutput, type DevelopmentResult } from '../protocol/index.js';
import type { AgentId, WorkerMutableConfig } from '../protocol/index.js';
import { DevelopmentRootPolicy } from './root-policy.js';

export interface DevelopmentServiceOptions extends DevelopmentAgentSessionOptions { managedConfig?:boolean; codexPermissions?:CodexPermissions; roots?: string[]; rootPolicy?: DevelopmentRootPolicy; agentPaths?: Partial<Record<AgentId, string>>; activeCount?: () => number; maxSessions?: number; leaseMs?: number; gitSshCommand?: string; onOutput?: (event: DevelopmentOutput) => void; }

export class DevelopmentService {
  private readonly managedConfig:boolean;
  readonly codexPermissions?:CodexPermissions;
  readonly files: DevelopmentFiles;
  readonly sessions: DevelopmentSessions;
  readonly agentSessions: DevelopmentAgentSessions;
  readonly rootPolicy: DevelopmentRootPolicy;
  constructor(options: DevelopmentServiceOptions = {}) {
    this.managedConfig=options.managedConfig??false;
    this.codexPermissions=options.codexPermissions;
    this.rootPolicy = options.rootPolicy ?? new DevelopmentRootPolicy({ roots: options.roots });
    this.files = new DevelopmentFiles({ rootPolicy: this.rootPolicy });
    this.sessions = new DevelopmentSessions({ codexPermissions:this.codexPermissions, rootPolicy: this.rootPolicy, gitSshCommand:options.gitSshCommand, roots: this.files.roots, agentPaths: options.agentPaths, activeCount: options.activeCount, maxSessions: options.maxSessions, leaseMs: options.leaseMs, onOutput: options.onOutput });
    this.agentSessions = new DevelopmentAgentSessions(options);
  }
  setOutputSink(sink: (event: DevelopmentOutput) => void): void { this.sessions.setOutputSink(sink); }
  applyConfig(config: WorkerMutableConfig, revision: string): void { this.rootPolicy.setApplied(config.development_roots, revision); this.sessions.updateConfig(config.agent_paths, config.capacity,config.codex_sandbox); }
  async handle(value: unknown): Promise<DevelopmentResult> {
    const command = developmentCommandSchema.parse(value);
    if(this.managedConfig&&['roots_update','codex_settings_update'].includes(command.action))throw Error('请通过统一 Worker 配置修改设备设置');
    switch (command.action) {
      case 'codex_settings':
        if(!this.codexPermissions)throw Error('请先更新设备端以支持 Codex 权限配置');
        return {action:'codex_settings',state:await this.codexPermissions.state()};
      case 'codex_settings_update':
        if(!this.codexPermissions)throw Error('请先更新设备端以支持 Codex 权限配置');
        return {action:'codex_settings_update',state:await this.codexPermissions.update(command.mode,command.expected_revision)};
      case 'roots': return { action: 'roots', roots: this.files.roots };
      case 'roots_state': return { action: 'roots_state', state: this.rootPolicy.state() };
      case 'roots_update': return this.rootPolicy.update(command.roots, command.revision, command.stop_ids);
      case 'list': return this.files.list(command.path);
      case 'repository': return this.files.repository(command.path);
      case 'sessions': {
        const path = await this.files.directory(command.path);
        return this.agentSessions.listAll(path);
      }
      case 'active_sessions': return this.sessions.activeSessions();
      case 'history': {
        const path = await this.files.directory(command.path);
        return this.agentSessions.history(command.agent, path, command.session_id);
      }
      case 'preview': return this.files.preview(command.path);
      case 'open': {
        const cwd = await this.files.directory(command.cwd);
        if (command.mode === 'resume' && command.agent_session_id)
          await this.agentSessions.assertResumable(command.agent, cwd, command.agent_session_id);
        return this.sessions.open({ ...command, cwd });
      }
      case 'read': return this.sessions.read(command.session_id, command.after);
      case 'input': return this.sessions.input(command.session_id, command.data);
      case 'resize': return this.sessions.resize(command.session_id, command.cols, command.rows);
      case 'stop': return this.sessions.stop(command.session_id);
      case 'renew': return this.sessions.renew(command.session_ids);
    }
  }
  active(): number { return this.sessions.active(); }
  occupied(): number { return this.sessions.occupied(); }
  async stopAll(): Promise<void> { await this.sessions.shutdown(); }
}
