import { expect, test } from 'vitest';
import { resolveComputerPaths } from '../../src/cli/paths.js';
import { parseComputerCommand } from '../../src/cli/index.js';

test('resolves all product paths below the user home', () => {
  expect(resolveComputerPaths('/home/alice')).toEqual({
    root: '/home/alice/.local/share/luoshu-computer',
    state: '/home/alice/.local/share/luoshu-computer/state',
    versions: '/home/alice/.local/share/luoshu-computer/versions',
    current: '/home/alice/.local/share/luoshu-computer/current',
    executable: '/home/alice/.local/bin/luoshu-computer',
    service: '/home/alice/.config/systemd/user/luoshu-computer.service',
  });
});

test('development updates opt in to build checks without adding flags to other commands', () => {
  expect(parseComputerCommand(['update', '--dev'])).toEqual({command:'update', dev:true});
  expect(parseComputerCommand(['update'])).toEqual({command:'update'});
  expect(() => parseComputerCommand(['update', '--dev', '--dev'])).toThrow(/Unknown|repeated/);
  expect(() => parseComputerCommand(['restart', '--dev'])).toThrow(/Unknown/);
});

test('parses stable product commands and rejects removed local authorization flags', () => {
  expect(parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk'])).toEqual({
    command: 'setup', server: 'https://luoshu.test', code: 'secret', name: 'desk',
  });
  expect(parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk', '--maintenance-root', '/home/alice/src/luoshu'])).toEqual({
    command: 'setup', server: 'https://luoshu.test', code: 'secret', name: 'desk', maintenanceRoot: '/home/alice/src/luoshu',
  });
  expect(parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk', '--capacity', '4'])).toEqual({
    command: 'setup', server: 'https://luoshu.test', code: 'secret', name: 'desk', capacity: 4,
  });
  expect(() => parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk', '--capacity', '0'])).toThrow(/capacity/i);
  expect(() => parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk', '--capacity', '17'])).toThrow(/capacity/i);
  expect(() => parseComputerCommand(['setup', '--server', 'https://luoshu.test', '--code', 'secret', '--name', 'desk', '--maintenance-root', '../repo'])).toThrow(/absolute/i);
  expect(() => parseComputerCommand(['setup', '--agents', 'codex'])).toThrow(/Unknown/);
  expect(parseComputerCommand(['start'])).toEqual({ command: 'start' });
  expect(parseComputerCommand(['stop'])).toEqual({ command: 'stop' });
  expect(parseComputerCommand(['restart'])).toEqual({ command: 'restart' });
  expect(() => parseComputerCommand(['stop', '--purge'])).toThrow(/Unknown/);
});

test('setup supports multiple development roots independently from maintenance roots', () => {
  expect(parseComputerCommand(['setup','--server','https://luoshu.test','--code','secret','--name','desk',
    '--development-root','/home/alice/code','--development-root','/srv/projects','--maintenance-root','/srv/luoshu'])).toMatchObject({
      developmentRoots: ['/home/alice/code','/srv/projects'], maintenanceRoot: '/srv/luoshu',
    });
  expect(()=>parseComputerCommand(['setup','--server','https://luoshu.test','--code','secret','--name','desk','--development-root','../code'])).toThrow(/absolute/);
});

test('setup accepts an explicit Codex permission mode and rejects unsupported modes',()=>{
 const base=['setup','--server','https://luoshu.test','--code','secret','--name','desk'];
 expect(parseComputerCommand([...base,'--codex-sandbox','danger-full-access'])).toMatchObject({codexSandbox:'danger-full-access'});
 expect(parseComputerCommand([...base,'--codex-sandbox','workspace-write'])).toMatchObject({codexSandbox:'workspace-write'});
 expect(()=>parseComputerCommand([...base,'--codex-sandbox','anything'])).toThrow();
});

test('setup accepts a local release key file only together with a directory feed URL',()=>{
 const base=['setup','--server','https://luoshu.test','--code','secret','--name','desk'];
 expect(parseComputerCommand([...base,'--release-url','https://downloads.test/computer','--release-key','/keys/release.pem'])).toMatchObject({releaseUrl:'https://downloads.test/computer',releaseKey:'/keys/release.pem'});
 expect(()=>parseComputerCommand([...base,'--release-url','https://downloads.test/computer'])).toThrow(/together|key/i);
 expect(()=>parseComputerCommand([...base,'--release-key','/keys/release.pem'])).toThrow(/together|URL/i);
});

test('setup rejects empty independent release configuration values',()=>{
 const base=['setup','--server','https://luoshu.test','--code','secret','--name','desk'];
 expect(()=>parseComputerCommand([...base,'--release-url','','--release-key','/keys/public.pem'])).toThrow(/release/i);
 expect(()=>parseComputerCommand([...base,'--release-url','https://downloads.test/computer','--release-key',''])).toThrow(/release/i);
});
