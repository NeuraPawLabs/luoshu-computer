import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {GitMaintenance} from '../src/maintenance/git.js';
import type {MaintenanceRequest} from '@luoshu/protocol';
import {runtimeMaintenance} from '../src/config-maintenance.js';
import {WorkerConfigController} from '../src/config-controller.js';
import {saveWorkerConfig} from '../src/environment.js';

const run = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, {recursive: true, force: true}); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-maintenance-git-')); cleanup.push(root);
  const repository = join(root, 'repo'), worktrees = join(root, 'worktrees');
  await mkdir(repository); await mkdir(worktrees);
  await run('git', ['init', '-b', 'main'], {cwd: repository});
  await run('git', ['config', 'user.email', 'worker@example.test'], {cwd: repository});
  await run('git', ['config', 'user.name', 'Luoshu Worker'], {cwd: repository});
  await mkdir(join(repository, 'src')); await writeFile(join(repository, 'src', 'value.txt'), 'broken\n');
  await run('git', ['add', 'src/value.txt'], {cwd: repository}); await run('git', ['commit', '-m', 'initial'], {cwd: repository});
  const base = (await run('git', ['rev-parse', 'HEAD'], {cwd: repository})).stdout.trim();
  const request: MaintenanceRequest = {type: 'maintenance_request', request_id: 'request_1', attempt_id: 'attempt_1', lease_epoch: 1,
    operation: 'repair', repository, base_sha: base, branch: 'luoshu/repair/incident_1/attempt_1', agent: 'codex', instruction: 'fix',
    allowed_paths: ['src/**'], checks: [{name: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeout_seconds: 10}], timeout_seconds: 60};
  return {root, repository, worktrees, base, request};
}

test('maintenance roots apply to the next execution without changing an in-flight verification',async()=>{
 const data=await fixture(),ready=join(data.root,'ready'),release=join(data.root,'release');
 await saveWorkerConfig(data.root,{worker_id:'w',url:'https://example.test',name:'worker',capacity:1,maintenance_roots:[data.repository]});
 const controller=new WorkerConfigController(data.root),maintenance=runtimeMaintenance(data.root,controller),script=join(data.root,'wait.cjs');
 await writeFile(script,`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const interval=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(interval);}},10);`);
 const request:MaintenanceRequest={...data.request,operation:'verify',checks:[{name:'wait',executable:process.execPath,args:[script],timeout_seconds:10}]};
 const running=maintenance.execute(request,new AbortController().signal);
 void running.catch(()=>{});
 try{
  await expect.poll(async()=>{try{return await readFile(ready,'utf8');}catch{return '';}}).toBe('ready');
  const state=await controller.state();expect((await controller.apply({request_id:'disable',revision:crypto.randomUUID(),expected_revision:state.revision,config:{...state.config,maintenance_roots:[]}})).status).toBe('applied');
  await writeFile(release,'go');expect((await running).status).toBe('passed');
  await expect(maintenance.execute({...request,attempt_id:'next'},new AbortController().signal)).rejects.toThrow(/未开放维护目录/);
 }finally{await writeFile(release,'go');await running;}
});

test('repairs a fixed base in an isolated worktree without moving main', async () => {
  const data = await fixture(), maintenance = new GitMaintenance({roots: [data.repository], worktreeRoot: data.worktrees});
  const result = await maintenance.execute(data.request, {signal: new AbortController().signal, runAgent: async ({cwd}) => {
    await writeFile(join(cwd, 'src', 'value.txt'), 'fixed\n'); return {exitCode: 0, summary: 'fixed'};
  }});

  expect(result).toMatchObject({status: 'patch_ready', base_sha: data.base, branch: data.request.branch, changed_paths: ['src/value.txt'], checks: [{name: 'unit', exit_code: 0}]});
  expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  expect((await run('git', ['rev-parse', 'main'], {cwd: data.repository})).stdout.trim()).toBe(data.base);
  expect((await readFile(join(data.repository, 'src', 'value.txt'), 'utf8'))).toBe('broken\n');
});

