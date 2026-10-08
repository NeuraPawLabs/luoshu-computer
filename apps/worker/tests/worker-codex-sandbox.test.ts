import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {runCodex} from '../src/codex.js';
import {Executor} from '../src/executor.js';
import {WorkerState} from '../src/state.js';
import type {Assignment} from '@luoshu/protocol';

async function fixture(options: {failure?: string; legacy?: boolean; hang?: boolean} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'luoshu-sandbox-'));
  const executable = join(dir, 'codex'), calls = join(dir, 'calls');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, cwd:process.cwd(), broker:process.env.GIT_SSH_COMMAND})+'\\n');
if (args[0] === 'sandbox') {
  if (args.includes('--help')) { console.log(${JSON.stringify(options.legacy ? 'Commands:\n  linux  Run under Linux sandbox' : 'Usage: codex sandbox [OPTIONS] [COMMAND]...')}); process.exit(0); }
  if (${!!options.hang}) { setInterval(()=>{},1000); }
  else if (${!!options.failure}) { console.error(${JSON.stringify(options.failure ?? '')}); process.exitCode=1; }
  else { process.exit(0); }
} else {
  process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'done');});
}
`, {mode: 0o700});
  return {dir, executable, calls, cleanup: () => rm(dir, {recursive: true, force: true})};
}

test('sandbox initialization failure stops before invoking the model and reports actionable redacted diagnostics', async () => {
  const f = await fixture({failure: 'bwrap: setting up uid map: Permission denied\ntoken=private-value'});
  try {
    const result = await runCodex({cwd:f.dir, prompt:'inspect project', executable:f.executable});
    expect(result.exitCode).not.toBe(0);
    expect(result.summary).toContain('bwrap: setting up uid map: Permission denied');
    expect(result.summary).toContain('AppArmor');
    expect(result.summary).not.toContain('private-value');
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls.some(call=>call.args[0]==='exec')).toBe(false);
    expect(result.sessionId).toBeUndefined();
  } finally { await f.cleanup(); }
});

test.each([false, true])('checks the exact execution sandbox before starting Codex (legacy CLI: %s)', async legacy => {
  const f = await fixture({legacy});
  try {
    const result = await runCodex({cwd:f.dir, prompt:'inspect', executable:f.executable, env:{GIT_SSH_COMMAND:'node broker',GIT_SSH_VARIANT:'ssh'}});
    expect(result.exitCode).toBe(0);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls.map(call=>call.args[0])).toEqual(['sandbox','sandbox','exec']);
    const probe = calls[1];
    expect(probe.cwd).toBe(f.dir);
    expect(probe.broker).toBe('node broker');
    expect(probe.args).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"','approval_policy="never"','sandbox_workspace_write.network_access=true','shell_environment_policy.set.GIT_SSH_COMMAND="node broker"']));
    expect(probe.args.slice(-2)).toEqual(['--','/bin/true']);
    expect(probe.args.includes('linux')).toBe(legacy);
    expect(calls.every(call=>!call.args.some((arg:string)=>arg.includes('danger-full-access')||arg.includes('bypass')))).toBe(true);
  } finally { await f.cleanup(); }
});

test('explicit full access starts Codex without invoking bubblewrap even when the sandbox is unavailable', async () => {
  const f = await fixture({failure:'bwrap: setting up uid map: Permission denied'});
  try {
    const result = await runCodex({cwd:f.dir,prompt:'inspect',executable:f.executable,sandboxMode:'danger-full-access'});
    expect(result.exitCode).toBe(0);
    const calls = (await readFile(f.calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(expect.arrayContaining(['exec','--sandbox','danger-full-access','approval_policy="never"']));
  } finally { await f.cleanup(); }
});

test('cancellation interrupts the sandbox check without starting the model', async () => {
  const f = await fixture({hang:true});
  const controller = new AbortController();
  try {
    const pending = runCodex({cwd:f.dir, prompt:'inspect', executable:f.executable, signal:controller.signal});
    await expect.poll(async()=>{try{return (await readFile(f.calls,'utf8')).trim().split('\n').length;}catch{return 0;}}).toBe(2);
    controller.abort();
    expect((await pending).exitCode).toBe(130);
    expect((await readFile(f.calls,'utf8'))).not.toContain('"exec"');
  } finally { controller.abort(); await f.cleanup(); }
});

test('a missing Codex executable returns a failed result instead of hanging or starting work', async () => {
  const f = await fixture();
  try {
    const result = await runCodex({cwd:f.dir,prompt:'inspect',executable:join(f.dir,'missing')});
    expect(result.exitCode).not.toBe(0);
    expect(result.summary).toContain('ENOENT');
    expect(result.sessionId).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('a hung sandbox check times out without invoking the model', async () => {
  const f = await fixture({hang:true});
  try {
    const result = await runCodex({cwd:f.dir,prompt:'inspect',executable:f.executable});
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain('timed out');
    expect(await readFile(f.calls,'utf8')).not.toContain('"exec"');
  } finally { await f.cleanup(); }
}, 15000);

test('executor retains the sandbox failure reason and records failed evidence', async () => {
  const f = await fixture({failure:'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'});
  const state = new WorkerState(join(f.dir,'worker.db'));
  const assignment:Assignment = {attempt_id:'sandbox-failure', lease_epoch:1, agent:'codex',instruction:'inspect',input_files:[],codebases:[],timeout_seconds:30};
  state.recordStart(assignment.attempt_id,1,assignment);
  const executor = new Executor({state,stateDir:f.dir,agentPaths:{codex:f.executable},emit:event=>state.appendEvent(event)});
  try {
    const result = await executor.runAttempt(assignment,10000);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('bwrap: loopback');
    expect(result.error).toContain('AppArmor');
    const event = state.unackedEvents().find(event=>event.event.type==='agent_finished');
    expect(event?.event).toMatchObject({evidence:{outcome:'failed',exit_code:1}});
  } finally { await executor.stopAll('cleanup'); await executor.delivery.close(); state.close(); await f.cleanup(); }
});
