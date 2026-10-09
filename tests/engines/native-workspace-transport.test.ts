import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {CodexEngineService} from '../../src/engines/service.js';
import {NativeCodebases} from '../../src/engines/native-codebases.js';
import {NativeRunFiles} from '../../src/engines/native-files.js';
import {withNativePolicy} from '../helpers/native-policy.js';
import {DevelopmentRootPolicy} from '../../src/development/root-policy.js';
const exec=promisify(execFile);
async function fixture(options:{blockedGit?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-workspace-wire-')),source=join(root,'source'),state=join(root,'state'),cwd=join(root,'chat');for(const p of [source,state,cwd])await mkdir(p);
 const git=async(args:string[])=>(await exec('git',args,{cwd:source})).stdout.trim();await git(['init','-b','main']);await writeFile(join(source,'index.txt'),'base');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=f@invalid','commit','-m','init']);const base=await git(['rev-parse','HEAD']);
 const helper=join(root,'ssh'),helperPid=join(root,'helper-pid');
 if(options.blockedGit)await writeFile(helper,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(helperPid)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700});
 const db=new Database(':memory:'),store=new CodexSessionStore(db),codebases=new NativeCodebases(db,{stateDir:state,allowedRoots:()=>[source],...(options.blockedGit?{gitSshCommand:helper}:{})}),files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));let starts=0;
 const calls:any[]=[];const rpc:any={initialize:async()=>({}),startThread:async(p:any)=>{calls.push(['thread/start',p]);starts++;return{id:'thread'};},resumeThread:async(p:any)=>{calls.push(['thread/resume',p]);return{id:p.threadId};},startTurn:async(p:any)=>{calls.push(['turn/start',p]);return{id:'turn'};},interruptTurn:async()=>{},backgroundTerminals:async()=>({data:[],nextCursor:null})};
 const rootPolicy=new DevelopmentRootPolicy({roots:[source],persist:async()=>{}});
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>cwd,files,codebases,rootPolicy,capacity:()=>1});
 const input=[{type:'text',text:'work'}],binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},submission={submission_id:'submission',batch_id:'batch',run_id:'run',session_id:'session',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null,codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'write',source:{kind:'local',path:source},root_path:'.',default_branch:'main'}]};
 const prepare={action:'workspace_prepare',request_id:'prepare',submission,workspace_id:'session',developer_instructions:'custom',input_files:[],lease_ms:120000};
 return{root,base,db,store,codebases,files,service,input,submission,prepare,calls,rpc,rootPolicy,helperPid,starts:()=>starts,close:async()=>{await service.close();db.close();await rm(root,{recursive:true,force:true});}};
}
test('native workspace prepare returns bound pinned receipt without starting any native thread and preserves capacity',async()=>{
 const f=await fixture();try{
  const response=await f.service.handle(f.prepare);
  expect(response).toMatchObject({action:'workspace_prepare',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,codebases:[{codebase_id:f.submission.codebases[0].id,base_commit:f.base,branch:'luoshu/feature/run-app'}]});
  expect(f.starts()).toBe(0);expect(f.store.session('session')?.thread_id).toBeNull();expect(f.files.activeCount()).toBe(1);
  expect(await f.service.handle({...f.prepare,request_id:'replay'})).toEqual({...response,request_id:'replay'});
  await expect(f.service.handle({...f.prepare,submission:{...f.submission,submission_id:'other',run_id:'other',session_id:'other'},workspace_id:'other'})).rejects.toThrow(/capacity/);
  await expect(f.service.handle({...f.prepare,submission:{...f.submission,codebases:[{...f.submission.codebases[0],alias:'different'}]}})).rejects.toThrow(/conflict/);
 }finally{await f.close();}
});
test('prepared native resources establish exact permissions before the first thread and carry trusted paths into its turn',async()=>{
 const f=await fixture();try{
  const prepared=await f.service.handle(f.prepare);if(prepared.action!=='workspace_prepare')throw Error();
  const path=prepared.codebases[0].checkout_path;
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  expect(f.calls[0][1].permissionScope.config.filesystem[':workspace_roots']).toEqual({'targets/app':'write'});
  expect(f.calls[0][1].permissionScope.runtimeWorkspaceRoots).toEqual([join(f.root,'state','runs','run')]);
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  expect(f.calls.filter(c=>c[0]==='thread/resume')).toHaveLength(0);
  const context=JSON.parse(f.calls.find(c=>c[0]==='turn/start')[1].input[0].text);
  expect(context.luoshu_run.codebases).toMatchObject([{id:f.submission.codebases[0].id,checkout_path:path,base_commit:f.base,access_mode:'write'}]);
  expect(await readFile(join(path,'index.txt'),'utf8')).toBe('base');
  // A delayed preparation replay must not recreate or rewrite Agent-visible input.
  const stage=vi.spyOn(f.files,'prepare');
  await expect(f.service.handle(f.prepare)).resolves.toEqual(prepared);
  expect(stage).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('Codebase delivery rejects session policy drift from the exact policy pinned before native execution',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  const policy=JSON.parse(f.store.session('session')!.policy_json!);policy.permissions.config.filesystem['/foreign']='write';
  f.db.prepare('UPDATE codex_native_sessions SET policy_json=? WHERE session_key=?').run(JSON.stringify(policy),'session');
  await expect(f.service.codebaseReceipts({session_id:'session',submission_id:'submission',run_id:'run'})).rejects.toThrow(/policy|scope/i);
 }finally{await f.close();}
});

test('native submit cannot race a replay that is still staging its workspace',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 try{
  await f.service.handle(f.prepare);
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  let entered=false;const original=f.files.prepare.bind(f.files);
  vi.spyOn(f.files,'prepare').mockImplementation(async(input)=>{entered=true;await gate;return original(input);});
  const preparing=f.service.handle(f.prepare);void preparing.catch(()=>{});
  await expect.poll(()=>entered).toBe(true);
  const sending=f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000}).then(()=>({kind:'sent'}),error=>({kind:'error',message:String(error)}));
  const outcome=await Promise.race([sending,new Promise(resolve=>setImmediate(()=>resolve({kind:'pending'})))]);
  release();await preparing;await sending;
  expect(outcome).toMatchObject({kind:'error',message:expect.stringMatching(/preparation.*pending/i)});
  expect(f.calls.filter(c=>c[0]==='turn/start')).toHaveLength(0);
 }finally{release();await f.close();}
});
test('workspace preparation cannot stage files for another binding or mismatched attachment digest',async()=>{
 const f=await fixture();try{
  await expect(f.service.handle({...f.prepare,input_files:[{name:'forged.txt',mime_type:'text/plain',content_base64:'eA=='}]})).rejects.toThrow(/digest/);
  expect(f.store.session('session')).toBeUndefined();
  await expect(f.service.handle({...f.prepare,submission:{...f.submission,binding:{...f.submission.binding,engine:{...f.submission.binding.engine,worker_id:'foreign'}}}})).rejects.toThrow(/Worker/);
 }finally{await f.close();}
});
test('known runtime drift is rejected before a new Codebase preparation acquires files or capacity',async()=>{
 const f=await fixture();try{
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom'});
  const before=f.store.session('session');f.rpc.runtimeExecutable=async()=>{throw Object.assign(Error('runtime replaced'),{code:'CODEX_RUNTIME_CHANGED'});};
  await expect(f.service.handle(f.prepare)).rejects.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
  expect(f.files.pending()).toEqual([]);expect(f.store.preparationState(f.submission as any)).toBe('missing');expect(f.store.session('session')).toEqual(before);
  await expect(readFile(join(f.root,'chat','runs','run','inputs'))).rejects.toThrow(/ENOENT/);
 }finally{await f.close();}
});

