import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCodex } from '../src/codex.js';

describe('Codex process adapter', () => {
  test('uses stdin and captures actual JSONL command evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luoshu-codex-'));
    const fake = join(dir, 'fake-codex');
    await writeFile(fake, `#!/usr/bin/env node
if(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}
let prompt=''; process.stdin.on('data',d=>prompt+=d); process.stdin.on('end',()=>{
 const args=process.argv.slice(2); const out=args[args.indexOf('--output-last-message')+1];
 require('fs').writeFileSync(out, JSON.stringify({summary:'changed safely'}));
 console.log(JSON.stringify({type:'command_execution',command:'npm test',exit_code:0,output:'2 passed'}));
 console.log(JSON.stringify({type:'agent_message',text:'done'}));
 if (!prompt.includes('acceptance')) process.exitCode=7;
});`, { mode: 0o700 });
    await chmod(fake, 0o700);
    const result = await runCodex({ cwd: dir, prompt: 'acceptance', executable: fake });
    expect(result.exitCode).toBe(0);
    expect(result.checks).toEqual([{ command: 'npm test', exit_code: 0, output: '2 passed' }]);
    expect(result.summary).toBe('{"summary":"changed safely"}');
    expect(result.argv).toContain('workspace-write');
    expect(result.argv).toContain('approval_policy="never"');
  });

  test('workspace execution skips the Git repository check and accepts a plain text last message',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'luoshu-codex-workspace-'));const fake=join(dir,'fake-codex');
    await writeFile(fake,`#!/usr/bin/env node
if(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{const a=process.argv.slice(2);require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],'plain final answer');});`,{mode:0o700});
    const result=await runCodex({cwd:dir,prompt:'work',executable:fake});expect(result.summary).toBe('plain final answer');expect(result.argv).toContain('--skip-git-repo-check');
  });

  test('streams bounded progress, captures session id, and fails with no final output',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'luoshu-codex-progress-'));const fake=join(dir,'fake-codex');await writeFile(fake,`#!/usr/bin/env node
if(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-1'})+'\\n');process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'working'}}));});`,{mode:0o700});const progress:string[]=[];const result=await runCodex({cwd:dir,prompt:'work',executable:fake,onProgress:x=>progress.push(x)});expect(result.exitCode).not.toBe(0);expect(result.sessionId).toBe('thread-1');expect(progress).toEqual(['working']);
  });

  test('stderr and a turn.failed event cannot become a successful final result',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-codex-failed-'));const fake=join(dir,'fake');await writeFile(fake,`#!/usr/bin/env node\nif(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.error('diagnostic only');console.log(JSON.stringify({type:'turn.failed'}));});`,{mode:0o700});const result=await runCodex({cwd:dir,prompt:'x',executable:fake});expect(result.exitCode).not.toBe(0);expect(result.summary).not.toContain('diagnostic only');});

  test('bounds an oversized final message',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-codex-large-'));const fake=join(dir,'fake');await writeFile(fake,`#!/usr/bin/env node\nif(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}\nprocess.stdin.resume();process.stdin.on('end',()=>{const a=process.argv.slice(2);require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],'x'.repeat(1000000));});`,{mode:0o700});const result=await runCodex({cwd:dir,prompt:'x',executable:fake});expect(result.summary.length).toBeLessThanOrEqual(16000);});

  test('kills the process group and prevents a descendant side effect after cancellation', async () => {
    const dir=await mkdtemp(join(tmpdir(),'luoshu-cancel-'));const fake=join(dir,'fake-codex');const marker=join(dir,'marker'),ready=join(dir,'ready');
    await writeFile(fake,`#!/usr/bin/env node
if(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}
const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),400)`) }],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});
    const controller=new AbortController();const running=runCodex({cwd:dir,prompt:'work',executable:fake,signal:controller.signal,killGraceMs:50});await expect.poll(async()=>{try{return await readFile(ready,'utf8');}catch{return '';}}).toBe('ready');controller.abort();expect((await running).exitCode).not.toBe(0);await new Promise(resolve=>setTimeout(resolve,450));await expect(readFile(marker)).rejects.toThrow();
  });
});

test('cancellation also kills a detached-stdio descendant that ignores SIGTERM',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-stubborn-'));const fake=join(dir,'codex'),marker=join(dir,'marker'),ready=join(dir,'ready');const childCode=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),250);setTimeout(()=>process.exit(0),400)`;
 await writeFile(fake,`#!/usr/bin/env node\nif(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});const controller=new AbortController();const running=runCodex({cwd:dir,prompt:'x',executable:fake,signal:controller.signal,killGraceMs:30});for(let i=0;i<100;i++){try{await readFile(ready);break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}controller.abort();expect((await running).exitCode).not.toBe(0);await new Promise(resolve=>setTimeout(resolve,300));await expect(readFile(marker)).rejects.toThrow();
});

test('ignores malformed event values and bounds checks and session metadata for the wire',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-codex-bounds-'));const fake=join(dir,'codex');await writeFile(fake,`#!/usr/bin/env node\nif(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}\nprocess.stdin.resume();process.stdin.on('end',()=>{const a=process.argv.slice(2);require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],'done');console.log('null');console.log(JSON.stringify({type:'thread.started',thread_id:'x'.repeat(300)}));for(let i=0;i<70;i++)console.log(JSON.stringify({type:'command_execution',command:'test',exit_code:0,output:'ok'}));});`,{mode:0o700});const result=await runCodex({cwd:dir,prompt:'work',executable:fake});expect(result.exitCode).toBe(0);expect(result.checks).toHaveLength(50);expect(result.sessionId?.length).toBeLessThanOrEqual(200);});

test('broker environment is explicitly set for Codex shell commands and permits the socket transport',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-git-env-')),fake=join(dir,'codex');await writeFile(fake,`#!/usr/bin/env node\nif(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}\nprocess.stdin.resume();process.stdin.on('end',()=>{const a=process.argv.slice(2);require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],'ok');});`,{mode:0o700});
 const r=await runCodex({cwd:dir,prompt:'push',executable:fake,env:{GIT_SSH_COMMAND:'node helper',GIT_SSH_VARIANT:'ssh'}});expect(r.argv).toContain('shell_environment_policy.set.GIT_SSH_COMMAND="node helper"');expect(r.argv).toContain('sandbox_workspace_write.network_access=true');
});
