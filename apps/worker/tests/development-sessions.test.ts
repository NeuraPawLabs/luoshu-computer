import { expect, test } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentSessions } from '../src/development/sessions.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-pty-')); const executable = join(root, 'codex-fixture');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdin.setEncoding("utf8"); process.stdin.on("data", d => { if (d.includes("exit")) process.exit(7); process.stdout.write("echo:" + d); });\n', { mode: 0o755 });
  return { root, executable };
}

test('starts a direct PTY executable, forwards input, and captures output', async () => {
  const data = await fixture(); const sessions = new DevelopmentSessions({ agentPaths: { codex: data.executable }, roots: [data.root] });
  await sessions.open({ action: 'open', session_id: 's1', agent: 'codex', cwd: data.root, mode: 'new', cols: 80, rows: 24 });
  sessions.input('s1', 'hello\n'); await new Promise(resolve => setTimeout(resolve, 100));
  expect(sessions.read('s1', 0).chunks.map(chunk => chunk.data).join('')).toContain('echo:hello');
  await sessions.stop('s1');
  expect(() => sessions.input('s1', 'after')).toThrow(/exited/);
});

test('simultaneous opens deduplicate a session and reserve capacity before executable resolution',async()=>{
 const data=await fixture(),sessions=new DevelopmentSessions({agentPaths:{codex:data.executable},maxSessions:1});
 const command={action:'open' as const,session_id:'same',agent:'codex' as const,cwd:data.root,mode:'new' as const,cols:80,rows:24};
 try{
  const [first,second]=await Promise.all([sessions.open(command),sessions.open(command)]);expect(first.session.id).toBe(second.session.id);expect(sessions.active()).toBe(1);
  await sessions.stop('same');
  const pending=sessions.open({...command,session_id:'first'});const other=sessions.open({...command,session_id:'second'});
  await expect(other).rejects.toThrow(/capacity/);await pending;expect(sessions.active()).toBe(1);
 }finally{await sessions.shutdown();}
});
test('occupied capacity includes opening and stopping without changing the active-session view',async()=>{
 const data=await fixture(),sessions=new DevelopmentSessions({agentPaths:{codex:data.executable},maxSessions:1});
 try{
  const opening=sessions.open({action:'open',session_id:'capacity',agent:'codex',cwd:data.root,mode:'new',cols:80,rows:24});
  expect(sessions.occupied()).toBe(1);await opening;expect(sessions.occupied()).toBe(1);
  const stopping=sessions.stop('capacity');expect(sessions.active()).toBe(0);expect(sessions.occupied()).toBe(1);
  await expect(sessions.open({action:'open',session_id:'other',agent:'codex',cwd:data.root,mode:'new',cols:80,rows:24})).rejects.toThrow(/capacity/);
  await stopping;expect(sessions.occupied()).toBe(0);
 }finally{await sessions.shutdown();}
});

test('pushes PTY output and exit state to the development stream sink', async () => {
  const data = await fixture(); const events: Array<{ sequence: number; data: string; session: { status: string } }> = [];
  const sessions = new DevelopmentSessions({ agentPaths: { codex: data.executable }, roots: [data.root], onOutput: event => events.push(event) });
  await sessions.open({ action: 'open', session_id: 'push', agent: 'codex', cwd: data.root, mode: 'new', cols: 80, rows: 24 });
  sessions.input('push', 'hello\n');
  await expect.poll(() => events.some(event => event.data.includes('echo:hello'))).toBe(true);
  await sessions.stop('push');
  expect(events.at(-1)?.session.status).toBe('exited');
});

