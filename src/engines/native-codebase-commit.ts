import type Database from 'better-sqlite3';
import {constants} from 'node:fs';
import {mkdtemp,open,rm,realpath,lstat,readlink} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import type {CodebaseAssignment} from '../protocol/index.js';
import {codebaseExecutionResultSchema} from '../protocol/index.js';
import type {PreparedCodebase} from '../runtime/codebase-workspace.js';
import {runGitCommand} from '../runtime/git-command.js';
import {withOutputRoot} from '../runtime/files.js';
import {NativeIndexPublication} from './native-index-publication.js';

interface Identity {run_id:string;session_id:string;submission_id:string}
interface Receipt {identity_json:string;tree:string;head:string|null;created_at:number}
const paths=(raw:string)=>raw.split('\0').filter(Boolean);
async function fileBytes(repo:string,path:string,allowLink=false):Promise<{bytes:Buffer;mode:string}|null>{
 try{return await withOutputRoot(dirname(join(repo,path)),async parent=>{
  const location='/proc/self/fd/'+parent.fd+'/'+basename(path),info=await lstat(location);
  if(allowLink&&info.isSymbolicLink())return{bytes:Buffer.from(await readlink(location)),mode:'120000'};
  const handle=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await handle.stat();if(!before.isFile()||before.nlink!==1)throw Error('Native commit requires regular unlinked files');
   const bytes=await handle.readFile(),after=await handle.stat();
   if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1)throw Error('Native commit file changed during collection');
   return{bytes,mode:before.mode&0o111?'100755':'100644'};
  }finally{await handle.close();}
 });}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}

/** Delivery-only commit for a scoped subtree. The Agent never receives the
 * parent repository or object database, and Git hooks/clean filters never run. */
