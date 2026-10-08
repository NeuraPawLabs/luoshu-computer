import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rename,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import {NativeWorkspaceRoots} from '../src/agent-engines/native-workspace-roots.js';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-root-owner-')),path=join(root,'worker.db'),db=new Database(path),roots=new NativeWorkspaceRoots(db,root);
 return{root,path,db,roots,async close(){if(db.open)db.close();await rm(root,{recursive:true,force:true});}};
}
test('session/workspace mapping is unique and concurrent exact creation exposes one owned directory',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.roots.prepare('workspace','session'),f.roots.prepare('workspace','session')]);expect(a).toBe(b);
  const saved=f.db.prepare('SELECT * FROM native_workspace_owners').get();
  await expect(f.roots.prepare('workspace','foreign')).rejects.toThrow(/another session/);
  await expect(f.roots.prepare('different','session')).rejects.toThrow(/binding/);
  expect(f.db.prepare('SELECT * FROM native_workspace_owners').get()).toEqual(saved);
  await expect(f.roots.cleanup('foreign',a,()=>{})).rejects.toThrow(/missing/);expect((await lstat(a)).isDirectory()).toBe(true);
 }finally{await f.close();}
});
test('an existing unknown directory is not adopted or removed even after a rejected creation',async()=>{
 const f=await fixture();try{
  const path=join(f.root,'assistant-engine-workspaces','workspace');await mkdir(path,{recursive:true});await writeFile(join(path,'foreign'),'keep');
  await expect(f.roots.prepare('workspace','session')).rejects.toThrow(/ownership.*unknown/);
  await expect(f.roots.cleanup('session',path,()=>{})).rejects.toThrow(/unresolved/);
  expect(await readFile(join(path,'foreign'),'utf8')).toBe('keep');expect(()=>f.db.transaction(()=>f.roots.purge('session'))()).toThrow(/not confirmed/);
 }finally{await f.close();}
});
test('creator failure before pin cannot be repaired by adopting the surviving directory',async()=>{
 const f=await fixture();try{
  f.db.exec("CREATE TRIGGER reject_pin BEFORE UPDATE OF owner_json ON native_workspace_owners BEGIN SELECT RAISE(ABORT,'pin failed'); END");
  await expect(f.roots.prepare('workspace','session')).rejects.toThrow('pin failed');f.db.exec('DROP TRIGGER reject_pin');
  const path=join(f.root,'assistant-engine-workspaces','workspace');expect((await lstat(path)).isDirectory()).toBe(true);
  await expect(f.roots.prepare('workspace','session')).rejects.toThrow(/unresolved/);await expect(f.roots.cleanup('session',path,()=>{})).rejects.toThrow(/unresolved/);
 }finally{await f.close();}
});
test.each(['directory','symlink','parent'] as const)('cleanup rejects replaced %s without removing the foreign tree',async mode=>{
 const f=await fixture();try{
  const path=await f.roots.prepare('workspace','session'),parent=join(f.root,'assistant-engine-workspaces'),outside=join(f.root,'outside');
  await mkdir(outside);await writeFile(join(outside,'foreign'),'outside');
  if(mode==='parent'){await rename(parent,parent+'-saved');await mkdir(path,{recursive:true});await writeFile(join(path,'foreign'),'keep');}
  else{await rename(path,path+'-saved');if(mode==='symlink')await symlink(outside,path);else{await mkdir(path);await writeFile(join(path,'foreign'),'keep');}}
  await expect(f.roots.cleanup('session',path,()=>{})).rejects.toThrow(/identity|link|symbolic/);
  expect(await readFile(join(path,'foreign'),'utf8')).toBe(mode==='symlink'?'outside':'keep');expect(await readFile(join(outside,'foreign'),'utf8')).toBe('outside');
 }finally{await f.close();}
});
test('removed root survives DB reopen and final transaction rollback without recreation or foreign deletion',async()=>{
 const f=await fixture();let reopened:Database.Database|undefined;
 try{
  const path=await f.roots.prepare('workspace','session'),other=await f.roots.prepare('foreign-workspace','foreign');
  await writeFile(join(path,'scratch'),'private');await writeFile(join(other,'keep'),'foreign');
  await f.roots.cleanup('session',path,()=>{});f.db.close();reopened=new Database(f.path);const roots=new NativeWorkspaceRoots(reopened,f.root);
  expect(reopened.prepare('SELECT state FROM native_workspace_owners WHERE session_key=?').get('session')).toEqual({state:'removed'});
  expect(()=>reopened!.transaction(()=>{roots.purge('session');throw Error('final close failed');})()).toThrow('final close failed');
  await roots.cleanup('session',path,()=>{});await expect(roots.prepare('workspace','session')).rejects.toThrow(/unresolved/);
  reopened.transaction(()=>roots.purge('session'))();expect(reopened.prepare('SELECT session_key FROM native_workspace_owners').all()).toEqual([{session_key:'foreign'}]);
  await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(other,'keep'),'utf8')).toBe('foreign');
 }finally{reopened?.close();await f.close();}
});
test('cleanup-before-prepare does not create a root or ownership record',async()=>{
 const f=await fixture();try{
  await f.roots.cleanup('missing',undefined,()=>{});f.db.transaction(()=>f.roots.purge('missing'))();
  await expect(lstat(join(f.root,'assistant-engine-workspaces'))).rejects.toMatchObject({code:'ENOENT'});expect(f.db.prepare('SELECT * FROM native_workspace_owners').all()).toEqual([]);
 }finally{await f.close();}
});
