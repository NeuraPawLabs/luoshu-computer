import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ComputerPaths {
  root: string;
  state: string;
  versions: string;
  current: string;
  executable: string;
  service: string;
}

export function resolveComputerPaths(home = homedir()): ComputerPaths {
  const root = join(home, '.local', 'share', 'luoshu-computer');
  return {
    root,
    state: join(root, 'state'),
    versions: join(root, 'versions'),
    current: join(root, 'current'),
    executable: join(home, '.local', 'bin', 'luoshu-computer'),
    service: join(home, '.config', 'systemd', 'user', 'luoshu-computer.service'),
  };
}
