import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {runCodex} from '../src/codex.js';
import {runOpenCode} from '../src/opencode.js';
test.each(['codex','opencode'] as const)('%s reports native session before final process output',async agent=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-session-checkpoint-')),fake=join(root,'agent');
 try{
  await writeFile(fake,`#!/usr/bin/env node
if(process.argv[2]==='sandbox'){if(process.argv.includes('--help'))console.log('Usage: codex sandbox [OPTIONS] [COMMAND]...');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{
 console.log(JSON.stringify(${JSON.stringify(agent==='codex'?{type:'thread.started',thread_id:'session_early'}:{type:'step_start',sessionID:'session_early'})}));
 setTimeout(()=>{const args=process.argv.slice(2);if(args.includes('--output-last-message'))require('fs').writeFileSync(args[args.indexOf('--output-last-message')+1],'done');else console.log(JSON.stringify({type:'text',part:{text:'done'}}));},150);
});`,{mode:0o700});
  const sessions:string[]=[];let done=false;
  const pending=(agent==='codex'?runCodex:runOpenCode)({cwd:root,prompt:'go',executable:fake,onSession:id=>sessions.push(id)}).then(result=>{done=true;return result;});
  await expect.poll(()=>sessions).toEqual(['session_early']);
  expect(done).toBe(false);await pending;
 }finally{await rm(root,{recursive:true,force:true});}
});
