import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runOpenCode } from '../../src/runtime/opencode.js';

test('OpenCode uses JSON stdin mode and returns text plus session id',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-'));const fake=join(dir,'opencode');const capture=join(dir,'capture');
 await writeFile(fake,`#!/usr/bin/env node
let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),prompt:p}));console.log(JSON.stringify({type:'text',sessionID:'ses_1',part:{text:'first '}}));console.log(JSON.stringify({type:'text',sessionID:'ses_1',part:{text:'answer'}}));console.log(JSON.stringify({type:'step_finish',sessionID:'ses_1'}));});`,{mode:0o700});await chmod(fake,0o700);
 const progress:string[]=[];const result=await runOpenCode({cwd:dir,prompt:'summarize',executable:fake,onProgress:text=>progress.push(text)});const invoked=JSON.parse(await readFile(capture,'utf8'));
 expect(invoked).toEqual({args:['run','--format','json','--dir',dir],prompt:'summarize'});expect(result).toMatchObject({exitCode:0,summary:'first answer',sessionId:'ses_1'});expect(progress).toEqual(['first ','answer']);
});

test('OpenCode parses a bounded final JSON event without a newline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-tail-'));const fake=join(dir,'opencode');await writeFile(fake,`#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'text',sessionID:'tail',part:{text:'x'.repeat(20000)}})));`,{mode:0o700});const result=await runOpenCode({cwd:dir,prompt:'work',executable:fake});expect(result.exitCode).toBe(0);expect(result.summary.length).toBe(16000);expect(result.sessionId).toBe('tail');
});

test('OpenCode fails on no result but accepts normal prose containing denied',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-empty-'));const empty=join(dir,'empty');const prose=join(dir,'prose');await writeFile(empty,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{});`,{mode:0o700});await writeFile(prose,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',part:{text:'The claim was denied in the source document.'}})));`,{mode:0o700});expect((await runOpenCode({cwd:dir,prompt:'x',executable:empty})).exitCode).not.toBe(0);expect((await runOpenCode({cwd:dir,prompt:'x',executable:prose})).exitCode).toBe(0);
});

test('OpenCode recognizes nested errors and explicit auto-rejection warnings',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-nested-'));const fake=join(dir,'opencode');await writeFile(fake,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'error',error:{data:{message:'nested failure'}}}));console.log(JSON.stringify({type:'warning',code:'permission_auto_rejected',message:'auto rejected'}));});`,{mode:0o700});const result=await runOpenCode({cwd:dir,prompt:'x',executable:fake});expect(result.exitCode).not.toBe(0);expect(result.summary).toMatch(/nested failure/);});

test('OpenCode errors and permission denials fail even when the process exits zero',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-denied-'));const fake=join(dir,'opencode');await writeFile(fake,`#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'error',sessionID:'ses_2',error:{message:'permission denied by user'}})));`,{mode:0o700});
 const result=await runOpenCode({cwd:dir,prompt:'work',executable:fake});expect(result.exitCode).not.toBe(0);expect(result.summary).toMatch(/permission denied/i);
});

test('OpenCode cancellation terminates descendants before returning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-cancel-'));const fake=join(dir,'opencode');const marker=join(dir,'marker');await writeFile(fake,`#!/usr/bin/env node
const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),400)`) }],{stdio:'ignore'});process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});
 const controller=new AbortController();const running=runOpenCode({cwd:dir,prompt:'work',executable:fake,signal:controller.signal,killGraceMs:30});setTimeout(()=>controller.abort(),30);expect((await running).exitCode).not.toBe(0);await new Promise(resolve=>setTimeout(resolve,450));await expect(readFile(marker)).rejects.toThrow();
});

test('OpenCode cancellation kills descendants that ignore SIGTERM after the parent closes',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-stubborn-opencode-'));const fake=join(dir,'opencode'),marker=join(dir,'marker'),ready=join(dir,'ready');const childCode=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),250);setTimeout(()=>process.exit(0),400)`;await writeFile(fake,`#!/usr/bin/env node\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});process.stdin.resume();setInterval(()=>{},1000);`,{mode:0o700});const controller=new AbortController();const running=runOpenCode({cwd:dir,prompt:'x',executable:fake,signal:controller.signal,killGraceMs:30});for(let i=0;i<100;i++){try{await readFile(ready);break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}controller.abort();expect((await running).exitCode).not.toBe(0);await new Promise(resolve=>setTimeout(resolve,300));await expect(readFile(marker)).rejects.toThrow();});

test('OpenCode ignores malformed event values and bounds session metadata',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-opencode-bounds-'));const fake=join(dir,'opencode');await writeFile(fake,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log('null');console.log(JSON.stringify({type:'text',sessionID:'x'.repeat(300),part:{text:'done'}}));});`,{mode:0o700});const result=await runOpenCode({cwd:dir,prompt:'work',executable:fake});expect(result.exitCode).toBe(0);expect(result.sessionId?.length).toBeLessThanOrEqual(200);});
