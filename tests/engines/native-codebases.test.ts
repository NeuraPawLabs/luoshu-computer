import Database from 'better-sqlite3';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test,vi} from 'vitest';
import {NativeCodebases} from '../../src/engines/native-codebases.js';
import {NativeIndexPublication} from '../../src/engines/native-index-publication.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import * as workspaceHelpers from '../../src/runtime/codebase-workspace.js';
import * as commands from '../../src/runtime/git-command.js';
const exec=promisify(execFile);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-codebases-')),source=join(root,'source'),state=join(root,'state');await mkdir(source);await mkdir(state);
 const git=async(args:string[],cwd=source)=>(await exec('git',args,{cwd})).stdout.trim();
 await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 await writeFile(join(source,'index.txt'),'base');await git(['add','.']);await git(['commit','-m','initial']);const base=await git(['rev-parse','HEAD']);
 const db=new Database(':memory:'),service=new NativeCodebases(db,{stateDir:state,allowedRoots:()=>[source]});
 const spec={id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'write' as const,source:{kind:'local' as const,path:source},root_path:'.',default_branch:'main'};
 const input={session_id:'session',run_id:'run',submission_id:'submission',codebases:[spec]};
 return{root,source,state,git,base,db,service,spec,input,close:async()=>{db.close();await workspaceHelpers.removeCodebaseWorkspace(join(state,'runs','run','references','app'));await rm(root,{recursive:true,force:true});}};
}
test('native Codebase journal pins real source commit and coalesces repeat preparation across service restart',async()=>{
 const f=await fixture();try{
  const [first,second]=await Promise.all([f.service.prepare(f.input),f.service.prepare(f.input)]);expect(second).toEqual(first);
  expect(first.assignments[0]).toMatchObject({base_commit:f.base,branch:'luoshu/feature/run-app'});
  expect(first.workspace.path).toBe(join(f.state,'runs','run'));expect(first.write).toEqual([join(f.state,'runs','run','targets','app')]);expect(first.read).toEqual([]);
  await writeFile(join(f.source,'index.txt'),'new branch head');await f.git(['add','.']);await f.git(['commit','-m','next']);
  const reopened=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[f.source]});
  expect(await reopened.prepare(f.input)).toEqual(first);expect(await readFile(join(first.write[0],'index.txt'),'utf8')).toBe('base');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_native_codebases').get()).toEqual({n:1});
 }finally{await f.close();}
});
test('native Codebase cancellation stops an in-flight real Git SSH operation without repinning or creating a checkout',async()=>{
 const f=await fixture(),helper=join(f.root,'ssh'),pidFile=join(f.root,'helper-pid');let work:Promise<unknown>|undefined;
 try{
  await writeFile(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700});
  const service=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[],gitSshCommand:helper}),input={...f.input,codebases:[{...f.spec,source:{kind:'git' as const,repository_url:'ssh://fixture.invalid/project.git'}}]};
  work=service.prepare(input);void work.catch(()=>{});
  await expect.poll(()=>readFile(pidFile,'utf8').catch(()=>null),{timeout:5000}).not.toBeNull();
  await expect(service.cancel({...input,session_id:'foreign'})).rejects.toThrow(/identity/i);
  await service.cancel(input);await expect(work).rejects.toThrow(/cancel|abort/i);
  expect(f.db.prepare('SELECT state,assignments_json FROM assistant_native_codebases').get()).toEqual({state:'resolving',assignments_json:null});
  const pid=Number(await readFile(pidFile,'utf8'));
  await expect.poll(async()=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z';}catch{return true;}}).toBe(true);
 }finally{
  const pid=Number(await readFile(pidFile,'utf8').catch(()=>0));if(pid)try{process.kill(pid,'SIGKILL');}catch{}
  await work?.catch(()=>{});await f.close();
 }
});
test('cancelling real Git clone retains its pinned commit and partial Run directory',async()=>{
 const f=await fixture(),helper=join(f.root,'clone-ssh'),marker=join(f.root,'stage'),pidFile=join(f.root,'clone-pid');let work:Promise<unknown>|undefined;
 try{
  const advertisement=f.base+' refs/heads/main\0symref=HEAD:refs/heads/main\n',packet=(Buffer.byteLength(advertisement)+4).toString(16).padStart(4,'0')+advertisement+'0000';
  await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'resolved');process.stdout.write(${JSON.stringify(packet)});}else{fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}\n`,{mode:0o700});
  const service=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[],gitSshCommand:helper}),input={...f.input,codebases:[{...f.spec,source:{kind:'git' as const,repository_url:'ssh://fixture.invalid/project.git'}}]};
  work=service.prepare(input);void work.catch(()=>{});
  await expect.poll(()=>readFile(pidFile,'utf8').catch(()=>null),{timeout:5000}).not.toBeNull();
  const row=f.db.prepare('SELECT state,assignments_json FROM assistant_native_codebases').get() as {state:string;assignments_json:string};
  expect(row.state).toBe('pinned');expect(JSON.parse(row.assignments_json)[0].base_commit).toBe(f.base);
  await service.cancel(input);await expect(work).rejects.toThrow(/cancel|abort/i);
  const {stat}=await import('node:fs/promises');expect((await stat(join(f.state,'runs','run','targets'))).isDirectory()).toBe(true);
  expect(f.db.prepare('SELECT state,assignments_json FROM assistant_native_codebases').get()).toEqual(row);
  await expect(readFile(join(f.state,'runs','run','workspace.json'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{
  const pid=Number(await readFile(pidFile,'utf8').catch(()=>0));if(pid)try{process.kill(pid,'SIGKILL');}catch{}
  await work?.catch(()=>{});await f.close();
 }
});
test.each(['source','session','submission','root'] as const)('native preparation rejects changed %s identity without replacing work',async change=>{
 const f=await fixture();try{
  const first=await f.service.prepare(f.input);await writeFile(join(first.write[0],'work.txt'),'preserve');
  const next=structuredClone(f.input);
  if(change==='source')next.codebases[0].default_branch='other';if(change==='root')next.codebases[0].root_path='subdir';if(change==='session')next.session_id='foreign';if(change==='submission')next.submission_id='foreign';
  await expect(f.service.prepare(next)).rejects.toThrow(/identity|conflict/);expect(await readFile(join(first.write[0],'work.txt'),'utf8')).toBe('preserve');
 }finally{await f.close();}
});
test('native preparation saves pin before checkout failure and never follows changed branch on retry',async()=>{
 const f=await fixture(),original=workspaceHelpers.prepareCodebaseWorkspace;let failing=true;
 const spy=vi.spyOn(workspaceHelpers,'prepareCodebaseWorkspace').mockImplementation(async options=>{if(failing)throw Error('disk unavailable');return original(options);});
 try{
  await expect(f.service.prepare(f.input)).rejects.toThrow('disk unavailable');
  expect(JSON.parse((f.db.prepare('SELECT assignments_json FROM assistant_native_codebases').get() as any).assignments_json)[0].base_commit).toBe(f.base);
  await writeFile(join(f.source,'index.txt'),'later');await f.git(['add','.']);await f.git(['commit','-m','later']);failing=false;
  expect((await f.service.prepare(f.input)).assignments[0].base_commit).toBe(f.base);
 }finally{spy.mockRestore();await f.close();}
});
test('cancellation identity alone cannot authorize deletion of an unowned partial directory',async()=>{
 const f=await fixture();try{
  const service=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[]}),input={...f.input,codebases:[{...f.spec,source:{kind:'git' as const,repository_url:'ssh://fixture.invalid/project.git'}}]};new CodexSessionStore(f.db);
  f.db.prepare("INSERT INTO assistant_native_codebases VALUES(?,?,?,?,NULL,'resolving')").run(input.run_id,input.session_id,input.submission_id,JSON.stringify(input.codebases));f.db.prepare('INSERT INTO codex_cancelled_preparations VALUES(?,?)').run(input.submission_id,JSON.stringify(input));
  await mkdir(join(f.state,'runs',input.run_id,'targets','app'),{recursive:true});await writeFile(join(f.state,'runs',input.run_id,'targets','app','partial.txt'),'partial');
  await expect(service.cleanupSession('session')).rejects.toThrow(/settled|ownership/);expect((await lstat(join(f.state,'runs','run','targets'))).isDirectory()).toBe(true);expect(await readFile(join(f.state,'runs','run','targets','app','partial.txt'),'utf8')).toBe('partial');expect(()=>f.db.transaction(()=>service.purgeSessionData('session'))()).toThrow(/settled|ownership/);
 }finally{await f.close();}
});
test('failed uncancelled partial preparation remains for recovery and cleanup refuses it',async()=>{
 const f=await fixture(),helper=join(f.root,'failed-ssh'),pidFile=join(f.root,'failed-pid');let work:Promise<unknown>|undefined;
 try{
  await writeFile(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.exit(9);\n`,{mode:0o700});
  const service=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[],gitSshCommand:helper}),input={...f.input,codebases:[{...f.spec,source:{kind:'git' as const,repository_url:'ssh://fixture.invalid/project.git'}}]};
  await expect(service.prepare(input)).rejects.toThrow();expect(f.db.prepare('SELECT state FROM assistant_native_codebases').get()).toEqual({state:'resolving'});
  await expect(service.cleanupSession('session')).rejects.toThrow(/settled/);expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_native_codebases').get()).toEqual({n:1});
 }finally{await work?.catch(()=>{});await f.close();}
});
test('cancelled creator-owned partial Run can be cleaned after preparation has drained',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.prepare(f.input);await writeFile(join(prepared.workspace.path,'partial-marker'),'retain until cleanup');
  f.db.prepare("UPDATE assistant_native_codebases SET state='pinned' WHERE run_id=?").run(f.input.run_id);
  const cancelled=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[f.source],isPreparationCancelled:identity=>identity.run_id===f.input.run_id});
  await cancelled.cleanupSession(f.input.session_id);await expect(lstat(prepared.workspace.path)).rejects.toMatchObject({code:'ENOENT'});
  f.db.transaction(()=>cancelled.purgeSessionData(f.input.session_id))();expect(f.db.prepare('SELECT * FROM native_codebase_workspace_owners').all()).toEqual([]);
 }finally{await f.close();}
});
test('foreign Git index lock blocks Codebase cleanup and preserves the checkout',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.prepare(f.input),lock=join(prepared.workspace.codebases[0].repository_path,'.git','index.lock');await writeFile(lock,'foreign lock');
  await expect(f.service.cleanupSession(f.input.session_id)).rejects.toThrow(/Git lock|index\.lock|publication/i);
  expect(await readFile(lock,'utf8')).toBe('foreign lock');await rm(lock);await f.service.cleanupSession(f.input.session_id);await expect(lstat(prepared.workspace.path)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await f.close();}
});
test('local root authorization and partial workspace survive rejection',async()=>{
 const f=await fixture();try{
  const denied=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>[]});await expect(denied.prepare(f.input)).rejects.toThrow(/root|authorized/i);
  const partial=join(f.state,'runs','run');await mkdir(partial,{recursive:true});await writeFile(join(partial,'preserve.txt'),'unfinished work');
  await expect(f.service.prepare(f.input)).rejects.toThrow(/partial|identity|complete/i);expect(await readFile(join(partial,'preserve.txt'),'utf8')).toBe('unfinished work');
 }finally{await f.close();}
});
test('native preparation rejects aliased state directories and unsafe repository protocols',async()=>{
 const f=await fixture();try{
  const linked=join(f.root,'linked');await symlink(f.state,linked);const service=new NativeCodebases(f.db,{stateDir:linked,allowedRoots:()=>[f.source]});
  await expect(service.prepare(f.input)).rejects.toThrow(/canonical|symbolic|path/);
  await expect(f.service.prepare({...f.input,run_id:'other',submission_id:'other',codebases:[{...f.spec,source:{kind:'git',repository_url:'ext::sh -c unsafe'}}]})).rejects.toThrow(/source|protocol|repository/i);
 }finally{await f.close();}
});
test('read Codebase receipts require explicit enforced policy and expose only read roots',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.prepare({...f.input,codebases:[{...f.spec,access_mode:'read'}]});
  expect(prepared.write).toEqual([]);expect(prepared.read).toEqual([join(f.state,'runs','run','references','app')]);
  await expect(f.service.collect(f.input,false)).rejects.toThrow(/isolation/);
  const receipts=await f.service.collect(f.input,true);expect(receipts).toMatchObject([{codebase_id:f.spec.id,base_commit:f.base,result:'unchanged',read_isolation:'enforced'}]);
  await expect(f.service.collect({...f.input,submission_id:'foreign'},true)).rejects.toThrow(/identity/);
 }finally{await f.close();}
});
test('authority lost during source resolution does not pin or prepare a checkout',async()=>{
 const f=await fixture(),original=workspaceHelpers.resolveCodebaseAssignments;let valid=true;
 const spy=vi.spyOn(workspaceHelpers,'resolveCodebaseAssignments').mockImplementation(async options=>{const result=await original(options);valid=false;return result;});
 try{
  await expect(f.service.prepare(f.input,()=>{if(!valid)throw Error('authority lost');})).rejects.toThrow('authority lost');
  expect(f.db.prepare('SELECT assignments_json,state FROM assistant_native_codebases').get()).toEqual({assignments_json:null,state:'resolving'});
 }finally{spy.mockRestore();await f.close();}
});

