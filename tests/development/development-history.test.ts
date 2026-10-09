import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { developmentResultSchema } from '../../src/protocol/index.js';
import { DevelopmentAgentSessions } from '../../src/development/agent-sessions.js';
import { DevelopmentService } from '../../src/development/service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-history-'));
  roots.push(root);
  const codexHome = join(root, '.codex'), opencodeDataDir = join(root, 'opencode');
  await mkdir(codexHome); await mkdir(opencodeDataDir);
  const rollout = join(codexHome, 'rollout.jsonl');
  const db = new Database(join(codexHome, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('native-1', root, rollout, 0);
  db.close();
  return { root, codexHome, opencodeDataDir, rollout, sessions: new DevelopmentAgentSessions({ codexHome, opencodeDataDir }) };
}
const message = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });

test('reads saved Codex conversation without tools, internal instructions, or duplicate events', async () => {
  const { root, rollout, sessions } = await fixture();
  await writeFile(rollout, [
    message('developer', 'private instructions'), message('user', '之前的请求'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '之前的请求' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'tool result' } }),
    message('assistant', '之前的回复'), '{unfinished',
  ].join('\n'));
  const result = await sessions.history('codex', root, 'native-1');
  expect(result).toEqual({ action: 'history', agent: 'codex', path: root, session_id: 'native-1', text: '用户\n之前的请求\n\nCodex\n之前的回复\n\n', truncated: false });
  expect(developmentResultSchema.safeParse(result).success).toBe(true);
  await expect(sessions.history('codex', '/other', 'native-1')).rejects.toThrow(/session/i);
  await expect(sessions.history('codex', root, 'missing')).rejects.toThrow(/session/i);
});

test('reads OpenCode text parts in conversation order and scopes them to the saved session directory', async () => {
  const { root, opencodeDataDir, sessions } = await fixture();
  const db = new Database(join(opencodeDataDir, 'opencode.db'));
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, time_archived INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses-1', root);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses-1', 1, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'ses-1', 2, JSON.stringify({ role: 'assistant' }));
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
  part.run('p2', 'm2', 'ses-1', 2, JSON.stringify({ type: 'text', text: 'OpenCode 回复' }));
  part.run('p1', 'm1', 'ses-1', 1, JSON.stringify({ type: 'text', text: '检查改动' }));
  part.run('p3', 'm2', 'ses-1', 3, JSON.stringify({ type: 'reasoning', text: 'hidden reasoning' }));
  db.close();
  expect(await sessions.history('opencode', root, 'ses-1')).toEqual({ action: 'history', agent: 'opencode', path: root, session_id: 'ses-1', text: '用户\n检查改动\n\nOpenCode\nOpenCode 回复\n\n', truncated: false });
  await expect(sessions.history('opencode', '/other', 'ses-1')).rejects.toThrow(/session/i);
});

test('bounds history while retaining the latest reply and removing terminal escape controls', async () => {
  const { root, rollout, sessions } = await fixture();
  await writeFile(rollout, [message('user', '早'.repeat(300_000)), message('assistant', '最新回复\x1b[2J\x1b]52;c;clipboard\x07')].join('\n'));
  const result = await sessions.history('codex', root, 'native-1');
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(256 * 1024);
  expect(result.text).toContain('最新回复');
  expect(result.text).not.toContain('\x1b');
  expect(result.text).not.toContain('clipboard');
  expect(developmentResultSchema.safeParse(result).success).toBe(true);
});

test('history commands enforce allowed roots without consuming a development slot', async () => {
  const { root, codexHome, opencodeDataDir, rollout } = await fixture();
  await writeFile(rollout, message('assistant', '已保存的回复'));
  const service = new DevelopmentService({ roots: [root], codexHome, opencodeDataDir, maxSessions: 0 });
  await expect(service.handle({ action: 'history', agent: 'codex', path: root, session_id: 'native-1' })).resolves.toMatchObject({ text: 'Codex\n已保存的回复\n\n' });
  expect(service.active()).toBe(0);
  await expect(service.handle({ action: 'history', agent: 'codex', path: '/outside', session_id: 'native-1' })).rejects.toThrow(/outside an allowed root/);
});
