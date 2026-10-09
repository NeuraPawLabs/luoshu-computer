import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { applyComputerUpdate } from '../../src/cli/update.js';
import { COMPUTER_VERSION } from '../../src/cli/version.js';

const exec = promisify(execFile);

async function fixture(installedVersion = '0.1.0', releaseVersion = '0.1.1') {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-computer-update-'));
  const paths = { root, state: join(root, 'state'), versions: join(root, 'versions'), current: join(root, 'current'), executable: join(root, 'bin', 'luoshu-computer'), service: join(root, 'service') };
  await mkdir(join(root, 'source'), { recursive: true }); await writeFile(join(root, 'source', 'version.txt'), 'new');
  const archive = join(root, 'new.tar.gz'); await exec('tar', ['-czf', archive, '-C', join(root, 'source'), '.']);
  const bytes = await import('node:fs/promises').then(fs => fs.readFile(archive));
  await mkdir(join(paths.versions, installedVersion), { recursive: true }); await symlink(join(paths.versions, installedVersion), paths.current);
  return { root, paths, archive, bytes, manifest: { version: releaseVersion, releases: { 'linux-x64': { path: `/computer/releases/${releaseVersion}/linux-x64.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength } } } };
}

test('the Worker configuration release updates an installed 0.1.4 computer', async () => {
  const workerPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const fixtureData = await fixture('0.1.4', workerPackage.version);
  try {
    const result = await applyComputerUpdate({ paths: fixtureData.paths, manifest: fixtureData.manifest, download: async () => fixtureData.bytes, activeAttemptIds: () => [] });
    expect(result).toEqual({ status: 'updated', from: '0.1.4', to: COMPUTER_VERSION });
    expect(await readlink(fixtureData.paths.current)).toBe(join(fixtureData.paths.versions, COMPUTER_VERSION));
    expect(await readFile(join(fixtureData.paths.current, 'version.txt'), 'utf8')).toBe('new');
  } finally { await rm(fixtureData.root, { recursive: true, force: true }); }
});

test('worker package, lockfile and reported computer versions agree', async () => {
  const workerPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  expect(COMPUTER_VERSION).toBe(workerPackage.version);
  expect(lock.packages[''].version).toBe(workerPackage.version);
});

test('renumbering the independent release preserves legacy installation state and rollback',async()=>{
 const f=await fixture('0.1.6','0.1.0');
 try{
  await mkdir(f.paths.state);await writeFile(join(f.paths.state,'identity.json'),'keep local identity');
  await writeFile(join(f.paths.current,'legacy.txt'),'keep old build');
  expect(await applyComputerUpdate({paths:f.paths,manifest:f.manifest,download:async()=>f.bytes,activeAttemptIds:()=>[]})).toEqual({status:'updated',from:'0.1.6',to:'0.1.0'});
  expect(await readFile(join(f.paths.state,'identity.json'),'utf8')).toBe('keep local identity');
  expect(await readFile(join(f.paths.versions,'0.1.6','legacy.txt'),'utf8')).toBe('keep old build');
  expect(await readFile(join(f.paths.root,'rollback-version'),'utf8')).toBe(join(f.paths.versions,'0.1.6'));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('downloads, verifies, and atomically switches an idle client', async () => {
  const fixtureData = await fixture();
  try {
    const result = await applyComputerUpdate({ paths: fixtureData.paths, manifest: fixtureData.manifest, download: async () => fixtureData.bytes, activeAttemptIds: () => [] });
    expect(result).toEqual({ status: 'updated', from: '0.1.0', to: '0.1.1' });
    expect(await readlink(fixtureData.paths.current)).toContain('versions/0.1.1');
  } finally { await rm(fixtureData.root, { recursive: true, force: true }); }
});

test('defers update while an execution is active', async () => {
  const fixtureData = await fixture();
  try { expect(await applyComputerUpdate({ paths: fixtureData.paths, manifest: fixtureData.manifest, download: async () => fixtureData.bytes, activeAttemptIds: () => ['run_1'] })).toEqual({ status: 'deferred', version: '0.1.1' }); }
  finally { await rm(fixtureData.root, { recursive: true, force: true }); }
});

test('digest mismatch leaves the previous current link untouched', async () => {
  const fixtureData = await fixture();
  try { await expect(applyComputerUpdate({ paths: fixtureData.paths, manifest: { ...fixtureData.manifest, releases: { 'linux-x64': { ...fixtureData.manifest.releases['linux-x64'], sha256: '0'.repeat(64) } } }, download: async () => fixtureData.bytes, activeAttemptIds: () => [] })).rejects.toThrow(/SHA-256/); expect(await readlink(fixtureData.paths.current)).toContain('versions/0.1.0'); }
  finally { await rm(fixtureData.root, { recursive: true, force: true }); }
});

test('rechecks active sessions after downloading before switching', async () => {
  const fixtureData = await fixture(); let active = false;
  await expect(applyComputerUpdate({ paths: fixtureData.paths, manifest: fixtureData.manifest, download: async () => { active = true; return fixtureData.bytes; }, activeAttemptIds: () => active ? ['development-1'] : [] })).resolves.toEqual({ status: 'deferred', version: '0.1.1' });
  expect(await readlink(fixtureData.paths.current)).toContain('versions/0.1.0');
  await rm(fixtureData.root, { recursive: true, force: true });
});

test('development update installs changed content at the same version without overwriting the previous build', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    await mkdir(f.paths.state);await writeFile(join(f.paths.state,'identity.json'),'keep identity');
    await writeFile(join(f.paths.current,'version.txt'),'previous');
    const result=await applyComputerUpdate({paths:f.paths,manifest:f.manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>[]});
    expect(result.status).toBe('updated');
    expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,`0.1.5-dev-${f.manifest.releases['linux-x64'].sha256}`));
    expect(await readFile(join(f.paths.current,'version.txt'),'utf8')).toBe('new');
    expect(await readFile(join(f.paths.versions,'0.1.5','version.txt'),'utf8')).toBe('previous');
    expect(await readFile(join(f.paths.root,'rollback-version'),'utf8')).toBe(join(f.paths.versions,'0.1.5'));
    expect(await readFile(join(f.paths.state,'identity.json'),'utf8')).toBe('keep identity');
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('same development build is current and normal updates preserve its semantic version', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const options={paths:f.paths,manifest:f.manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>[]};
    await applyComputerUpdate(options);const link=await readlink(f.paths.current);
    const noDownload=async()=>{throw Error('same build must not download');};
    expect(await applyComputerUpdate({...options,download:noDownload})).toEqual({status:'current',version:'0.1.5'});
    expect(await applyComputerUpdate({...options,dev:false,download:noDownload})).toEqual({status:'current',version:'0.1.5'});
    expect(await readlink(f.paths.current)).toBe(link);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('a second development build with the same version keeps the first build as rollback', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const options={paths:f.paths,manifest:f.manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>[]};
    await applyComputerUpdate(options);const previous=await readlink(f.paths.current);
    await writeFile(join(f.root,'source','version.txt'),'second');
    await exec('tar',['-czf',f.archive,'-C',join(f.root,'source'),'.']);const bytes=await readFile(f.archive);
    const release={...f.manifest.releases['linux-x64'],sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
    const result=await applyComputerUpdate({...options,manifest:{...f.manifest,releases:{'linux-x64':release}},download:async()=>bytes});
    expect(result.status).toBe('updated');expect(await readFile(join(f.paths.root,'rollback-version'),'utf8')).toBe(previous);
    expect(await readFile(join(previous,'version.txt'),'utf8')).toBe('new');
    expect(await readFile(join(f.paths.current,'version.txt'),'utf8')).toBe('second');
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('same version development refresh defers for active work and for work admitted during download', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const options={paths:f.paths,manifest:f.manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>['native-running']};
    expect(await applyComputerUpdate(options)).toEqual({status:'deferred',version:'0.1.5'});
    let active=false;
    expect(await applyComputerUpdate({...options,activeAttemptIds:()=>active?['native-running']:[],download:async()=>{active=true;return f.bytes;}})).toEqual({status:'deferred',version:'0.1.5'});
    expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,'0.1.5'));
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('development refresh with a bad digest leaves the installed build intact', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const manifest={...f.manifest,releases:{'linux-x64':{...f.manifest.releases['linux-x64'],sha256:'0'.repeat(64)}}};
    await expect(applyComputerUpdate({paths:f.paths,manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>[]})).rejects.toThrow(/SHA-256/);
    expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,'0.1.5'));
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('a failed extraction leaves current and rollback records unchanged', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const bytes=Buffer.from('not a tar archive');
    const manifest={...f.manifest,releases:{'linux-x64':{...f.manifest.releases['linux-x64'],sha256:createHash('sha256').update(bytes).digest('hex')}}};
    await expect(applyComputerUpdate({paths:f.paths,manifest,dev:true,download:async()=>bytes,activeAttemptIds:()=>[]})).rejects.toThrow();
    expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,'0.1.5'));
    await expect(readFile(join(f.paths.root,'rollback-version'))).rejects.toMatchObject({code:'ENOENT'});
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('reinstalling a retained build after rollback keeps both immutable directories usable', async () => {
  const f=await fixture('0.1.5','0.1.5');
  try {
    const options={paths:f.paths,manifest:f.manifest,dev:true,download:async()=>f.bytes,activeAttemptIds:()=>[]};
    await applyComputerUpdate(options);const retained=await readlink(f.paths.current);
    await rm(f.paths.current);await symlink(join(f.paths.versions,'0.1.5'),f.paths.current);
    await applyComputerUpdate(options);
    expect(await readFile(join(retained,'version.txt'),'utf8')).toBe('new');
    expect(await applyComputerUpdate({...options,download:async()=>{throw Error('must be current');}})).toEqual({status:'current',version:'0.1.5'});
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('concurrent CLI or daemon update attempts publish a development build only once', async()=>{
  const f=await fixture('0.1.5','0.1.5');let downloads=0;
  try{
    const options={paths:f.paths,manifest:f.manifest,dev:true,activeAttemptIds:()=>[],download:async()=>{downloads++;return f.bytes;}};
    const results=await Promise.all([applyComputerUpdate(options),applyComputerUpdate(options)]);
    expect(results.map(result=>result.status).sort()).toEqual(['current','updated']);expect(downloads).toBe(1);
    expect(await readFile(join(f.paths.root,'rollback-version'),'utf8')).toBe(join(f.paths.versions,'0.1.5'));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
