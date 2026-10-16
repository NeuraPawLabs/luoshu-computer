import type Database from 'better-sqlite3';
import {lstat,mkdir,readdir,realpath,rename,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {Assignment,CodebaseAssignment,CodebaseExecutionResult} from '../protocol/index.js';
import {NativeCodebaseCommits} from '../engines/native-codebase-commit.js';
import type {CodebaseWorkspace,PreparedCodebase} from './codebase-workspace.js';
import {collectCodebaseResults} from './codebase-workspace.js';
import {runGitCommand} from './git-command.js';

interface Row {execution_id:string;codebase_id:string;scope_json:string;base_commit:string}
interface Metadata {scope_json:string;phase:'prepared'|'ready'}
async function entry(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function regularTree(path:string):Promise<void>{
 const info=await lstat(path);if(info.isSymbolicLink())throw Error('Task Git metadata must not contain symbolic links');
 if(info.isDirectory()){for(const name of await readdir(path))await regularTree(join(path,name));}
 else if(!info.isFile()||info.nlink!==1)throw Error('Task Git metadata must contain private regular files');
}

/** Keep Git authority outside every model write root. Only host plumbing reads
 * this metadata; files named .git inside the workspace never select a Git dir.
 * Per-attempt baselines allow successive steps without replacing prior seals. */
export class TaskCodebaseResults {
 private readonly commits:NativeCodebaseCommits;
 constructor(private readonly db:Database.Database){
  db.exec(`CREATE TABLE IF NOT EXISTS task_codebase_baselines(execution_id TEXT NOT NULL,codebase_id TEXT NOT NULL,
   scope_json TEXT NOT NULL,base_commit TEXT NOT NULL,PRIMARY KEY(execution_id,codebase_id));
   CREATE TABLE IF NOT EXISTS task_codebase_metadata(repository_path TEXT PRIMARY KEY,scope_json TEXT NOT NULL,phase TEXT NOT NULL);`);
  this.commits=new NativeCodebaseCommits(db);
 }
 private metadata(workspace:CodebaseWorkspace,prepared:PreparedCodebase){return join(workspace.path,'.task-git',prepared.alias);}
 private scope(assignment:Assignment,codebase:CodebaseAssignment,prepared:PreparedCodebase,gitDir:string){
  return JSON.stringify({run_id:assignment.run_id,codebase,repository:prepared.repository_path,gitDir});
 }
 private git(gitDir:string,repo:string,args:string[],raw=false){return runGitCommand(['--git-dir='+gitDir,'--work-tree='+repo,...args],{cwd:repo,isolated:true,raw});}
 async prepare(assignment:Assignment,workspace:CodebaseWorkspace,current:()=>void):Promise<void>{
  for(const codebase of assignment.codebases.filter(codebase=>codebase.access_mode==='write')){
   current();const prepared=workspace.codebases.find(item=>item.id===codebase.id);if(!prepared)throw Error('Task Codebase missing');
   const gitDir=this.metadata(workspace,prepared),marker=join(prepared.repository_path,'.git');
   const scope=this.scope(assignment,codebase,prepared,gitDir);
   let ownership=this.db.prepare('SELECT * FROM task_codebase_metadata WHERE repository_path=?').get(prepared.repository_path) as Metadata|undefined;
   if(ownership&&ownership.scope_json!==scope)throw Error('Task Git metadata ownership changed');
   if(!ownership){
    if(await entry(gitDir))throw Error('Unowned task Git metadata already exists');
    const source=await lstat(marker);if(!source.isDirectory()||source.isSymbolicLink())throw Error('Task Git metadata ownership missing');
    // Durable relocation intent precedes any filesystem mutation. Interrupted
    // moves are resumed from this binding, never adopted from a model marker.
    this.db.prepare("INSERT INTO task_codebase_metadata VALUES(?,?,'prepared')").run(prepared.repository_path,scope);
    ownership={scope_json:scope,phase:'prepared'};
   }
   if(ownership.phase==='prepared'){
    const source=await entry(marker),destination=await entry(gitDir);
    if(!destination){
     if(!source?.isDirectory()||source.isSymbolicLink())throw Error('Task Git relocation source missing');
     await regularTree(marker);current();await mkdir(dirname(gitDir),{recursive:true,mode:0o700});
     if(await realpath(dirname(gitDir))!==dirname(gitDir))throw Error('Task Git metadata path changed');
     await rename(marker,gitDir);
    }else if(source?.isDirectory()||!destination.isDirectory()||destination.isSymbolicLink())throw Error('Task Git relocation ownership conflicts');
    current();
    if(!await entry(marker))await writeFile(marker,'gitdir: '+gitDir+'\n',{flag:'wx',mode:0o400});
    this.db.prepare("UPDATE task_codebase_metadata SET phase='ready' WHERE repository_path=? AND scope_json=?").run(prepared.repository_path,scope);
   }
   if(await realpath(gitDir)!==gitDir)throw Error('Task Git metadata path changed');current();
   const head=await this.git(gitDir,prepared.repository_path,['rev-parse','HEAD']);current();
   await this.git(gitDir,prepared.repository_path,['merge-base','--is-ancestor',codebase.base_commit,head]);current();
   const prior=this.db.prepare('SELECT * FROM task_codebase_baselines WHERE execution_id=? AND codebase_id=?').get(assignment.attempt_id,codebase.id) as Row|undefined;
   if(prior&&(prior.scope_json!==scope||prior.base_commit!==head))throw Error('Task Codebase baseline changed');
   this.db.prepare('INSERT OR IGNORE INTO task_codebase_baselines VALUES(?,?,?,?)').run(assignment.attempt_id,codebase.id,scope,head);
  }
 }
 async collect(assignment:Assignment,workspace:CodebaseWorkspace,current:()=>void):Promise<CodebaseExecutionResult[]>{
  const results:CodebaseExecutionResult[]=[];
  for(const codebase of assignment.codebases){
   current();const prepared=workspace.codebases.find(item=>item.id===codebase.id);if(!prepared)throw Error('Task Codebase missing');
   if(codebase.access_mode==='read'){
    results.push(...await collectCodebaseResults({...workspace,codebases:[prepared]},[codebase],{isolated:true}));continue;
   }
   const gitDir=this.metadata(workspace,prepared),row=this.db.prepare('SELECT * FROM task_codebase_baselines WHERE execution_id=? AND codebase_id=?').get(assignment.attempt_id,codebase.id) as Row|undefined;
   if(!row||row.scope_json!==this.scope(assignment,codebase,prepared,gitDir))throw Error('Task Codebase baseline missing');
   const result=await this.commits.collect({run_id:assignment.attempt_id,session_id:'task:'+assignment.attempt_id,submission_id:assignment.attempt_id},
    {...codebase,base_commit:row.base_commit},prepared,current,{gitDir,wholeRepository:true});current();
   const paths=(await this.git(gitDir,prepared.repository_path,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',codebase.base_commit+'..'+result.head_commit,'--'],true)).split('\0').filter(Boolean);
   const prefix=codebase.root_path==='.'?'':codebase.root_path+'/';
   if(paths.some(path=>!path.startsWith(prefix)))throw Error('Task Codebase changed outside its authorized root');
   results.push({codebase_id:codebase.id,access_mode:'write',head_commit:result.head_commit,branch:codebase.branch,result:paths.length?'changed':'unchanged',changed_paths:paths.map(path=>path.slice(prefix.length))});
  }
  current();return results;
 }
}
