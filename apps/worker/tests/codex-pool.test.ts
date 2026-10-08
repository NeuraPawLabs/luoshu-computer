import {expect,test,vi} from 'vitest';
import {mkdtemp,rm,mkdir,symlink,lstat,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServerPool} from '../src/agent-engines/codex-pool.js';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import Database from 'better-sqlite3';

test('pool maps only safe workspace IDs to private absolute directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-pool-')),pool=new CodexAppServerPool({stateDir:root});try{
  expect(await pool.workspacePath('run-1')).toBe(join(root,'assistant-engine-workspaces','run-1'));expect(await pool.workspacePath('../escape')).toBeNull();expect(await pool.workspacePath('/etc')).toBeNull();
 }finally{await pool.close();await rm(root,{recursive:true,force:true});}
});
test('pool shutdown cannot race recovery into a new native client',async()=>{
 const pool=new CodexAppServerPool({stateDir:'/unused'}),first=pool.client('worker');await first.close();
 let release!:()=>void,entered=false;const barrier=new Promise<void>(resolve=>release=resolve);
 vi.spyOn(first,'close').mockImplementation(async()=>{entered=true;await barrier;});
 const recovery=pool.recoverClient('worker');void recovery.catch(()=>{});await expect.poll(()=>entered).toBe(true);
 let done=false;const closing=pool.close().then(()=>{done=true;}),again=pool.close();
 await new Promise(r=>setImmediate(r));expect(done).toBe(false);
 release();await expect(recovery).rejects.toThrow(/clos|shut/i);await Promise.all([closing,again]);
 expect(()=>pool.client('worker')).toThrow(/clos|shut/i);
});
test('workspace mapping rejects symlink parents and symlink destinations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-pool-')),outside=await mkdtemp(join(tmpdir(),'luoshu-codex-outside-'));
 try{
  const pool=new CodexAppServerPool({stateDir:root});await mkdir(join(root,'assistant-engine-workspaces'));
  await symlink(outside,join(root,'assistant-engine-workspaces','escape'));
  await expect(pool.workspacePath('escape')).rejects.toThrow(/symbolic|workspace/i);
  await expect(lstat(join(outside,'child'))).rejects.toThrow();
  const root2=join(root,'other');await mkdir(root2);await symlink(outside,join(root2,'assistant-engine-workspaces'));
  await expect(new CodexAppServerPool({stateDir:root2}).workspacePath('child')).rejects.toThrow(/symbolic|workspace/i);
  await expect(lstat(join(outside,'child'))).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('workspace owner registry deletes only the exact session root after quiescence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-pool-owner-')),db=new Database(':memory:'),pool=new CodexAppServerPool({stateDir:root,db});
 try{
  const owned=await pool.workspacePath('workspace','session'),foreign=await pool.workspacePath('foreign-workspace','foreign');
  await writeFile(join(owned!,'private.txt'),'owned');await writeFile(join(foreign!,'keep.txt'),'foreign');
  expect(db.prepare('SELECT * FROM native_workspace_owners WHERE session_key=?').get('session')).toMatchObject({session_key:'session',workspace_id:'workspace',cwd:owned,state:'owned'});
  await pool.quiesce('worker');await pool.cleanupWorkspace('session',owned!,()=>{});
  await expect(lstat(owned!)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(foreign!,'keep.txt'),'utf8')).toBe('foreign');
  expect(()=>pool.purgeWorkspace('session')).toThrow(/transaction/);db.transaction(()=>pool.purgeWorkspace('session'))();
  expect(db.prepare('SELECT session_key,cwd,state FROM native_workspace_owners').all()).toEqual([{session_key:'foreign',cwd:foreign,state:'owned'}]);
 }finally{await pool.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('workspace cleanup rejects a changed owner path and leaves the directory intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-pool-owner-')),db=new Database(':memory:'),pool=new CodexAppServerPool({stateDir:root,db});
 try{
  const owned=await pool.workspacePath('session');await writeFile(join(owned!,'private.txt'),'owned');db.prepare("UPDATE native_workspace_owners SET cwd=? WHERE session_key='session'").run(join(root,'foreign'));
  await expect(pool.cleanupWorkspace('session',owned!,()=>{})).rejects.toThrow(/owner|identity|path/);expect(await readFile(join(owned!,'private.txt'),'utf8')).toBe('owned');
 }finally{await pool.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('unknown native interactions are rejected by default',async()=>{
 const pool=new CodexAppServerPool({stateDir:'/tmp/luoshu-codex-test'}),client=pool.client('worker');
 await expect((client as any).options?.onServerRequest?.({id:1,method:'item/fileChange/requestApproval',params:{}})).rejects.toMatchObject({code:-32010});await pool.close();
});
test('pool replaces a failed client only after its old process has exited and coalesces recovery',async()=>{
 class Child extends EventEmitter {
  sent:any[]=[];stdout=new PassThrough();stderr=new PassThrough();
  stdin=new Writable({write:(chunk,_encoding,done)=>{this.sent.push(JSON.parse(chunk.toString()));done();}});
  kill(){return true;}
 }
 const child=new Child();let closed=0;
 const pool=new CodexAppServerPool({stateDir:'/unused',onClosed:()=>{closed++;}}),first=pool.client('worker');
 // Replace only OS process creation; exercise the real RPC and pool lifecycle.
 (first as any).options.spawn=()=>child;
 const initialized=first.initialize({clientInfo:{name:'fixture',version:'1'}});child.stdout.write(JSON.stringify({id:1,result:{userAgent:'fixture/0.160.0 (Linux)'}})+'\n');await initialized;
 child.stdout.write('invalid envelope\n');expect(closed).toBe(1);expect(pool.client('worker')).toBe(first);
 let replaced=false;const recovery=pool.recoverClient('worker').then(client=>{replaced=true;return client;}),other=pool.recoverClient('worker');
 await new Promise(r=>setImmediate(r));expect(replaced).toBe(false);
 child.emit('close');const [a,b]=await Promise.all([recovery,other]);expect(a).toBe(b);expect(a).not.toBe(first);expect(pool.client('worker')).toBe(a);await pool.close();
});
test('idle unload closes the native client only when no durable work remains',async()=>{
 const pool=new CodexAppServerPool({stateDir:'/unused'}),first=pool.client('worker');
 try{
  expect(await pool.unloadIfIdle('worker',()=>1)).toBe(false);expect(pool.client('worker')).toBe(first);
  await first.close();expect(await pool.unloadIfIdle('worker',()=>0)).toBe(true);
  const next=pool.client('worker');expect(next).not.toBe(first);
 }finally{await pool.close();}
});
test('timed-out native shutdown keeps recovery fenced until actual late exit',async()=>{
 class Child extends EventEmitter {
  stdout=new PassThrough();stderr=new PassThrough();
  stdin=new Writable({write:(_chunk,_encoding,done)=>done()});
  signals:Array<string|undefined>=[];kill(signal?:string){this.signals.push(signal);return true;}
 }
 const child=new Child(),pool=new CodexAppServerPool({stateDir:'/unused'}),first=pool.client('worker');
 (first as any).options.spawn=()=>child;
 const initialized=first.initialize({clientInfo:{name:'fixture',version:'1'}});child.stdout.write(JSON.stringify({id:1,result:{userAgent:'fixture/0.160.0 (Linux)'}})+'\n');await initialized;
 vi.useFakeTimers();
 try{
  child.stdout.write('invalid envelope\n');
  const recovering=pool.recoverClient('worker'),rejected=expect(recovering).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
  await vi.advanceTimersByTimeAsync(6001);await rejected;
  expect(first.hasExited).toBe(false);expect(pool.client('worker')).toBe(first);
  await expect(pool.recoverClient('worker')).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});expect(child.signals).toEqual(['SIGTERM']);
  child.emit('close',0);const next=await pool.recoverClient('worker');expect(next).not.toBe(first);expect(pool.client('worker')).toBe(next);
 }finally{child.emit('close',0);vi.useRealTimers();await pool.close();}
});
test('production pool binds native launch lease to its Worker database without reserving on mere browsing',async()=>{
 const db=new Database(':memory:'),pool=new CodexAppServerPool({stateDir:'/unused',db});
 try{
  const client=pool.client('worker');expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);
  const lease=await (client as any).options.nativeLease();expect(db.prepare('SELECT worker_id,unit_name FROM native_systemd_units').get()).toEqual({worker_id:'worker',unit_name:lease.unitName});lease.released();
 }finally{await pool.close();db.close();}
});
test('cleanup quiescence closes owned client without replacement and retries uncertain exit',async()=>{
 const pool=new CodexAppServerPool({stateDir:'/unused'}),client=pool.client('worker');let fail=true;
 const close=client.close.bind(client);vi.spyOn(client,'close').mockImplementation(async()=>{if(fail)throw Error('exit unknown');await close();});
 try{
  await expect(pool.quiesce('worker')).rejects.toThrow('exit unknown');expect(pool.client('worker')).toBe(client);
  fail=false;await pool.quiesce('worker');expect(client.hasExited).toBe(true);
  expect(pool.client('worker')).not.toBe(client);
 }finally{fail=false;await pool.close();}
});
test('readiness audit uses a disposable native client and leaves no pool session or workspace owner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-audit-')),db=new Database(':memory:'),created:string[]=[],clients:any[]=[];
 const pool=new CodexAppServerPool({stateDir:root,db,rpcFactory:(id)=>{
  created.push(id);const client:any={id,isClosed:false,hasExited:true,initialize:async()=>{},readAccount:async()=>({requiresOpenaiAuth:false,hasAccount:false}),assertPermissionProfileAvailable:async()=>{},close:async()=>{client.isClosed=true;}};clients.push(client);return client;
 }});
 try{const live=pool.client('worker');const audit=pool.audit('worker');await expect.poll(()=>created.length).toBe(2);await expect(audit).resolves.toBe('ready');expect(created).toEqual(['worker','audit:worker']);expect(live).toBe(clients[0]);expect(live.isClosed).toBe(false);expect(clients[1].isClosed).toBe(true);expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);expect(db.prepare('SELECT * FROM native_workspace_owners').all()).toEqual([]);}
 finally{await pool.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('readiness audit cannot report ready or delete its root when native close is unconfirmed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-audit-close-')),db=new Database(':memory:'),release:{value?:()=>void}={},created:any[]=[];
 const pool=new CodexAppServerPool({stateDir:root,db,rpcFactory:(id)=>{const client:any={id,isClosed:false,hasExited:false,initialize:async()=>{},readAccount:async()=>({requiresOpenaiAuth:false,hasAccount:false}),assertPermissionProfileAvailable:async()=>{},close:()=>{if(client.isClosed)return Promise.resolve();return new Promise<void>(resolve=>{release.value=()=>{client.isClosed=true;client.hasExited=true;resolve();}})}};created.push(client);return client;}});
 try{
  const pending=pool.audit('worker');await expect.poll(()=>created.length).toBe(1);
  await expect(pending).resolves.toBe('permissions_unavailable');
  const audit=(pool as any).audits.get('worker');expect(audit?.root).toBeTruthy();await expect(lstat(audit.root)).resolves.toBeTruthy();
  release.value!();await pool.close();expect(db.prepare('SELECT * FROM native_systemd_units').all()).toEqual([]);
 }finally{release.value?.();await pool.close().catch(()=>undefined);db.close();await rm(root,{recursive:true,force:true});}
});

