import {chmod, mkdir, writeFile, realpath, open, readdir, lstat, unlink, rmdir, type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve, sep, dirname, basename, isAbsolute} from 'node:path';
import {MAX_FILE_BYTES, MAX_TASK_FILES, taskFileSchema, taskFilesSchema, type TaskFile} from '../protocol/index.js';
import {createOutputZip, type ArchiveEntry} from './output-zip.js';

export interface Workspace {path:string; inputs:string; outputs:string}
export const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_BYTES = MAX_FILE_BYTES;
const MAX_ARCHIVE_PATH = 500;
function assertName(name:string):void {taskFileSchema.parse({name,mime_type:'application/octet-stream',content_base64:''});}
function contained(root:string,p:string):void {
 const r=resolve(root),v=resolve(p);
 if(v!==r&&!v.startsWith(r+'/'))throw new Error('Path escapes workspace');
}
export async function prepareWorkspace(options:{stateDir:string;attemptId:string;inputFiles:TaskFile[]}):Promise<Workspace>{
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(options.attemptId))throw new Error('Invalid execution ID');
 const files=taskFilesSchema.parse(options.inputFiles);
 const stateReal=await realpath(resolve(options.stateDir)),parent=resolve(stateReal,'workspaces');
 await mkdir(parent,{recursive:true,mode:0o700});
 const parentReal=await realpath(parent);contained(stateReal,parentReal);
 const path=join(parentReal,options.attemptId);contained(stateReal,path);await mkdir(path,{mode:0o700});
 const inputs=join(path,'inputs'),outputs=join(path,'outputs');
 await mkdir(inputs,{mode:0o700});await mkdir(outputs,{mode:0o700});await chmod(path,0o700);
 for(const file of files)await writeFile(join(inputs,file.name),Buffer.from(file.content_base64,'base64'),{mode:0o600,flag:'wx'});
 return {path,inputs,outputs};
}

async function assertOwnedEntry(parent:FileHandle,name:string,device:number){
 const info=await lstat(join(descriptorPath(parent),name));
 if(info.dev!==device||info.isSymbolicLink()||!(info.isDirectory()||info.isFile())||info.isFile()&&info.nlink!==1)throw Error('Owned workspace contains a link, mount or unsupported entry');
 return info;
}
async function sameOwnedDirectory(parent:FileHandle,name:string,child:FileHandle,device:number){
 const expected=await child.stat(),actual=await assertOwnedEntry(parent,name,device);
 if(!actual.isDirectory()||actual.dev!==expected.dev||actual.ino!==expected.ino)throw Error('Owned workspace directory changed during cleanup');
}
async function visitOwnedDirectory(directory:FileHandle,device:number,remove:boolean,current:()=>void):Promise<void>{
 // Change directory permissions by descriptor, never a symlinkable pathname.
 // Unlinking a file needs writable parent permissions, not chmod on the file.
 current();if(remove){await directory.chmod(0o700);current();}
 for(const name of await readdir(descriptorPath(directory))){
  current();const info=await assertOwnedEntry(directory,name,device),path=join(descriptorPath(directory),name);current();
  if(info.isDirectory()){
   const child=await openDirectory(path);
   try{
    await sameOwnedDirectory(directory,name,child,device);
    current();await visitOwnedDirectory(child,device,remove,current);
    await sameOwnedDirectory(directory,name,child,device);current();
    if(remove){await rmdir(path);current();}
   }finally{await child.close();}
  }else if(remove){current();await unlink(path);current();}
 }
 current();
}
/** Delete one caller-owned directory through pinned, no-follow parents.
 * Reject changed/linked entries; never chmod files or recursively rm a path.
 * A partial deletion remains retryable. Ownership/quiescence is the caller's
 * responsibility; this is not isolation from malicious same-account actors. */