test('ready workspace identity is revalidated and cannot redirect a replay to another checkout',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.prepare(f.input),identityPath=join(prepared.workspace.path,'workspace.json'),saved=JSON.parse(await readFile(identityPath,'utf8'));
  saved.workspace.codebases[0].checkout_path=f.source;await writeFile(identityPath,JSON.stringify(saved));
  await expect(f.service.prepare(f.input)).rejects.toThrow(/identity|path/);
  await expect(f.service.collect(f.input,true)).rejects.toThrow(/identity|path/);
 }finally{await f.close();}
});
test('revoked local roots prevent reusing or collecting a prepared native Codebase',async()=>{
 const f=await fixture();try{
  let roots=[f.source];const service=new NativeCodebases(f.db,{stateDir:f.state,allowedRoots:()=>roots});
  await service.prepare(f.input);roots=[];
  await expect(service.prepare(f.input)).rejects.toThrow(/authorized roots/);
  await expect(service.collect(f.input,true)).rejects.toThrow(/authorized roots/);
 }finally{await f.close();}
});
test.each(['../outside','a/../../outside','a//b','a\\b','/absolute'])('unsafe native Codebase root %s is rejected before Git work',async root_path=>{
 const f=await fixture();try{
  await expect(f.service.prepare({...f.input,codebases:[{...f.spec,root_path}]})).rejects.toThrow(/root path/);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_native_codebases').get()).toEqual({n:0});
 }finally{await f.close();}
});
test('changed Codebase pin does not validate against a different saved source specification',async()=>{
 const f=await fixture();try{
  await f.service.prepare(f.input);
  const row=f.db.prepare('SELECT assignments_json FROM assistant_native_codebases').get() as {assignments_json:string};const assignments=JSON.parse(row.assignments_json);assignments[0].alias='different';
  f.db.prepare('UPDATE assistant_native_codebases SET assignments_json=?').run(JSON.stringify(assignments));
  await expect(f.service.prepare(f.input)).rejects.toThrow(/identity|assignment|specification/);
 }finally{await f.close();}
});

