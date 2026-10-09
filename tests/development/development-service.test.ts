import { expect, test } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentService } from '../../src/development/service.js';

test('dispatches validated commands and returns explicit errors for unknown sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-service-')); await writeFile(join(root, 'readme.txt'), 'ok');
  const service = new DevelopmentService({ roots: [root] });
  await expect(service.handle({ action: 'roots' })).resolves.toMatchObject({ action: 'roots', roots: [root] });
  await expect(service.handle({ action: 'list', path: root })).resolves.toMatchObject({ action: 'list' });
  await expect(service.handle({ action: 'sessions', path: root })).resolves.toMatchObject({ action: 'sessions', path: root, sessions: [], truncated: false });
  await expect(service.handle({ action: 'active_sessions' })).resolves.toMatchObject({ action: 'active_sessions', sessions: [], truncated: false });
  await expect(service.handle({ action: 'read', session_id: 'missing', after: 0 })).rejects.toThrow(/Unknown/);
  await expect(service.handle({ action: 'open', session_id: 's', agent: 'codex', cwd: root, mode: 'new', cols: 0, rows: 20 })).rejects.toThrow();
});
