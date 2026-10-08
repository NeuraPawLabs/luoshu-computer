import { expect, test } from 'vitest';
import { computerDoctor, computerStatus, uninstallComputer } from '../src/computer/diagnostics.js';

test('doctor distinguishes missing service, unreachable Core, and missing Agents', async () => {
  const checks = await computerDoctor({
    paths: { root: '/tmp/luoshu', state: '/tmp/luoshu/state', versions: '/tmp/luoshu/versions', current: '/tmp/luoshu/current', executable: '/tmp/bin/luoshu-computer', service: '/tmp/service' },
    serviceState: 'missing', fetchImpl: async () => { throw new Error('offline'); }, probe: async () => undefined,
  });
  expect(checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'service', status: 'error' }),
    expect.objectContaining({ id: 'core', status: 'error' }),
    expect.objectContaining({ id: 'agents', status: 'warn' }),
  ]));
});

test('status reads the product configuration without exposing a private key', async () => {
  const status = await computerStatus({
    paths: { root: '/tmp/luoshu', state: '/tmp/luoshu/state', versions: '/tmp/luoshu/versions', current: '/tmp/luoshu/current', executable: '/tmp/bin/luoshu-computer', service: '/tmp/service' },
    readConfig: async () => ({ worker_id: 'worker_1', url: 'https://luoshu.test', name: 'desk', capacity: 1 }),
    report: { name: 'desk', os: 'linux', arch: 'x64', tools: {}, agents: [], capacity: 1, revision: 1, protocol_version: 8, computer_version: '0.1.1' },
  });
  expect(status).toEqual(expect.objectContaining({ version: '0.1.1', worker_id: 'worker_1', server: 'https://luoshu.test', assistant_engines: [] }));
  expect(JSON.stringify(status)).not.toContain('private');
});

test('doctor reports Agents from the current environment report', async () => {
  const checks = await computerDoctor({
    paths: { root: '/tmp/luoshu', state: '/tmp/luoshu/state', versions: '/tmp/luoshu/versions', current: '/tmp/luoshu/current', executable: '/tmp/bin/luoshu-computer', service: '/tmp/service' },
    serviceState: 'running', fetchImpl: async () => new Response('', { status: 200 }),
    report: { name: 'desk', os: 'linux', arch: 'x64', tools: { codex: '1.2.3' }, agents: [{ id: 'codex', version: '1.2.3', detected: true }, { id: 'opencode', detected: false }], capacity: 1, revision: 1, protocol_version: 8, computer_version: '0.1.1' },
  });
  expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'agents', status: 'ok', message: '至少检测到一个 Agent' })]));
});

test('uninstall keeps identity unless purge is explicit', async () => {
  const removed: string[] = [];
  await uninstallComputer({ paths: { root: '/tmp/luoshu', state: '/tmp/luoshu/state', versions: '/tmp/luoshu/versions', current: '/tmp/luoshu/current', executable: '/tmp/bin/luoshu-computer', service: '/tmp/service' }, purge: false, run: async () => undefined, remove: async path => { removed.push(path); } });
  expect(removed).not.toContain('/tmp/luoshu/state');
  await uninstallComputer({ paths: { root: '/tmp/luoshu', state: '/tmp/luoshu/state', versions: '/tmp/luoshu/versions', current: '/tmp/luoshu/current', executable: '/tmp/bin/luoshu-computer', service: '/tmp/service' }, purge: true, run: async () => undefined, remove: async path => { removed.push(path); } });
  expect(removed).toContain('/tmp/luoshu/state');
});