test('codebase purge removes scoped commit contents only for its session inside the final transaction',async()=>{
 const f=await fixture();try{
  await mkdir(join(f.source,'app'));await writeFile(join(f.source,'app','main.txt'),'base');await f.git(['add','.']);await f.git(['commit','-m','subtree']);
  const input={...f.input,codebases:[{...f.spec,root_path:'app'}]};
  const own=await f.service.prepare(input);await writeFile(join(own.write[0],'main.txt'),'private change');
  await f.service.collect(input,true);
  const foreignInput={...input,session_id:'foreign',run_id:'foreign-run',submission_id:'foreign-sub'};
  const foreign=await f.service.prepare(foreignInput);await writeFile(join(foreign.write[0],'main.txt'),'foreign change');await f.service.collect(foreignInput,true);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM native_codebase_commits').get()).toEqual({n:2});
  const retained={workspace:f.db.prepare("SELECT * FROM assistant_native_codebases WHERE session_id='foreign'").get(),commit:f.db.prepare("SELECT * FROM native_codebase_commits WHERE run_id='foreign-run'").get()};
  expect(()=>f.service.purgeSessionData('session')).toThrow(/transaction/);
  await f.service.cleanupSession('session');f.db.transaction(()=>f.service.purgeSessionData('session'))();
  expect(f.db.prepare('SELECT * FROM assistant_native_codebases').all()).toEqual([retained.workspace]);
  expect(f.db.prepare('SELECT * FROM native_codebase_commits').all()).toEqual([retained.commit]);
  expect(await readFile(join(f.source,'app','main.txt'),'utf8')).toBe('base');
 }finally{await f.close();}
});
test('pending index publication prevents directory cleanup and metadata purge until exact recovery',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.prepare(f.input);new NativeIndexPublication(f.db);
  // Deliberately unresolved journal: cleanup must retain it, not interpret it
  // as permission to delete a lock. Publication recovery has separate tests.
  f.db.prepare('INSERT INTO native_index_publications VALUES(?,?,?,?,NULL,NULL)').run(join(prepared.write[0],'.git'),JSON.stringify({identity:f.input}),'unresolved','unresolved');
  await expect(f.service.cleanupSession('session')).rejects.toThrow(/publication|settled/);
  expect(()=>f.db.transaction(()=>f.service.purgeSessionData('session'))()).toThrow(/publication|settled/);
  expect(await readFile(join(prepared.write[0],'index.txt'),'utf8')).toBe('base');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM native_index_publications').get()).toEqual({n:1});
 }finally{await f.close();}
});
test('codebase cleanup cannot race receipt collection before its index publication starts',async()=>{
 const f=await fixture();let release!:()=>void,work:Promise<unknown>|undefined;const gate=new Promise<void>(r=>release=r),original=commands.runGitCommand;
 const spy=vi.spyOn(commands,'runGitCommand');
 try{
  await f.service.prepare(f.input);let entered=false;
  spy.mockImplementation(async(args,options)=>{if(!entered){entered=true;await gate;}return original(args,options);});
  work=f.service.collect(f.input,true);void work.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  await expect(f.service.cleanupSession('session')).rejects.toThrow(/settled/);
  expect(()=>f.db.transaction(()=>f.service.purgeSessionData('session'))()).toThrow(/settled/);
  release();await work;
 }finally{release();await work?.catch(()=>{});spy.mockRestore();await f.close();}
});
