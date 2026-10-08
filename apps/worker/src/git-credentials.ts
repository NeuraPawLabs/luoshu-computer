import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeGitHost } from '@luoshu/protocol';

interface StoredCredential { host: string; private_key: string; configured_at: number; }
export interface GitCredentialStatus { host: string; configured: boolean; checked_at: number | null; error?: string; }

export class LocalGitCredentialStore {
  private readonly file: string;
  constructor(readonly stateDir: string, readonly now: () => number = Date.now) { this.file = join(stateDir, 'git-credentials.json'); }
  private async read(): Promise<StoredCredential[]> { try { const value = JSON.parse(await readFile(this.file, 'utf8')) as unknown; return Array.isArray(value) ? value as StoredCredential[] : []; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
  private async write(value: StoredCredential[]): Promise<void> { await mkdir(this.stateDir, {recursive: true, mode: 0o700}); const temporary = `${this.file}.new-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600}); await chmod(temporary, 0o600); await rename(temporary, this.file); await chmod(this.file, 0o600); }
  async configure(hostInput: string, privateKey: string): Promise<void> { const host = normalizeGitHost(hostInput); if (!privateKey.trim()) throw new Error('Git private key is required'); const credentials = await this.read(); const next = credentials.filter(item => item.host !== host); next.push({host, private_key: privateKey, configured_at: this.now()}); await this.write(next); }
  async remove(hostInput: string): Promise<void> { const host = normalizeGitHost(hostInput); await this.write((await this.read()).filter(item => item.host !== host)); }
  async credential(hostInput: string): Promise<{host: string; private_key: string} | undefined> { const host = normalizeGitHost(hostInput); const item = (await this.read()).find(value => value.host === host); return item ? {host: item.host, private_key: item.private_key} : undefined; }
  async status(): Promise<GitCredentialStatus[]> { return (await this.read()).map(item => ({host: item.host, configured: true, checked_at: item.configured_at})); }
}
