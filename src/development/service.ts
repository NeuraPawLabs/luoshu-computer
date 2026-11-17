import type {CodexPermissions} from '../runtime/codex-permissions.js';
import { DevelopmentFiles } from './files.js';
import { DevelopmentSessions } from './sessions.js';
import { DevelopmentAgentSessions, type DevelopmentAgentSessionOptions } from './agent-sessions.js';
import { developmentCommandSchema, type DevelopmentCommand, type DevelopmentOutput, type DevelopmentResult } from '../protocol/index.js';
import type { AgentId, DeviceMutableConfiguration, DeviceServiceReport } from '../protocol/index.js';
import { DevelopmentRootPolicy } from './root-policy.js';

export interface DevelopmentServiceOptions extends DevelopmentAgentSessionOptions { managedConfig?:boolean; codexPermissions?:CodexPermissions; roots?: string[]; rootPolicy?: DevelopmentRootPolicy; agentPaths?: Partial<Record<AgentId, string>>; activeCount?: () => number; maxSessions?: number; leaseMs?: number; gitSshCommand?: string; onOutput?: (event: DevelopmentOutput) => void; version?:string; }

export class DevelopmentService {
  private readonly managedConfig:boolean;
  private readonly version:string;
  readonly codexPermissions?:CodexPermissions;
  readonly files: DevelopmentFiles;
  readonly sessions: DevelopmentSessions;
  readonly agentSessions: DevelopmentAgentSessions;
  readonly rootPolicy: DevelopmentRootPolicy;
  constructor(options: DevelopmentServiceOptions = {}) {
    this.managedConfig=options.managedConfig??false;
    this.version=options.version??'1';
    this.codexPermissions=options.codexPermissions;
    this.rootPolicy = options.rootPolicy ?? new DevelopmentRootPolicy({ roots: options.roots });
    this.files = new DevelopmentFiles({ rootPolicy: this.rootPolicy });
    this.sessions = new DevelopmentSessions({ codexPermissions:this.codexPermissions, rootPolicy: this.rootPolicy, gitSshCommand:options.gitSshCommand, roots: this.files.roots, agentPaths: options.agentPaths, activeCount: options.activeCount, maxSessions: options.maxSessions, leaseMs: options.leaseMs, onOutput: options.onOutput });
    this.agentSessions = new DevelopmentAgentSessions(options);
  }
  setOutputSink(sink: (event: DevelopmentOutput) => void): void { this.sessions.setOutputSink(sink); }
  applyConfig(config:DeviceMutableConfiguration, revision: string): void {
    const roots=config.development_policy.mode==='home'?null:config.development_policy.mode==='custom'?[...config.development_policy.roots]:[];
    this.rootPolicy.setApplied(roots, revision);
    this.sessions.updateConfig(config.agent_paths, config.capacity, config.codex_sandbox);
  }
  describe():DeviceServiceReport { return {id:'development',type:'development',version:this.version,agent_id:null,status:'ready',reason:null,features:['browse','repository','native_history','terminal','codebase_preparation']}; }

  async handle(value: unknown): Promise<DevelopmentResult> {
    const command = developmentCommandSchema.parse(value);
    switch (command.action) {
      case 'codex_settings':
        if(!this.codexPermissions)throw Error('请先更新设备端以支持 Codex 权限配置');
        return {action:'codex_settings',state:await this.codexPermissions.state()};
      case 'roots': return { action: 'roots', roots: this.files.roots };
      case 'roots_state': return { action: 'roots_state', state: this.rootPolicy.state() };
      case 'list': return this.files.list(command.path);
      case 'repository': return this.files.repository(command.path);
      case 'sessions': {
        const path = await this.files.directory(command.path);
        return this.agentSessions.listAll(path);
      }
      case 'active_sessions': return this.sessions.activeSessions();
      case 'history': {
        const path = await this.files.directory(command.path);
        return this.agentSessions.history(command.agent, path, command.engine_session_id);
      }
      case 'preview': return this.files.preview(command.path);
      case 'open': {
        const cwd = await this.files.directory(command.cwd);
        const agentSessionId=command.engine_session_id;
        if (command.mode === 'resume' && agentSessionId)
          await this.agentSessions.assertResumable(command.agent, cwd, agentSessionId);
        return this.sessions.open({ ...command, cwd, ...(agentSessionId?{engine_session_id:agentSessionId}: {}) } as any);
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
