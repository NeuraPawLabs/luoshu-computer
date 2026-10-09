import {execFile} from 'node:child_process';
import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {collectCodebaseResults, prepareCodebaseWorkspace, removeCodebaseWorkspace} from '../../src/runtime/codebase-workspace.js';
import type {CodebaseAssignment} from '../../src/protocol/index.js';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async()=>{for(const root of roots.splice(0))await removeCodebaseWorkspace(root);});

async function repository(parent:string,name:string,content:string){
  const path=join(parent,name);const {mkdir}=await import('node:fs/promises');await mkdir(path,{recursive:true});
  await run('git',['init','-b','main'],{cwd:path});await run('git',['config','user.email','worker@test'],{cwd:path});await run('git',['config','user.name','Worker Test'],{cwd:path});
  await writeFile(join(path,'index.txt'),content);await run('git',['add','.'],{cwd:path});await run('git',['commit','-m','initial'],{cwd:path});
  return{path,commit:(await run('git',['rev-parse','HEAD'],{cwd:path})).stdout.trim()};
}

test('prepares write targets and technically read-only references at exact commits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'luoshu-codebases-'));roots.push(root);const state=join(root,'state');const {mkdir}=await import('node:fs/promises');await mkdir(state);
  const web=await repository(root,'web','web'),api=await repository(root,'api','api');
  const codebases:CodebaseAssignment[]=[
    {id:'11111111-1111-4111-8111-111111111111',alias:'web',access_mode:'write',source:{kind:'local',path:web.path},root_path:'.',default_branch:'main',base_commit:web.commit,branch:'luoshu/feature/web'},
    {id:'22222222-2222-4222-8222-222222222222',alias:'api',access_mode:'read',source:{kind:'local',path:api.path},root_path:'.',default_branch:'main',base_commit:api.commit,branch:null},
  ];
  const workspace=await prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_1',codebases,allowedRoots:[root]});
  expect(await readFile(join(workspace.targets,'web','index.txt'),'utf8')).toBe('web');
  expect(await readFile(join(workspace.references,'api','index.txt'),'utf8')).toBe('api');
  expect((await stat(join(workspace.references,'api','index.txt'))).mode&0o222).toBe(0);
  await writeFile(join(workspace.targets,'web','index.txt'),'changed');await run('git',['add','.'],{cwd:join(workspace.targets,'web')});await run('git',['-c','user.name=Worker Test','-c','user.email=worker@test','commit','-m','change'],{cwd:join(workspace.targets,'web')});
  const results=await collectCodebaseResults(workspace,codebases);
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({codebase_id:codebases[0]!.id,access_mode:'write',result:'changed',changed_paths:['index.txt']}),
    expect.objectContaining({codebase_id:codebases[1]!.id,access_mode:'read',result:'unchanged',head_commit:null,read_isolation:'enforced'}),
  ]));
});

test('rejects local sources outside allowed roots and read entries with a changed commit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'luoshu-codebases-'));roots.push(root);const outside=await mkdtemp(join(tmpdir(),'luoshu-outside-'));roots.push(outside);const {mkdir}=await import('node:fs/promises');const state=join(root,'state');await mkdir(state);const api=await repository(outside,'api','api');
  const codebase:CodebaseAssignment={id:'22222222-2222-4222-8222-222222222222',alias:'api',access_mode:'read',source:{kind:'local',path:api.path},root_path:'.',default_branch:'main',base_commit:api.commit,branch:null};
  await expect(prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_2',codebases:[codebase],allowedRoots:[root]})).rejects.toThrow(/allowed root/i);
  await expect(prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_3',codebases:[{...codebase,base_commit:'f'.repeat(40)}],allowedRoots:[outside]})).rejects.toThrow(/commit|checkout|reference/i);
});

test('keeps a prepared codebase workspace after collection so delivery can retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codebases-retain-'));roots.push(root);const state=join(root,'state');const {mkdir}=await import('node:fs/promises');await mkdir(state);
 const web=await repository(root,'web-retain','web');
 const codebase:CodebaseAssignment={id:'33333333-3333-4333-8333-333333333333',alias:'web',access_mode:'write',source:{kind:'local',path:web.path},root_path:'.',default_branch:'main',base_commit:web.commit,branch:'luoshu/feature/retain'};
 const workspace=await prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_retain',codebases:[codebase],allowedRoots:[root]});
 expect(await stat(workspace.path)).toBeTruthy();
  expect(await readFile(join(workspace.targets,'web','index.txt'),'utf8')).toBe('web');
  await writeFile(join(workspace.targets,'web','index.txt'),'uncommitted work');
  const again=await prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_retain',codebases:[codebase],allowedRoots:[root]});
  expect(await readFile(join(again.targets,'web','index.txt'),'utf8')).toBe('uncommitted work');
  await expect(prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_retain',codebases:[{...codebase,base_commit:'f'.repeat(40)}],allowedRoots:[root]})).rejects.toThrow(/identity|match/i);
});
test('owned codebase cleanup refuses symlink content without changing its target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codebases-cleanup-'));const state=join(root,'state');const {mkdir,symlink,rm}=await import('node:fs/promises');await mkdir(state);const web=await repository(root,'web-clean','web');
 const codebase:CodebaseAssignment={id:'44444444-4444-4444-8444-444444444444',alias:'web',access_mode:'write',source:{kind:'local',path:web.path},root_path:'.',default_branch:'main',base_commit:web.commit,branch:'luoshu/feature/cleanup'};
 const workspace=await prepareCodebaseWorkspace({stateDir:state,workspaceId:'run_clean',codebases:[codebase],allowedRoots:[root]}),outside=join(root,'outside');await writeFile(outside,'keep');await symlink(outside,join(workspace.targets,'web','escape'));
 const {removeCodebaseWorkspace}=await import('../../src/runtime/codebase-workspace.js');await expect(removeCodebaseWorkspace(workspace.path)).rejects.toThrow(/symbolic|owned/i);expect(await readFile(outside,'utf8')).toBe('keep');await rm(root,{recursive:true,force:true});
});
