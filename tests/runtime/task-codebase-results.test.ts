import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {runGitCommand} from '../../src/runtime/git-command.js';
import {prepareCodebaseWorkspace} from '../../src/runtime/codebase-workspace.js';
import {TaskCodebaseResults} from '../../src/runtime/task-codebase-results.js';
import type {Assignment} from '../../src/protocol/index.js';

test('interrupted Git metadata relocation resumes from durable intent without adopting a model marker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-task-metadata-')),db=new Database(':memory:'),source=join(root,'source');
 const git=(args:string[])=>runGitCommand(args,{cwd:source,isolated:true});
 try{
  await mkdir(join(source,'src'),{recursive:true});await git(['init','-b','main']);await writeFile(join(source,'src','index.txt'),'base');await git(['add','.']);await git(['commit','-m','base']);
  const assignment:Assignment={attempt_id:'attempt',run_id:'run',lease_epoch:1,agent:'codex',permission_scope:'task_workspace',instruction:'fix',input_files:[],timeout_seconds:30,
   codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'code',access_mode:'write',source:{kind:'local',path:source},root_path:'src',default_branch:'main',base_commit:await git(['rev-parse','HEAD']),branch:'luoshu/feature/task'}]};
  const workspace=await prepareCodebaseWorkspace({stateDir:root,workspaceId:'run',codebases:assignment.codebases,allowedRoots:[root]});
  const results=new TaskCodebaseResults(db),metadata=join(workspace.path,'.task-git','code');
  await expect(results.prepare(assignment,workspace,()=>{if(existsSync(metadata))throw Error('interrupted');})).rejects.toThrow('interrupted');
  expect(db.prepare('SELECT phase FROM task_codebase_metadata').get()).toEqual({phase:'prepared'});
  await results.prepare(assignment,workspace,()=>{});
  expect(db.prepare('SELECT phase FROM task_codebase_metadata').get()).toEqual({phase:'ready'});
  await writeFile(join(workspace.codebases[0]!.checkout_path,'index.txt'),'fixed');
  const first=await results.collect(assignment,workspace,()=>{}),replay=await results.collect(assignment,workspace,()=>{});
  expect(first).toMatchObject([{result:'changed',changed_paths:['index.txt']}]);expect(replay).toEqual(first);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test.each(['unchanged','changed','new'])('whole repository delivery preserves existing symlinks/gitlinks but rejects %s link changes',async link=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-task-links-')),db=new Database(':memory:'),source=join(root,'source');
 const git=(args:string[])=>runGitCommand(args,{cwd:source,isolated:true});
 try{
  await mkdir(source);await git(['init','-b','main']);await writeFile(join(source,'index.txt'),'base');await symlink('index.txt',join(source,'linked.txt'));
  await git(['add','.']);await git(['commit','-m','base']);
  const module=await git(['rev-parse','HEAD']);await git(['update-index','--add','--cacheinfo','160000',module,'module']);await git(['commit','-m','module']);
  const assignment:Assignment={attempt_id:'attempt',run_id:'run',lease_epoch:1,agent:'codex',permission_scope:'task_workspace',instruction:'fix',input_files:[],timeout_seconds:30,
   codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'code',access_mode:'write',source:{kind:'local',path:source},root_path:'.',default_branch:'main',base_commit:await git(['rev-parse','HEAD']),branch:'luoshu/feature/task'}]};
  const workspace=await prepareCodebaseWorkspace({stateDir:root,workspaceId:'run',codebases:assignment.codebases,allowedRoots:[root]});
  const results=new TaskCodebaseResults(db);await results.prepare(assignment,workspace,()=>{});
  const checkout=workspace.codebases[0]!.checkout_path;await writeFile(join(checkout,'index.txt'),'fixed');
  if(link==='changed'){await rm(join(checkout,'linked.txt'));await symlink('/etc/passwd',join(checkout,'linked.txt'));}
  if(link==='new')await symlink('/etc/passwd',join(checkout,'new-link'));
  const collected=results.collect(assignment,workspace,()=>{});
  if(link==='unchanged')expect(await collected).toMatchObject([{result:'changed',changed_paths:['index.txt']}]);
  else await expect(collected).rejects.toThrow(/symbolic links/);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
