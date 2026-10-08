import { mkdirSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [name, ...args] = process.argv.slice(2);
if (!['core', 'worker'].includes(name)) throw new Error('use core or worker');
if(args.length && (name !== 'core' || args.length !== 2 || args[0] !== '--computer-release'))throw new Error('Usage: package-runtime.mjs core [--computer-release DIR] | worker');
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'dist', name);
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const workspaces = new Map();

function collect(path) {
  if (workspaces.has(path)) return;
  const manifest = JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8'));
  if (!existsSync(resolve(root, path, 'dist'))) throw new Error(`Build ${path} first`);
  // Ship only compiled code and runtime dependencies; no development scripts.
  const { scripts, devDependencies, references, ...runtime } = manifest;
  workspaces.set(path, runtime);
  for (const dependency of Object.keys(runtime.dependencies ?? {})) {
    if (!dependency.startsWith('@luoshu/')) continue;
    const link = lock.packages[`node_modules/${dependency}`];
    if (!link?.link) throw new Error(`Missing workspace dependency: ${dependency}`);
    collect(link.resolved);
  }
}

collect(`apps/${name}`);
let computerMirror;
if(args.length){
  const {validateComputerRelease}=await import('./computer-release.mjs');
  computerMirror=validateComputerRelease(resolve(args[1]));
}
if (name === 'core') {
  if (!existsSync(resolve(root, 'dist/app/index.html'))) throw new Error('Build the app first');
  execFileSync(process.execPath, [resolve(root, 'scripts/assemble-public.mjs')], { cwd: root });
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const entry = `apps/${name}/dist/main.js`;
const manifest = {
  name: `luoshu-${name}-runtime`, version: workspaces.get(`apps/${name}`).version, private: true, type: 'module',
  engines: { node: '>=22' }, workspaces: [...workspaces.keys()],
  scripts: { start: `node ${entry}` },
  ...(name === 'worker' ? { allowScripts: { 'node-pty@1.1.0': true } } : {}),
};
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

function copyCompiledSources(workspace, destination, relative = '') {
  // Incremental TypeScript builds retain removed modules. Ship only outputs with a current source.
  const sourceRoot = resolve(root, workspace, 'src');
  const compiledRoot = resolve(root, workspace, 'dist');
  for (const entry of readdirSync(join(sourceRoot, relative), { withFileTypes: true })) {
    const source = join(relative, entry.name);
    if (entry.isDirectory()) { copyCompiledSources(workspace, destination, source); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    const module = source.slice(0, -3);
    const compiled = join(compiledRoot, `${module}.js`);
    if (!existsSync(compiled)) throw new Error(`Build current source ${workspace}/src/${source} first`);
    for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
      const file = join(compiledRoot, `${module}${suffix}`);
      if (!existsSync(file)) continue;
      const output = join(destination, `${module}${suffix}`);
      mkdirSync(dirname(output), { recursive: true });
      cpSync(file, output);
    }
  }
}
writeJson(resolve(target, 'package.json'), manifest);
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[''] = manifest;
for (const [path, record] of Object.entries(lock.packages)) {
  if ((path.startsWith('apps/') || path.startsWith('packages/')) && !workspaces.has(path)) {
    delete lock.packages[path];
  } else if (record.link && !workspaces.has(record.resolved)) {
    delete lock.packages[path];
  }
}
for (const [path, runtime] of workspaces) {
  const destination = resolve(target, path);
  mkdirSync(destination, { recursive: true });
  copyCompiledSources(path, resolve(destination, 'dist'));
  if(existsSync(resolve(root,path,'LICENSE')))cpSync(resolve(root,path,'LICENSE'),resolve(destination,'LICENSE'));
  writeJson(resolve(destination, 'package.json'), runtime);
  lock.packages[path] = runtime;
}
writeJson(resolve(target, 'package-lock.json'), lock);
// Reconcile the reduced workspace graph using the existing lock and local cache.
// Native dependencies are installed on the destination host with npm ci.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
  cwd: target, stdio: 'pipe', timeout: 60_000,
});
if (name === 'core') {
  cpSync(resolve(root, 'dist/public'), resolve(target, 'public'), { recursive: true });
  for(const file of computerMirror?.files ?? []){
    const output=resolve(target,'public/computer',file.path);
    mkdirSync(dirname(output),{recursive:true});
    writeFileSync(output,file.bytes,{mode:file.mode});
  }
}
writeFileSync(resolve(target, 'README.txt'), `Luoshu ${name} runtime\nNode.js 22+\nRun npm ci --omit=dev on the destination host, then node ${entry}${name === 'core' ? ' serve' : name === 'worker' ? ' join|run' : ' setup|daemon|status|doctor'}.\n${name === 'core' ? 'Set LUOSHU_PUBLIC_DIR to the absolute path of public/ and LUOSHU_DB to persistent storage.\n' : ''}`);
console.log(target);
