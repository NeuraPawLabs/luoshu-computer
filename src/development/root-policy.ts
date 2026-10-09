import { homedir } from 'node:os';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { DevelopmentRootBlocker, DevelopmentRootState, DevelopmentResult } from '../protocol/index.js';

export function containsDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function validateDevelopmentRoots(roots: string[]): string[] {
  if (roots.length > 32) throw Error('最多允许 32 个开发目录');
  return [...new Set(roots.map(path => {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error('开发目录必须是绝对路径');
    const absolute = resolve(path);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw Error('Symbolic links are not allowed in development roots');
    }
    if (!lstatSync(absolute).isDirectory()) throw Error(`开发目录不存在或不是目录：${path}`);
    accessSync(absolute, constants.R_OK | constants.X_OK);
    return realpathSync(absolute);
  }))];
}
interface Activity { kind: DevelopmentRootBlocker['kind']; paths: string[]; stop?: () => Promise<void> }
export class DevelopmentRootPolicy {
  private configured: string[] | null;
  private current: string[];
  private revision: string;
  private updating = false;
  get writable(): boolean { return Boolean(this.options.persist); }
  private readonly activities = new Map<string, Activity>();
  private readonly listeners = new Set<() => void>();
  private readonly home: string;
  constructor(private readonly options: { roots?: string[] | null; revision?: string; home?: string; persist?: (roots: string[] | null, revision: string) => Promise<void> } = {}) {
    this.home = resolve(options.home ?? homedir());
    this.configured = options.roots == null ? null : validateDevelopmentRoots(options.roots);
    this.current = this.configured ?? validateDevelopmentRoots([this.home]);
    this.revision = options.revision ?? 'initial';
  }
  state(): DevelopmentRootState { return { roots: [...this.current], configured_roots: this.configured && [...this.configured], revision: this.revision, default_root: this.home }; }
  roots(): string[] { return [...this.current]; }
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private changed():void {for(const listener of this.listeners)listener();}
  setApplied(roots: string[] | null, revision: string): void { this.configured = roots === null ? null : validateDevelopmentRoots(roots); this.current = this.configured ?? validateDevelopmentRoots([this.home]); this.revision = revision; this.changed(); }
  assert(path: string): void {
    if (this.updating) throw Error('开发目录正在更新，请稍后重试');
    if (!this.current.some(root => containsDirectory(root, resolve(path)))) throw Error(`Local Codebase is outside an allowed root: ${path}`);
  }
  acquire(id: string, kind: Activity['kind'], paths: string[], stop?: () => Promise<void>): () => void {
    if (this.updating) throw Error('开发目录正在更新，请稍后重试');
    for (const path of paths) this.assert(path);
    return this.retainUnresolved(id,kind,paths,stop);
  }
  /** Restore an existing durable operation as a blocker, never grant it new
   * execution authority. The caller must stop/reconcile revoked operations. */
  retainUnresolved(id:string,kind:Activity['kind'],paths:string[],stop?:()=>Promise<void>):()=>void {
    if (this.activities.has(id)) throw Error('Directory activity is already registered');
    const activity = { kind, paths: [...paths], stop };
    this.activities.set(id, activity);
    return () => { if (this.activities.get(id) === activity) this.activities.delete(id); };
  }
  async update(roots: string[] | null, revision: string, stopIds: string[]): Promise<Extract<DevelopmentResult, { action: 'roots_update' }>> {
    if (this.updating) throw Error('开发目录正在更新，请稍后重试');
    this.updating = true;
    try {
      const configured = roots === null ? null : validateDevelopmentRoots(roots);
      const next = configured ?? validateDevelopmentRoots([this.home]);
      if (revision === this.revision) {
        if (JSON.stringify(configured) !== JSON.stringify(this.configured)) throw Error('目录配置版本与内容不一致');
        return { action: 'roots_update', status: 'applied', state: this.state(), blockers: [] };
      }
      const narrowing = this.current.some(root => !next.some(allowed => containsDirectory(allowed, root)));
      const affected = () => [...this.activities].filter(([, activity]) =>
        activity.paths.length ? activity.paths.some(path => !next.some(root => containsDirectory(root, path))) : narrowing);
      for (const [id, activity] of affected()) if (stopIds.includes(id) && activity.stop) await activity.stop();
      const blockers = affected().map(([id, activity]) => ({ id, kind: activity.kind, path: activity.paths[0] ?? '整个设备执行环境', stoppable: Boolean(activity.stop) }));
      if (blockers.length) return { action: 'roots_update', status: 'blocked', state: this.state(), blockers };
      if (!this.options.persist) throw Error('当前设备未启用动态目录配置，请更新设备端');
      await this.options.persist(configured, revision);
      this.configured = configured; this.current = next; this.revision = revision;this.changed();
      return { action: 'roots_update', status: 'applied', state: this.state(), blockers: [] };
    } finally { this.updating = false; }
  }
}
