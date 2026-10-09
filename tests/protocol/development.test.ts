import { expect, test } from 'vitest';
import * as protocol from '../../src/protocol/index.js';

const open = { action: 'open', session_id: 'session_1', agent: 'codex', cwd: '/tmp/project', mode: 'new', cols: 100, rows: 30 };
const sessions = { action: 'sessions', path: '/tmp/project' };
const activeSessions = { action: 'active_sessions' };

test('exports a strict development command contract with no arbitrary startup fields', () => {
  expect(protocol).toHaveProperty('developmentCommandSchema');
  expect(protocol.developmentCommandSchema.parse(open)).toEqual(open);
  expect(protocol.developmentCommandSchema.safeParse({ ...open, mode: 'resume' }).success).toBe(false);
  for (const forbidden of ['argv', 'env', 'command', 'executable']) {
    expect(protocol.developmentCommandSchema.safeParse({ ...open, [forbidden]: 'sh' }).success).toBe(false);
  }
  expect(protocol.developmentCommandSchema.safeParse({ ...open, cols: 0 }).success).toBe(false);
  expect(protocol.developmentCommandSchema.safeParse({ action: 'read', session_id: 's', after: -1 }).success).toBe(false);
  for(const action of ['git_status','git_diff','git_branch','git_commit','run_check'])expect(protocol.developmentCommandSchema.safeParse({action,path:'/tmp/project'}).success).toBe(false);
});

test('validates correlated development results and exclusive errors on the wire', () => {
  const request = { type: 'development_request', request_id: 'r1', command: open };
  expect(protocol.serverMessageSchema.safeParse(request).success).toBe(true);
  const response = { type: 'development_response', request_id: 'r1', result: { action: 'roots', roots: ['/tmp'] } };
  expect(protocol.workerMessageSchema.safeParse(response).success).toBe(true);
  expect(protocol.workerMessageSchema.safeParse({ ...response, error: 'bad' }).success).toBe(false);
  expect(protocol.workerMessageSchema.safeParse({ type: 'development_response', request_id: 'r1', error: 'bad' }).success).toBe(true);
  expect(protocol.workerMessageSchema.safeParse({ ...response, result: { action: 'roots', roots: ['/tmp'], extra: true } }).success).toBe(false);
});

test('validates bounded directory session summaries without output data', () => {
  const summary = { id: 'session_1', agent: 'codex', cwd: '/tmp/project', title: 'Fix the build', created_at: 100, updated_at: 200 };
  const result = { action: 'sessions', path: '/tmp/project', sessions: [summary], truncated: false };
  expect(protocol.developmentCommandSchema.safeParse(sessions).success).toBe(true);
  expect(protocol.developmentResultSchema.safeParse(result).success).toBe(true);
  for (const change of [
    { ...sessions, path: '' },
    { ...sessions, output: 'secret transcript' },
    { ...result, sessions: [{ ...summary, output: 'secret transcript' }] },
    { ...result, sessions: Array.from({ length: 101 }, () => summary) },
    { ...result, sessions: [{ ...summary, created_at: -1 }] },
  ]) expect(protocol.developmentCommandSchema.safeParse(change).success || protocol.developmentResultSchema.safeParse(change).success).toBe(false);
});

test('validates bounded active development sessions without transcript data', () => {
  const summary = { id: 'runtime_1', agent: 'codex', cwd: '/tmp/project', title: 'Fix the build', created_at: 100, updated_at: 200, status: 'running' };
  const result = { action: 'active_sessions', sessions: [summary], truncated: false };
  expect(protocol.developmentCommandSchema.safeParse(activeSessions).success).toBe(true);
  expect(protocol.developmentResultSchema.safeParse(result).success).toBe(true);
  for (const change of [
    { ...activeSessions, output: 'secret transcript' },
    { ...result, sessions: [{ ...summary, output: 'secret transcript' }] },
    { ...result, sessions: Array.from({ length: 101 }, () => summary) },
    { ...result, sessions: [{ ...summary, status: 'saved' }] },
  ]) expect(protocol.developmentCommandSchema.safeParse(change).success || protocol.developmentResultSchema.safeParse(change).success).toBe(false);
});

