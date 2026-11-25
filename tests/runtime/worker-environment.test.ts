import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { agentEnvironmentPath, buildEnvironmentReport, createIdentity, saveWorkerConfig, loadWorkerConfig, resolveAgentPaths } from '../../src/runtime/environment.js';

describe('worker environment and identity', () => {
  test('reports typed software, Agents and services without local authority flags', async () => {
    const report = await buildEnvironmentReport({
      name: 'desk', capacity: 2,
      probe: async (tool) => ({ git: 'git version 2.45.1', node: 'v22.4.0', codex: 'codex-cli 0.154.0' })[tool],
      services:[{id:'development',type:'development',version:'1',agent_id:null,status:'ready',reason:null,features:['browse','repository','native_history','terminal','codebase_preparation']}],
    });
    expect(report).toMatchObject({platform:{computer_version:expect.any(String)},protocol_version:10,report_revision:1});expect(report.agents).toEqual(expect.arrayContaining([{id:'codex',version:'0.154.0',detected:true}]));
    expect(report.software).toEqual(expect.arrayContaining([{id:'git',version:'2.45.1',detected:true},{id:'node',version:'22.4.0',detected:true}]));
    expect(JSON.stringify(report)).not.toContain('luoshu.');
  });

  test('does not claim Git or unavailable Agents and keeps unknown capability data out of reports', async () => {
    const report=await buildEnvironmentReport({name:'desk',capacity:1,probe:async tool=>({node:'v22.1.0',opencode:'opencode 1.2.3'} as Record<string,string>)[tool]});
    expect(report.software).toEqual(expect.arrayContaining([{id:'node',version:'22.1.0',detected:true},{id:'opencode',version:'1.2.3',detected:true}]));
    expect(report.agents).toEqual([{id:'codex',version:null,detected:false},{id:'opencode',version:'1.2.3',detected:true}]);
    expect(report.protocol_version).toBe(10);
    expect(report.services).toEqual([]);
  });

  test('persists private identity and policy config with owner-only mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luoshu-worker-'));
    const identity = await createIdentity(dir);
    await saveWorkerConfig(dir, { worker_id: 'worker_1', url: 'https://example.test', name: 'desk', capacity: 2 });
    expect((await stat(join(dir, 'identity.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
    expect(identity.publicKey).toContain('PUBLIC KEY');
    expect(await readFile(join(dir, 'identity.json'), 'utf8')).toContain('PRIVATE KEY');
  });

  test('resolves detected Agents to absolute executable paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luoshu-agent-paths-'));
    const bin = join(dir, 'bin');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(bin);
    for (const agent of ['codex', 'opencode']) await writeFile(join(bin, agent), '#!/bin/sh\nprintf "%s\\n" "1.2.3"\n', { mode: 0o700 });
    expect(await resolveAgentPaths({ envPath: bin, home: dir })).toEqual({ codex: join(bin, 'codex'), opencode: join(bin, 'opencode') });
  });

  test('refreshes configured paths when an installed Agent moved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luoshu-agent-refresh-'));
    const bin = join(dir, 'bin');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(bin);
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nprintf "%s\\n" "1.2.3"\n', { mode: 0o700 });
    expect(await resolveAgentPaths({ agentPaths: { codex: '/old/node/codex' }, envPath: bin, home: dir, refreshMissing: true })).toEqual({ codex: join(bin, 'codex') });
  });

  test('adds Agent parent directories so script based Agents can find Node', () => {
    expect(agentEnvironmentPath({ codex: '/home/alice/.nvm/versions/node/v24/bin/codex' }, '/usr/bin:/bin')).toBe('/home/alice/.nvm/versions/node/v24/bin:/usr/bin:/bin');
  });

  test('persists explicit Codex permissions and rejects an invalid sandbox mode',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'luoshu-permissions-'));
    const config={worker_id:'worker_1',url:'https://example.test',name:'desk',capacity:1};
    await saveWorkerConfig(dir,{...config,codex_sandbox:'danger-full-access'});
    expect((await loadWorkerConfig(dir)).codex_sandbox).toBe('danger-full-access');
    await expect(saveWorkerConfig(dir,{...config,codex_sandbox:'invalid' as any})).rejects.toThrow();
  });
});
