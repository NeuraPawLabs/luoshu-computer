import {constants} from 'node:fs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, expect, test, vi} from 'vitest';

const injection = vi.hoisted(() => ({source:'', outside:'', replaced:false, buffers:[] as number[]}));
// Replace a parent at the last possible moment: O_NOFOLLOW on the leaf alone
// cannot prevent opening a file through a newly symlinked parent.
vi.mock('node:fs/promises', async importOriginal => {
 const fs = await importOriginal<typeof import('node:fs/promises')>();
 return {...fs, open:async (path:string, flags:number) => {
  if(injection.source && !injection.replaced && path.endsWith('/answer.txt')) {
   injection.replaced = true;
   await fs.rename(injection.source, injection.source + '-original');
   await fs.symlink(injection.outside, injection.source);
  }
  const handle = await fs.open(path, flags);
  if(!(flags & constants.O_DIRECTORY)) {
   const read = handle.read.bind(handle);
   handle.read = ((buffer:Buffer, offset:number, length:number, position:number) => {
    injection.buffers.push(buffer.byteLength);
    return read(buffer, offset, length, position);
   }) as typeof handle.read;
  }
  return handle;
 }};
});
import {collectOutputFiles} from '../src/files.js';

const roots:string[]=[];
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-output-security-'));roots.push(root);
 const outputs=join(root,'outputs');await mkdir(outputs);
 return {root,outputs};
}
afterEach(async()=>{
 injection.source='';injection.outside='';injection.replaced=false;injection.buffers=[];
 for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
test('nested tiny files do not retain a maximum-size buffer per file',async()=>{
 const {outputs}=await setup();await mkdir(join(outputs,'project'));
 for(let i=0;i<20;i++)await writeFile(join(outputs,'project',`file-${i}.txt`),'tiny');
 await collectOutputFiles(outputs);
 expect(injection.buffers.length).toBeGreaterThan(0);
 expect(Math.max(...injection.buffers)).toBeLessThanOrEqual(64*1024);
});
test('a replaced parent directory cannot introduce outside file bytes',async()=>{
 const {root,outputs}=await setup(),project=join(outputs,'project'),outside=join(root,'outside');
 await mkdir(project);await mkdir(outside);
 await writeFile(join(project,'answer.txt'),'safe');
 // Outside is a FIFO: unsafe traversal would attempt to open it and fail.
 await import('node:child_process').then(({execFileSync})=>execFileSync('mkfifo',[join(outside,'answer.txt')]));
 injection.source=project;injection.outside=outside;
 const files=await collectOutputFiles(outputs);
 expect(injection.replaced).toBe(true);
 expect(files[0].name).toBe('project.zip');
});
