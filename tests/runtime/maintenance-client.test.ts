import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {afterEach, expect, test} from 'vitest';
import {WorkerClient} from '../../src/runtime/client.js';
import {createIdentity, saveWorkerConfig} from '../../src/runtime/environment.js';
import type {MaintenanceRequest, WorkerMessage, WorkerReport} from '../../src/protocol/index.js';

const closers: (() => void)[] = [];
afterEach(() => { while (closers.length) closers.pop()?.(); });
const waitFor = <T>(read: () => T | undefined) => new Promise<T>((resolve, reject) => { const end = Date.now() + 2_000; const poll = () => { const value = read(); if (value !== undefined) return resolve(value); if (Date.now() > end) return reject(new Error('timeout')); setTimeout(poll, 10); }; poll(); });

test('advertises maintenance only with an executor and returns a correlated bounded result', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'luoshu-maintenance-client-')); await createIdentity(stateDir);
  const server = createServer(), wss = new WebSocketServer({server, path: '/ws/worker'}), received: WorkerMessage[] = [];
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  await saveWorkerConfig(stateDir, {worker_id: 'worker_1', url: `http://127.0.0.1:${address.port}`, name: 'desk', capacity: 1});
  const report: WorkerReport = {name: 'desk', os: 'linux', arch: 'x64', tools: {git:'2.0.0'}, agents: [{id: 'codex', detected: true}], capacity: 1, revision: 1, protocol_version: 8, computer_version: '0.1.2'};
  const request: MaintenanceRequest = {type: 'maintenance_request', request_id: 'request_1', attempt_id: 'attempt_1', lease_epoch: 1, operation: 'repair', repository: '/srv/luoshu', base_sha: 'a'.repeat(40), branch: 'luoshu/repair/incident_1/attempt_1', agent: 'codex', instruction: 'fix', allowed_paths: ['apps/core/**'], checks: [{name: 'unit', executable: 'npm', args: ['test'], timeout_seconds: 60}], timeout_seconds: 300};
  wss.on('connection', socket => { socket.send(JSON.stringify({type: 'challenge', nonce: 'nonce', protocol_version: 8})); socket.on('message', raw => { const message = JSON.parse(raw.toString()) as WorkerMessage; received.push(message); if (message.type === 'auth') { socket.send(JSON.stringify({type: 'welcome', worker_id: 'worker_1', generation: 1, heartbeat_ms: 1000, lease_ms: 120000})); socket.send(JSON.stringify(request)); }if(message.type==='maintenance_response'&&message.request_id==='request_1')socket.send(JSON.stringify({...request,request_id:'request_2',attempt_id:'attempt_2',branch:'luoshu/repair/incident_1/attempt_2',agent:'opencode'})); }); });
  let calls=0;const client = new WorkerClient({stateDir, report, maintenance: {execute: async value => {calls++;return{status: 'patch_ready', summary: 'fixed', base_sha: value.base_sha, commit_sha: 'b'.repeat(40), branch: value.branch, changed_paths: ['apps/core/fix.ts'], checks: []};}}});
  closers.push(() => { client.stop(); wss.clients.forEach(socket => socket.terminate()); wss.close(); server.close(); });
  await client.connect();
  const auth = await waitFor(() => received.find(message => message.type === 'auth'));
  expect(auth.type === 'auth' && auth.report.maintenance_git).toBe(true);
  const response = await waitFor(() => received.find(message => message.type === 'maintenance_response'));
  expect(response).toMatchObject({type: 'maintenance_response', request_id: 'request_1', attempt_id: 'attempt_1', lease_epoch: 1, result: {status: 'patch_ready', commit_sha: 'b'.repeat(40)}});
  const denied=await waitFor(()=>received.find(message=>message.type==='maintenance_response'&&message.request_id==='request_2'));
  expect(denied).toMatchObject({type:'maintenance_response',error:expect.stringMatching(/authorized|detected/i),execution_unknown:false});expect(calls).toBe(1);
});
