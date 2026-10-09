import type Database from 'better-sqlite3';
import {isDeepStrictEqual} from 'node:util';
import {mkdir,realpath,lstat,open,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {codebaseAssignmentSchema,nativeCodebaseSpecsSchema,nativeCodebaseReceiptsSchema,type NativeCodebaseSpec,type CodebaseAssignment,type NativeCodebaseReceipt} from '../protocol/index.js';
export {nativeCodebaseSpecsSchema,type NativeCodebaseSpec} from '../protocol/index.js';
import {resolveCodebaseAssignments,prepareCodebaseWorkspace,existingCodebaseWorkspace,collectCodebaseResults,type CodebaseWorkspace} from '../runtime/codebase-workspace.js';
import {containsDirectory} from '../development/root-policy.js';
import {NativeCodebaseCommits} from './native-codebase-commit.js';
import {NativeCodebaseWorkspaceOwners,type NativeCodebaseWorkspaceIdentity} from './native-codebase-workspace-owners.js';
import {withOutputRoot} from '../runtime/files.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
interface Identity {session_id:string;run_id:string;submission_id:string}
interface Input extends Identity {codebases:NativeCodebaseSpec[]}
interface Row extends Identity {specs_json:string;assignments_json:string|null;state:'resolving'|'pinned'|'ready'}
export interface PreparedNativeCodebases {assignments:CodebaseAssignment[];workspace:CodebaseWorkspace;read:string[];write:string[]}
const MAX_DOCUMENT_FILES=32,MAX_DOCUMENT_BYTES=10*1024*1024;
const descriptor=(handle:FileHandle)=>'/proc/self/fd/'+handle.fd;
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
function safeParts(value:string):string[]{const parts=value.split(/[\\/]/u).filter(Boolean);if(!parts.length||parts.some(part=>part==='.'||part==='..'||part.includes('\0')))throw Error('Invalid Native documentation path');return parts;}
async function openChild(parent:FileHandle,name:string,create:boolean):Promise<FileHandle>{const path=`${descriptor(parent)}/${name}`;if(create)await mkdir(path,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});return open(path,directoryFlags);}
async function readSafeFile(root:string,parts:string[]):Promise<Buffer>{return withOutputRoot(root,async base=>{const handles:FileHandle[]=[];try{let parent=base;for(const part of parts.slice(0,-1)){parent=await openChild(parent,part,false);handles.push(parent);}const file=await open(`${descriptor(parent)}/${parts.at(-1)!}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.size>MAX_DOCUMENT_BYTES)throw Error('Native documentation file is invalid');return await file.readFile();}finally{await file.close();}}finally{for(const handle of handles.reverse())await handle.close();}});}
async function writeSafeFile(root:string,parts:string[],bytes:Buffer):Promise<void>{return withOutputRoot(root,async base=>{const handles:FileHandle[]=[];try{let parent=base;for(const part of parts.slice(0,-1)){parent=await openChild(parent,part,true);handles.push(parent);}const path=`${descriptor(parent)}/${parts.at(-1)!}`;try{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const prior=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!(await prior.readFile()).equals(bytes))throw Error('Native documentation delivery conflict');}finally{await prior.close();}}}finally{for(const handle of handles.reverse())await handle.close();}});}

/** Durable preparation only. This does not grant an Agent filesystem access;
 * callers must apply actual native permissions before passing these paths. */
export class NativeCodebases {
 private readonly preparing=new Map<string,Promise<PreparedNativeCodebases>>();
 private readonly controllers=new Map<string,AbortController>();
 private readonly collecting=new Map<string,number>();
 private readonly commits:NativeCodebaseCommits;
 private readonly owners:NativeCodebaseWorkspaceOwners;
 constructor(private db:Database.Database,private options:{stateDir:string;allowedRoots:()=>string[];gitSshCommand?:string;isPreparationCancelled?:(identity:Identity)=>boolean}){
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_native_codebases(
   run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,submission_id TEXT NOT NULL UNIQUE,
   specs_json TEXT NOT NULL,assignments_json TEXT,state TEXT NOT NULL)`);
  this.commits=new NativeCodebaseCommits(db);this.owners=new NativeCodebaseWorkspaceOwners(db,options.stateDir);
 }
 private row(identity:Identity):Row|undefined{
  id.parse(identity.run_id);id.parse(identity.session_id);id.parse(identity.submission_id);
  const row=this.db.prepare('SELECT * FROM assistant_native_codebases WHERE run_id=?').get(identity.run_id) as Row|undefined;
  if(row&&(row.session_id!==identity.session_id||row.submission_id!==identity.submission_id))throw Error('Native Codebase identity conflict');return row;
 }
 private async stateRoot(){
  const configured=this.options.stateDir;
  if(!isAbsolute(configured)||resolve(configured)!==configured||await realpath(configured)!==configured)throw Error('Native Codebase state path must be canonical');
  const runs=resolve(configured,'runs');await mkdir(runs,{recursive:false,mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  if(await realpath(runs)!==runs)throw Error('Native Codebase runs path must be canonical');return configured;
 }
 private async sources(specs:NativeCodebaseSpec[],assertCurrent:()=>void){
  for(const spec of specs){
   assertCurrent();
   if(spec.source.kind==='local'){
    const path=spec.source.path;
    if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path)throw Error('Native Codebase source path must be canonical');
    assertCurrent();const roots=await Promise.all(this.options.allowedRoots().map(p=>realpath(p)));assertCurrent();
    if(!roots.some(root=>containsDirectory(root,path)))throw Error('Native Codebase source is outside authorized roots');
   }else{
    let valid=false;
    try{const url=new URL(spec.source.repository_url);valid=['https:','ssh:'].includes(url.protocol)&&Boolean(url.hostname)&&!url.password&&(url.protocol!=='https:'||!url.username);}catch{valid=/^git@[a-zA-Z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(spec.source.repository_url);}
    if(!valid)throw Error('Invalid native Codebase repository protocol or credentials');
   }
  }
 }
 async prepare(input:Input,assertCurrent:()=>void=()=>{}):Promise<PreparedNativeCodebases>{
  assertCurrent();const prior=this.row(input),specs=nativeCodebaseSpecsSchema.parse(input.codebases).sort((a,b)=>a.id.localeCompare(b.id)),json=JSON.stringify(specs);
  if(prior&&prior.specs_json!==json)throw Error('Native Codebase specification conflict');
  if(!prior)this.db.prepare("INSERT INTO assistant_native_codebases VALUES(?,?,?,?,NULL,'resolving')").run(input.run_id,input.session_id,input.submission_id,json);
  const active=this.preparing.get(input.run_id);if(active){const result=await active;assertCurrent();return result;}
  const controller=new AbortController();this.controllers.set(input.run_id,controller);
  const current=()=>{controller.signal.throwIfAborted();assertCurrent();};
  const work=this.prepareOnce(input,specs,current,controller.signal);this.preparing.set(input.run_id,work);
  try{return await work;}finally{if(this.preparing.get(input.run_id)===work){this.preparing.delete(input.run_id);this.controllers.delete(input.run_id);}}
 }
 async cancel(identity:Identity):Promise<void>{
  this.row(identity);this.controllers.get(identity.run_id)?.abort(new Error('Native Codebase preparation cancelled'));
  await this.preparing.get(identity.run_id)?.catch(()=>undefined);
 }
 private settledSession(session_id:string){
  this.commits.assertSessionSettled(session_id);
  const rows=this.db.prepare('SELECT session_id,run_id,submission_id,assignments_json,state FROM assistant_native_codebases WHERE session_id=?').all(session_id) as Array<{session_id:string;run_id:string;submission_id:string;assignments_json:string|null;state:string}>;
  for(const row of rows){
   id.parse(row.run_id);
   const identity={session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id};
   const cancelled=row.session_id===session_id&&Boolean(this.options.isPreparationCancelled?.(identity));
   if(row.session_id!==session_id||!row.assignments_json||(!cancelled&&row.state!=='ready')||this.preparing.has(row.run_id)||this.collecting.has(row.run_id))throw Error('Native Codebase workspace is not settled');
  }
  return rows;
 }
 purgeSessionData(session_id:string):void{
  if(!this.db.inTransaction)throw Error('Native data purge requires the final close transaction');
  this.settledSession(session_id);this.commits.purgeSessionData(session_id);
  const rows=this.db.prepare('SELECT run_id,session_id,submission_id FROM assistant_native_codebases WHERE session_id=?').all(session_id) as NativeCodebaseWorkspaceIdentity[];
  for(const row of rows)this.owners.purge(row);
  this.db.prepare('DELETE FROM assistant_native_codebases WHERE session_id=?').run(session_id);
 }
 async cleanupSession(session_id:string,current:()=>void=()=>{}):Promise<void>{
  current();const state=await this.stateRoot();current();const rows=this.settledSession(session_id);await this.assertNoForeignGitLocks(state,rows,current);
  for(const row of rows){current();await this.owners.cleanup({session_id:row.session_id,run_id:row.run_id,submission_id:row.submission_id},current);current();}
 }
 private async assertNoForeignGitLocks(state:string,rows:Array<{session_id:string;run_id:string;submission_id:string;assignments_json:string|null;state:string}>,current:()=>void):Promise<void>{
  for(const row of rows){
   current();if(!row.assignments_json)continue;let assignments:CodebaseAssignment[];try{assignments=z.array(codebaseAssignmentSchema).parse(JSON.parse(row.assignments_json));}catch{throw Error('Native Codebase assignment ownership is invalid');}
   const root=resolve(state,'runs',row.run_id);
   for(const assignment of assignments){
    current();const repository=resolve(root,assignment.access_mode==='write'?'targets':'references',assignment.alias),lock=resolve(repository,'.git','index.lock');
    try{const info=await lstat(lock);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Native Codebase Git lock identity is invalid');throw Error('Native Codebase Git index.lock is present; cleanup is blocked');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   }
  }
 }
 private async prepareOnce(identity:Identity,specs:NativeCodebaseSpec[],assertCurrent:()=>void,signal:AbortSignal){
  const state=await this.stateRoot();assertCurrent();await this.sources(specs,assertCurrent);assertCurrent();
  let row=this.row(identity)!;
  if(!row.assignments_json){
   const assignments=await resolveCodebaseAssignments({codebases:specs.map(s=>({...s,branch:s.access_mode==='write'?`luoshu/feature/${identity.run_id.slice(0,48)}-${s.alias.slice(0,60)}`:null})),allowedRoots:this.options.allowedRoots(),gitSshCommand:this.options.gitSshCommand,signal});
   assertCurrent();await this.sources(specs,assertCurrent);assertCurrent();
   this.db.transaction(()=>{const current=this.row(identity)!;if(current.assignments_json&&!isDeepStrictEqual(JSON.parse(current.assignments_json),assignments))throw Error('Native Codebase resolved pin conflict');if(!current.assignments_json)this.db.prepare("UPDATE assistant_native_codebases SET assignments_json=?,state='pinned' WHERE run_id=?").run(JSON.stringify(assignments),identity.run_id);})();
   row=this.row(identity)!;
  }
  const assignments=z.array(codebaseAssignmentSchema).parse(JSON.parse(row.assignments_json!));
  if(row.state!=='ready'){await this.owners.prepare(identity);await this.owners.assertOwned(identity);assertCurrent();await prepareCodebaseWorkspace({stateDir:state,workspaceId:identity.run_id,codebases:assignments,allowedRoots:this.options.allowedRoots(),gitSshCommand:this.options.gitSshCommand,signal,ownedRoot:true});await this.owners.assertOwned(identity);}
  assertCurrent();await this.sources(specs,assertCurrent);assertCurrent();
  const workspace=await existingCodebaseWorkspace(state,identity.run_id,assignments);assertCurrent();
  this.db.prepare("UPDATE assistant_native_codebases SET state='ready' WHERE run_id=?").run(identity.run_id);
  return{assignments,workspace,read:workspace.codebases.filter(c=>c.access_mode==='read').map(c=>c.checkout_path),write:workspace.codebases.filter(c=>c.access_mode==='write').map(c=>c.checkout_path)};
 }
 async prepared(identity:Identity,assertCurrent:()=>void=()=>{}):Promise<PreparedNativeCodebases>{
  assertCurrent();const row=this.row(identity);if(!row?.assignments_json||row.state!=='ready')throw Error('Native Codebase preparation is incomplete');
  const specs=nativeCodebaseSpecsSchema.parse(JSON.parse(row.specs_json));await this.sources(specs,assertCurrent);assertCurrent();
  const assignments=z.array(codebaseAssignmentSchema).parse(JSON.parse(row.assignments_json)),state=await this.stateRoot();assertCurrent();
  const workspace=await existingCodebaseWorkspace(state,identity.run_id,assignments);assertCurrent();
  return{assignments,workspace,read:workspace.codebases.filter(c=>c.access_mode==='read').map(c=>c.checkout_path),write:workspace.codebases.filter(c=>c.access_mode==='write').map(c=>c.checkout_path)};
 }
 async collect(identity:Identity,readIsolationEnforced:boolean,assertCurrent:()=>void=()=>{}):Promise<NativeCodebaseReceipt[]>{
  this.row(identity);this.collecting.set(identity.run_id,(this.collecting.get(identity.run_id)??0)+1);
  try{return await this.collectOnce(identity,readIsolationEnforced,assertCurrent);}
  finally{const remaining=this.collecting.get(identity.run_id)!-1;if(remaining)this.collecting.set(identity.run_id,remaining);else this.collecting.delete(identity.run_id);}
 }
 async collectDocumentation(identity:Identity,outputs:string,assertCurrent:()=>void=()=>{}):Promise<void>{
  this.collecting.set(identity.run_id,(this.collecting.get(identity.run_id)??0)+1);
  try{
   const row=this.row(identity);if(!row)return;if(!row.assignments_json||row.state!=='ready')throw Error('Native Codebase preparation is incomplete');
   const assignments=z.array(codebaseAssignmentSchema).parse(JSON.parse(row.assignments_json)),workspace=await existingCodebaseWorkspace(await this.stateRoot(),identity.run_id,assignments),results=await collectCodebaseResults(workspace,assignments);let count=0,total=0;
   for(const result of results){
   assertCurrent();const assignment=assignments.find(item=>item.id===result.codebase_id),prepared=workspace.codebases.find(item=>item.id===result.codebase_id);if(!assignment||!prepared||result.result==='unchanged'||assignment.access_mode!=='write')continue;
   for(const changed of result.changed_paths){
    if(!/^(?:docs[\\/]).+\\.(?:md|mdx)$/iu.test(changed))continue;
     const parts=safeParts(changed),bytes=await readSafeFile(prepared.checkout_path,parts);
     if(++count>MAX_DOCUMENT_FILES||total+bytes.length>MAX_DOCUMENT_BYTES)throw Error('Native documentation collection exceeds limits');total+=bytes.length;
     await writeSafeFile(outputs,['documents',assignment.alias,...parts],bytes);
   }
  }
  }finally{const remaining=(this.collecting.get(identity.run_id)??1)-1;if(remaining)this.collecting.set(identity.run_id,remaining);else this.collecting.delete(identity.run_id);}
 }
 private async collectOnce(identity:Identity,readIsolationEnforced:boolean,assertCurrent:()=>void):Promise<NativeCodebaseReceipt[]>{
  assertCurrent();const row=this.row(identity);if(!row?.assignments_json||row.state!=='ready')throw Error('Native Codebase preparation is incomplete');
  const specs=nativeCodebaseSpecsSchema.parse(JSON.parse(row.specs_json));await this.sources(specs,assertCurrent);assertCurrent();
  const assignments=z.array(codebaseAssignmentSchema).parse(JSON.parse(row.assignments_json));
  if(assignments.some(c=>c.access_mode==='read')&&!readIsolationEnforced)throw Error('Native Codebase read isolation has not been enforced');
  const state=await this.stateRoot();assertCurrent();const workspace=await existingCodebaseWorkspace(state,identity.run_id,assignments);assertCurrent();
  const scoped=assignments.filter(a=>a.access_mode==='write'&&a.root_path!=='.');
  const scopedResults=[];
  for(const assignment of scoped)scopedResults.push(await this.commits.collect(identity,assignment,workspace.codebases.find(c=>c.id===assignment.id)!,assertCurrent));
  const results=await collectCodebaseResults(workspace,assignments.filter(a=>!scoped.includes(a)));assertCurrent();
  await this.sources(specs,assertCurrent);assertCurrent();
  return nativeCodebaseReceiptsSchema.parse([...results.map(r=>({...r,base_commit:assignments.find(a=>a.id===r.codebase_id)!.base_commit})),...scopedResults]);
 }
}
