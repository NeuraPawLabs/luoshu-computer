import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {NativeUnitRegistry} from '../../src/engines/native-unit-registry.js';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeControlEnvironment} from '../../src/engines/native-systemd-launch.js';
import {spawnSystemdSupervisor} from '../../src/engines/native-systemd-supervisor.js';

test('registry writes launch intent before commit, fences live owners and stores no launch content',async()=>{
 const db=new Database(':memory:');try{
  const registry=new NativeUnitRegistry(db),lease=await registry.acquire('worker');
  const row=db.prepare('SELECT * FROM native_systemd_units').get() as any;
  expect(row).toMatchObject({worker_id:'worker',unit_name:lease.unitName,owner_token:lease.ownerToken,phase:'reserved',runtime_json:null});
  await expect(new NativeUnitRegistry(db).acquire('worker')).rejects.toThrow(/owner.*active/);
  lease.committed();expect(db.prepare('SELECT phase FROM native_systemd_units').get()).toEqual({phase:'committed'});
  const runtime={invocation:'a'.repeat(32),cgroup:'/user.slice/'+lease.unitName+'.service'};
  lease.observed(runtime);expect(db.prepare('SELECT phase,runtime_json FROM native_systemd_units').get()).toEqual({phase:'observed',runtime_json:JSON.stringify(runtime)});
  expect(JSON.stringify(row)).not.toContain('environment');lease.released();expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);
 }finally{db.close();}
});
test('registry phase persistence failure prevents granting native launch authority',async()=>{
 const db=new Database(':memory:');try{
  const lease=await new NativeUnitRegistry(db).acquire('worker');
  db.exec("CREATE TRIGGER reject_commit BEFORE UPDATE ON native_systemd_units BEGIN SELECT RAISE(ABORT,'disk unavailable'); END");
  expect(()=>lease.committed()).toThrow('disk unavailable');expect(db.prepare('SELECT phase FROM native_systemd_units').get()).toEqual({phase:'reserved'});
 }finally{db.close();}
});
test.each(['reserved','committed','running','worker-only','cleanup'] as const)('actual Worker SIGKILL and SQLite reopen handle %s identity without replay',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'native-unit-reopen-')),path=join(root,'worker.db');let db:Database.Database|undefined,unit:string|undefined;
 const worker=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../helpers/native-unit-crash.ts',import.meta.url)),path,root,mode],{env:nativeControlEnvironment(process.env),stdio:['ignore','pipe','pipe','ipc']});
 worker.stdout.resume();worker.stderr.resume();const exited=new Promise(r=>worker.once('exit',r));
 try{
  const message=await new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',()=>reject(Error('fixture exited before ready')));});unit=message.unit;
  db=new Database(path);const original=db.prepare('SELECT * FROM native_systemd_units').get();
  if(mode==='running'||mode==='worker-only'||mode==='cleanup'){
   expect(original).toMatchObject({phase:'observed',runtime_json:expect.any(String)});
   // Kill the independent supervisor as well, so restart must use SQLite,
   // not simply rely on IPC disconnect doing the cleanup in the background.
   if(mode==='running'||mode==='cleanup')process.kill(message.supervisor,'SIGKILL');
  }
  worker.kill('SIGKILL');await exited;db.close();db=new Database(path);
  const registry=new NativeUnitRegistry(db);
  if(mode==='committed'){
   await expect(registry.acquire('worker')).rejects.toThrow(/launch remains unknown/);expect(db.prepare('SELECT * FROM native_systemd_units').get()).toEqual(original);
  }else{
   if(mode==='cleanup'){await registry.quiesce('worker');expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);}
   else{const lease=await registry.acquire('worker');expect(lease.unitName).not.toBe(unit);lease.released();}
   if(mode==='running'||mode==='worker-only'||mode==='cleanup')for(const pid of [message.target,message.descendant])await expect.poll(async()=>{try{const raw=await readFile(`/proc/${pid}/stat`,'utf8');return ['Z','X'].includes(raw.slice(raw.lastIndexOf(')')+2).split(' ')[0]!);}catch(e){if((e as any).code==='ENOENT')return true;throw e;}}).toBe(true);
  }
 }finally{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await exited;if(unit)await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});db?.close();await rm(root,{recursive:true,force:true});}
});
test('failed runtime persistence prevents Agent startup even with a live transient unit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-unit-pin-failure-')),db=new Database(join(root,'worker.db')),marker=join(root,'must-not-run');
 const lease=await new NativeUnitRegistry(db).acquire('worker');
 db.exec("CREATE TRIGGER fail_pin BEFORE UPDATE OF runtime_json ON native_systemd_units BEGIN SELECT RAISE(ABORT,'disk unavailable'); END");
 const child=spawnSystemdSupervisor({executable:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],cwd:root,env:{},lease});child.stdout.resume();child.stderr.resume();
 const exited=new Promise(r=>child.once('exit',r));
 try{
  await exited;await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});expect(db.prepare('SELECT phase FROM native_systemd_units').get()).toEqual({phase:'committed'});
  await child.confirmNativeExit();expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);
 }finally{await promisify(execFile)('systemctl',['--user','stop',lease.unitName],{timeout:6000}).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;db.close();await rm(root,{recursive:true,force:true});}
});
