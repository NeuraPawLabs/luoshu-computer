import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentId, DevelopmentResult } from '@luoshu/protocol';

const SESSION_LIST_LIMIT = 100;
const NATIVE_QUERY_LIMIT = SESSION_LIST_LIMIT + 1;
const HISTORY_TEXT_LIMIT = 256 * 1024;
const HISTORY_FILE_LIMIT = 8 * 1024 * 1024;
const HISTORY_MESSAGE_LIMIT = 1000;

function parseRecord(value: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

class HistoryText {
  text = '';
  truncated = false;
  append(role: unknown, content: string, agent: AgentId): void {
    if (role !== 'user' && role !== 'assistant') return;
    const text = stripVTControlCharacters(content).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
    if (!text) return;
    this.text += `${role === 'user' ? '用户' : agent === 'codex' ? 'Codex' : 'OpenCode'}\n${text}\n\n`;
    if (this.text.length > HISTORY_TEXT_LIMIT) {
      this.truncated = true;
      this.text = this.text.slice(-HISTORY_TEXT_LIMIT);
    }
  }
}

export interface DevelopmentAgentSessionOptions {
  codexHome?: string;
  opencodeDataDir?: string;
}

type AgentSessionSummary = Extract<DevelopmentResult, { action: 'sessions' }>['sessions'][number];

const timestamp = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
};

const milliseconds = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
};

const title = (value: unknown, fallback: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, 1000);
};

export class DevelopmentAgentSessions {
  private readonly codexHome: string;
  private readonly opencodeDataDir: string;

  constructor(options: DevelopmentAgentSessionOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.opencodeDataDir = options.opencodeDataDir ?? process.env.OPENCODE_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode');
  }

  async list(agent: AgentId, cwd: string): Promise<Extract<DevelopmentResult, { action: 'sessions' }>> {
    return agent === 'codex' ? this.listCodex(cwd) : this.listOpenCode(cwd);
  }

  async listAll(cwd: string): Promise<Extract<DevelopmentResult, { action: 'sessions' }>> {
    const [codex, opencode] = await Promise.all([this.list('codex', cwd), this.list('opencode', cwd)]);
    const sessions = [...codex.sessions, ...opencode.sessions].sort((left, right) => right.updated_at - left.updated_at);
    return { action: 'sessions', path: cwd, sessions: sessions.slice(0, SESSION_LIST_LIMIT), truncated: sessions.length > SESSION_LIST_LIMIT || codex.truncated || opencode.truncated };
  }

  async history(agent: AgentId, cwd: string, id: string): Promise<Extract<DevelopmentResult, { action: 'history' }>> {
    const history = agent === 'codex' ? await this.codexHistory(cwd, id) : this.openCodeHistory(cwd, id);
    return { action: 'history', path: cwd, agent, session_id: id, text: history.text, truncated: history.truncated };
  }

