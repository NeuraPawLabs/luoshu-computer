import {expect,test,vi} from 'vitest';
import {mkdtemp,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAppServerPool} from '../../src/engines/codex-pool.js';

function gate(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};}
function fake(initialize:()=>Promise<void>=async()=>{}){
 const value={isClosed:false,hasExited:true,root:'',starts:0,initialize:async()=>{value.starts++;value.hasExited=false;await initialize();if(value.isClosed)throw Error('closed');},readAccount:async()=>({requiresOpenaiAuth:false,accountPresent:false}),assertPermissionProfileAvailable:async(root:string)=>{value.root=root;},close:async()=>{value.isClosed=true;value.hasExited=true;}};
 return value;
}
test('concurrent audit calls before native spawn perform one audit, not sequential duplicate probes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'audit-lifecycle-')),entered=gate(),release=gate(),clients:ReturnType<typeof fake>[]=[];
 const pool=new CodexAppServerPool({stateDir:root,rpcFactory:()=>{const c=fake(async()=>{entered.release();await release.promise;});clients.push(c);return c as any;}});
 try{const a=pool.audit('worker'),b=pool.audit('worker');await entered.promise;release.release();expect(await Promise.all([a,b])).toEqual(['ready','ready']);expect(clients).toHaveLength(1);}finally{release.release();await pool.close();await rm(root,{recursive:true,force:true});}
});
test('shutdown before asynchronous audit setup prevents late initialize and drains its directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'audit-shutdown-')),clients:ReturnType<typeof fake>[]=[];
 const pool=new CodexAppServerPool({stateDir:root,rpcFactory:()=>{const c=fake();clients.push(c);return c as any;}});
 try{const result=pool.audit('worker');await pool.close();expect(await result).toBe('permissions_unavailable');expect(clients.every(c=>c.starts===0)).toBe(true);
  await expect(pool.audit('worker')).rejects.toThrow(/closed/);
 }finally{await pool.close();await rm(root,{recursive:true,force:true});}
});
test('shutdown waits for in-flight audit logic as well as process exit before returning',async()=>{
 const root=await mkdtemp(join(tmpdir(),'audit-drain-')),entered=gate(),release=gate(),c=fake(async()=>{entered.release();await release.promise;});
 const pool=new CodexAppServerPool({stateDir:root,rpcFactory:()=>c as any});
 try{const result=pool.audit('worker');await entered.promise;let ended=false;const close=pool.close().then(()=>{ended=true;});await new Promise(r=>setImmediate(r));expect(ended).toBe(false);release.release();await close;expect(await result).toBe('permissions_unavailable');}
 finally{release.release();await pool.close();await rm(root,{recursive:true,force:true});}
});
test('failed audit close retains the owned directory, and retries close before replacing the client',async()=>{
 const root=await mkdtemp(join(tmpdir(),'audit-retry-close-')),clients:ReturnType<typeof fake>[]=[];let uncertain=true;
 const pool=new CodexAppServerPool({stateDir:root,rpcFactory:()=>{const c=fake();const close=c.close;vi.spyOn(c,'close').mockImplementation(async()=>{if(uncertain)throw Error('exit unknown');await close();});clients.push(c);return c as any;}});
 try{expect(await pool.audit('worker')).toBe('permissions_unavailable');const path=clients[0].root;expect((await lstat(path)).isDirectory()).toBe(true);expect(await pool.audit('worker')).toBe('permissions_unavailable');expect(clients).toHaveLength(1);uncertain=false;expect(await pool.audit('worker')).toBe('ready');expect(clients).toHaveLength(2);await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'});}
 finally{uncertain=false;await pool.close();await rm(root,{recursive:true,force:true});}
});
