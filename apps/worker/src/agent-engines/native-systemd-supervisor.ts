import {spawn as spawnProcess,execFile as execFileCallback,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {nativeLaunchSchema,nativeTargetEnvironment,nativeControlEnvironment,nativeModuleArguments,type NativeLaunch} from './native-systemd-launch.js';
import {NativeSystemdUnit,nativeUnitDescription} from './native-systemd-unit.js';
import type {NativeUnitLease} from './native-unit-registry.js';

const execFile=promisify(execFileCallback);
const unitNameSchema=/^luoshu-codex-[a-z0-9-]{1,90}$/u;
export interface NativeSystemdSpec {executable:string;args:string[];cwd?:string;env?:NodeJS.ProcessEnv;unitName?:string;ownerToken?:string;lease?:NativeUnitLease}
export type NativeSystemdProcess=ChildProcessWithoutNullStreams&{confirmNativeExit:()=>Promise<void>};
const unknownExit=()=>Object.assign(Error('Native systemd exit remains unconfirmed'),{code:'CODEX_RPC_UNKNOWN'});
const delay=()=>new Promise<void>(resolve=>setTimeout(resolve,50));

export async function assertSystemdUserAvailable():Promise<void>{
 if(process.platform!=='linux')throw Object.assign(Error('Native direct engine requires Linux systemd user service'),{code:'SUPERVISOR_UNAVAILABLE'});
 try{
  const result=await execFile('systemctl',['--user','show','--property=Version','--value'],{timeout:5000,maxBuffer:4096});
  if(!/^\d+(?:\.\d+)?(?:[-+][\w.-]+)?\s*$/u.test(result.stdout.trim()))throw Error('systemd user manager did not report a version');
 }catch(error){throw Object.assign(Error('Native systemd user supervisor is unavailable'),{code:'SUPERVISOR_UNAVAILABLE',cause:error});}
}

export function spawnSystemdSupervisor(spec:NativeSystemdSpec):NativeSystemdProcess{
 if(process.platform!=='linux')throw Object.assign(Error('Native systemd user supervisor is unavailable'),{code:'SUPERVISOR_UNAVAILABLE'});
 const unitName=spec.lease?.unitName??spec.unitName??`luoshu-codex-${randomUUID().replaceAll('-','')}`;
 if(!unitNameSchema.test(unitName))throw Error('Invalid transient native systemd unit name');
 const ownerToken=spec.lease?.ownerToken??spec.ownerToken??randomUUID(),authority=new NativeSystemdUnit({unitName,ownerToken});
 const {lease,...parameters}=spec;
 const launch=nativeLaunchSchema.safeParse({...parameters,unitName,ownerToken,cwd:spec.cwd??process.cwd(),env:nativeTargetEnvironment(spec.env)});
 if(!launch.success)throw Error('Invalid native launch specification');
 const child=spawnProcess(process.execPath,[...nativeModuleArguments('native-systemd-supervisor'),'--run'],{env:nativeControlEnvironment(process.env),detached:false,stdio:['pipe','pipe','pipe','ipc']});
 let committed=false,confirmation:Promise<void>|undefined,exited=false,released=false;
 const release=()=>{if(!released){lease?.released();released=true;}};
 child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});
 child.on('message',message=>{
  if(message&&typeof message==='object'&&(message as any).type==='native_launch_ready'&&typeof (message as any).nonce==='string'&&child.connected){
   try{lease?.committed();}catch{child.disconnect();return;}committed=true;
   child.send({type:'native_launch_commit',nonce:(message as any).nonce},error=>{if(error&&child.connected)child.disconnect();});
  }
  if(message&&typeof message==='object'&&(message as any).type==='native_systemd_cgroup'){
   void authority.inspect().then(snapshot=>{
    const value=message as any;
    if(snapshot.state==='active'&&snapshot.runtime&&value.unit===unitName&&value.cgroup===snapshot.runtime.cgroup&&value.invocation===snapshot.runtime.invocation&&child.connected){lease?.observed(snapshot.runtime);child.send({type:'native_runtime_commit',invocation:snapshot.runtime.invocation},()=>{});}
   }).catch(()=>{if(child.connected)child.disconnect();});
  }
 });
 child.send({type:'native_launch',spec:launch.data},error=>{if(error&&child.connected)child.disconnect();});
 const managed=child as unknown as NativeSystemdProcess;
 managed.confirmNativeExit=()=>{
  if(confirmation)return confirmation;
  confirmation=(async()=>{
   if(!committed&&exited){release();return;}
   const deadline=Date.now()+5000;
   do{const snapshot=await authority.inspect();if(snapshot.state==='stopped'){release();return;}if(snapshot.state==='active'&&snapshot.runtime)await authority.stop();else throw unknownExit();await delay();}while(Date.now()<deadline);
   throw unknownExit();
  })().finally(()=>{confirmation=undefined;});
  return confirmation;
 };
 return managed;
}