  async assertResumable(agent: AgentId, cwd: string, id: string): Promise<void> {
    if (agent !== 'codex') return;
    let source: unknown;
    for (const file of await this.codexStateFiles()) {
      let db: Database.Database | undefined;
      try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        const row = db.prepare('SELECT source FROM threads WHERE id = ? AND cwd = ? AND archived = 0').get(id, cwd) as { source: unknown } | undefined;
        if (row) { source = row.source; break; }
      } catch {
        // Let the native CLI handle sessions without readable source metadata.
      } finally { db?.close(); }
    }
    if (typeof source === 'string' && Object.hasOwn(parseRecord(source) ?? {}, 'subagent'))
      throw new Error('Codex 子代理会话不能独立恢复，请返回会话列表选择主会话继续。');
  }

  private async codexHistory(cwd: string, id: string): Promise<HistoryText> {
    let rollout: string | undefined;
    for (const file of await this.codexStateFiles()) {
      let db: Database.Database | undefined;
      try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? AND cwd = ? AND archived = 0').get(id, cwd) as { rollout_path?: string } | undefined;
        if (row?.rollout_path) { rollout = row.rollout_path; break; }
      } catch {
        // Older state databases may not contain this thread or the rollout column.
      } finally { db?.close(); }
    }
    if (!rollout) throw new Error('Native Agent session history is unavailable for this directory');
    const handle = await open(rollout, 'r');
    const history = new HistoryText();
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - HISTORY_FILE_LIMIT);
      const bytes = Buffer.alloc(Math.min(size, HISTORY_FILE_LIMIT));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      let text = bytes.subarray(0, bytesRead).toString('utf8');
      if (start > 0) { history.truncated = true; text = text.slice(text.indexOf('\n') + 1); }
      for (const line of text.split('\n')) {
        const record = parseRecord(line), payload = record?.payload;
        if (record?.type !== 'response_item' || payload?.type !== 'message' || !Array.isArray(payload.content)) continue;
        const content = payload.content.flatMap((part: { type?: string; text?: unknown }) =>
          part && (part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string' ? [part.text] : [],
        ).join('\n');
        history.append(payload.role, content, 'codex');
      }
      return history;
    } finally { await handle.close(); }
  }

  private openCodeHistory(cwd: string, id: string): HistoryText {
    const db = new Database(join(this.opencodeDataDir, 'opencode.db'), { readonly: true, fileMustExist: true });
    try {
      if (!db.prepare('SELECT id FROM session WHERE id = ? AND directory = ? AND (time_archived IS NULL OR time_archived = 0)').get(id, cwd))
        throw new Error('Native Agent session history is unavailable for this directory');
      const history = new HistoryText();
      const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?').all(id, HISTORY_MESSAGE_LIMIT + 1) as { id: string; data: string }[];
      history.truncated = messages.length > HISTORY_MESSAGE_LIMIT;
      const parts = db.prepare('SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id');
      for (const message of messages.slice(0, HISTORY_MESSAGE_LIMIT).reverse()) {
        const role = parseRecord(message.data)?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content: string[] = [];
        for (const row of parts.iterate(id, message.id) as Iterable<{ data: string }>) {
          const part = parseRecord(row.data);
          if (part?.type === 'text' && typeof part.text === 'string' && !part.ignored && !part.synthetic) content.push(part.text);
        }
        history.append(role, content.join('\n'), 'opencode');
      }
      return history;
    } finally { db.close(); }
  }

  private async listCodex(cwd: string): Promise<Extract<DevelopmentResult, { action: 'sessions' }>> {
    const files = await this.codexStateFiles();
    const sessions: AgentSessionSummary[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      let db: Database.Database | undefined;
      try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        const columns = db.pragma('table_info(threads)') as { name: string }[];
        // Filter before LIMIT: recent child tasks must not hide the resumable parent.
        // Older stores lack source; plain CLI source strings are not JSON.
        const resumable = columns.some(column => column.name === 'source')
          ? "AND CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NULL ELSE 1 END"
          : '';
        const rows = db.prepare(`SELECT id, cwd, title, first_user_message, created_at, updated_at FROM threads WHERE cwd = ? AND archived = 0 ${resumable} ORDER BY updated_at DESC LIMIT ${NATIVE_QUERY_LIMIT}`).all(cwd) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          sessions.push({ id, agent: 'codex', cwd, title: title(row.title ?? row.first_user_message, 'Codex Session'), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) });
        }
      } catch {
        // A missing, locked, or older native database should not make the workspace unusable.
      } finally { db?.close(); }
      if (sessions.length >= SESSION_LIST_LIMIT) break;
    }
    sessions.sort((left, right) => right.updated_at - left.updated_at);
    return { action: 'sessions', path: cwd, sessions: sessions.slice(0, SESSION_LIST_LIMIT), truncated: sessions.length > SESSION_LIST_LIMIT };
  }

  private async listOpenCode(cwd: string): Promise<Extract<DevelopmentResult, { action: 'sessions' }>> {
    const file = join(this.opencodeDataDir, 'opencode.db');
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const rows = db.prepare(`SELECT id, title, time_created, time_updated, directory FROM session WHERE directory = ? AND (time_archived IS NULL OR time_archived = 0) ORDER BY time_updated DESC LIMIT ${NATIVE_QUERY_LIMIT}`).all(cwd) as Array<Record<string, unknown>>;
      const sessions = rows.flatMap(row => {
        const id = typeof row.id === 'string' ? row.id : '';
        return id ? [{ id, agent: 'opencode' as const, cwd, title: title(row.title, 'OpenCode Session'), created_at: milliseconds(row.time_created), updated_at: milliseconds(row.time_updated) }] : [];
      });
      return { action: 'sessions', path: cwd, sessions: sessions.slice(0, SESSION_LIST_LIMIT), truncated: sessions.length > SESSION_LIST_LIMIT };
    } catch {
      return { action: 'sessions', path: cwd, sessions: [], truncated: false };
    } finally { db?.close(); }
  }

  private async codexStateFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.codexHome);
      const candidates = entries.filter(name => /^state(?:_\d+)?\.sqlite$/.test(name)).map(name => join(this.codexHome, name));
      const ranked = await Promise.all(candidates.map(async file => ({ file, modified: await stat(file).then(value => value.mtimeMs).catch(() => 0) })));
      return ranked.sort((left, right) => right.modified - left.modified).map(item => item.file);
    } catch { return []; }
  }
}
