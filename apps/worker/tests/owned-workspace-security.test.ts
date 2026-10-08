import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,chmod,symlink,link,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test,vi} from 'vitest';

const race=vi.hoisted(()=>({source:'',target:'',triggered:false,onChmod:undefined as (()=>void)|undefined}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 const replace=async()=>{if(race.source&&!race.triggered){race.triggered=true;await fs.rename(race.source,race.source+'-saved');await fs.symlink(race.target,race.source);}};
 return{...fs,chmod:async(path:any,mode:any)=>{await replace();const result=await fs.chmod(path,mode);race.onChmod?.();return result;},open:async(path:any,...args:any[])=>{
  const handle=await (fs.open as any)(path,...args);
  const change=handle.chmod.bind(handle);handle.chmod=async(mode:any)=>{await replace();const result=await change(mode);race.onChmod?.();return result;};return handle;
 }};
});
import {removeOwnedWorkspace} from '../src/files.js';
import {removeCodebaseWorkspace} from '../src/codebase-workspace.js';

test('expected directory identity rejects a normal replacement before any contents are removed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'owned-delete-identity-')),path=join(root,'owned');
 try{
  await mkdir(path);const before=await lstat(path,{bigint:true}),parent=await lstat(root,{bigint:true});
  const expected={dev:String(before.dev),ino:String(before.ino),parent_dev:String(parent.dev),parent_ino:String(parent.ino)};
  await rename(path,path+'-saved');await mkdir(path);await writeFile(join(path,'foreign'),'preserve');
  await expect(removeOwnedWorkspace(path,()=>{},expected)).rejects.toThrow(/identity/);
  expect(await readFile(join(path,'foreign'),'utf8')).toBe('preserve');
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const [name,remove] of [['files',removeOwnedWorkspace],['codebases',removeCodebaseWorkspace]] as const){
 test(`${name} cleanup stops further mutations on authority loss mid-traversal`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'owned-delete-authority-')),owned=join(root,'owned');await mkdir(owned);await writeFile(join(owned,'one'),'keep');await writeFile(join(owned,'two'),'also keep');
  let allowed=true;const current=()=>{if(!allowed)throw Error('authority revoked');};race.onChmod=()=>{allowed=false;};
  try{
   await expect(remove(owned,current)).rejects.toThrow('authority revoked');
   expect(await readFile(join(owned,'one'),'utf8')).toBe('keep');expect(await readFile(join(owned,'two'),'utf8')).toBe('also keep');
   race.onChmod=undefined;allowed=true;await remove(owned,current);await expect(lstat(owned)).rejects.toMatchObject({code:'ENOENT'});
  }finally{race.onChmod=undefined;await rm(root,{recursive:true,force:true});}
 });
 test(`${name} cleanup cannot follow a parent swapped after validation`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'owned-delete-race-')),owned=join(root,'owned'),inside=join(owned,'nested'),outside=join(root,'outside');
  await mkdir(inside,{recursive:true});await mkdir(outside);await writeFile(join(inside,'keep'),'owned');await writeFile(join(outside,'keep'),'private',{mode:0o400});await chmod(outside,0o500);
  race.source=inside;race.target=outside;
  try{
   await remove(owned).catch(()=>undefined);
   // Assert before fixture teardown changes permissions. Restoring the mode
   // here would conceal a cleanup routine that followed the injected link.
   expect(race.triggered).toBe(true);expect((await lstat(outside)).mode&0o777).toBe(0o500);
   expect((await lstat(join(outside,'keep'))).mode&0o777).toBe(0o400);expect(await readFile(join(outside,'keep'),'utf8')).toBe('private');
  }finally{race.source='';race.target='';race.triggered=false;await chmod(outside,0o700);await rm(root,{recursive:true,force:true});}
 });
 test(`${name} cleanup preserves linked data and handles read-only directories idempotently`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'owned-delete-safe-')),owned=join(root,'owned'),outside=join(root,'private');await mkdir(owned);await writeFile(outside,'private',{mode:0o400});
  try{
   await link(outside,join(owned,'hard'));await expect(remove(owned)).rejects.toThrow(/link/i);expect((await lstat(outside)).mode&0o777).toBe(0o400);await rm(join(owned,'hard'));
   await symlink(outside,join(owned,'symbolic'));await expect(remove(owned)).rejects.toThrow(/link/i);await rm(join(owned,'symbolic'));
   await mkdir(join(owned,'read-only'));await writeFile(join(owned,'read-only','data'),'delete',{mode:0o400});await chmod(join(owned,'read-only'),0o500);
   await remove(owned);await remove(owned);await expect(lstat(owned)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(outside,'utf8')).toBe('private');
  }finally{await rm(root,{recursive:true,force:true});}
 });
}
