import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { developmentResultSchema } from '@luoshu/protocol';
import { DevelopmentService } from '../src/development/service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('inspects a repository and subdirectory for registration without starting a session or changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'development-repository-')); roots.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-b', 'dev']);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.txt'), 'saved');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial']);
  const service = new DevelopmentService({ roots: [root], maxSessions: 0 });
  const result = await service.handle({ action: 'repository', path: join(root, 'src') });
  expect(result).toEqual({ action: 'repository', path: join(root, 'src'), repository_path: root, root_path: 'src', default_branch: 'dev' });
  expect(developmentResultSchema.safeParse(result).success).toBe(true);
  expect(service.active()).toBe(0);
  expect(git(['status', '--porcelain'])).toBe('');
  git(['checkout', '--detach']);
  await expect(service.handle({ action: 'repository', path: root })).resolves.toMatchObject({ root_path: '.', default_branch: 'HEAD' });
  await symlink(join(root, 'src'), join(root, 'linked'));
  await expect(service.handle({ action: 'repository', path: join(root, 'linked') })).rejects.toThrow(/Symbolic/);
  const confined = new DevelopmentService({ roots: [join(root, 'src')] });
  await expect(confined.handle({ action: 'repository', path: join(root, 'src') })).rejects.toThrow(/outside/);
});

test('rejects ordinary folders and repositories without a commit before registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'development-no-repository-')); roots.push(root);
  const service = new DevelopmentService({ roots: [root] });
  await expect(service.handle({ action: 'repository', path: root })).rejects.toThrow(/Git/);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  await expect(service.handle({ action: 'repository', path: root })).rejects.toThrow(/提交/);
});
