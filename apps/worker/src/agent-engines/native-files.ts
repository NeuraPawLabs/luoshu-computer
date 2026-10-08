import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,type FileHandle} from 'node:fs/promises';
import {isAbsolute,normalize,join} from 'node:path';
import type Database from 'better-sqlite3';
import {taskFilesSchema,nativeCodebaseReceiptsSchema,type NativeCodebaseReceipt,type TaskFile,type NativeDelivery} from '@luoshu/protocol';
import {sealNativeDelivery,verifyNativeDelivery} from '@luoshu/protocol/assistant-engine-files-hash';
import {withOutputRoot,collectOutputSnapshot,removeOwnedWorkspace} from '../files.js';
import type {NativeCheckTarget,NativeDeliveredCheck} from '@luoshu/protocol';

interface Identity {session_id:string;run_id:string;submission_id:string}
interface Input extends Identity {cwd:string;input_files:TaskFile[]}
interface Row extends Identity {cwd:string;input_sha256:string;state:'preparing'|'ready'|'cancelled';delivery_json:string|null}
export type NativeFileDelivery=NativeDelivery;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const descriptor=(handle:FileHandle)=>'/proc/self/fd/'+handle.fd;
const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
function id(value:string){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw Error('Invalid native file identity');return value;}

/** Run-local file intent and immutable output snapshot, independent of Task.
 * The caller supplies a trusted native terminal-state check, not a model claim. */
