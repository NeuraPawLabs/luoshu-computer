import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DevelopmentResult } from '../protocol/index.js';
import { DevelopmentRootPolicy } from './root-policy.js';

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const execute = promisify(execFile);

export interface DevelopmentFileOptions { roots?: string[]; rootPolicy?: DevelopmentRootPolicy }

export class DevelopmentFiles {
  private readonly policy: DevelopmentRootPolicy;
  get roots(): string[] { return this.policy.roots(); }
  constructor(options: DevelopmentFileOptions = {}) {
    this.policy = options.rootPolicy ?? new DevelopmentRootPolicy({ roots: options.roots });
  }

  async list(path: string): Promise<Extract<DevelopmentResult, { action: 'list' }>> {
    const target = await this.safePath(path);
    const info = await lstat(target);
    if (!info.isDirectory()) throw new Error('Development path is not a directory');
    const all = await readdir(target, { withFileTypes: true });
    // The development workspace navigates working directories and never edits
    // files. Filter before applying the limit so a directory-heavy workspace
    // cannot hide its useful entries behind unrelated files.
    const directories = all.filter(entry => !entry.isSymbolicLink() && entry.isDirectory() && !entry.name.startsWith('.'));
    const entries = directories.slice(0, MAX_LIST_ENTRIES).map(entry => ({
      path: join(target, entry.name),
      name: entry.name,
      kind: 'directory' as const,
    }));
    return { action: 'list', path: target, entries, truncated: directories.length > MAX_LIST_ENTRIES };
  }

  async preview(path: string): Promise<Extract<DevelopmentResult, { action: 'preview' }>> {
    const target = await this.safePath(path);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error('Development path is not a regular file');
    if (info.size > MAX_PREVIEW_BYTES) {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const bytes = Buffer.alloc(MAX_PREVIEW_BYTES); await handle.read(bytes, 0, bytes.length, 0); return { action: 'preview', path: target, text: bytes.toString('utf8'), truncated: true }; }
      finally { await handle.close(); }
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const bytes = Buffer.alloc(info.size); const result = await handle.read(bytes, 0, bytes.length, 0); return { action: 'preview', path: target, text: bytes.subarray(0, result.bytesRead).toString('utf8'), truncated: false }; }
    finally { await handle.close(); }
  }

  async directory(path: string): Promise<string> { const target = await this.safePath(path); if (!(await lstat(target)).isDirectory()) throw new Error('Development working directory is not a directory'); return target; }

  async repository(path: string): Promise<Extract<DevelopmentResult, { action: 'repository' }>> {
    const target = await this.directory(path);
    const git = async (args: string[]) => (await execute('git', ['-C', target, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim();
    let repository: string;
    try { repository = await git(['rev-parse', '--show-toplevel']); }
    catch { throw new Error('当前目录不在 Git 仓库中，请先使用已有 Git 代码目录'); }
    await this.directory(repository);
    try { await git(['rev-parse', '--verify', 'HEAD^{commit}']); }
    catch { throw new Error('当前 Git 仓库尚无提交，请先创建首次提交'); }
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'HEAD');
    return { action: 'repository', path: target, repository_path: repository, root_path: relative(repository, target) || '.', default_branch: branch };
  }

  private async safePath(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error('Development paths must be absolute');
    const target = resolve(input);
    this.policy.assert(target);
    const root = this.roots.find(candidate => target === candidate || relative(candidate, target).split(sep)[0] !== '..' && !relative(candidate, target).startsWith(`..${sep}`));
    if (!root) throw new Error('Development path is outside an allowed root');
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Development root must be a regular directory');
    const rel = relative(root, target);
    let current = root;
    for (const part of rel ? rel.split(sep) : []) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in development paths');
    }
    return target;
  }
}
