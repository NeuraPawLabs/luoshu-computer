import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {NativeRunFiles} from '../../src/engines/native-files.js';
import {prepareCodebaseWorkspace,collectCodebaseResults} from '../../src/runtime/codebase-workspace.js';
import type {NativeCodebaseReceipt,CodebaseAssignment} from '../../src/protocol/index.js';
const run=promisify(execFile);

test('native immutable packet freezes actual Codebase commits with files and never recollects on replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-codebase-receipt-')),db=new Database(':memory:');
 try{
  const source=join(root,'source'),state=join(root,'state'),cwd=join(root,'chat');for(const p of [source,state,cwd])await mkdir(p);
  const git=async(args:string[],path=source)=>(await run('git',args,{cwd:path})).stdout.trim();
  await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
  await writeFile(join(source,'file.txt'),'base');await git(['add','.']);await git(['commit','-m','initial']);const base=await git(['rev-parse','HEAD']);
  const assignment:CodebaseAssignment={id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'write',source:{kind:'local',path:source},root_path:'.',default_branch:'main',base_commit:base,branch:'luoshu/feature/receipt'};
  const workspace=await prepareCodebaseWorkspace({stateDir:state,workspaceId:'run',codebases:[assignment],allowedRoots:[root]}),target=workspace.codebases[0].repository_path;
  await writeFile(join(target,'file.txt'),'changed');await git(['add','.'],target);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','change'],target);
  const head=await git(['rev-parse','HEAD'],target);let collections=0;
  const files=new NativeRunFiles(db,()=>true,async identity=>{collections++;expect(identity).toEqual({session_id:'session',run_id:'run',submission_id:'submission'});return(await collectCodebaseResults(workspace,[assignment])).map(r=>({...r,base_commit:base}));});
  const paths=await files.prepare({cwd,session_id:'session',run_id:'run',submission_id:'submission',input_files:[]});await writeFile(join(paths.outputs,'answer.txt'),'frozen');
  const packet=await files.collect('session','run','submission');expect(packet.codebases).toMatchObject([{base_commit:base,head_commit:head,result:'changed',changed_paths:['file.txt']}]);
  await writeFile(join(target,'file.txt'),'modified later');await writeFile(join(paths.outputs,'answer.txt'),'different');
  const reopened=new NativeRunFiles(db,()=>true,async()=>{throw Error('Do not reexecute receipt collection');});
  expect(await reopened.collect('session','run','submission')).toEqual(packet);expect(collections).toBe(1);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('failed Codebase receipt collection keeps delivery locked and does not freeze partial files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-codebase-failure-')),db=new Database(':memory:');let fail=true;
 try{
  const files=new NativeRunFiles(db,()=>true,async()=>{if(fail)throw Error('Codebase evidence unavailable');return[];});
  await files.prepare({cwd:root,session_id:'session',run_id:'run',submission_id:'submission',input_files:[]});
  await expect(files.collect('session','run','submission')).rejects.toThrow('Codebase evidence unavailable');
  expect(files.cached('session','run','submission')).toBeNull();expect(()=>files.assertSubmissionAllowed('session','another','another')).toThrow(/pending/);
  fail=false;expect((await files.collect('session','run','submission')).codebases).toEqual([]);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('authority is rechecked after collecting Codebase evidence before snapshot publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-codebase-authority-')),db=new Database(':memory:');let valid=true;
 try{
  const files=new NativeRunFiles(db,()=>true,async()=>{valid=false;return[] as NativeCodebaseReceipt[];});
  await files.prepare({cwd:root,session_id:'session',run_id:'run',submission_id:'submission',input_files:[]});
  await expect(files.collect('session','run','submission',()=>{if(!valid)throw Error('authority revoked');})).rejects.toThrow('authority revoked');
  expect(files.cached('session','run','submission')).toBeNull();
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
test('malformed Codebase evidence cannot freeze or unlock delivery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-codebase-invalid-')),db=new Database(':memory:');
 try{
  const files=new NativeRunFiles(db,()=>true,async()=>[{codebase_id:'invalid'}] as NativeCodebaseReceipt[]);
  await files.prepare({cwd:root,session_id:'session',run_id:'run',submission_id:'submission',input_files:[]});
  await expect(files.collect('session','run','submission')).rejects.toThrow();
  expect(files.cached('session','run','submission')).toBeNull();expect(()=>files.assertSubmissionAllowed('session','next','next')).toThrow(/pending/);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
