import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
const guardian=new URL('../src/agent-engines/native-guardian.ts',import.meta.url).pathname;
interface Identity {pid:number;start:string;group:number;state:string}
async function identity(pid:number):Promise<Identity|null>{
 try{const text=await readFile(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(' ');return{pid,start:fields[19]!,group:Number(fields[2]),state:fields[0]!};}
 catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}
}
async function running(saved:Identity){const current=await identity(saved.pid);return current?.start===saved.start&&!['Z','X'].includes(current.state);}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await exited;}

test.each(['worker_kill','native_exit','stop','repeat_stop','inherited_pipes'] as const)('guardian reaps ready stubborn children: %s',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'guardian-ownership-')),ready=join(root,'ready.json');
 const descendant=`process.on('SIGTERM',()=>{});process.send({pid:process.pid});setInterval(()=>{},1000);`;
 const target=`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});process.on('SIGUSR1',()=>process.exit(9));const d=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',${mode==='inherited_pipes'?'1,2':"'ignore','ignore'"},'ipc']});d.once('message',m=>require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({target:process.pid,descendant:m.pid,guardian:process.ppid})));setInterval(()=>{},1000);`;
 const ownerCode=`const {spawn}=require('node:child_process');spawn(process.execPath,['--import',${JSON.stringify(import.meta.resolve('tsx'))},${JSON.stringify(guardian)},process.execPath,'-e',${JSON.stringify(target)}],{detached:true,stdio:['pipe','ignore','ignore','ipc']});setInterval(()=>{},1000);`;
 const owner=spawn(process.execPath,['-e',ownerCode],{stdio:'ignore'}),unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const saved:Identity[]=[];
 try{
  let ids:{target:number;descendant:number;guardian:number}|undefined;
  await expect.poll(async()=>{try{ids=JSON.parse(await readFile(ready,'utf8'));return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}},{timeout:5000}).toBe(true);
  for(const pid of [ids!.target,ids!.descendant,ids!.guardian]){const value=await identity(pid);expect(value).not.toBeNull();saved.push(value!);}
  expect(saved.every(p=>!['Z','X'].includes(p.state))).toBe(true);
  const foreign=await identity(unrelated.pid!);expect(foreign).not.toBeNull();
  if(mode==='worker_kill')await stop(owner);
  else if(mode==='native_exit'||mode==='inherited_pipes')process.kill(ids!.target,'SIGUSR1');
  else{process.kill(ids!.guardian,'SIGTERM');if(mode==='repeat_stop')process.kill(ids!.guardian,'SIGINT');}
  await expect.poll(async()=>Promise.all(saved.map(running)),{timeout:5000}).toEqual([false,false,false]);
  expect(await running(foreign!)).toBe(true);
 }finally{
  // Only exact fixture identities: no command-line search or stale PID killing.
  for(const value of saved)if(await running(value))try{process.kill(value.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await stop(owner);await stop(unrelated);await rm(root,{recursive:true,force:true});
 }
});
test.each(['spawn_error','early_disconnect'] as const)('guardian exits on %s without waiting for a target',async mode=>{
 const target=mode==='spawn_error'?'/nonexistent/luoshu-fixture':process.execPath;
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),guardian,target,'-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','ignore','ignore','ipc']});
 // Node may omit ChildProcess.close when IPC disconnect precedes startup.
 // Observe OS-process exit and pipe disposal independently, not that event.
 const exited=new Promise<void>(r=>child.once('exit',()=>r()));
 try{
  if(mode==='early_disconnect')child.disconnect();
  await expect.poll(()=>child.exitCode!==null||child.signalCode!==null,{timeout:5000}).toBe(true);await exited;
  await expect.poll(()=>child.stdin!.destroyed).toBe(true);
 }finally{await stop(child);}
});
