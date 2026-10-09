import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {receiveGitFrames,sendGitFrame} from './git-wire.js';

// One session lives outside the Worker's execution group. IPC disconnect is its
// parent-death signal, so it can terminate its SSH children even after SIGKILL.
const controller=new AbortController();
const children=new Map<ChildProcess,Promise<number>>();
const killers=new Map<ChildProcess,ReturnType<typeof setTimeout>>();
function terminate(child:ChildProcess){
 if(child.exitCode!==null||child.signalCode!==null)return;
 child.kill('SIGTERM');if(!killers.has(child))killers.set(child,setTimeout(()=>child.kill('SIGKILL'),1000));
}
const cancel=()=>{controller.abort();for(const child of children.keys())terminate(child);};
process.once('disconnect',cancel);process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
function start(command:string,args:string[],options:Parameters<typeof spawn>[2]):ChildProcess {
 if(controller.signal.aborted)throw Error('Git SSH cancelled');
 const child=spawn(command,args,options);
 const exit=new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>{const timer=killers.get(child);if(timer)clearTimeout(timer);killers.delete(child);resolve(code??1);});});
 children.set(child,exit);return child;
}
async function run(input:{stateDir:string;args:string[];privateKey:string}){
 let temp:string|undefined,ssh:ChildProcess|undefined;let code=1;
 try{
  temp=await mkdtemp(join(tmpdir(),'luoshu-git-agent-'));const agentSocket=join(temp,'agent.sock');
  const agent=start('ssh-agent',['-D','-a',agentSocket],{stdio:'ignore'});
  for(let n=0;;n++){
   if(controller.signal.aborted)throw Error('Git SSH cancelled');
   if(agent.exitCode!==null||agent.signalCode!==null||n>=100)throw Error('SSH agent did not start');
   try{await stat(agentSocket);break;}catch{await new Promise(r=>setTimeout(r,10));}
  }

  const env={...process.env,SSH_AUTH_SOCK:agentSocket,SSH_ASKPASS_REQUIRE:'never'};
  const add=start('ssh-add',['-'],{env,stdio:['pipe','ignore','ignore']});add.stdin!.on('error',()=>{});add.stdin!.end(input.privateKey);input.privateKey='';

  if(await children.get(add)!==0)throw Error('SSH key could not be loaded');
  ssh=start('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=15','-o','IdentityFile=none','-o','IdentitiesOnly=no','-o',`IdentityAgent=${agentSocket}`,'-o',`UserKnownHostsFile=${join(input.stateDir,'git_known_hosts')}`,'-o','StrictHostKeyChecking=accept-new',...input.args],{env,stdio:['pipe','pipe','pipe']});
  ssh.stdin!.on('error',()=>{});
  receiveGitFrames(process.stdin,frame=>{
   if(frame.type==='stdin'&&typeof frame.data==='string'){if(!ssh!.stdin!.write(Buffer.from(frame.data,'base64'))){process.stdin.pause();ssh!.stdin!.once('drain',()=>process.stdin.resume());}}
   else if(frame.type==='end')ssh!.stdin!.end();
  });
  for(const [type,stream] of [['stdout',ssh.stdout!],['stderr',ssh.stderr!]] as const)stream.on('data',bytes=>{if(!sendGitFrame(process.stdout,{type,data:bytes.toString('base64')})){stream.pause();process.stdout.once('drain',()=>stream.resume());}});
  sendGitFrame(process.stdout,{type:'ready'});code=await children.get(ssh)!;
 }catch(error){sendGitFrame(process.stdout,{type:'error',message:error instanceof Error?error.message:'Git SSH failed'});}
 finally{
  input.privateKey='';cancel();await Promise.all(children.values());if(temp)await rm(temp,{recursive:true,force:true});
  // Completion is emitted after both SSH and its credential agent have exited.
  sendGitFrame(process.stdout,{type:'exit',code});process.stdin.destroy();
  if(process.connected)process.disconnect?.();
 }
}
process.stdin.on('error',cancel);process.stdout.on('error',cancel);
process.once('message',input=>{void run(input as Parameters<typeof run>[0]).catch(()=>{cancel();process.exitCode=1;});});
