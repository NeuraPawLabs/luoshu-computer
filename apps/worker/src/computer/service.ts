import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import type { ComputerPaths } from './paths.js';

export interface ServiceFileOps {
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  chmod?: typeof chmod;
  rename?: typeof rename;
}

export function renderSystemdUnit(paths: ComputerPaths): string {
  return `[Unit]\nDescription=Luoshu Computer\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${paths.executable} daemon\nEnvironment=PATH=%h/.local/bin:%h/.bun/bin:%h/n/bin:%h/.opencode/bin:/usr/local/bin:/usr/bin:/bin\nRestart=always\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=10s\n\n[Install]\nWantedBy=default.target\n`;
}

export async function installUserService(paths: ComputerPaths, run: (command: string, args: string[]) => Promise<void> | void = async (command, args) => {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
}, io: ServiceFileOps = {}): Promise<void> {
  const makeDir = io.mkdir ?? mkdir;
  const write = io.writeFile ?? writeFile;
  const setMode = io.chmod ?? chmod;
  const move = io.rename ?? rename;
  const slash = paths.service.lastIndexOf('/');
  await makeDir(slash > 0 ? paths.service.slice(0, slash) : '.', { recursive: true, mode: 0o700 });
  const temporary = `${paths.service}.new-${process.pid}`;
  await write(temporary, renderSystemdUnit(paths), { mode: 0o600 });
  await setMode(temporary, 0o600);
  await move(temporary, paths.service);
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', '--now', 'luoshu-computer.service']);
}