test('cancelling preparation drains pending Git work, releases capacity and durably prevents a late submit',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 try{
  const original=f.codebases.prepare.bind(f.codebases);let entered=false;
  vi.spyOn(f.codebases,'prepare').mockImplementation(async(input,assertCurrent)=>{entered=true;await gate;return original(input,assertCurrent);});
  const preparing=f.service.handle(f.prepare);void preparing.catch(()=>{});
  await expect.poll(()=>entered).toBe(true);
  let settled=false;const cancel=f.service.handle({action:'workspace_cancel',request_id:'cancel',submission:f.submission}).then(r=>{settled=true;return r;});void cancel.catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));expect(settled).toBe(false);expect(f.files.activeCount()).toBe(1);
  release();await expect(preparing).rejects.toThrow(/cancel/i);
  expect(await cancel).toMatchObject({action:'workspace_cancel',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1});
  expect(f.files.activeCount()).toBe(0);expect(f.store.submission('submission')).toBeUndefined();expect(f.starts()).toBe(0);
  await expect(f.service.handle(f.prepare)).rejects.toThrow(/cancel/i);
  const reopened=new CodexSessionStore(f.db);
  expect(()=>reopened.reserve({...f.submission.binding,engine:f.submission.binding.engine} as any,'session',f.store.session('session')!.cwd,'submission',f.submission.input_sha256)).toThrow(/cancel/i);
  await expect(f.service.handle({...f.prepare,submission:{...f.submission,submission_id:'other',run_id:'other',session_id:'other'},workspace_id:'other'})).resolves.toMatchObject({action:'workspace_prepare',run_id:'other'});
 }finally{release();await f.close();}
});

