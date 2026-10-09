import {mkdtemp,mkdir,writeFile,rm,symlink,link,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import {fingerprintNativeTree} from '../../src/engines/native-check-snapshot.js';
test('Codebase fingerprint includes dirty bytes, filenames and executable mode but not root Git metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-check-tree-'));try{
  await mkdir(join(root,'.git'));await writeFile(join(root,'.git','HEAD'),'one');await writeFile(join(root,'中文.txt'),'one');const first=await fingerprintNativeTree(root);
  await writeFile(join(root,'.git','HEAD'),'two');expect(await fingerprintNativeTree(root)).toBe(first);
  await writeFile(join(root,'中文.txt'),'two');const next=await fingerprintNativeTree(root);expect(next).not.toBe(first);
  await chmod(join(root,'中文.txt'),0o700);expect(await fingerprintNativeTree(root)).not.toBe(next);
 }finally{await rm(root,{recursive:true,force:true});}
});
test.each(['symlink','hardlink'])('Codebase fingerprint refuses %s instead of following another resource',async kind=>{
 const root=await mkdtemp(join(tmpdir(),'native-check-links-'));try{
  await mkdir(join(root,'tree'));await writeFile(join(root,'secret'),'private');
  if(kind==='symlink')await symlink(join(root,'secret'),join(root,'tree','bad'));else await link(join(root,'secret'),join(root,'tree','bad'));
  await expect(fingerprintNativeTree(join(root,'tree'))).rejects.toThrow(/link|regular/);
 }finally{await rm(root,{recursive:true,force:true});}
});
