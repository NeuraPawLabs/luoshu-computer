import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,lstat,readFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import {NativeCodebaseWorkspaceOwners} from '../../src/engines/native-codebase-workspace-owners.js';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-codebase-owner-')),db=new Database(':memory:'),owners=new NativeCodebaseWorkspaceOwners(db,root);
 return{root,db,owners,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}

test('creator reserves and pins one Codebase Run root before it is exposed',async()=>{
 const f=await fixture();try{
  const path=await f.owners.prepare({session_id:'session',run_id:'run',submission_id:'submission'});
  expect(path).toBe(join(f.root,'runs','run'));expect((await lstat(path)).isDirectory()).toBe(true);
  expect(f.db.prepare('SELECT session_id,run_id,submission_id,state,cwd FROM native_codebase_workspace_owners').get()).toMatchObject({session_id:'session',run_id:'run',submission_id:'submission',state:'owned',cwd:path});
  await expect(f.owners.prepare({session_id:'session',run_id:'run',submission_id:'submission'})).resolves.toBe(path);
 }finally{await f.close();}
});

test('existing unknown Codebase Run directory is never adopted or removed',async()=>{
 const f=await fixture();try{
  const path=join(f.root,'runs','run');await mkdir(path,{recursive:true});await writeFile(join(path,'foreign'),'keep');
  await expect(f.owners.prepare({session_id:'session',run_id:'run',submission_id:'submission'})).rejects.toThrow(/unknown|ownership/i);
  await expect(f.owners.cleanup({session_id:'session',run_id:'run',submission_id:'submission'},()=>{})).rejects.toThrow(/owner|unknown|unresolved/i);
  expect(f.db.prepare('SELECT state FROM native_codebase_workspace_owners').get()).toEqual({state:'reserved'});
  expect(await readFile(join(path,'foreign'),'utf8')).toBe('keep');
 }finally{await f.close();}
});

test('cleanup validates the canonical owner path before deleting anything',async()=>{
 const f=await fixture();try{
  const identity={session_id:'session',run_id:'run',submission_id:'submission'};
  const owned=await f.owners.prepare(identity),moved=join(f.root,'runs','foreign');
  await writeFile(join(owned,'keep'),'owned bytes');await rename(owned,moved);
  f.db.prepare('UPDATE native_codebase_workspace_owners SET cwd=? WHERE run_id=?').run(moved,'run');
  await expect(f.owners.cleanup(identity)).rejects.toThrow(/path|identity/);
  expect(await readFile(join(moved,'keep'),'utf8')).toBe('owned bytes');
 }finally{await f.close();}
});

test('removed state requires absence, even if a matching inode is still at that path',async()=>{
 const f=await fixture();try{
  const identity={session_id:'session',run_id:'run',submission_id:'submission'},path=await f.owners.prepare(identity);
  await writeFile(join(path,'keep'),'not removed');f.db.prepare("UPDATE native_codebase_workspace_owners SET state='removed'").run();
  await expect(f.owners.cleanup(identity)).rejects.toThrow(/removed|absence|present/);
  expect(await readFile(join(path,'keep'),'utf8')).toBe('not removed');
 }finally{await f.close();}
});

test('replacement of an owned Codebase Run root is rejected without touching the foreign tree',async()=>{
 const f=await fixture();try{
  const identity={session_id:'session',run_id:'run',submission_id:'submission'},path=await f.owners.prepare(identity),saved=path+'-saved';await rename(path,saved);await mkdir(path);await writeFile(join(path,'foreign'),'keep');
  await expect(f.owners.cleanup(identity,()=>{})).rejects.toThrow(/identity|owner|symbolic/i);expect(await readFile(join(path,'foreign'),'utf8')).toBe('keep');expect(await lstat(saved)).toBeTruthy();
 }finally{await f.close();}
});