test('coalesced readiness audit is released after a late native exit and can be retried',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-audit-retry-')),db=new Database(':memory:'),clients:any[]=[];
 const pool=new CodexAppServerPool({stateDir:root,db,auditCloseTimeoutMs:10,rpcFactory:(id)=>{const client:any={id,isClosed:false,hasExited:false,initialize:async()=>{},readAccount:async()=>({requiresOpenaiAuth:false,accountPresent:false}),assertPermissionProfileAvailable:async()=>{},close:()=>{if(client.hasExited)return Promise.resolve();return client.closePromise??(client.closePromise=new Promise<void>(resolve=>{client.release=()=>{client.isClosed=true;client.hasExited=true;resolve();}}))}};clients.push(client);return client;}});
 try{
  const first=pool.audit('worker'),second=pool.audit('worker');expect(first).toBe(second);await expect(first).resolves.toBe('permissions_unavailable');await expect(second).resolves.toBe('permissions_unavailable');expect(clients).toHaveLength(1);
  const firstRoot=(pool as any).audits.get('worker').root;await expect(lstat(firstRoot)).resolves.toBeTruthy();clients[0].release();const retry=pool.audit('worker');await expect.poll(()=>clients.length,{interval:1}).toBe(2);await expect(lstat(firstRoot)).rejects.toMatchObject({code:'ENOENT'});await expect.poll(()=>clients[1].closePromise!==undefined,{interval:1}).toBe(true);clients[1].release();await expect(retry).resolves.toBe('ready');
 }finally{for(const client of clients)client.release?.();await pool.close().catch(()=>undefined);db.close();await rm(root,{recursive:true,force:true});}
});

test('readiness audit does not infer login state from arbitrary error text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-audit-classification-')),clients:any[]=[];
 const pool=new CodexAppServerPool({stateDir:root,auditCloseTimeoutMs:100,rpcFactory:()=>{const client:any={hasExited:true,initialize:async()=>{throw Error('credential parser failed')},close:async()=>{},readAccount:async()=>({requiresOpenaiAuth:false,accountPresent:false}),assertPermissionProfileAvailable:async()=>{}};clients.push(client);return client;}});
 try{await expect(pool.audit('worker')).resolves.toBe('permissions_unavailable');}finally{await pool.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
});

test('readiness audit reports a runtime protocol failure distinctly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-audit-protocol-'));
 const pool=new CodexAppServerPool({stateDir:root,auditCloseTimeoutMs:100,rpcFactory:()=>({hasExited:true,initialize:async()=>{throw Object.assign(Error('unsupported response'),{code:'CODEX_RPC_PROTOCOL_ERROR'});},close:async()=>{},readAccount:async()=>({requiresOpenaiAuth:false,accountPresent:false}),assertPermissionProfileAvailable:async()=>{}} as any)});
 try{await expect(pool.audit('worker')).resolves.toBe('protocol_unsupported');}finally{await pool.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
});