test('an interactive Agent receives carriage return as Enter in raw PTY mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-enter-'));
  const executable = join(root, 'codex-fixture');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.on("data", data => { if (data.includes("\\r")) process.stdout.write("Agent replied\\r\\n"); }); process.stdout.write("ready\\r\\n");\n', { mode: 0o755 });
  const sessions = new DevelopmentSessions({ agentPaths: { codex: executable }, roots: [root] });
  try {
    await sessions.open({ action: 'open', session_id: 'interactive', agent: 'codex', cwd: root, mode: 'new', cols: 80, rows: 24 });
    await expect.poll(() => sessions.read('interactive', 0).chunks.map(chunk => chunk.data).join('')).toContain('ready');
    sessions.input('interactive', '继续\r');
    await expect.poll(() => sessions.read('interactive', 0).chunks.map(chunk => chunk.data).join('')).toContain('Agent replied');
  } finally { await sessions.stop('interactive'); }
});

test('PTY receives browser dimensions and Ctrl-C remains responsive after a burst of Unicode output',async()=>{
 const {rm}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'development-pty-size-')),executable=join(root,'agent');
 await writeFile(executable,`#!/usr/bin/env node
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdout.on('resize',()=>process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
process.stdin.on('data',data=>{if(data.includes('b'))process.stdout.write('中文🌟'.repeat(100000));if(data.includes('\\x03'))process.stdout.write('INTERRUPTED\\r\\n');});
process.stdout.write('READY:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n');`,{mode:0o700});
 const sessions=new DevelopmentSessions({agentPaths:{codex:executable},roots:[root]});
 try{
  await sessions.open({action:'open',session_id:'size',agent:'codex',cwd:root,mode:'new',cols:80,rows:24});
  const text=()=>sessions.read('size',0).chunks.map(c=>c.data).join('');await expect.poll(text).toContain('READY:80x24');
  sessions.resize('size',44,18);await expect.poll(text).toContain('SIZE:44x18');
  sessions.input('size','b');await expect.poll(()=>sessions.read('size',0).truncated).toBe(true);
  sessions.input('size','\x03');await expect.poll(text).toContain('INTERRUPTED');expect(sessions.read('size',0).chunks.length).toBeLessThanOrEqual(2048);
 }finally{await sessions.shutdown();await rm(root,{recursive:true,force:true});}
});

test('starts the Agent PTY with an explicit UTF-8 locale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoshu-development-locale-')); const executable = join(root, 'codex-fixture');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(process.env.LANG + "\\n"); process.stdin.resume();\n', { mode: 0o755 });
  const sessions = new DevelopmentSessions({ agentPaths: { codex: executable }, roots: [root] });
  const originalLang = process.env.LANG; process.env.LANG = '';
  try {
    await sessions.open({ action: 'open', session_id: 'locale', agent: 'codex', cwd: root, mode: 'new', cols: 80, rows: 24 });
    await expect.poll(() => sessions.read('locale', 0).chunks.map(chunk => chunk.data).join('')).toContain('UTF-8');
    await sessions.stop('locale');
  } finally { if (originalLang === undefined) delete process.env.LANG; else process.env.LANG = originalLang; }
});

test('resume uses the native resume argument and suppresses Ctrl-Z', async () => {
  const data = await fixture(); const sessions = new DevelopmentSessions({ agentPaths: { codex: data.executable }, roots: [data.root] });
  await sessions.open({ action: 'open', session_id: 's2', agent: 'codex', agent_session_id: 'native-s2', cwd: data.root, mode: 'resume', cols: 80, rows: 24 });
  sessions.input('s2', '\x1ahello'); await new Promise(resolve => setTimeout(resolve, 100));
  expect(sessions.read('s2', 0).chunks.map(chunk => chunk.data).join('')).toContain('hello');
});

test('never launches an unknown executable for a native resume', async () => {
  const sessions = new DevelopmentSessions({ agentPaths: { opencode: '/missing/opencode', codex: '/missing/codex' } });
  await expect(sessions.open({ action: 'open', session_id: 's3', agent: 'opencode', cwd: tmpdir(), mode: 'resume', cols: 80, rows: 24 })).rejects.toThrow(/available/);
  await expect(sessions.open({ action: 'open', session_id: 's4', agent: 'codex', cwd: tmpdir(), mode: 'new', cols: 80, rows: 24 })).rejects.toThrow(/available/);
});