test('rejects path escapes, dirty baselines, and edits outside the allow-list', async () => {
  const data = await fixture(), outside = await mkdtemp(join(tmpdir(), 'luoshu-maintenance-outside-')); cleanup.push(outside);
  const maintenance = new GitMaintenance({roots: [data.repository], worktreeRoot: data.worktrees});
  await expect(maintenance.execute({...data.request, repository: outside}, {signal: new AbortController().signal, runAgent: async () => ({exitCode: 0, summary: 'no'})})).rejects.toThrow(/allowed root/i);
  await writeFile(join(data.repository, 'dirty.txt'), 'dirty');
  await expect(maintenance.execute(data.request, {signal: new AbortController().signal, runAgent: async () => ({exitCode: 0, summary: 'no'})})).rejects.toThrow(/clean/i);
  await rm(join(data.repository, 'dirty.txt'));
  await expect(maintenance.execute({...data.request, attempt_id: 'attempt_2', branch: 'luoshu/repair/incident_1/attempt_2'}, {signal: new AbortController().signal, runAgent: async ({cwd}) => {
    await writeFile(join(cwd, 'outside.txt'), 'bad'); return {exitCode: 0, summary: 'bad'};
  }})).rejects.toThrow(/allowed path/i);
  expect((await run('git', ['rev-parse', 'main'], {cwd: data.repository})).stdout.trim()).toBe(data.base);
});

test('rejects an agent that modifies the main repository instead of the assigned worktree',async()=>{
 const data=await fixture(),maintenance=new GitMaintenance({roots:[data.repository],worktreeRoot:data.worktrees});
 await expect(maintenance.execute({...data.request,attempt_id:'attempt-main',branch:'luoshu/repair/incident_1/attempt-main'},{signal:new AbortController().signal,runAgent:async()=>{await writeFile(join(data.repository,'main-tampered.txt'),'bad');return{exitCode:0,summary:'tampered'};}})).rejects.toThrow(/outside its worktree/i);
});

test('fails closed when a check fails and does not create a candidate commit', async () => {
  const data = await fixture(), maintenance = new GitMaintenance({roots: [data.repository], worktreeRoot: data.worktrees});
  const result = await maintenance.execute({...data.request, checks: [{name: 'fail', executable: process.execPath, args: ['-e', 'process.exit(7)'], timeout_seconds: 10}]}, {signal: new AbortController().signal, runAgent: async ({cwd}) => {
    await writeFile(join(cwd, 'src', 'value.txt'), 'fixed\n'); return {exitCode: 0, summary: 'fixed'};
  }});
  expect(result).toMatchObject({status: 'failed', checks: [{name: 'fail', exit_code: 7}]});
  expect(result).not.toHaveProperty('commit_sha');
});

test('verifies an immutable candidate without invoking a repair agent or creating another commit', async () => {
  const data = await fixture(), maintenance = new GitMaintenance({roots: [data.repository], worktreeRoot: data.worktrees});
  const repaired = await maintenance.execute(data.request, {signal: new AbortController().signal, runAgent: async ({cwd}) => {
    await writeFile(join(cwd, 'src', 'value.txt'), 'fixed\n'); return {exitCode: 0, summary: 'fixed'};
  }});
  let called = false;
  const verified = await maintenance.execute({...data.request, request_id: 'verify_1', attempt_id: 'verify_1', operation: 'verify', base_sha: repaired.commit_sha!, branch: 'luoshu/verify/incident_1/verify_1'}, {signal: new AbortController().signal, runAgent: async () => { called = true; return {exitCode: 1, summary: 'must not call'}; }});
  expect(called).toBe(false);
  expect(verified).toMatchObject({status: 'passed', commit_sha: repaired.commit_sha, base_sha: repaired.commit_sha, changed_paths: [], checks: [{exit_code: 0}]});
});

test('treats cancellation during a verification command as unknown instead of an ordinary failed check', async () => {
  const data=await fixture(),maintenance=new GitMaintenance({roots:[data.repository],worktreeRoot:data.worktrees}),controller=new AbortController();
  const verifying={...data.request,request_id:'verify_cancel',attempt_id:'verify_cancel',operation:'verify' as const,branch:'luoshu/verify/incident_1/verify_cancel',checks:[{name:'slow',executable:process.execPath,args:['-e','setInterval(Date.now,1000)'],timeout_seconds:30}]};
  const pending=maintenance.execute(verifying,{signal:controller.signal,runAgent:async()=>({exitCode:1,summary:'must not call'})});
  setTimeout(()=>controller.abort('test-cancel'),20);
  await expect(pending).rejects.toThrow(/cancel/i);
});
