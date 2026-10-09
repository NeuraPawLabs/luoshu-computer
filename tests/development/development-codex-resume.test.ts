import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentAgentSessions } from '../../src/development/agent-sessions.js';
import { DevelopmentService } from '../../src/development/service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-codex-resume-'));
  roots.push(root);
  const codexHome = join(root, '.codex');
  await mkdir(codexHome);
  const rollout = join(codexHome, 'child.jsonl');
  const db = new Database(join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT, title TEXT, first_user_message TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)');
  insert.run('parent', root, 'cli', 'Main conversation', 'Main conversation', 1, null);
  for (let i = 0; i < 105; i++) {
    insert.run(`child-${i}`, root, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: `/root/reviewer_${i}` } } }), 'Child task', 'Child task', 1000 + i, rollout);
  }
  db.close();
  await writeFile(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved child reply' }] } }) + '\n');
  return { root, codexHome };
}

test('excludes Codex subagents before the session list limit so the parent remains selectable', async () => {
  const { root, codexHome } = await fixture();
  const sessions = new DevelopmentAgentSessions({ codexHome, opencodeDataDir: join(root, 'missing') });
  const result = await sessions.listAll(root);
  expect(result.sessions.map(session => session.id)).toEqual(['parent']);
  expect(result.truncated).toBe(false);
});

test('keeps ordinary Codex sources and applies truncation only to resumable conversations', async () => {
  const { root, codexHome } = await fixture();
  const db = new Database(join(codexHome, 'state_5.sqlite'));
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 1, ?, 0, NULL)');
  for (const [i, source] of ['vscode', 'exec', 'app-server', 'unknown', null, '{malformed'].entries()) {
    insert.run(`ordinary-${i}`, root, source, 'Conversation', 'Conversation', 2 + i);
  }
  db.close();
  const sessions = new DevelopmentAgentSessions({ codexHome });
  expect((await sessions.list('codex', root)).sessions.map(session => session.id)).toEqual(['ordinary-5', 'ordinary-4', 'ordinary-3', 'ordinary-2', 'ordinary-1', 'ordinary-0', 'parent']);
  const more = new Database(join(codexHome, 'state_5.sqlite'));
  for (let i = 0; i < 100; i++) more.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 1, ?, 0, NULL)').run(`root-${i}`, root, 'cli', 'Conversation', 'Conversation', 10 + i);
  more.close();
  const result = await sessions.list('codex', root);
  expect(result.sessions).toHaveLength(100);
  expect(result.sessions[0].id).toBe('root-99');
  expect(result.sessions[99].id).toBe('root-0');
  expect(result.truncated).toBe(true);
});

test('rejects stale Codex child resume requests before starting a PTY and keeps history readable', async () => {
  const { root, codexHome } = await fixture();
  const service = new DevelopmentService({ roots: [root], codexHome, agentPaths: { codex: '/missing/codex' } });
  await expect(service.handle({ action: 'open', session_id: 'stale', agent: 'codex', cwd: root, mode: 'resume', agent_session_id: 'child-0', cols: 80, rows: 24 })).rejects.toThrow(/子代理.*主会话/);
  expect(service.active()).toBe(0);
  await expect(service.handle({ action: 'history', agent: 'codex', path: root, session_id: 'child-0' })).resolves.toMatchObject({ text: 'Codex\nSaved child reply\n\n' });
});

test('resumes the selected parent with its native ID', async () => {
  const { root, codexHome } = await fixture();
  const executable = join(root, 'codex-fixture');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const service = new DevelopmentService({ roots: [root], codexHome, agentPaths: { codex: executable } });
  try {
    await service.handle({ action: 'open', session_id: 'main', agent: 'codex', cwd: root, mode: 'resume', agent_session_id: 'parent', cols: 80, rows: 24 });
    await expect.poll(async () => {
      const result = await service.handle({ action: 'read', session_id: 'main', after: 0 });
      return result.action === 'read' && result.session.status === 'exited' ? result.chunks.map(chunk => chunk.data).join('') : '';
    }).toBe('["resume","parent"]');
  } finally { await service.stopAll(); }
});