test('lists only sessions for the requested cwd and never returns transcript data', async () => {
  const first = await fixture();
  const secondRoot = await mkdtemp(join(tmpdir(), 'luoshu-development-other-'));
  const sessions = new DevelopmentSessions({ agentPaths: { codex: first.executable }, roots: [first.root, secondRoot] });
  await sessions.open({ action: 'open', session_id: 'first', agent: 'codex', cwd: first.root, mode: 'new', cols: 80, rows: 24 });
  await sessions.open({ action: 'open', session_id: 'second', agent: 'codex', cwd: secondRoot, mode: 'new', cols: 80, rows: 24 });
  const listed = sessions.list(first.root);
  expect(listed.sessions).toHaveLength(1);
  expect(listed.sessions[0]).toMatchObject({ id: 'first', cwd: first.root, title: 'codex Agent' });
  expect(listed.sessions[0]).not.toHaveProperty('chunks');
  await sessions.stop('first');
  expect(sessions.list(first.root).sessions[0]).toMatchObject({ id: 'first', title: 'codex Agent' });
  await sessions.stop('second');
});

test('lists only active PTY sessions without transcript data', async () => {
  const first = await fixture();
  const secondRoot = await mkdtemp(join(tmpdir(), 'luoshu-development-active-'));
  const sessions = new DevelopmentSessions({ agentPaths: { codex: first.executable }, roots: [first.root, secondRoot] });
  await sessions.open({ action: 'open', session_id: 'active_first', agent: 'codex', cwd: first.root, mode: 'new', cols: 80, rows: 24 });
  await sessions.open({ action: 'open', session_id: 'active_second', agent: 'codex', cwd: secondRoot, mode: 'new', cols: 80, rows: 24 });
  const active = sessions.activeSessions();
  expect(active).toMatchObject({ action: 'active_sessions', truncated: false });
  expect(active.sessions.map(session => session.id).sort()).toEqual(['active_first', 'active_second']);
  expect(active.sessions[0]).not.toHaveProperty('chunks');
  expect(active.sessions[0]).not.toHaveProperty('output');
  await sessions.stop('active_first');
  expect(sessions.activeSessions().sessions.map(session => session.id)).toEqual(['active_second']);
  await sessions.stop('active_second');
});

test.each([['codex','new'],['codex','resume'],['opencode','new']] as const)('development %s %s inherits the Git broker without private credentials',async(agent,mode)=>{
 const {readFile,rm}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'development-git-'));const executable=join(root,'agent'),output=join(root,'captured.json');
 await writeFile(executable,`#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),ssh:process.env.GIT_SSH_COMMAND,variant:process.env.GIT_SSH_VARIANT}));\n`,{mode:0o755});
 const {DevelopmentService}=await import('../src/development/service.js');const service=new DevelopmentService({roots:[root],agentPaths:{[agent]:executable},gitSshCommand:'node git-helper --socket /private/socket'});
 try{await service.handle({action:'open',session_id:'git_session',...(mode==='resume'?{agent_session_id:'native-git'}:{}),agent,cwd:root,mode,cols:80,rows:24});await expect.poll(async()=>{try{return JSON.parse(await readFile(output,'utf8'));}catch{return null;}}).toMatchObject({ssh:'node git-helper --socket /private/socket',variant:'ssh'});
 const captured=JSON.parse(await readFile(output,'utf8'));if(agent==='codex'){expect(captured.args).toContain('sandbox_workspace_write.network_access=true');expect(captured.args).toContain('shell_environment_policy.set.GIT_SSH_COMMAND="node git-helper --socket /private/socket"');if(mode==='resume')expect(captured.args).toContain('resume');}
 }finally{await service.stopAll();await rm(root,{recursive:true,force:true});}
});
