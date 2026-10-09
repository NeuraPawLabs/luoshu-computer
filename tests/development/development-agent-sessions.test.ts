import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentAgentSessions } from '../../src/development/agent-sessions.js';

test('lists Codex sessions for the selected directory from the native state database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-codex-sessions-'));
  const codexHome = join(root, '.codex'); await mkdir(codexHome);
  const db = new Database(join(codexHome, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, first_user_message TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('codex-1', '/workspace/project', 'Fix the build', 'Fix the build', 100, 200, 0);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('codex-other', '/workspace/other', 'Other', 'Other', 300, 400, 0);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('codex-archived', '/workspace/project', 'Archived', 'Archived', 500, 600, 1);
  db.close();

  const sessions = new DevelopmentAgentSessions({ codexHome });
  await expect(sessions.list('codex', '/workspace/project')).resolves.toMatchObject({
    action: 'sessions',
    path: '/workspace/project',
    sessions: [{ id: 'codex-1', agent: 'codex', cwd: '/workspace/project', title: 'Fix the build', created_at: 100000, updated_at: 200000 }],
    truncated: false,
  });
});

test('lists OpenCode sessions for the selected directory from the native database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-opencode-sessions-'));
  const opencodeDataDir = join(root, 'opencode'); await mkdir(opencodeDataDir);
  const db = new Database(join(opencodeDataDir, 'opencode.db'));
  db.exec('CREATE TABLE session (id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, directory TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_project', 'Review changes', 100000, 200000, null, '/workspace/project');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_archived', 'Archived', 300000, 400000, 1, '/workspace/project');
  db.close();

  const sessions = new DevelopmentAgentSessions({ opencodeDataDir });
  await expect(sessions.list('opencode', '/workspace/project')).resolves.toMatchObject({
    action: 'sessions',
    path: '/workspace/project',
    sessions: [{ id: 'ses_project', agent: 'opencode', cwd: '/workspace/project', title: 'Review changes', created_at: 100000, updated_at: 200000 }],
    truncated: false,
  });
});

test('returns an empty list when an Agent has no native session store', async () => {
  const sessions = new DevelopmentAgentSessions({ codexHome: '/missing/codex', opencodeDataDir: '/missing/opencode' });
  await expect(sessions.list('codex', '/workspace/project')).resolves.toMatchObject({ sessions: [], truncated: false });
  await expect(sessions.list('opencode', '/workspace/project')).resolves.toMatchObject({ sessions: [], truncated: false });
});
