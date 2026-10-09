import { expect, test } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentFiles } from '../../src/development/files.js';

test('lists directories and previews regular files beneath configured roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-files-'));
  await mkdir(join(root, 'space dir')); await writeFile(join(root, 'space dir', 'note.txt'), 'hello');
  const files = new DevelopmentFiles({ roots: [root] });
  await expect(files.list(root)).resolves.toMatchObject({ entries: [{ name: 'space dir', kind: 'directory' }] });
  await expect(files.preview(join(root, 'space dir', 'note.txt'))).resolves.toMatchObject({ text: 'hello', truncated: false });
});

test('directory listing ignores files before its directory limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-directories-'));
  await Promise.all(Array.from({length: 510}, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), 'x')));
  await mkdir(join(root, 'project'));
  const files = new DevelopmentFiles({roots: [root]});
  await expect(files.list(root)).resolves.toMatchObject({
    entries: [{path: join(root, 'project'), name: 'project', kind: 'directory'}],
    truncated: false,
  });
});

test('directory listing hides dot-prefixed directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-hidden-'));
  await mkdir(join(root, '.config'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'project'));
  const files = new DevelopmentFiles({ roots: [root] });
  await expect(files.list(root)).resolves.toMatchObject({
    entries: [{ path: join(root, 'project'), name: 'project', kind: 'directory' }],
    truncated: false,
  });
});

test('rejects traversal and symlink components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-files-')); const outside = await mkdtemp(join(tmpdir(), 'luoshu-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'secret'); await symlink(outside, join(root, 'linked'));
  const files = new DevelopmentFiles({ roots: [root] });
  await expect(files.preview(join(root, '..', 'outside'))).rejects.toThrow(/outside|regular/);
  await expect(files.list(join(root, 'linked'))).rejects.toThrow(/Symbolic/);
});
