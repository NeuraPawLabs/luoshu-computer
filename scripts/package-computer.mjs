import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {createComputerArchive} from './computer-archive.mjs';
import {copyComputerNodeRuntime} from './computer-node-runtime.mjs';
import {PROTOCOL_VERSION} from '../dist/lib/protocol/index.js';
import {COMPUTER_VERSION} from '../dist/lib/cli/version.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist/computer');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if(version!==COMPUTER_VERSION)throw Error('Build the current Worker version before packaging Computer');
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Computer release packaging supports only Linux x64');
const staging = resolve(root, 'dist/.computer-staging/linux-x64');
rmSync(output, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync(process.execPath, [resolve(root, 'scripts/package-runtime.mjs')], { cwd: root, stdio: 'pipe' });
cpSync(resolve(root, 'dist/runtime'), join(staging, 'app'), { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--offline', '--no-audit', '--no-fund'], { cwd: join(staging, 'app'), stdio: 'pipe', timeout: 120_000 });

function flattenSymlinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(root, readlinkSync(path));
      if (!target.startsWith(`${staging}/`)) throw new Error(`Computer package contains an external symlink: ${path}`);
      const targetStat = lstatSync(target);
      rmSync(path, { recursive: true, force: true });
      cpSync(target, path, { recursive: targetStat.isDirectory(), dereference: true });
    } else if (entry.isDirectory()) {
      flattenSymlinks(path);
    }
  }
}

// npm creates workspace and .bin symlinks during the production install. The
// release archive must be self-contained and contain no links for the client
// updater to safely validate and extract it.
flattenSymlinks(join(staging, 'app'));
copyComputerNodeRuntime(staging);
cpSync(resolve(root,'LICENSE'),join(staging,'LICENSE'));
mkdirSync(join(staging, 'bin'), { recursive: true });
writeFileSync(join(staging, 'bin/luoshu-computer'), `#!/bin/sh\nset -eu\nSELF=$(readlink -f -- "$0")\nROOT=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)\nexec "$ROOT/runtime/node" "$ROOT/app/dist/main.js" "$@"\n`, { mode: 0o755 });
const releaseDir = join(output, 'releases', version);
mkdirSync(releaseDir, { recursive: true });
const archive = join(releaseDir, 'linux-x64.tar.gz');
createComputerArchive(staging,archive);
const bytes = readFileSync(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = { version, protocol_version: PROTOCOL_VERSION, releases: { 'linux-x64': { path: `/computer/releases/${version}/linux-x64.tar.gz`, sha256, size: bytes.byteLength } } };
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const template = readFileSync(resolve(root, 'scripts/templates/install-computer.sh'), 'utf8');
writeFileSync(join(output, 'install.sh'), template.replace('__LUOSHU_BASE_URL__', '${LUOSHU_BASE_URL:-http://127.0.0.1:8080}'), { mode: 0o755 });
rmSync(resolve(root, 'dist/.computer-staging'), { recursive: true, force: true });
console.log(output);