test('validates scoped history requests and bounded transcript responses on the wire', () => {
  const command = { action: 'history', path: '/tmp/project', agent: 'codex', session_id: 'native-1' };
  const result = { ...command, text: '用户\n之前的请求\n\nCodex\n之前的回复\n', truncated: false };
  expect(protocol.serverMessageSchema.safeParse({ type: 'development_request', request_id: 'r1', command }).success).toBe(true);
  expect(protocol.workerMessageSchema.safeParse({ type: 'development_response', request_id: 'r1', result }).success).toBe(true);
  for (const invalid of [
    { ...command, path: '' }, { ...command, agent: 'shell' }, { ...command, session_id: '../rollout.jsonl' },
    { ...command, rollout_path: '/tmp/rollout.jsonl' },
  ]) expect(protocol.developmentCommandSchema.safeParse(invalid).success).toBe(false);
  expect(protocol.developmentResultSchema.safeParse({ ...result, text: 'x'.repeat(256 * 1024 + 1) }).success).toBe(false);
});

test('accepts bounded push output events with session state and cursor sequence', () => {
  const output = { type: 'development_output', session_id: 'session_1', sequence: 1, data: '中文\n', session: { id: 'session_1', agent: 'codex', cwd: '/tmp/project', mode: 'new', status: 'running' } };
  expect(protocol.workerMessageSchema.safeParse(output).success).toBe(true);
  expect(protocol.workerMessageSchema.safeParse({ ...output, sequence: 0 }).success).toBe(false);
  expect(protocol.workerMessageSchema.safeParse({ ...output, data: 'x'.repeat(512 * 1024 + 1) }).success).toBe(false);
  expect(protocol.workerMessageSchema.safeParse({ ...output, extra: true }).success).toBe(false);
});

test('directory settings distinguish default, disabled and absolute allowlists',()=>{
 const revision='11111111-1111-4111-8111-111111111111';
 for(const roots of [null,[],['/home/alice/code','/srv/projects']])expect(protocol.developmentCommandSchema.safeParse({action:'roots_update',roots,revision,stop_ids:[]}).success).toBe(true);
 for(const roots of [['relative'],['/bad\npath'],Array(33).fill('/work')])expect(protocol.developmentCommandSchema.safeParse({action:'roots_update',roots,revision}).success).toBe(false);
 expect(protocol.developmentCommandSchema.safeParse({action:'roots_update',roots:['/work'],revision,stop_all:true}).success).toBe(false);
});

test('validates bounded Worker configuration updates without exposing immutable identity fields',()=>{
 const config={name:'专用 Codex',capacity:4,agent_paths:{codex:'/opt/codex',opencode:'/opt/opencode'},development_roots:['/srv/code'],maintenance_roots:['/srv/maintenance'],codex_sandbox:'danger-full-access'};
 const request={type:'worker_config_request',request_id:'config_1',expected_revision:'original',revision:'11111111-1111-4111-8111-111111111111',config};
 expect(protocol.serverMessageSchema.safeParse(request).success).toBe(true);
 expect(protocol.workerMessageSchema.safeParse({type:'worker_config_response',request_id:'config_1',revision:request.revision,applied_revision:'applied',status:'applied',config}).success).toBe(true);
 for(const field of ['worker_id','url','private_key','state_dir']) expect(protocol.serverMessageSchema.safeParse({...request,config:{...config,[field]:'secret'}}).success).toBe(false);
 expect(protocol.serverMessageSchema.safeParse({...request,config:{...config,capacity:0}}).success).toBe(false);
 expect(protocol.serverMessageSchema.safeParse({...request,config:{...config,agent_paths:{codex:'relative'}}}).success).toBe(false);
 expect(protocol.workerMessageSchema.safeParse({type:'worker_config_response',request_id:'config_1',revision:request.revision,applied_revision:'applied',status:'failed',config,error:'bad'}).success).toBe(true);
});
