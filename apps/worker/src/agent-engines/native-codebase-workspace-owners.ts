import type Database from 'better-sqlite3';
import {constants} from 'node:fs';
import {mkdir,open,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {withOutputRoot,removeOwnedWorkspace,type OwnedDirectoryIdentity} from '../files.js';

export interface NativeCodebaseWorkspaceIdentity {session_id:string;run_id:string;submission_id:string}
interface Row extends NativeCodebaseWorkspaceIdentity {cwd:string;owner_json:string|null;state:'reserved'|'owned'|'removed'}
const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const identitySchema=z.object({dev:z.string().regex(/^\d+$/u),ino:z.string().regex(/^\d+$/u),parent_dev:z.string().regex(/^\d+$/u),parent_ino:z.string().regex(/^\d+$/u)}).strict();

/** Creator-owned roots for native Codebase checkout Runs. A cancellation
 * tombstone or a matching path is never enough to adopt a directory. */
export class NativeCodebaseWorkspaceOwners {
 constructor(private readonly db:Database.Database,private readonly stateDir:string){db.exec(`CREATE TABLE IF NOT EXISTS native_codebase_workspace_owners(
  run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,submission_id TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL UNIQUE,owner_json TEXT,state TEXT NOT NULL);`);}
 private row(run_id:string){return this.db.prepare('SELECT * FROM native_codebase_workspace_owners WHERE run_id=?').get(run_id) as Row|undefined;}
 private async parent(create=false){
  const root=await realpath(this.stateDir),runs=join(root,'runs');
  if(create)await mkdir(runs,{recursive:true,mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
  return runs;
 }
 private expected(input:NativeCodebaseWorkspaceIdentity){id.parse(input.run_id);id.parse(input.session_id);id.parse(input.submission_id);return input;}
 async prepare(input:NativeCodebaseWorkspaceIdentity):Promise<string>{
  this.expected(input);const existing=this.row(input.run_id),runs=await this.parent(true),cwd=join(runs,input.run_id);
  if(existing){if(existing.session_id!==input.session_id||existing.submission_id!==input.submission_id||existing.cwd!==cwd)throw Error('Native Codebase workspace ownership binding changed');if(existing.state!=='owned'||!existing.owner_json)throw Error('Native Codebase workspace ownership is unresolved');await this.verify(existing);return cwd;}
  const other=this.db.prepare('SELECT run_id FROM native_codebase_workspace_owners WHERE cwd=? OR submission_id=?').get(cwd,input.submission_id) as {run_id:string}|undefined;if(other)throw Error('Native Codebase workspace already belongs to another Run');
  const parentReal=await realpath(runs);const result=await withOutputRoot(parentReal,async parent=>{
   const parentStat=await parent.stat({bigint:true});
   this.db.prepare("INSERT INTO native_codebase_workspace_owners(run_id,session_id,submission_id,cwd,owner_json,state) VALUES(?,?,?,?,NULL,'reserved')").run(input.run_id,input.session_id,input.submission_id,cwd);
   const path=join('/proc/self/fd/'+parent.fd,input.run_id);
   try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('Native Codebase partial workspace ownership is unknown for existing directory');throw error;}
   const child=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const childStat=await child.stat({bigint:true});if(childStat.dev!==parentStat.dev)throw Error('Native Codebase workspace crosses device boundary');
    const owner:OwnedDirectoryIdentity={dev:String(childStat.dev),ino:String(childStat.ino),parent_dev:String(parentStat.dev),parent_ino:String(parentStat.ino)};
    await child.sync();await parent.sync();this.db.prepare("UPDATE native_codebase_workspace_owners SET owner_json=?,state='owned' WHERE run_id=? AND state='reserved'").run(JSON.stringify(owner),input.run_id);
    await this.verify(this.row(input.run_id)!);return cwd;
   }finally{await child.close();}
  });
  return result;
 }
 private async verify(row:Row,allowMissing=false,requireAbsent=false):Promise<void>{
  const runs=await this.parent(),owner=identitySchema.parse(JSON.parse(row.owner_json??'null'));
  if(row.cwd!==join(runs,id.parse(row.run_id)))throw Error('Native Codebase workspace owner path changed');
  await withOutputRoot(runs,async parent=>{
   const parentStat=await parent.stat({bigint:true});if(String(parentStat.dev)!==owner.parent_dev||String(parentStat.ino)!==owner.parent_ino)throw Error('Native Codebase workspace parent identity changed');
   const path=join('/proc/self/fd/'+parent.fd,row.run_id);let stat;
   try{stat=await lstat(path,{bigint:true});}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   if(requireAbsent)throw Error('Removed Native Codebase workspace is still present');
   if(!stat.isDirectory()||stat.isSymbolicLink()||String(stat.dev)!==owner.dev||String(stat.ino)!==owner.ino)throw Error('Native Codebase workspace directory identity changed');
  });
 }
 async assertOwned(input:NativeCodebaseWorkspaceIdentity):Promise<string>{
  this.expected(input);const row=this.row(input.run_id);if(!row||row.session_id!==input.session_id||row.submission_id!==input.submission_id||row.state!=='owned'||!row.owner_json)throw Error('Native Codebase workspace ownership is unresolved');await this.verify(row);return row.cwd;
 }
 async cleanup(input:NativeCodebaseWorkspaceIdentity,current:()=>void=()=>{}):Promise<void>{
  this.expected(input);current();const row=this.row(input.run_id);if(!row||row.session_id!==input.session_id||row.submission_id!==input.submission_id)throw Error('Native Codebase workspace ownership is missing');
  if(row.cwd!==join(await this.parent(),input.run_id))throw Error('Native Codebase workspace owner path changed');current();
  const original=JSON.stringify(row),check=()=>{current();if(JSON.stringify(this.row(input.run_id))!==original)throw Error('Native Codebase workspace ownership changed during cleanup');};
  if(row.state==='owned'&&row.owner_json)await removeOwnedWorkspace(row.cwd,check,identitySchema.parse(JSON.parse(row.owner_json)));
  else if(row.state==='removed'&&row.owner_json)await this.verify(row,true,true);
  else{const runs=await this.parent();await withOutputRoot(runs,async parent=>{try{await lstat(join('/proc/self/fd/'+parent.fd,input.run_id));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw Error('Native Codebase workspace ownership is unresolved');});}
  check();this.db.prepare("UPDATE native_codebase_workspace_owners SET state='removed' WHERE run_id=?").run(input.run_id);
 }
 purge(input:NativeCodebaseWorkspaceIdentity):void{
  this.expected(input);if(!this.db.inTransaction)throw Error('Native Codebase workspace purge requires the final close transaction');const row=this.row(input.run_id);if(row&&(row.session_id!==input.session_id||row.submission_id!==input.submission_id||row.state!=='removed'))throw Error('Native Codebase workspace removal is not confirmed');this.db.prepare('DELETE FROM native_codebase_workspace_owners WHERE run_id=?').run(input.run_id);
 }
}