export class NativeRunFiles {
 private readonly preparing=new Map<string,Promise<{inputs:string;outputs:string}>>();
 private readonly collecting=new Map<string,Promise<NativeFileDelivery>>();
 constructor(private db:Database.Database,private terminal:(identity:Identity)=>boolean,private collectCodebases:(identity:Identity,assertCurrent:()=>void)=>Promise<NativeCodebaseReceipt[]>=async()=>[],private collectCommands:(identity:Identity)=>Promise<import('@luoshu/protocol').NativeCommandReceipt[]>=async()=>[],private collectChecks:(identity:Identity,outputSha:string,current:()=>void)=>Promise<{content:NativeCheckTarget[];checks:NativeDeliveredCheck[]}>=async(_i,sha)=>({content:[{kind:'outputs',sha256:sha}],checks:[]}),private collectDocuments:(identity:Identity,outputs:string,current:()=>void)=>Promise<void>=async()=>{}){db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_native_run_files(
   run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,submission_id TEXT NOT NULL UNIQUE,cwd TEXT NOT NULL,
   input_sha256 TEXT NOT NULL,state TEXT NOT NULL,delivery_json TEXT);`);}
 private row(run:string){return this.db.prepare('SELECT * FROM assistant_native_run_files WHERE run_id=?').get(run) as Row|undefined;}
 pending():Identity[]{return this.db.prepare("SELECT session_id,run_id,submission_id FROM assistant_native_run_files WHERE delivery_json IS NULL AND state!='cancelled'").all() as Identity[];}
 private settledSession(session:string){
  const rows=this.db.prepare('SELECT session_id,run_id,cwd,state,delivery_json FROM assistant_native_run_files WHERE session_id=?').all(session) as Array<{session_id:string;run_id:string;cwd:string;state:string;delivery_json:string|null}>;
  for(const row of rows){id(row.run_id);if(row.session_id!==session||!row.delivery_json&&row.state!=='cancelled'||this.preparing.has(row.run_id)||this.collecting.has(row.run_id))throw Error('Native owned file delivery is not settled');}
  return rows;
 }
 purgeSessionData(session:string):void{
  if(!this.db.inTransaction)throw Error('Native data purge requires the final close transaction');
  this.settledSession(session);
  this.db.prepare('DELETE FROM assistant_native_run_files WHERE session_id=?').run(session);
 }
 async cleanupSession(session:string,current:()=>void=()=>{}):Promise<void>{
  current();const rows=this.settledSession(session);
  for(const row of rows){current();await removeOwnedWorkspace(join(row.cwd,'runs',row.run_id),current);current();}
 }
 assertSubmissionAllowed(session:string,run:string,submission:string):void{
  const pending=this.db.prepare("SELECT run_id,submission_id FROM assistant_native_run_files WHERE session_id=? AND delivery_json IS NULL AND state!='cancelled'").all(session) as Array<{run_id:string;submission_id:string}>;
  if(pending.some(row=>row.run_id!==run||row.submission_id!==submission))throw Error('Native delivery is pending; collect the original result before another turn');
 }
 cached(session:string,run:string,submission:string):NativeFileDelivery|null{
  const row=this.row(id(run));if(!row)return null;
  if(row.session_id!==session||row.submission_id!==submission)throw Error('Native delivery scope identity mismatch');
  return row.delivery_json?verifyNativeDelivery(JSON.parse(row.delivery_json)):null;
 }
 activeCount():number{return(this.db.prepare(`SELECT COUNT(*) AS n FROM assistant_native_run_files f WHERE f.delivery_json IS NULL AND f.state!='cancelled' AND NOT EXISTS(SELECT 1 FROM codex_native_submissions s WHERE s.submission_id=f.submission_id AND s.status IN ('prepared','starting','running','stopping','unknown'))`).get() as {n:number}).n;}
 cancelPreparation(identity:Identity):void{
  const row=this.row(identity.run_id);if(!row)return;
  if(row.session_id!==identity.session_id||row.submission_id!==identity.submission_id||row.delivery_json)throw Error('Native file cancellation identity conflict');
  if(this.preparing.has(identity.run_id)||this.collecting.has(identity.run_id))throw Error('Native file work has not drained');
  this.db.prepare("UPDATE assistant_native_run_files SET state='cancelled' WHERE run_id=?").run(identity.run_id);
 }
 hasIntent(session:string,run:string,submission:string):boolean{const row=this.row(run);if(row&&(row.session_id!==session||row.submission_id!==submission))throw Error('Native file intent identity conflict');return Boolean(row);}
 preparationCancelled(session:string,run:string,submission:string):boolean{
  const row=this.row(run);if(!row)return true;
  if(row.session_id!==session||row.submission_id!==submission)throw Error('Native file inspection identity conflict');return row.state==='cancelled';
 }
 async fingerprint(identity:Identity,current:()=>void):Promise<string>{
  current();const row=this.row(identity.run_id);if(!row||row.state!=='ready'||row.session_id!==identity.session_id||row.submission_id!==identity.submission_id)throw Error('Native check output scope mismatch');
  const snapshot=await collectOutputSnapshot(join(row.cwd,'runs',row.run_id,'outputs'));current();return snapshot.source_sha256;
 }
 async prepare(raw:Input):Promise<{inputs:string;outputs:string}>{
  id(raw.run_id);id(raw.session_id);id(raw.submission_id);
  if(!isAbsolute(raw.cwd)||normalize(raw.cwd)!==raw.cwd)throw Error('Native workspace requires a normalized absolute directory');
  const files=taskFilesSchema.parse(raw.input_files),sha=digest(JSON.stringify(files)),prior=this.row(raw.run_id);
  if(prior?.state==='cancelled')throw Error('Native preparation was cancelled');
  if(prior&&(prior.session_id!==raw.session_id||prior.submission_id!==raw.submission_id||prior.cwd!==raw.cwd||prior.input_sha256!==sha))throw Error('Native file intent conflict');
  if(!prior)this.db.prepare("INSERT INTO assistant_native_run_files VALUES(?,?,?,?,?,'preparing',NULL)").run(raw.run_id,raw.session_id,raw.submission_id,raw.cwd,sha);
  const active=this.preparing.get(raw.run_id);if(active)return active;
  const promise=this.stage({...raw,input_files:files});this.preparing.set(raw.run_id,promise);
  try{return await promise;}finally{this.preparing.delete(raw.run_id);}
 }
 private async directory(parent:FileHandle,name:string):Promise<FileHandle>{
  const path=join(descriptor(parent),name);
  try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  try{return await open(path,flags);}catch{throw Error('Native workspace must be a real directory; links are forbidden');}
 }
 private async stage(input:Input){
  await withOutputRoot(input.cwd,async root=>{
   const handles:FileHandle[]=[];
   try{
    const runs=await this.directory(root,'runs');handles.push(runs);
    const run=await this.directory(runs,input.run_id);handles.push(run);
    const inputs=await this.directory(run,'inputs');handles.push(inputs);
    const outputs=await this.directory(run,'outputs');handles.push(outputs);
    for(const file of input.input_files){
     const bytes=Buffer.from(file.content_base64,'base64'),path=join(descriptor(inputs),file.name);let writer:FileHandle|undefined;
     try{writer=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
     catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
     if(writer){try{await writer.writeFile(bytes);await writer.sync();}finally{await writer.close();}}
     const reader=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
     try{
      const before=await reader.stat();if(!before.isFile()||before.nlink!==1||before.size!==bytes.length)throw Error('Native input changed or link conflict');
      const read=Buffer.alloc(bytes.length+1);let length=0;
      while(length<read.length){const part=await reader.read(read,length,read.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
      const after=await reader.stat();
      if(length!==bytes.length||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1||!read.subarray(0,length).equals(bytes))throw Error('Native input changed or content conflict');
     }finally{await reader.close();}
    }
    for(const directory of [...handles].reverse())await directory.sync();await root.sync();
   }finally{for(const handle of handles.reverse())await handle.close();}
  });
  this.db.prepare("UPDATE assistant_native_run_files SET state='ready' WHERE run_id=? AND submission_id=?").run(input.run_id,input.submission_id);
  return{inputs:join(input.cwd,'runs',input.run_id,'inputs'),outputs:join(input.cwd,'runs',input.run_id,'outputs')};
 }
 async collect(session:string,run:string,submission:string,assertCurrent:()=>void=()=>{}):Promise<NativeFileDelivery>{
  assertCurrent();
  const row=this.row(id(run));if(!row||row.session_id!==session||row.submission_id!==submission)throw Error('Native delivery scope identity mismatch');
  if(row.state!=='ready'||!this.terminal(row))throw Error('Native execution is active or terminal state is unknown');
  if(row.delivery_json)return verifyNativeDelivery(JSON.parse(row.delivery_json));
  const current=this.collecting.get(run);if(current)return current;
  const promise=this.snapshot(row,assertCurrent);this.collecting.set(run,promise);
  try{return await promise;}finally{this.collecting.delete(run);}
 }
 private async snapshot(row:Row,assertCurrent:()=>void):Promise<NativeFileDelivery>{
  assertCurrent();const codebases=nativeCodebaseReceiptsSchema.parse(await this.collectCodebases({session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id},assertCurrent));assertCurrent();
  const identity={session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id};
  const outputs=join(row.cwd,'runs',row.run_id,'outputs');await this.collectDocuments({session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id},outputs,assertCurrent);assertCurrent();
  const snapshot=await collectOutputSnapshot(outputs);const commands=await this.collectCommands(identity);assertCurrent();
  const evidence=await this.collectChecks(identity,snapshot.source_sha256,assertCurrent);assertCurrent();
  return this.db.transaction(()=>{
   assertCurrent();
   if(!this.terminal(row))throw Error('Native terminal state changed during collection');
   const prior=this.row(row.run_id);if(prior?.delivery_json)return verifyNativeDelivery(JSON.parse(prior.delivery_json));
   const result=sealNativeDelivery({session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id,delivery_id:randomUUID(),...snapshot,codebases,commands,...evidence});
   this.db.prepare('UPDATE assistant_native_run_files SET delivery_json=? WHERE run_id=? AND submission_id=?').run(JSON.stringify(result),row.run_id,row.submission_id);
   return result;
  })();
 }
}
