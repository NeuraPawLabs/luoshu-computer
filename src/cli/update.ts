import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ComputerPaths } from './paths.js';
import {updateComputerLauncher} from './launcher.js';

const exec = promisify(execFile);
type Release = { path: string; sha256: string; size: number };
export interface UpdateResult { status: 'updated' | 'deferred' | 'current'; from?: string; to?: string; version?: string }

type UpdateOptions = { paths: ComputerPaths; manifest: { version: string; releases: Record<string, Release> }; dev?: boolean; download: () => Promise<Uint8Array>; activeAttemptIds: () => string[] };
const receiptName = '.luoshu-release.json';

// Serialize CLI and daemon updates. A crash releases flock; no stale PID lock.
export async function applyComputerUpdate(options: UpdateOptions): Promise<UpdateResult> {
  await mkdir(options.paths.root, {recursive:true,mode:0o700});
  const lock = spawn('flock', ['--exclusive', '--timeout', '5', join(options.paths.root,'update.lock'), process.execPath, '-e', "process.stdout.write('locked');process.stdin.resume();"], {stdio:['pipe','pipe','ignore']});
  const closed = new Promise<void>(done=>lock.once('close',()=>done()));
  lock.stdin.on('error',()=>{});
  try {
    await new Promise<void>((accept,reject)=>{
      lock.once('error',reject);
      lock.stdout.once('data',()=>accept());
      lock.once('close',()=>reject(Error('Another Computer update is in progress')));
    });
    return await installUpdate(options);
  } finally {lock.stdin.end();await closed;}
}

async function installedRelease(paths:ComputerPaths) {
  let target:string;
  try {target=resolve(dirname(paths.current),await readlink(paths.current));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(dirname(target)!==resolve(paths.versions))throw Error('Installed Computer is outside the versions directory');
  const name=basename(target),development=/^(.*)-dev-([a-f0-9]{64})$/.exec(name);
  let receipt:{version:string;sha256:string}|undefined;
  try {
    receipt=JSON.parse(await readFile(join(target,receiptName),'utf8'));
    if(!receipt||typeof receipt.version!=='string'||!/^\d[A-Za-z0-9.+_-]{0,119}$/.test(receipt.version)||typeof receipt.sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sha256))throw Error('Installed Computer build receipt is invalid');
    const names=[receipt.version,`${receipt.version}-dev-${receipt.sha256}`];
    if(!names.some(base=>name===base||name.startsWith(base+'-')&&/^[A-Za-z0-9]{6}$/.test(name.slice(base.length+1))))throw Error('Installed Computer build directory does not match its receipt');
  } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return {target,name,version:receipt?.version??development?.[1]??name,sha256:receipt?.sha256};
}

async function installUpdate(options:UpdateOptions):Promise<UpdateResult> {
  const release = options.manifest.releases['linux-x64'];
  if (!release) throw new Error('No Linux x64 Computer release is available');
  if(!/^\d[A-Za-z0-9.+_-]{0,119}$/.test(options.manifest.version))throw Error('Invalid Computer release version');
  if (!/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error('Invalid release SHA-256');
  const installed=await installedRelease(options.paths),from=installed?.version;
  if (from === options.manifest.version && (!options.dev || installed?.sha256===release.sha256)) return { status: 'current', version: from };
  if (options.activeAttemptIds().length) return { status: 'deferred', version: options.manifest.version };
  const bytes = await options.download();
  if (options.activeAttemptIds().length) return { status: 'deferred', version: options.manifest.version };
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== release.sha256) throw new Error('Computer release SHA-256 mismatch');
  await mkdir(options.paths.versions, { recursive: true, mode: 0o700 });
  const temp=await mkdtemp(join(options.paths.versions,'.update-'));
  try {
    const tempArchive=join(temp,'release.tar.gz'),staging=join(temp,'build');
    await writeFile(tempArchive, bytes, { mode: 0o600 });await mkdir(staging,{mode:0o700});
    const listing = await exec('tar', ['-tvzf', tempArchive]);
    for (const line of listing.stdout.split('\n').filter(Boolean)) {
      const kind = line[0],name = line.trim().split(/\s+/).at(-1) ?? '';
      if (!['d','-'].includes(kind)||name.startsWith('/')||name.split('/').includes('..')) throw new Error('Unsafe Computer release archive');
    }
    await exec('tar',['-xzf',tempArchive,'-C',staging]);
    await writeFile(join(staging,receiptName),JSON.stringify({version:options.manifest.version,sha256:actual})+'\n',{mode:0o600});
    // Recheck after unpacking as a new turn could have started during extraction.
    if(options.activeAttemptIds().length)return {status:'deferred',version:options.manifest.version};
    const buildName=options.dev?`${options.manifest.version}-dev-${actual}`:options.manifest.version;
    let target=join(options.paths.versions,buildName);
    try{await rename(staging,target);}catch(error){
      if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      // A historical build may already exist, including the rollback target.
      // Never erase it. Publish the verified bytes under a new directory.
      target=await mkdtemp(join(options.paths.versions,`${buildName}-`));await rename(staging,target);
    }
    await updateComputerLauncher(options.paths);
    if (installed) await writeFile(join(options.paths.root,'rollback-version'),installed.target,{mode:0o600});
    await rm(join(options.paths.root,'update-attempted'),{force:true});
    const next=join(temp,'current');await symlink(target,next);await rename(next,options.paths.current);
    return {status:'updated',from,to:options.manifest.version};
  } finally {await rm(temp,{recursive:true,force:true});}
}

export async function confirmComputerUpdate(paths: ComputerPaths): Promise<void> {
  await rm(join(paths.root, 'rollback-version'), { force: true });
  await rm(join(paths.root, 'update-attempted'), { force: true });
}
