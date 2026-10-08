import {execFile as execFileCallback} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {nativeControlEnvironment} from './native-systemd-launch.js';

const execFile=promisify(execFileCallback);
export const nativeUnitIdentitySchema=z.object({unitName:z.string().regex(/^luoshu-codex-[a-z0-9-]{1,90}$/u),ownerToken:z.string().uuid()}).strict();
export interface NativeUnitRuntime {invocation:string;cgroup:string}
export interface NativeUnitIO {show:(unit:string)=>Promise<string>;stop:(unit:string)=>Promise<void>;events:(path:string)=>Promise<string>}
export const nativeUnitDescription=(token:string)=>'Luoshu native '+token;
const nativeIO:NativeUnitIO={
 show:async unit=>(await execFile('systemctl',['--user','show',unit,'--no-pager','--property=Id','--property=Description','--property=LoadState','--property=ActiveState','--property=SubState','--property=Job','--property=InvocationID','--property=ControlGroup'],{env:nativeControlEnvironment(process.env),timeout:1500,maxBuffer:8192})).stdout,
 stop:async unit=>{await execFile('systemctl',['--user','stop',unit],{env:nativeControlEnvironment(process.env),timeout:5000,maxBuffer:8192});},
 events:path=>readFile(path,'utf8'),
};

/** A systemd query failure is never evidence of exit. Missing-before-observed
 * is also not exit: a queued StartTransientUnit can still create the service. */
export class NativeSystemdUnit {
 readonly unit:string;readonly identity:z.infer<typeof nativeUnitIdentitySchema>;
 private saved?:NativeUnitRuntime;
 constructor(identity:z.infer<typeof nativeUnitIdentitySchema>,private readonly io:NativeUnitIO=nativeIO,runtime?:NativeUnitRuntime){
  this.identity=nativeUnitIdentitySchema.parse(identity);this.unit=identity.unitName+'.service';if(runtime)this.pin(runtime);
 }
 get runtime():NativeUnitRuntime|undefined{return this.saved?{...this.saved}:undefined;}
 private pin(runtime:NativeUnitRuntime){
  const {invocation,cgroup}=runtime;
  if(!/^[a-f0-9]{32}$/u.test(invocation)||!cgroup.startsWith('/')||posix.normalize(cgroup)!==cgroup||posix.basename(cgroup)!==this.unit||/[\u0000-\u0020\u007f]/u.test(cgroup))throw Error('Native unit identity or cgroup is invalid');
  if(this.saved&&(this.saved.invocation!==invocation||this.saved.cgroup!==cgroup))throw Error('Native unit runtime identity changed');
  this.saved={invocation,cgroup};
 }
 async inspect():Promise<{state:'missing'|'active'|'stopped';runtime?:NativeUnitRuntime}>{
  const raw=await this.io.show(this.unit),fields:Record<string,string>={};
  for(const line of raw.trim().split('\n')){const at=line.indexOf('=');if(at<1||Object.hasOwn(fields,line.slice(0,at)))throw Error('Native unit snapshot is invalid');fields[line.slice(0,at)]=line.slice(at+1);}
  if(fields.Id!==this.unit||['LoadState','ActiveState','SubState','Job','InvocationID','ControlGroup','Description'].some(k=>!Object.hasOwn(fields,k)))throw Error('Native unit identity is incomplete');
  const missing=fields.LoadState==='not-found';
  if(missing){if(fields.ActiveState!=='inactive'||fields.SubState!=='dead'||fields.Job||fields.InvocationID||fields.ControlGroup)throw Error('Native missing unit identity is inconsistent');}
  else{
   if(fields.LoadState!=='loaded'||fields.Description!==nativeUnitDescription(this.identity.ownerToken))throw Error('Native unit ownership changed');
   if(this.saved&&fields.InvocationID&&fields.InvocationID!==this.saved.invocation)throw Error('Native unit invocation identity changed');
   if(fields.ControlGroup)this.pin({invocation:fields.InvocationID!,cgroup:fields.ControlGroup});
  }
  if(!this.saved)return{state:missing?'missing':'active'};
  const terminal=missing||(['inactive','failed'].includes(fields.ActiveState!)&&['dead','failed'].includes(fields.SubState!)&&!fields.Job);
  let empty=false;
  try{const events=await this.io.events('/sys/fs/cgroup'+this.saved.cgroup+'/cgroup.events');const lines=events.trim().split('\n').filter(l=>l.startsWith('populated '));if(lines.length!==1||!/^populated [01]$/u.test(lines[0]!))throw Error('Native cgroup state is unknown');empty=lines[0]==='populated 0';}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')empty=true;else throw error;}
  return{state:terminal&&empty?'stopped':'active',runtime:this.runtime};
 }
 async stop():Promise<void>{
  const snapshot=await this.inspect();
  if(snapshot.state==='active'&&snapshot.runtime)await this.io.stop(this.unit);
 }
}
