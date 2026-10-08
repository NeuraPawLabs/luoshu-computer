import type {CodexSandboxMode} from '@luoshu/protocol';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { pairWorker } from '../client.js';
import {validateComputerReleaseSource} from './releases.js';
import type { ComputerPaths } from './paths.js';
import { installUserService, type ServiceFileOps } from './service.js';

export interface SetupResult { workerId: string; status: string; service: 'started' }
export interface SetupOptions {
  server: string; code: string; name: string; capacity?: number; releaseUrl?: string; releaseKey?: string; maintenanceRoot?:string; developmentRoots?:string[]; codexSandbox?:CodexSandboxMode; paths: ComputerPaths;
  pair?: typeof pairWorker;
  writeFile?: typeof writeFile; mkdir?: typeof mkdir; chmod?: typeof chmod; rename?: typeof rename;
  run?: (command: string, args: string[]) => Promise<void> | void;
}

function validateServer(server: string): void {
  const url = new URL(server);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!loopback && url.protocol !== 'https:') throw new Error('Computer server URL must use HTTPS outside loopback');
}

export async function setupComputer(options: SetupOptions): Promise<SetupResult> {
  validateServer(options.server);
  if ((options.releaseUrl !== undefined) !== (options.releaseKey !== undefined)) throw new Error('Computer release URL and key file must be specified together');
  const releasePublicKey = options.releaseKey === undefined ? undefined : await readFile(options.releaseKey, 'utf8');
  validateComputerReleaseSource({release_url: options.releaseUrl, release_public_key: releasePublicKey});
  const name = options.name.trim();
  if (!name || name.length > 100) throw new Error('Device name must contain 1 to 100 characters');
  const capacity = options.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) throw new Error('Capacity must be an integer from 1 to 16');
  const pair = options.pair ?? pairWorker;
  const result = await pair({ stateDir: options.paths.state, url: options.server, code: options.code, name, capacity,
    releaseUrl:options.releaseUrl, releasePublicKey, codexSandbox:options.codexSandbox, developmentRoots: options.developmentRoots, maintenanceRoots: options.maintenanceRoot ? [options.maintenanceRoot] : [] });
  await (options.mkdir ?? mkdir)(options.paths.state, { recursive: true, mode: 0o700 });
  const io: ServiceFileOps = { writeFile: options.writeFile, mkdir: options.mkdir, chmod: options.chmod, rename: options.rename };
  await installUserService(options.paths, options.run, io);
  return { workerId: result.workerId, status: result.status, service: 'started' };
}
