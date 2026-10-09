import type Database from 'better-sqlite3';
import {constants} from 'node:fs';
import {mkdir,open,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {withOutputRoot,removeOwnedWorkspace,type OwnedDirectoryIdentity} from '../runtime/files.js';

interface Row {session_key:string;workspace_id:string;cwd:string;owner_json:string|null;state:'reserved'|'owned'|'removed'}
const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const digits=z.string().regex(/^\d+$/u);
const identitySchema=z.object({dev:digits,ino:digits,parent_dev:digits,parent_ino:digits}).strict();

/** Creator-owned session roots, not adoption of arbitrary existing folders.
 * No Agent receives a path before its created directory identity is pinned. */
export class NativeWorkspaceRoots {
 private readonly creating=new Map<string,Promise<string>>();
 constructor(private db:Database.Database,private stateDir:string){db.exec(`CREATE TABLE IF NOT EXISTS native_workspace_owners(
  session_key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL UNIQUE,cwd TEXT NOT NULL UNIQUE,
  owner_json TEXT,state TEXT NOT NULL);`);}
 private row(session:string){return this.db.prepare('SELECT * FROM native_workspace_owners WHERE session_key=?').get(session) as Row|undefined;}
 private async parent(){return join(await realpath(this.stateDir),'assistant-engine-workspaces');}
 async prepare(workspace:string,session:string):Promise<string>{
  id.parse(workspace);id.parse(session);
  const prior=this.creating.get(session);if(prior){await prior;return this.prepare(workspace,session);}
  const work=this.create(workspace,session);this.creating.set(session,work);
  try{return await work;}finally{if(this.creating.get(session)===work)this.creating.delete(session);}
 }
 private async create(workspace:string,session:string):Promise<string>{
  const parent=await this.parent(),cwd=join(parent,workspace);
  await mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  return withOutputRoot(parent,async directory=>{
   const prior=this.row(session),other=this.db.prepare('SELECT session_key FROM native_workspace_owners WHERE workspace_id=? OR cwd=?').get(workspace,cwd) as {session_key:string}|undefined;
   if(other&&other.session_key!==session)throw Error('Native workspace already belongs to another session');
   if(prior){
    if(prior.cwd!==cwd||prior.workspace_id!==workspace)throw Error('Native workspace binding changed');
    if(prior.state!=='owned'||!prior.owner_json)throw Error('Native workspace creation or removal remains unresolved');
    await this.verify(prior);return cwd;
   }
   this.db.prepare("INSERT INTO native_workspace_owners VALUES(?,?,?,NULL,'reserved')").run(session,workspace,cwd);
   const path=join('/proc/self/fd/'+directory.fd,workspace);
   // EEXIST is never authority to adopt an unknown folder, even if empty.
   try{await mkdir(path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('Native workspace ownership is unknown for existing directory');throw e;}
   const child=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const p=await directory.stat({bigint:true}),c=await child.stat({bigint:true});
    if(p.dev!==c.dev)throw Error('Native workspace crosses device boundary');
    const owner:OwnedDirectoryIdentity={dev:String(c.dev),ino:String(c.ino),parent_dev:String(p.dev),parent_ino:String(p.ino)};
    await child.sync();await directory.sync();
    this.db.prepare("UPDATE native_workspace_owners SET owner_json=?,state='owned' WHERE session_key=? AND state='reserved'").run(JSON.stringify(owner),session);
    await this.verify(this.row(session)!);return cwd;
   }finally{await child.close();}
  });
 }
 private async verify(row:Row,allowMissing=false):Promise<void>{
  const parent=await this.parent();
  if(row.cwd!==join(parent,id.parse(row.workspace_id)))throw Error('Native workspace owner path changed');
  const owner=identitySchema.parse(JSON.parse(row.owner_json!));
  await withOutputRoot(parent,async directory=>{
   const p=await directory.stat({bigint:true}),path=join('/proc/self/fd/'+directory.fd,row.workspace_id);
   if(String(p.dev)!==owner.parent_dev||String(p.ino)!==owner.parent_ino)throw Error('Native workspace parent identity changed');
   let c;try{c=await lstat(path,{bigint:true});}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   if(!c.isDirectory()||c.isSymbolicLink()||String(c.dev)!==owner.dev||String(c.ino)!==owner.ino)throw Error('Native workspace directory identity changed');
  });
 }
 async cleanup(session:string,cwd:string|undefined,current:()=>void):Promise<void>{
  current();id.parse(session);if(this.creating.has(session))throw Error('Native workspace preparation is not settled');
  const row=this.row(session);if(!row){if(cwd)throw Error('Native workspace ownership missing');return;}
  const parent=await this.parent();current();
  if(row.cwd!==join(parent,id.parse(row.workspace_id))||cwd!==undefined&&cwd!==row.cwd)throw Error('Native workspace owner path changed');
  const original=JSON.stringify(row),check=()=>{current();if(JSON.stringify(this.row(session))!==original)throw Error('Native workspace ownership changed during cleanup');};
  if((row.state==='owned'||row.state==='removed')&&row.owner_json){
   if(row.state==='owned')await removeOwnedWorkspace(row.cwd,check,identitySchema.parse(JSON.parse(row.owner_json)));else await this.verify(row,true);check();
  }else{
   // A creator crash before pinning is not ownership proof. Missing is safe
   // to forget after caller quiescence; an existing unpinned root is retained.
   await withOutputRoot(parent,async directory=>{
    try{await lstat(join('/proc/self/fd/'+directory.fd,row.workspace_id));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    throw Error('Native workspace ownership or removed state is unresolved');
   });check();
  }
  this.db.prepare("UPDATE native_workspace_owners SET state='removed' WHERE session_key=?").run(session);
 }
 async assertOwned(session:string,cwd:string|undefined,current:()=>void):Promise<void>{
  current();const row=this.row(session);if(!row||!['owned','removed'].includes(row.state)||!row.owner_json)throw Error('Native workspace ownership is unresolved');
  if(cwd!==undefined&&cwd!==row.cwd)throw Error('Native workspace owner path changed');await this.verify(row,true);current();
 }
 purge(session:string):void{
  if(!this.db.inTransaction)throw Error('Native workspace purge requires final close transaction');
  const row=this.row(session);if(row&&row.state!=='removed')throw Error('Native workspace removal is not confirmed');
  this.db.prepare('DELETE FROM native_workspace_owners WHERE session_key=?').run(session);
 }
}
