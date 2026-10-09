import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {generateKeyPairSync,sign} from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const exec = promisify(execFile);

test('computer package contains a Linux release and manifest digest', async () => {
  execFileSync(process.execPath, ['scripts/package-computer.mjs'], { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(root, 'dist/computer/manifest.json'), 'utf8'));
  const workerPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, workerPackage.version);
  const archive = join(root, 'dist/computer', manifest.releases['linux-x64'].path.replace(/^\/computer\//, ''));
  const packagedVersion = execFileSync('tar', ['-xOzf', archive, './app/dist/cli/version.js'], { encoding: 'utf8' });
  const runtime = await import(`data:text/javascript,${encodeURIComponent(packagedVersion)}`);
  assert.equal(runtime.COMPUTER_VERSION, manifest.version);
  assert.equal(manifest.protocol_version, 8);
  assert.equal(manifest.releases['linux-x64'].sha256.length, 64);
  assert.ok(existsSync(join(root, 'dist/computer', manifest.releases['linux-x64'].path.replace(/^\/computer\//, ''))));
  const listing = execFileSync('tar', ['-tzf', join(root, 'dist/computer', manifest.releases['linux-x64'].path.replace(/^\/computer\//, ''))], { encoding: 'utf8' });
  assert.match(listing, /app\/node_modules\/ws\/package\.json/);
  assert.doesNotMatch(listing, /app\/packages\//);
  assert.match(listing, /app\/dist\/main\.js/);
  const detailed = execFileSync('tar', ['-tvzf', join(root, 'dist/computer', manifest.releases['linux-x64'].path.replace(/^\/computer\//, ''))], { encoding: 'utf8' });
  assert.doesNotMatch(detailed, /(^|\n)l[rwx-]{9}\s/);
});

test('installer template is included and contains no development npm command', () => {
  const installer = readFileSync(join(root, 'dist/computer/install.sh'), 'utf8');
  assert.match(installer, /sha256sum/);
  assert.doesNotMatch(installer, /npm run worker/);
});

test('the generated release updates an installed 0.1.2 computer', async () => {
  const { applyComputerUpdate } = await import('../../dist/lib/cli/update.js');
  const computerRoot = join(root, 'dist/computer');
  const manifest = JSON.parse(readFileSync(join(computerRoot, 'manifest.json'), 'utf8'));
  const installRoot = mkdtempSync(join(tmpdir(), 'luoshu-computer-release-update-'));
  const paths = { root: installRoot, state: join(installRoot, 'state'), versions: join(installRoot, 'versions'), current: join(installRoot, 'current'), executable: join(installRoot, 'bin/luoshu-computer'), service: join(installRoot, 'service') };
  try {
    mkdirSync(join(paths.versions, '0.1.2'), { recursive: true });
    symlinkSync(join(paths.versions, '0.1.2'), paths.current);
    const result = await applyComputerUpdate({ paths, manifest, activeAttemptIds: () => [], download: async () => readFileSync(join(computerRoot, manifest.releases['linux-x64'].path.replace(/^\/computer\//, ''))) });
    assert.deepEqual(result, { status: 'updated', from: '0.1.2', to: manifest.version });
    assert.equal(readlinkSync(paths.current), join(paths.versions, manifest.version));
    assert.ok(existsSync(join(paths.current, 'bin/luoshu-computer')));
  } finally { rmSync(installRoot, { recursive: true, force: true }); }
});

test('installer consumes a signed manifest with a pinned public key and activates the release', async () => {
  const computerRoot = join(root, 'dist/computer');
  const keyPair=generateKeyPairSync('ed25519');
  const signature=sign(null,readFileSync(join(computerRoot,'manifest.json')),keyPair.privateKey);
  const server = createServer((request, response) => {
    if(request.url==='/computer/manifest.sig'){response.end(signature);return;}
    const file = request.url === '/computer/manifest.json' ? join(computerRoot, 'manifest.json') : request.url?.startsWith('/computer/releases/') ? join(computerRoot, request.url.replace('/computer/', '')) : null;
    if (!file || !existsSync(file)) { response.statusCode = 404; response.end(); return; }
    response.setHeader('content-type', request.url?.endsWith('.json') ? 'application/json' : 'application/gzip');
    response.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const home = mkdtempSync(join(tmpdir(), 'luoshu-computer-install-'));
  try {
    const keyPath=join(home,'public.pem');writeFileSync(keyPath,keyPair.publicKey.export({type:'spki',format:'pem'}));
    await exec('sh', [join(computerRoot, 'install.sh')], { env: { ...process.env, HOME: home, LUOSHU_RELEASE_KEY:keyPath, LUOSHU_BASE_URL: `http://127.0.0.1:${address.port}` }, timeout: 120_000 });
    assert.equal(existsSync(join(home, '.local/bin/luoshu-computer')), true);
    assert.equal(existsSync(join(home, '.local/share/luoshu-computer/current/runtime/node')), true);
    const state = join(home, '.local/share/luoshu-computer/state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'config.json'), JSON.stringify({ worker_id: 'worker_1', url: 'http://127.0.0.1:8080', name: 'desk', capacity: 1 }));
    const status = await exec(join(home, '.local/bin/luoshu-computer'), ['status'], { env: { ...process.env, HOME: home }, timeout: 30_000 });
    assert.equal(JSON.parse(status.stdout).worker_id, 'worker_1');
    // A pre-migration updater rewrites the launcher to this historical entry.
    // Execute it with the real bundled Node to prove old clients can upgrade.
    const legacy = await exec(join(home, '.local/share/luoshu-computer/current/runtime/node'), [join(home, '.local/share/luoshu-computer/current/app/apps/worker/dist/computer-main.js'), 'status'], {env:{...process.env,HOME:home},timeout:30_000});
    assert.equal(JSON.parse(legacy.stdout).worker_id, 'worker_1');
    const installed=readlinkSync(join(home,'.local/share/luoshu-computer/current'));
    signature.fill(0);
    await assert.rejects(exec('sh',[join(computerRoot,'install.sh')],{env:{...process.env,HOME:home,LUOSHU_RELEASE_KEY:keyPath,LUOSHU_BASE_URL:`http://127.0.0.1:${address.port}`},timeout:30000}),/signature verification failed/);
    assert.equal(readlinkSync(join(home,'.local/share/luoshu-computer/current')),installed);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test('generated package refreshes the same version explicitly and then skips identical dev builds', async()=>{
  const {applyComputerUpdate}=await import('../../dist/lib/cli/update.js');
  const computerRoot=join(root,'dist/computer'),manifest=JSON.parse(readFileSync(join(computerRoot,'manifest.json'),'utf8'));
  const installRoot=mkdtempSync(join(tmpdir(),'luoshu-computer-dev-package-'));
  const paths={root:installRoot,state:join(installRoot,'state'),versions:join(installRoot,'versions'),current:join(installRoot,'current'),executable:join(installRoot,'bin/luoshu-computer'),service:join(installRoot,'service')};
  try{
    const original=join(paths.versions,manifest.version);mkdirSync(original,{recursive:true});writeFileSync(join(original,'old-build.txt'),'keep');symlinkSync(original,paths.current);
    const options={paths,manifest,dev:true,activeAttemptIds:()=>[],download:async()=>readFileSync(join(computerRoot,manifest.releases['linux-x64'].path.replace(/^\/computer\//,'')))};
    assert.equal((await applyComputerUpdate(options)).status,'updated');
    assert.ok(existsSync(join(paths.current,'runtime/node')));assert.ok(existsSync(join(original,'old-build.txt')));
    assert.equal(readFileSync(join(paths.root,'rollback-version'),'utf8'),original);
    assert.deepEqual(await applyComputerUpdate({...options,download:async()=>{throw Error('identical build must skip download');}}),{status:'current',version:manifest.version});
  }finally{rmSync(installRoot,{recursive:true,force:true});}
});

test.afterEach(() => {
  // Keep the generated artifact for the next packaging task; tests only remove stale temp files.
  rmSync(join(root, 'dist/computer/.test-temp'), { recursive: true, force: true });
});