async function runSupervisor():Promise<never>{
 let stopping=false,child:ChildProcessWithoutNullStreams|undefined;
 let cancelLaunch:()=>void=()=>{};
 let notifyStop:()=>void=()=>{};const stopped=new Promise<void>(resolve=>notifyStop=resolve);
 const stop=()=>{stopping=true;cancelLaunch();notifyStop();};
 process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});process.once('disconnect',()=>{void stop();});process.stdin.once('end',()=>{void stop();});process.stdin.once('error',()=>{void stop();});
 if(!process.connected)process.exit(1);
 const spec=await new Promise<NativeLaunch|null>((resolve,reject)=>{
  cancelLaunch=()=>resolve(null);
  process.once('message',message=>{const parsed=nativeLaunchSchema.safeParse((message as any)?.type==='native_launch'?(message as any).spec:null);if(!parsed.success)reject(Error('Invalid native launch specification'));else resolve(parsed.data);});
 });
 if(!spec||stopping||!process.connected)process.exit(1);
 // A buffered spec can arrive after the Worker disconnected. Require a fresh
 // round-trip on the owning IPC before creating a unit; never launch solely
 // because an old message preceded the disconnect event in Node's queue.
 const nonce=randomUUID();
 const committed=await new Promise<boolean>(resolve=>{
  cancelLaunch=()=>resolve(false);
  process.once('message',message=>resolve(Boolean(message&&typeof message==='object'&&(message as any).type==='native_launch_commit'&&(message as any).nonce===nonce)));
  process.send?.({type:'native_launch_ready',nonce},error=>{if(error)resolve(false);});
 });
 if(!committed||stopping||!process.connected)process.exit(1);
 const unit=spec.unitName,authority=new NativeSystemdUnit({unitName:unit,ownerToken:spec.ownerToken});
 const args=['--user','--quiet','--pipe','--wait','--collect','--service-type=exec','--expand-environment=no',`--unit=${unit}`,`--description=${nativeUnitDescription(spec.ownerToken)}`,'--property=Restart=no','--property=Delegate=no','--property=KillMode=control-group','--property=TimeoutStopSec=3s','--property=SendSIGKILL=yes','/usr/bin/env','-i',process.execPath,...nativeModuleArguments('native-systemd-target')];
 child=spawnProcess('systemd-run',args,{env:nativeControlEnvironment(process.env),stdio:['pipe','pipe','pipe']});
 const target=child;
 let wrapperEnded=false,spawnFailed=false,exitCode=1,runtimeAccepted=false;
 target.once('error',()=>{spawnFailed=true;stop();});
 target.once('exit',()=>stop());
 target.once('close',(code,signal)=>{process.stdin.unpipe(target.stdin);wrapperEnded=true;exitCode=signal?1:code??1;stop();});
 for(const stream of [child.stdin,child.stdout,child.stderr,process.stdout,process.stderr])stream.on('error',()=>{void stop();});
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
 process.on('message',message=>{
  if(!runtimeAccepted&&!stopping&&process.connected&&message&&typeof message==='object'&&(message as any).type==='native_runtime_commit'&&(message as any).invocation===authority.runtime?.invocation){runtimeAccepted=true;target.stdin.write(JSON.stringify(spec)+'\n');process.stdin.pipe(target.stdin);}
 });
 let announced=false;
 for(;;){
  if(spawnFailed){process.stderr.write('Native supervisor failed\n');process.exit(1);}
  try{
   const snapshot=await authority.inspect();
   if(snapshot.runtime&&!announced){announced=true;if(process.connected)process.send?.({type:'native_systemd_cgroup',unit,...snapshot.runtime},()=>{});}
   if(stopping){
    if(snapshot.state==='stopped'&&wrapperEnded)process.exit(exitCode);
    if(snapshot.state==='active'&&snapshot.runtime)await authority.stop();
   }else if(runtimeAccepted)await stopped;
  }catch{stop();/* Keep owning the unit. Errors are not native exit evidence. */}
  await delay();
 }
}

if(process.argv[2]==='--run')void runSupervisor().catch(()=>{process.stderr.write('Native supervisor failed\n');process.exit(1);});
