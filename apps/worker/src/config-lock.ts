import {spawn} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';

// Linux flock releases the lock when either process exits, including crashes.
// Keep the read/validate/write transaction inside this lease in every editor.
export async function lockWorkerConfig(stateDir:string):Promise<()=>Promise<void>> {
 await mkdir(stateDir,{recursive:true,mode:0o700});
 const path=join(stateDir,'config.lock'),file=await open(path,'a',0o600);await file.close();
 return new Promise((resolve,reject)=>{
  const child=spawn('flock',['--exclusive','--timeout','5',path,process.execPath,'-e',
   "process.stdout.write('locked');process.stdin.resume();"],{stdio:['pipe','pipe','ignore']});
  let locked=false;
  const closed=new Promise<void>(done=>child.once('close',()=>{done();if(!locked)reject(Error('设备配置正被其他进程修改，请稍后重试'));}));
  child.once('error',error=>reject(error));child.stdin.on('error',()=>{});
  child.stdout.once('data',()=>{locked=true;resolve(async()=>{child.stdin.end();await closed;});});
 });
}