export interface OwnedDirectoryIdentity {dev:string;ino:string;parent_dev:string;parent_ino:string}
export async function removeOwnedWorkspace(path:string,current:()=>void=()=>{},identity?:OwnedDirectoryIdentity):Promise<void>{
 current();
 if(!isAbsolute(path)||resolve(path)!==path||path==='/')throw Error('Owned workspace requires an exact directory path');
 let parentOpened=false;
 await withOutputRoot(dirname(path),async parent=>{
  parentOpened=true;
  if(identity){const info=await parent.stat({bigint:true});if(String(info.dev)!==identity.parent_dev||String(info.ino)!==identity.parent_ino)throw Error('Owned workspace parent identity changed');}
  current();const name=basename(path),device=(await parent.stat()).dev;let child:FileHandle;current();
  try{await assertOwnedEntry(parent,name,device);child=await openDirectory(join(descriptorPath(parent),name));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try{
   if(identity){const info=await child.stat({bigint:true});if(String(info.dev)!==identity.dev||String(info.ino)!==identity.ino)throw Error('Owned workspace directory identity changed');}
   await sameOwnedDirectory(parent,name,child,device);current();await visitOwnedDirectory(child,device,false,current);
   await visitOwnedDirectory(child,device,true,current);await sameOwnedDirectory(parent,name,child,device);current();
   await rmdir(join(descriptorPath(parent),name));current();
  }finally{await child.close();}
 }).catch(error=>{if(parentOpened||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
 current();
}

const normalized=(name:string)=>name.normalize('NFC').toLowerCase();
const descriptorPath=(handle:FileHandle)=>'/proc/self/fd/'+handle.fd;
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
async function openDirectory(path:string):Promise<FileHandle>{
 try{return await open(path,directoryFlags);}
 catch(error){
  if(['ELOOP','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))
   throw new Error('Output directory must be a real directory; symbolic links are forbidden');
  throw error;
 }
}

// Linux Worker: pin every parent descriptor. O_NOFOLLOW on a leaf by itself
// cannot stop an ancestor being swapped for a symlink between checks and reads.
export async function withOutputRoot<T>(path:string,read:(root:FileHandle)=>Promise<T>):Promise<T>{
 const handles:FileHandle[]=[];
 try{
  let current=await openDirectory('/');handles.push(current);
  for(const component of resolve(path).split(sep).filter(Boolean)){
   current=await openDirectory(join(descriptorPath(current),component));handles.push(current);
  }
  return await read(current);
 }finally{for(const handle of handles.reverse())await handle.close();}
}

export async function collectOutputFiles(outputs:string):Promise<TaskFile[]>{
 return (await collectOutputSnapshot(outputs)).files;
}
export async function collectOutputSnapshot(outputs:string,signal?:AbortSignal):Promise<{files:TaskFile[];source_sha256:string}>{
 signal?.throwIfAborted();
 return withOutputRoot(outputs,async root=>{
  const entries=(await readdir(descriptorPath(root),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  if(entries.length>MAX_TASK_FILES)throw new Error('Too many output files');
  const sourceNames=new Set<string>(),deliverableNames=new Set<string>();
  // Validate the final archive names before reading any contents.
  const planned=entries.map(entry=>{
   assertName(entry.name);
   if(entry.isDirectory())assertArchivePath(entry.name,entry.name);
   if(sourceNames.has(normalized(entry.name)))throw new Error('Duplicate output file');
   sourceNames.add(normalized(entry.name));
   const name=entry.isDirectory()?entry.name+'.zip':entry.name;
   if(name.length>240)throw new Error('Output ZIP filename exceeds 240 characters');
   if(deliverableNames.has(normalized(name)))throw new Error('Duplicate output deliverable filename');
   deliverableNames.add(normalized(name));
   return {entry,name};
  });
  const result:TaskFile[]=[];
  const source:Array<{path:string;mode:number;size:number;sha256:string}>=[];
  const record=(entry:ArchiveEntry)=>source.push({path:entry.path,mode:entry.mode,size:entry.bytes.length,sha256:createHash('sha256').update(entry.bytes).digest('hex')});
  for(const {entry,name} of planned){
   signal?.throwIfAborted();
   const path=join(descriptorPath(root),entry.name);
   if(entry.isDirectory()){
    const directory=await openDirectory(path);
    try{
     const archive:ArchiveEntry[]=[];
     await readDirectory(directory,entry.name,archive,{bytes:0,entries:0},signal);
     for(const item of archive)record(item);
     result.push(taskFile(name,'application/zip',await createOutputZip(archive,MAX_FILE_BYTES)));
    }finally{await directory.close();}
   }else{
    if(entry.isSymbolicLink()||!entry.isFile())throw new Error('Output must be a regular file; symbolic links are forbidden');
    const file=await readFileBytes(path);record({path:entry.name,...file});
    result.push(taskFile(name,mime(name),file.bytes));
   }
  }
  signal?.throwIfAborted();
  source.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {files:taskFilesSchema.parse(result),source_sha256:createHash('sha256').update(JSON.stringify(source)).digest('hex')};
 });
}

function assertArchivePath(path:string,component:string):void{
 if(!component||component==='.'||component==='..'||component.includes(':')||/[/\\\u0000-\u001f\u007f-\u009f]/u.test(component)||/[. ]$/u.test(component))
  throw new Error('Invalid output archive path');
 if(path.length>MAX_ARCHIVE_PATH)throw new Error('Output archive path is too long');
}
interface ArchiveState {bytes:number;entries:number}
async function readDirectory(directory:FileHandle,prefix:string,output:ArchiveEntry[],state:ArchiveState,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();
 const entries=(await readdir(descriptorPath(directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
 if(entries.length===0)output.push({path:prefix+'/',bytes:Buffer.alloc(0),mode:0o40755});
 const seen=new Set<string>();
 for(const entry of entries){
  signal?.throwIfAborted();
  const childPath=prefix+'/'+entry.name;assertArchivePath(childPath,entry.name);
  if(seen.has(normalized(entry.name)))throw new Error('Duplicate output path');
  seen.add(normalized(entry.name));
  if(++state.entries>MAX_ARCHIVE_ENTRIES)throw new Error('Too many entries in output directory');
  const path=join(descriptorPath(directory),entry.name);
  if(entry.isDirectory()){
   const child=await openDirectory(path);
   try{await readDirectory(child,childPath,output,state,signal);}finally{await child.close();}
  }else{
   if(entry.isSymbolicLink()||!entry.isFile())throw new Error('Output must be a regular file; symbolic links are forbidden');
   const file=await readFileBytes(path,MAX_ARCHIVE_BYTES-state.bytes);
   state.bytes+=file.bytes.length;
   output.push({path:childPath,...file});
  }
 }
}

async function readFileBytes(path:string,maxBytes=MAX_FILE_BYTES):Promise<{bytes:Buffer;mode:number}>{
 let handle:FileHandle|undefined;
 try{
  handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=await handle.stat();
  if(!info.isFile()||info.nlink!==1)throw new Error('Output must be a regular file without hard links');
  if(info.size>maxBytes)throw new Error('Output file or directory exceeds 10 MiB');
  // Actual file size plus one byte to detect concurrent growth, not 10 MiB
  // retained for each tiny file in a project.
  const content=Buffer.alloc(info.size+1);let bytesRead=0;
  while(bytesRead<content.length){
   const chunk=await handle.read(content,bytesRead,content.length-bytesRead,bytesRead);
   if(chunk.bytesRead===0)break;
   bytesRead+=chunk.bytesRead;
  }
  const after=await handle.stat();
  if(bytesRead!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||after.nlink!==1)
   throw new Error('Output file changed during collection');
  return {bytes:content.subarray(0,bytesRead),mode:0o100644|(info.mode&0o111)};
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ELOOP')throw new Error('Output symbolic links are forbidden');
  throw error;
 }finally{await handle?.close();}
}
function taskFile(name:string,mimeType:string,bytes:Buffer):TaskFile{
 if(bytes.length>MAX_FILE_BYTES)throw new Error('Output file exceeds 10 MiB');
 return taskFileSchema.parse({name,mime_type:mimeType,content_base64:bytes.toString('base64')});
}
function mime(name:string):string{
 const ext=name.toLowerCase().split('.').pop();
 return ext==='zip'?'application/zip':ext==='json'?'application/json':ext==='md'?'text/markdown':ext==='txt'?'text/plain':'application/octet-stream';
}
