import { chmod, readFile, stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LocalGitCredentialStore } from '../../src/runtime/git-credentials.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true}); });

test('stores Git private keys only in the Worker state directory with restrictive permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luoshu-worker-git-')); dirs.push(dir);
  const store = new LocalGitCredentialStore(dir);
  await store.configure('Git.Example.com', 'LOCAL_PRIVATE_KEY_MARKER');

  expect(await store.credential('git.example.com')).toMatchObject({host: 'git.example.com', private_key: 'LOCAL_PRIVATE_KEY_MARKER'});
  expect(await store.status()).toMatchObject([{host: 'git.example.com', configured: true}]);
  const file = await stat(join(dir, 'git-credentials.json'));
  expect(file.mode & 0o777).toBe(0o600);
  expect(await readFile(join(dir, 'git-credentials.json'), 'utf8')).toContain('LOCAL_PRIVATE_KEY_MARKER');
});

test('removes a local credential without making a Core request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luoshu-worker-git-')); dirs.push(dir);
  const store = new LocalGitCredentialStore(dir);
  await store.configure('git.example.com', 'PRIVATE');
  await store.remove('git.example.com');
  expect(await store.credential('git.example.com')).toBeUndefined();
  expect(await store.status()).toEqual([]);
});
