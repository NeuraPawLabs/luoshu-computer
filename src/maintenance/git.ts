import {execFile} from 'node:child_process';
import {lstat, mkdir, realpath, rm} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';
import {maintenanceRequestSchema, maintenanceResultSchema, type MaintenanceRequest, type MaintenanceResult} from '../protocol/index.js';

interface CommandOutput {stdout: string; stderr: string; exitCode: number;}
type CommandRunner = (executable: string, args: string[], options: {cwd: string; timeout: number; signal?: AbortSignal}) => Promise<CommandOutput>;
export interface RepairAgentInput {cwd: string; instruction: string; agent: MaintenanceRequest['agent']; signal: AbortSignal;}
export interface RepairAgentResult {exitCode: number; summary: string;}

function defaultRunner(executable: string, args: string[], options: {cwd: string; timeout: number; signal?: AbortSignal}): Promise<CommandOutput> {
  return new Promise(resolve => execFile(executable, args, {cwd: options.cwd, timeout: options.timeout, signal: options.signal, maxBuffer: 1024 * 1024, encoding: 'utf8'}, (error, stdout, stderr) => {
    const rawCode = error && typeof error === 'object' ? (error as {code?: unknown}).code : undefined;
    const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
    resolve({stdout: String(stdout), stderr: String(stderr), exitCode: code});
  }));
}

