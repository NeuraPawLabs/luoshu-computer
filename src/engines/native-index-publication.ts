import type Database from 'better-sqlite3';
import {constants} from 'node:fs';
import {open,readFile,lstat,link,unlink,rename,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withOutputRoot} from '../runtime/files.js';

interface Row {git_dir:string;binding:string;directory:string;token:string;owner:string|null;anchor:string|null}
const processSchema=z.object({boot:z.string().uuid(),pid:z.number().int().min(2),start:z.string().regex(/^\d+$/),claim:z.string().uuid()}).strict();
const anchorSchema=z.object({dev:z.string(),ino:z.string(),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const flags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const conflict=()=>Error('Native Git index.lock ownership is unconfirmed');
function metadata<T>(schema:z.ZodType<T>,raw:string):T{try{return schema.parse(JSON.parse(raw));}catch{throw conflict();}}
async function processIdentity(pid:number){
 try{
  const raw=await readFile(`/proc/${pid}/stat`,'utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).trim().split(' ');
  if(!parts[0]||!/^\d+$/.test(parts[19]??''))throw conflict();
  return{start:parts[19]!,state:parts[0]!};
 }catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}
}
async function info(path:string){try{return await lstat(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function snapshot(handle:FileHandle){
 const before=await handle.stat({bigint:true});
 if(!before.isFile()||before.nlink<1n||before.nlink>2n)throw conflict();
 const sha=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0;
 for(;;){const part=await handle.read(buffer,0,buffer.length,size);if(!part.bytesRead)break;size+=part.bytesRead;sha.update(buffer.subarray(0,part.bytesRead));}
 const after=await handle.stat({bigint:true});
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||after.size!==BigInt(size)||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw conflict();
 return{dev:before.dev.toString(),ino:before.ino.toString(),size,sha256:sha.digest('hex')};
}

/** Worker-owned scoped index publication only. The journal and private hard
 * link anchor bind recovery to a particular inode/content, not just a PID.
 * Does not own locks written by arbitrary Agent Git commands. */
export class NativeIndexPublication {
 constructor(private readonly db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS native_index_publications(
  git_dir TEXT PRIMARY KEY,binding TEXT NOT NULL,directory TEXT NOT NULL,token TEXT NOT NULL,owner TEXT,anchor TEXT);`);}
 private row(path:string){return this.db.prepare('SELECT * FROM native_index_publications WHERE git_dir=?').get(path) as Row|undefined;}
 assertSessionSettled(session:string):void{
  if(this.db.prepare("SELECT 1 FROM native_index_publications WHERE json_extract(binding,'$.identity.session_id')=? LIMIT 1").get(session))throw Error('Native index publication is not settled');
 }
 async publish(gitDir:string,binding:string,indexFile:string,current:()=>void,publishRef:()=>Promise<void>):Promise<void>{
  current();const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),self=await processIdentity(process.pid);if(!self)throw conflict();
  const owner=JSON.stringify(processSchema.parse({boot,pid:process.pid,start:self.start,claim:randomUUID()}));
  await withOutputRoot(gitDir,async directory=>{
   const directoryInfo=await directory.stat({bigint:true}),directoryId=[directoryInfo.dev,directoryInfo.ino].join(':');
   const path=(name:string)=>join('/proc/self/fd/'+directory.fd,name),lock=path('index.lock');
   const previous=this.row(gitDir);
   if(previous){
    if(previous.binding!==binding||previous.directory!==directoryId||!z.string().uuid().safeParse(previous.token).success)throw conflict();
    if(previous.owner){
     const old=metadata(processSchema,previous.owner);
     const live=old.boot===boot?await processIdentity(old.pid):null;
     if(live?.start===old.start&&!['Z','X'].includes(live.state))throw Error('Native Git index.lock owner is still active');
    }
   }
   current();
   this.db.transaction(()=>{
    if(JSON.stringify(this.row(gitDir))!==JSON.stringify(previous))throw conflict();
    if(previous)this.db.prepare('UPDATE native_index_publications SET owner=? WHERE git_dir=?').run(owner,gitDir);
    else this.db.prepare('INSERT INTO native_index_publications VALUES(?,?,?,?,?,NULL)').run(gitDir,binding,directoryId,randomUUID(),owner);
   })();
   const owned=()=>{current();const row=this.row(gitDir);if(!row||row.owner!==owner||row.binding!==binding||row.directory!==directoryId)throw conflict();return row;};
   const validAnchor=async(row:Row)=>{
    const expected=metadata(anchorSchema,row.anchor!),anchorPath=path('.luoshu-index-'+row.token),entry=await info(anchorPath);
    if(!entry)return null;
    if(!entry.isFile()||entry.dev.toString()!==expected.dev||entry.ino.toString()!==expected.ino)throw conflict();
    const handle=await open(anchorPath,flags);
    try{if(JSON.stringify(await snapshot(handle))!==JSON.stringify(expected))throw conflict();}finally{await handle.close();}
    return{entry,anchorPath};
   };
   try{
    if(previous){
     const row=owned(),existing=await info(lock),anchor=row.anchor?await validAnchor(row):null;
     if(existing){
      if(!anchor||!existing.isFile()||existing.dev!==anchor.entry.dev||existing.ino!==anchor.entry.ino)throw conflict();
      owned();await unlink(lock);await directory.sync();
     }
     // An unpinned staging file is never adopted or deleted on recovery. It
     // cannot have been linked by this protocol and stays for workspace cleanup.
     if(anchor){owned();await unlink(anchor.anchorPath);await directory.sync();}
     owned();this.db.prepare('UPDATE native_index_publications SET token=?,anchor=NULL WHERE git_dir=? AND owner=?').run(randomUUID(),gitDir,owner);
    }
    owned();if(await info(lock))throw conflict();
    const row=owned(),anchorPath=path('.luoshu-index-'+row.token);
    const source=await open(indexFile,flags);let target:FileHandle|undefined;
    try{
     target=await open(anchorPath,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
     if(!(await source.stat()).isFile())throw conflict();
     const buffer=Buffer.alloc(64*1024);let offset=0;
     for(;;){const read=await source.read(buffer,0,buffer.length,offset);if(!read.bytesRead)break;let written=0;while(written<read.bytesRead){const part=await target.write(buffer,written,read.bytesRead-written,offset+written);if(!part.bytesWritten)throw conflict();written+=part.bytesWritten;}offset+=read.bytesRead;}
     await target.sync();await directory.sync();owned();
     const pinned=JSON.stringify(await snapshot(target));owned();
     this.db.prepare('UPDATE native_index_publications SET anchor=? WHERE git_dir=? AND owner=?').run(pinned,gitDir,owner);
    }finally{await source.close();await target?.close();}
    owned();await link(anchorPath,lock);await directory.sync();
    const exactLock=async()=>{
     const row=owned(),anchor=await validAnchor(row),entry=await info(lock);
     if(!anchor||!entry?.isFile()||entry.dev!==anchor.entry.dev||entry.ino!==anchor.entry.ino||entry.nlink!==2n)throw conflict();
     owned();
    };
    await exactLock();await publishRef();await exactLock();
    await rename(lock,path('index'));await directory.sync();owned();
    await unlink(anchorPath);await directory.sync();owned();
    this.db.prepare('DELETE FROM native_index_publications WHERE git_dir=? AND owner=?').run(gitDir,owner);
   }finally{
    // Keep recovery evidence and any lock in place on failure. A subsequent
    // attempt can claim the released row; SIGKILL leaves the exact PID identity.
    this.db.prepare('UPDATE native_index_publications SET owner=NULL WHERE git_dir=? AND owner=?').run(gitDir,owner);
   }
  });
 }
}
