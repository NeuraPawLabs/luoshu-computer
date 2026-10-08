import {expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadComputerReleaseMirror} from '../src/computer-release-mirror.js';
import {PROTOCOL_VERSION} from '@luoshu/protocol';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'computer-mirror-'));
 const bytes=Buffer.from('archive snapshot');
 const path='/computer/releases/0.1.6/linux-x64.tar.gz';
 const manifest={version:'0.1.6',protocol_version:PROTOCOL_VERSION,releases:{'linux-x64':{path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}}};
 await mkdir(join(root,'releases','0.1.6'),{recursive:true});
 await writeFile(join(root,'releases','0.1.6','linux-x64.tar.gz'),bytes);
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest)+'\n');await writeFile(join(root,'install.sh'),'#!/bin/sh\n');
 return{root,bytes,manifest};
}
test('mirror uses verified byte snapshots and excludes unrelated files',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,'private-key.pem'),'DO NOT SHIP');
  const mirror=loadComputerReleaseMirror(f.root);
  expect(mirror.manifest).toEqual(f.manifest);expect(mirror.files.map(file=>file.path)).not.toContain('private-key.pem');
  await writeFile(join(f.root,'releases','0.1.6','linux-x64.tar.gz'),'changed after validation');
  expect(mirror.files.find(file=>file.path==='releases/0.1.6/linux-x64.tar.gz')!.bytes).toEqual(f.bytes);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test.each(['digest','size','protocol','path','symlink'])('mirror rejects invalid %s',async mutation=>{
 const f=await fixture();try{
  const archive=f.manifest.releases['linux-x64'];
  if(mutation==='digest')archive.sha256='0'.repeat(64);
  if(mutation==='size')archive.size++;
  if(mutation==='protocol')f.manifest.protocol_version--;
  if(mutation==='path')archive.path='/computer/../secret.tar.gz';
  if(mutation==='symlink'){
   const path=join(f.root,'releases','0.1.6','linux-x64.tar.gz');await rm(path);await symlink(join(f.root,'install.sh'),path);
  }
  await writeFile(join(f.root,'manifest.json'),JSON.stringify(f.manifest));
  expect(()=>loadComputerReleaseMirror(f.root)).toThrow();
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('mirror rejects duplicate archive routes before Core can register them',async()=>{
 const f=await fixture();try{
  const manifest={...f.manifest,releases:{...f.manifest.releases,'linux-arm64':f.manifest.releases['linux-x64']}};
  await writeFile(join(f.root,'manifest.json'),JSON.stringify(manifest));
  expect(()=>loadComputerReleaseMirror(f.root)).toThrow(/Duplicate/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