function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`);
}

function glob(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(path);
}

function clipped(value: string, limit = 8_000): string {
  return value.length > limit ? `${value.slice(0, limit - 12)} [truncated]` : value;
}

export class GitMaintenance {
  private readonly roots: string[];
  private readonly worktreeRoot: string;
  private readonly run: CommandRunner;

  constructor(options: {roots: string[]; worktreeRoot: string; run?: CommandRunner}) {
    if (!options.roots.length) throw new Error('At least one maintenance root is required');
    this.roots = options.roots.map(root => resolve(root)); this.worktreeRoot = resolve(options.worktreeRoot); this.run = options.run ?? defaultRunner;
  }

  async execute(requestValue: MaintenanceRequest, options: {signal: AbortSignal; runAgent: (input: RepairAgentInput) => Promise<RepairAgentResult>}): Promise<MaintenanceResult> {
    const request = maintenanceRequestSchema.parse(requestValue);
    const repository = await this.repository(request.repository);
    await this.prepareRoot();
    const top = (await this.git(repository, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== repository) throw new Error('Maintenance repository must be a Git root');
    const clean = await this.git(repository, ['status', '--porcelain', '--untracked-files=all']);
    if (clean.stdout.trim()) throw new Error('Maintenance repository baseline must be clean');
    const ignoredBefore=(await this.git(repository,['status','--porcelain','--ignored','--untracked-files=all'])).stdout;
    const mainHead=(await this.git(repository,['rev-parse','HEAD'])).stdout.trim();
    const base = (await this.git(repository, ['rev-parse', '--verify', `${request.base_sha}^{commit}`])).stdout.trim();
    if (base !== request.base_sha) throw new Error('Maintenance base SHA does not resolve exactly');
    const worktree = join(this.worktreeRoot, request.attempt_id);
    if (!contained(this.worktreeRoot, worktree)) throw new Error('Maintenance worktree escapes its root');
    let created = false, keep = false;
    try {
      const add = await this.git(repository, ['worktree', 'add', '-b', request.branch, worktree, request.base_sha]);
      if (add.exitCode !== 0) throw new Error(clipped(add.stderr || 'Unable to create maintenance worktree'));
      created = true;
      if (options.signal.aborted) throw new Error('Maintenance execution was cancelled before repair');
      if(request.operation==='verify'){
        const checks=[] as MaintenanceResult['checks'];
        for(const check of request.checks){const result=await this.run(check.executable,check.args,{cwd:worktree,timeout:check.timeout_seconds*1000,signal:options.signal});if(options.signal.aborted)throw new Error('Maintenance verification was cancelled');checks.push({name:check.name,command:[check.executable,...check.args].join(' ').slice(0,2_000),exit_code:result.exitCode,output:clipped([result.stdout,result.stderr].filter(Boolean).join('\n'))});}
        const passed=checks.every(check=>check.exit_code===0);
        return maintenanceResultSchema.parse({status:passed?'passed':'failed',summary:passed?'Verification passed':'Verification checks failed',base_sha:base,...(passed?{commit_sha:base}:{}),branch:request.branch,changed_paths:[],checks});
      }
      const agent = await options.runAgent({cwd: worktree, instruction: request.instruction, agent: request.agent, signal: options.signal});
      if (options.signal.aborted) throw new Error('Maintenance execution was cancelled');
      const mainAfterAgent=(await this.git(repository,['rev-parse','HEAD'])).stdout.trim(),mainChanges=(await this.git(repository,['status','--porcelain','--untracked-files=all'])).stdout.trim(),ignoredAfter=(await this.git(repository,['status','--porcelain','--ignored','--untracked-files=all'])).stdout;
      if(mainAfterAgent!==mainHead||mainChanges||ignoredAfter!==ignoredBefore)throw new Error('Maintenance Agent modified the repository outside its worktree');
      if (agent.exitCode !== 0) return maintenanceResultSchema.parse({status: 'failed', summary: clipped(agent.summary), base_sha: base, branch: request.branch, changed_paths: [], checks: []});
      const changed = await this.changedPaths(worktree);
      if (!changed.length) return maintenanceResultSchema.parse({status: 'failed', summary: 'Repair produced no changes', base_sha: base, branch: request.branch, changed_paths: [], checks: []});
      if (changed.some(path => !request.allowed_paths.some(pattern => glob(pattern, path)))) throw new Error('Repair changed a path outside the allowed path policy');
      const checks = [] as MaintenanceResult['checks'];
      for (const check of request.checks) {
        const result = await this.run(check.executable, check.args, {cwd: worktree, timeout: check.timeout_seconds * 1000, signal: options.signal});
        if(options.signal.aborted)throw new Error('Maintenance repair checks were cancelled');
        checks.push({name: check.name, command: [check.executable, ...check.args].join(' ').slice(0, 2_000), exit_code: result.exitCode, output: clipped([result.stdout, result.stderr].filter(Boolean).join('\n'))});
      }
      if (checks.some(check => check.exit_code !== 0)) return maintenanceResultSchema.parse({status: 'failed', summary: 'Repair checks failed', base_sha: base, branch: request.branch, changed_paths: changed, checks});
      const staged = await this.git(worktree, ['add', '--', ...changed]);
      if (staged.exitCode !== 0) throw new Error(clipped(staged.stderr || 'Unable to stage repair'));
      const committed = await this.git(worktree, ['commit', '-m', `fix: repair maintenance incident ${request.attempt_id}`]);
      if (committed.exitCode !== 0) throw new Error(clipped(committed.stderr || 'Unable to commit repair'));
      const commit = (await this.git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      const committedPaths = (await this.git(worktree, ['diff', '--name-only', `${base}..${commit}`])).stdout.split('\n').map(value => value.trim()).filter(Boolean).sort();
      if (!committedPaths.length || committedPaths.some(path => !request.allowed_paths.some(pattern => glob(pattern, path)))) throw new Error('Committed repair violates the allowed path policy');
      keep = true;
      return maintenanceResultSchema.parse({status: 'patch_ready', summary: clipped(agent.summary), base_sha: base, commit_sha: commit, branch: request.branch, changed_paths: committedPaths, checks});
    } finally {
      if (created && !keep) await this.cleanup(repository, worktree, request.branch);
    }
  }

  private async repository(path: string): Promise<string> {
    const resolved = resolve(path), actual = await realpath(resolved);
    for (const rootValue of this.roots) {
      const root = await realpath(rootValue), info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (contained(root, actual)) return actual;
    }
    throw new Error('Maintenance repository is outside an allowed root');
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.worktreeRoot, {recursive: true, mode: 0o700});
    const info = await lstat(this.worktreeRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.worktreeRoot) !== this.worktreeRoot) throw new Error('Maintenance worktree root must be a real directory');
  }

  private async git(cwd: string, args: string[]): Promise<CommandOutput> { return this.run('git', args, {cwd, timeout: 60_000}); }

  private async changedPaths(worktree: string): Promise<string[]> {
    const [tracked, staged, untracked] = await Promise.all([
      this.git(worktree, ['diff', '--name-only']), this.git(worktree, ['diff', '--name-only', '--cached']), this.git(worktree, ['ls-files', '--others', '--exclude-standard']),
    ]);
    for (const result of [tracked, staged, untracked]) if (result.exitCode !== 0) throw new Error('Unable to inspect repair changes');
    return [...new Set([tracked.stdout, staged.stdout, untracked.stdout].flatMap(value => value.split('\n')).map(value => value.trim()).filter(Boolean))].sort();
  }

  private async cleanup(repository: string, worktree: string, branch: string): Promise<void> {
    await this.git(repository, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await this.git(repository, ['branch', '-D', branch]).catch(() => undefined);
    await rm(worktree, {recursive: true, force: true});
  }
}
