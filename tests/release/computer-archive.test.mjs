import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createComputerArchive} from '../../scripts/computer-archive.mjs';

test('computer package bytes ignore source mtimes but change when file content changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-computer-archive-'));
 try{
  const source=join(root,'source');await mkdir(source);await mkdir(join(source,'app'));
  const file=join(source,'app','worker.js');await writeFile(file,'worker A');
  const first=join(root,'first.tar.gz'),second=join(root,'second.tar.gz'),third=join(root,'third.tar.gz');
  createComputerArchive(source,first);
  await utimes(file,1_000_000_000,1_000_000_000);await utimes(join(source,'app'),1_200_000_000,1_200_000_000);
  createComputerArchive(source,second);assert.deepEqual(await readFile(first),await readFile(second));
  await writeFile(file,'worker B');createComputerArchive(source,third);assert.notDeepEqual(await readFile(second),await readFile(third));
 }finally{await rm(root,{recursive:true,force:true});}
});