test('preparation cancellation fences out a delayed prepare even before its metadata arrives',async()=>{
 const f=await fixture();try{
  const request={action:'workspace_cancel',request_id:'cancel',submission:f.submission};
  await expect(f.service.handle(request)).resolves.toMatchObject({action:'workspace_cancel',session_state:'missing',native:null});
  await expect(f.service.handle(f.prepare)).rejects.toThrow(/cancel/i);
  await expect(f.service.handle({...request,request_id:'repeat'})).resolves.toMatchObject({action:'workspace_cancel'});
  await expect(f.service.handle({...request,submission:{...f.submission,run_id:'forged'}})).rejects.toThrow(/conflict/i);
  expect(f.files.activeCount()).toBe(0);expect(f.store.session('session')).toBeUndefined();
 }finally{await f.close();}
});

test('preparation cancellation never settles a submission with possible native effects',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  f.store.reserve(f.submission.binding as any,'session',f.store.session('session')!.cwd,'submission',f.submission.input_sha256);
  f.store.unknown('submission');
  await expect(f.service.handle({action:'workspace_cancel',request_id:'cancel',submission:f.submission})).rejects.toThrow(/submit|unresolved|native/i);
  expect(f.store.submission('submission')?.status).toBe('unknown');expect(f.store.activeCount()+f.files.activeCount()).toBe(1);
 }finally{await f.close();}
});

test('cancellation during native thread preparation drains its late receipt without submitting a turn',async()=>{
 const f=await fixture();let release!:(v:any)=>void;
 try{
  await f.service.handle(f.prepare);
  vi.spyOn(f.rpc,'startThread').mockImplementation(()=>new Promise(resolve=>release=resolve));
  const preparing=f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});void preparing.catch(()=>{});
  await expect.poll(()=>Boolean(release)).toBe(true);
  const cancel=f.service.handle({action:'workspace_cancel',request_id:'cancel',submission:f.submission});void cancel.catch(()=>{});
  expect(f.files.activeCount()).toBe(1);release({id:'late-thread'});
  await expect(preparing).rejects.toThrow(/cancel/i);
  await expect(cancel).resolves.toMatchObject({session_state:'idle',native:{thread_id:'late-thread'}});
  expect(f.files.activeCount()).toBe(0);expect(f.calls.some(c=>c[0]==='turn/start')).toBe(false);
 }finally{release?.({id:'late-thread'});await f.close();}
});

