import {expect,test} from 'vitest';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
const alive=async(pid:number)=>{try{const info=await readFile(`/proc/${pid}/stat`,'utf8');return !info.slice(info.lastIndexOf(')')+2).startsWith('Z');}catch{return false;}};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'git-lifecycle-')),state=join(dir,'state'),bin=join(dir,'bin'),temp=join(dir,'tmp');await Promise.all([mkdir(state),mkdir(bin),mkdir(temp)]);
 const marker=join(dir,'pids.json');await writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs'),p=require('path');const sshSocket=process.env.SSH_AUTH_SOCK;
const agentPid=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).map(x=>{try{const argv=fs.readFileSync('/proc/'+x+'/cmdline','utf8');return argv.includes(sshSocket)&&argv.startsWith('ssh-agent\\0')?+x:null;}catch{return null;}}).find(Boolean);
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ssh:process.pid,agent:agentPid,sshSocket}));
process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);
`,{mode:0o700});
 const keyPath=join(dir,'fixture-key');execFileSync('ssh-keygen',['-t','ed25519','-N','','-f',keyPath],{stdio:'ignore'});const key=readFileSync(keyPath,'utf8');
 const module=new URL('../src/git-helper.ts',import.meta.url).href;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {startGitCredentialServer} from ${JSON.stringify(module)};await startGitCredentialServer(${JSON.stringify(state)},{requestGitCredential:async()=>({host:'git.test',private_key:${JSON.stringify(key)}})});process.stdout.write('ready');`],{env:{...process.env,PATH:bin+':'+process.env.PATH,TMPDIR:temp},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((res,rej)=>{child.stdout!.once('data',()=>res());child.once('error',rej);child.once('exit',code=>rej(Error('broker exit '+code)));});
 const socket=createConnection(join(state,'git-credential.sock'));socket.on('error',()=>{});socket.resume();await new Promise<void>(r=>socket.once('connect',()=>{socket.write(JSON.stringify({argv:['git@git.test',"git-receive-pack 'repo.git'"]})+'\n');r();}));
 let pids:{ssh:number;agent:number;sshSocket:string}|undefined;
 await expect.poll(async()=>{try{pids=JSON.parse(await readFile(marker,'utf8'));return Boolean(pids?.agent);}catch{return false;}},{timeout:5000}).toBe(true);
 return {dir,temp,child,socket,pids:pids!,async close(){socket.destroy();child.kill('SIGKILL');for(const pid of [pids!.ssh,pids!.agent])if(pid&&await alive(pid))try{process.kill(pid,'SIGKILL');}catch{}await rm(dir,{recursive:true,force:true});}};
}
test('Worker SIGKILL still terminates SSH/agent and removes the per-use directory',async()=>{
 const f=await fixture();try{const exited=new Promise<void>(r=>f.child.once('exit',()=>r()));f.child.kill('SIGKILL');await exited;
 await expect.poll(()=>alive(f.pids.ssh),{timeout:5000}).toBe(false);await expect.poll(()=>alive(f.pids.agent),{timeout:5000}).toBe(false);await expect.poll(async()=>(await readdir(f.temp)).filter(name=>name.startsWith('luoshu-git-agent-')),{timeout:5000}).toEqual([]);
 }finally{await f.close();}
});
test('local cancellation waits for stubborn SSH termination and clears temporary credentials',async()=>{
 const f=await fixture();try{f.socket.destroy();await expect.poll(()=>alive(f.pids.ssh),{timeout:5000}).toBe(false);await expect.poll(()=>alive(f.pids.agent),{timeout:5000}).toBe(false);await expect.poll(async()=>(await readdir(f.temp)).filter(name=>name.startsWith('luoshu-git-agent-')),{timeout:5000}).toEqual([]);
 }finally{await f.close();}
});