export class NativeCodebaseCommits {
 private readonly publications:NativeIndexPublication;
 constructor(private db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS native_codebase_commits(
  run_id TEXT NOT NULL,codebase_id TEXT NOT NULL,identity_json TEXT NOT NULL,tree TEXT NOT NULL,head TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,codebase_id));`);this.publications=new NativeIndexPublication(db);}
 assertSessionSettled(session:string):void{this.publications.assertSessionSettled(session);}
 purgeSessionData(session:string):void{
  if(!this.db.inTransaction)throw Error('Native data purge requires the final close transaction');
  this.assertSessionSettled(session);
  this.db.prepare("DELETE FROM native_codebase_commits WHERE json_extract(identity_json,'$.identity.session_id')=?").run(session);
 }
 async collect(identity:Identity,assignment:CodebaseAssignment,prepared:PreparedCodebase,assertCurrent:()=>void){
  assertCurrent();
  if(assignment.access_mode!=='write'||assignment.root_path==='.'||!assignment.branch)throw Error('Scoped commit requires a write subdirectory');
  const repo=prepared.repository_path,root=prepared.checkout_path,prefix=assignment.root_path+'/',ref='refs/heads/'+assignment.branch;
  if(await realpath(repo)!==repo||await realpath(root)!==root||await realpath(join(repo,'.git'))!==join(repo,'.git'))throw Error('Native commit paths must be canonical');
  const git=async(args:string[],extra:Partial<Parameters<typeof runGitCommand>[1]>={})=>{assertCurrent();const result=await runGitCommand(args,{cwd:repo,isolated:true,...extra});assertCurrent();return result;};
  const key=JSON.stringify({identity,assignment,repo,root});
  let receipt=this.db.prepare('SELECT * FROM native_codebase_commits WHERE run_id=? AND codebase_id=?').get(identity.run_id,assignment.id) as Receipt|undefined;
  if(receipt&&receipt.identity_json!==key)throw Error('Native commit identity conflict');
  if(await git(['symbolic-ref','HEAD'])!==ref)throw Error('Native commit branch changed');
  const head=await git(['rev-parse','HEAD']);
  if(head!==assignment.base_commit&&head!==receipt?.head)throw Error('Native commit HEAD changed');
  const untracked=paths(await git(['ls-files','--others','--exclude-standard','-z'],{raw:true}));
  if(untracked.some(p=>!p.startsWith(prefix)))throw Error('Native subdirectory has changes outside its scope');
  const baseEntries=paths(await git(['ls-tree','-r','-z',assignment.base_commit],{raw:true})).map(entry=>{const tab=entry.indexOf('\t'),[mode,type,hash]=entry.slice(0,tab).split(' ');if(tab<0||!mode||!hash||!type)throw Error('Invalid Git tree entry');return{mode,type,hash,path:entry.slice(tab+1)};});
  // Never diff the working tree: Git may invoke configured clean filters even
  // with --no-textconv. Compare raw bytes outside the subtree with base blobs.
  for(const entry of baseEntries.filter(e=>!e.path.startsWith(prefix))){
   if(entry.type!=='blob')throw Error('Native subdirectory sibling metadata is unsupported');
   const file=await fileBytes(repo,entry.path,true);
   if(!file||file.mode!==entry.mode||await git(['hash-object','--stdin','--no-filters'],{input:file.bytes})!==entry.hash)throw Error('Native subdirectory has changes outside its scope');
  }
  const tracked=baseEntries.filter(e=>e.path.startsWith(prefix)).map(e=>e.path);
  const sealed=receipt?paths(await git(['ls-tree','-r','-z','--name-only',receipt.tree,'--',':(literal)'+assignment.root_path],{raw:true})):[];
  const candidates=[...new Set([...tracked,...sealed,...untracked])].sort();
  const temp=await mkdtemp(join(dirname(repo),'.luoshu-index-')),indexFile=join(temp,'index');
  try{
   await git(['read-tree',assignment.base_commit],{indexFile});
   for(const path of candidates){
    assertCurrent();
    if(!path.startsWith(prefix)||path.split('/').some(p=>p==='..'||p==='.'||p==='.git')||/[\u0000-\u001f\u007f]/u.test(path))throw Error('Invalid native commit path');
    const file=await fileBytes(repo,path);
    if(file){const hash=await git(['hash-object','-w','--stdin','--no-filters'],{input:file.bytes});await git(['update-index','--add','--cacheinfo',file.mode,hash,path],{indexFile});}
    else await git(['update-index','--force-remove','--',path],{indexFile});
   }
   const tree=await git(['write-tree'],{indexFile});
   const changedPaths=paths(await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',assignment.base_commit,tree,'--'],{raw:true}));
   if(changedPaths.some(p=>!p.startsWith(prefix)))throw Error('Native commit tree escapes authorized root');
   const result=codebaseExecutionResultSchema.parse({codebase_id:assignment.id,access_mode:'write',head_commit:head,branch:assignment.branch,result:changedPaths.length?'changed':'unchanged',changed_paths:changedPaths.map(p=>p.slice(prefix.length))});
   if(receipt&&receipt.tree!==tree)throw Error('Native commit snapshot changed after sealing');
   if(!receipt){
    receipt={identity_json:key,tree,head:null,created_at:Math.floor(Date.now()/1000)};
    this.db.prepare('INSERT INTO native_codebase_commits VALUES(?,?,?,?,NULL,?)').run(identity.run_id,assignment.id,key,tree,receipt.created_at);
   }
   const commit=changedPaths.length?await git(['commit-tree',tree,'-p',assignment.base_commit,'-m','Luoshu scoped delivery '+identity.run_id],{commitTime:receipt.created_at}):assignment.base_commit;
   if(receipt.head&&receipt.head!==commit)throw Error('Native commit receipt conflict');
   this.db.prepare('UPDATE native_codebase_commits SET head=? WHERE run_id=? AND codebase_id=?').run(commit,identity.run_id,assignment.id);
   if(await git(['symbolic-ref','HEAD'])!==ref)throw Error('Native commit branch changed during collection');
   await this.publications.publish(join(repo,'.git'),key,indexFile,assertCurrent,async()=>{
    if(await git(['symbolic-ref','HEAD'])!==ref)throw Error('Native commit branch changed during publication');
    const current=await git(['rev-parse',ref]);
    if(current!==commit)await git(['update-ref',ref,commit,assignment.base_commit]);
    if(await git(['symbolic-ref','HEAD'])!==ref||await git(['rev-parse','HEAD'])!==commit)throw Error('Native commit branch publication changed');
   });
   return{...result,head_commit:commit,base_commit:assignment.base_commit};
  }finally{await rm(temp,{recursive:true,force:true});}
 }
}