test('failed source preparation keeps its slot until explicit durable cancellation after Worker restart',async()=>{
 const f=await fixture();let reopened:CodexEngineService|undefined;
 try{
  const request={...f.prepare,submission:{...f.submission,codebases:[{...f.submission.codebases[0],source:{kind:'local',path:join(f.submission.codebases[0].source.path,'missing')}}]}};
  await expect(f.service.handle(request)).rejects.toThrow(/ENOENT/);expect(f.files.activeCount()).toBe(1);
  await f.service.close();
  reopened=new CodexEngineService(new CodexSessionStore(f.db),'worker',()=>{throw Error('Must not spawn');},{workspacePath:async()=>f.store.session('session')!.cwd,files:f.files,codebases:f.codebases});
  await expect(reopened.handle({action:'workspace_cancel',request_id:'cancel',submission:request.submission})).resolves.toMatchObject({action:'workspace_cancel'});
  expect(f.files.activeCount()).toBe(0);
  await expect(reopened.handle(request)).rejects.toThrow(/cancel/i);
 }finally{await reopened?.close();await f.close();}
});
test('directory narrowing reports native preparation and explicitly cancelling it releases only that source grant',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  const blocked=await f.rootPolicy.update([],'revoked',[]);
  expect(blocked).toMatchObject({status:'blocked',blockers:[{id:'native:submission',kind:'preparation',path:f.submission.codebases[0].source.path,stoppable:true}]});
  const revoked=await f.rootPolicy.update([],'revoked',['native:submission']);
  expect(revoked.status).toBe('applied');expect(f.files.activeCount()).toBe(0);
  await expect(f.service.handle(f.prepare)).rejects.toThrow(/cancel|allowed/i);expect(f.starts()).toBe(0);
 }finally{await f.close();}
});
test('native directory stop requests interrupt but retains the root blocker until execution and delivery are confirmed',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  const interrupt=vi.spyOn(f.rpc,'interruptTurn');
  expect((await f.rootPolicy.update([],'revoked',['native:submission'])).status).toBe('blocked');
  expect(interrupt).toHaveBeenCalledWith({threadId:'thread',turnId:'turn'});expect(f.store.submission('submission')?.status).toBe('stopping');
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'interrupted',items:[]}});
  expect((await f.rootPolicy.update([],'revoked',[])).status).toBe('blocked');
  await f.service.handle({action:'collect_result',request_id:'collect',session_id:'session',run_id:'run',submission_id:'submission',authorization_revision:1});
  expect((await f.rootPolicy.update([],'revoked',[])).status).toBe('applied');
 }finally{await f.close();}
});
test('applied Worker root configuration immediately stops native execution even without output or another request',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  const interrupt=vi.spyOn(f.rpc,'interruptTurn');
  f.rootPolicy.setApplied([],'config-revoked');
  await expect.poll(()=>interrupt.mock.calls.length).toBe(1);
  expect(f.store.submission('submission')?.status).toBe('stopping');
  await expect(f.service.serverRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'command'}})).rejects.toThrow(/authorized/i);
 }finally{await f.close();}
});
test('root configuration change during preparation cancels durably and cannot be undone by a regrant',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 try{
  const original=f.codebases.prepare.bind(f.codebases);let entered=false;
  vi.spyOn(f.codebases,'prepare').mockImplementation(async(input,assertCurrent)=>{entered=true;await gate;return original(input,assertCurrent);});
  const preparing=f.service.handle(f.prepare);void preparing.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  f.rootPolicy.setApplied([],'revoked');f.rootPolicy.setApplied([f.submission.codebases[0].source.path],'regranted');
  release();await expect(preparing).rejects.toThrow(/cancel/i);await expect.poll(()=>f.files.activeCount()).toBe(0);
  await expect(f.service.handle(f.prepare)).rejects.toThrow(/cancel/i);
 }finally{release();await f.close();}
});
test('reopening after source revocation keeps unresolved work inspectable and cannot revive preparation',async()=>{
 const f=await fixture();let reopened:CodexEngineService|undefined;try{
  await f.service.handle(f.prepare);await f.service.close();f.rootPolicy.setApplied([],'revoked-while-offline');
  expect(()=>{reopened=new CodexEngineService(new CodexSessionStore(f.db),'worker',()=>{throw Error('Must not spawn');},{workspacePath:async()=>f.store.session('session')!.cwd,files:f.files,codebases:f.codebases,rootPolicy:f.rootPolicy});}).not.toThrow();
  await expect.poll(()=>f.files.activeCount()).toBe(0);
  await expect(reopened!.handle(f.prepare)).rejects.toThrow(/cancel/i);
 }finally{await reopened?.close();await f.close();}
});
test('replaying a delivered workspace receipt never reacquires an inactive directory grant',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await f.service.handle({action:'collect_result',request_id:'collect',session_id:'session',run_id:'run',submission_id:'submission',authorization_revision:1});
  await f.service.handle(f.prepare);
  expect((await f.rootPolicy.update([],'revoked',[])).status).toBe('applied');
 }finally{await f.close();}
});
test('workspace inspection distinguishes a cancellation intent from drained cancellation without running native work',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 try{
  const inspect={action:'workspace_inspect',request_id:'inspect',submission:f.submission};
  await expect(f.service.handle(inspect)).resolves.toMatchObject({state:'missing',session_state:'missing',native:null});
  let entered=false;const original=f.codebases.prepare.bind(f.codebases);
  vi.spyOn(f.codebases,'prepare').mockImplementation(async(input,current)=>{entered=true;await gate;return original(input,current);});
  const preparing=f.service.handle(f.prepare);void preparing.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  await expect(f.service.handle(inspect)).resolves.toMatchObject({state:'open'});
  const cancelling=f.service.handle({action:'workspace_cancel',request_id:'cancel',submission:f.submission});void cancelling.catch(()=>{});
  await expect(f.service.handle(inspect)).resolves.toMatchObject({state:'cancelling'});
  release();await expect(preparing).rejects.toThrow(/cancel/i);await cancelling;
  await expect(f.service.handle(inspect)).resolves.toMatchObject({state:'cancelled',session_state:'idle',native:null});
  for(const field of ['run_id','session_id','input_sha256'] as const)await expect(f.service.handle({...inspect,submission:{...f.submission,[field]:field==='input_sha256'?'a'.repeat(64):'foreign'}})).rejects.toThrow(/conflict|identity/i);
  expect(f.starts()).toBe(0);expect(f.files.activeCount()).toBe(0);
 }finally{release();await f.close();}
});
test('workspace inspection never labels an unknown native submission as cancelled preparation',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);
  f.store.reserve(f.submission.binding as any,'session',f.store.session('session')!.cwd,'submission',f.submission.input_sha256);f.store.unknown('submission');
  await expect(f.service.handle({action:'workspace_inspect',request_id:'inspect',submission:f.submission})).resolves.toMatchObject({state:'submitted'});
  expect(f.store.activeCount()).toBe(1);
 }finally{await f.close();}
});
test('preparation lease expiry is durable and releases capacity only after pending Git work drains',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 try{
  let entered=false;const original=f.codebases.prepare.bind(f.codebases);
  vi.spyOn(f.codebases,'prepare').mockImplementation(async(input,current)=>{entered=true;await gate;return original(input,current);});
  const preparing=f.service.handle(f.prepare);void preparing.catch(()=>{});await expect.poll(()=>entered).toBe(true);
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  const renew={action:'workspace_renew',request_id:'renew',submission:f.submission,lease_ms:100};
  await f.service.handle(renew);await vi.advanceTimersByTimeAsync(101);
  await expect(f.service.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'cancelling'});
  expect(f.files.activeCount()).toBe(1);
  await expect(f.service.handle(renew)).rejects.toThrow(/cancel|expir/i);
  release();await expect(preparing).rejects.toThrow(/cancel|expir/i);
  await new Promise(resolve=>setImmediate(resolve));
  expect(f.files.activeCount()).toBe(0);expect(f.starts()).toBe(0);
 }finally{release();await f.close();vi.useRealTimers();}
});
test('preparation renewal survives its original deadline and then yields to native turn authority',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  const renew={action:'workspace_renew',request_id:'renew',submission:f.submission,lease_ms:100};
  for(const field of ['run_id','session_id'] as const)await expect(f.service.handle({...renew,submission:{...f.submission,[field]:'foreign'}})).rejects.toThrow(/conflict|identity/i);
  await f.service.handle(renew);await vi.advanceTimersByTimeAsync(60);await f.service.handle(renew);await vi.advanceTimersByTimeAsync(60);
  await expect(f.service.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'open'});
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000});
  await vi.advanceTimersByTimeAsync(200);expect(f.store.submission('submission')?.status).toBe('running');
  await expect(f.service.handle(renew)).rejects.toThrow(/submit|prepar/i);
 }finally{await f.close();vi.useRealTimers();}
});
test('malformed native input cannot disarm a pending preparation lease',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  await f.service.handle({action:'workspace_renew',request_id:'renew',submission:f.submission,lease_ms:100});
  await f.service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding:f.submission.binding,workspace_id:'session',developer_instructions:'custom',resources:{run_id:'run',submission_id:'submission'}});
  await expect(f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:[{type:'text',text:'changed'}],lease_ms:120000})).rejects.toThrow(/digest/i);
  await vi.advanceTimersByTimeAsync(101);
  await expect(f.service.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'cancelled'});
  expect(f.files.activeCount()).toBe(0);
 }finally{await f.close();vi.useRealTimers();}
});
test.each(['expired','cancelled'] as const)('reopened Worker drains %s preparation without creating a native process',async cause=>{
 const f=await fixture();let reopened:CodexEngineService|undefined;try{
  await f.service.handle(f.prepare);await f.service.close();
  if(cause==='expired')f.db.prepare('UPDATE codex_preparation_leases SET deadline=0').run();else f.store.cancelPreparation(f.submission as any);
  reopened=new CodexEngineService(new CodexSessionStore(f.db),'worker',()=>{throw Error('Must not spawn');},{workspacePath:async()=>f.store.session('session')!.cwd,files:f.files,codebases:f.codebases});
  await expect.poll(()=>f.files.activeCount()).toBe(0);
  await expect(reopened.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'cancelled'});
 }finally{await reopened?.close();await f.close();}
});
test('failed reservation of an unknown native session leaves the preparation expiry armed',async()=>{
 const f=await fixture();try{
  await f.service.handle(f.prepare);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  await f.service.handle({action:'workspace_renew',request_id:'r',submission:f.submission,lease_ms:100});
  f.db.prepare("UPDATE codex_native_sessions SET thread_id='lost-thread',native_status='unknown'").run();
  await expect(f.service.handle({action:'submit',request_id:'s',submission:f.submission,input:f.input,lease_ms:120000})).rejects.toThrow(/active|unresolved/i);
  await vi.advanceTimersByTimeAsync(101);
  await expect(f.service.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'cancelled',session_state:'unknown'});
 }finally{await f.close();vi.useRealTimers();}
});
test('reopened Worker preserves the original preparation deadline instead of extending it',async()=>{
 const f=await fixture();let reopened:CodexEngineService|undefined,reopenedDb:Database.Database|undefined;try{
  await f.service.handle(f.prepare);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  await f.service.handle({action:'workspace_renew',request_id:'r',submission:f.submission,lease_ms:100});
  await vi.advanceTimersByTimeAsync(60);
  // Crash/restart uses the durable image before graceful close cancels work.
  reopenedDb=new Database(f.db.serialize());await f.service.close();
  reopened=new CodexEngineService(new CodexSessionStore(reopenedDb),'worker',()=>{throw Error('Must not spawn');},{workspacePath:async()=>f.store.session('session')!.cwd,files:new NativeRunFiles(reopenedDb,()=>false)});
  await expect(reopened.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'open'});
  await vi.advanceTimersByTimeAsync(41);
  await expect(reopened.handle({action:'workspace_inspect',request_id:'i',submission:f.submission})).resolves.toMatchObject({state:'cancelled'});
 }finally{await reopened?.close();reopenedDb?.close();await f.close();vi.useRealTimers();}
});
test.each(['cancel','expiry','disconnect','close','revoke'] as const)('%s interrupts actual blocked Git before freeing native preparation capacity',async mode=>{
 const f=await fixture({blockedGit:true});let preparing:Promise<unknown>|undefined,control:Promise<unknown>|undefined;
 try{
  const submission={...f.submission,codebases:[{...f.submission.codebases[0],source:{kind:'git',repository_url:'ssh://fixture.invalid/project.git'}}]};
  preparing=f.service.handle({...f.prepare,submission});void preparing.catch(()=>{});
  await expect.poll(()=>readFile(f.helperPid,'utf8').catch(()=>null)).not.toBeNull();expect(f.files.activeCount()).toBe(1);
  if(mode==='expiry'){vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});await f.service.handle({action:'workspace_renew',request_id:'renew',submission,lease_ms:100});await vi.advanceTimersByTimeAsync(101);}
  else control=mode==='cancel'?f.service.handle({action:'workspace_cancel',request_id:'cancel',submission}):mode==='disconnect'?f.service.disconnect():mode==='revoke'?f.rootPolicy.update([],'revoked',['native:submission']):f.service.close();
  void control?.catch(()=>{});
  let settled=false;void preparing.then(()=>settled=true,()=>settled=true);
  await expect.poll(()=>settled).toBe(true);await control;
  await expect(preparing).rejects.toThrow(/cancel|abort|closing|generation|authority/i);
  const pid=Number(await readFile(f.helperPid,'utf8'));
  await expect.poll(async()=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z';}catch{return true;}}).toBe(true);
  expect(f.files.activeCount()).toBe(0);expect(f.starts()).toBe(0);
 }finally{
  vi.useRealTimers();const pid=Number(await readFile(f.helperPid,'utf8').catch(()=>0));if(pid)try{process.kill(pid,'SIGKILL');}catch{}
  await preparing?.catch(()=>{});await control?.catch(()=>{});await f.close();
 }
});
