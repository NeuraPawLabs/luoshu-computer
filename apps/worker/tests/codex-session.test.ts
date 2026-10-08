import {nativeApprovalPolicy} from '../src/agent-engines/codex-policy.js';
import {withNativePolicy} from './helpers/native-policy.js';
import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
import {CodexSessionStore,CodexSessionService} from '../src/agent-engines/codex-session.js';
import type {CodexAppServerClient} from '../src/agent-engines/codex-rpc.js';

function fakeRpc(){let threads=0,turns=0;const calls:any[]=[];return{calls,client:{initialize:async()=>({}),startThread:async(input:any)=>{calls.push(['thread/start',input]);return{id:`thread-${++threads}`};},resumeThread:async(input:any)=>{calls.push(['thread/resume',input]);return{id:input.threadId};},startTurn:async(input:any)=>{calls.push(['turn/start',input]);return{id:`turn-${++turns}`,status:'inProgress'};},interruptTurn:async(input:any)=>{calls.push(['turn/interrupt',input]);},onNotification:undefined} as unknown as CodexAppServerClient};}
test('session steering validates active submission and native scope without a new turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 rpc.client.steerTurn=async params=>{rpc.calls.push(['turn/steer',params]);return{turnId:params.expectedTurnId};};
 try{
  const native=await service.submit(submission()),input=[{type:'text' as const,text:'Answer'}];
  const params={session_key:'session',submission_id:'submission',thread_id:native.thread_id,turn_id:native.turn_id,input};
  for(const patch of [{submission_id:'foreign'},{thread_id:'foreign'},{turn_id:'foreign'},{session_key:'foreign'}])await expect(service.steer({...params,...patch})).rejects.toThrow(/active|scope|identity/);
  await expect(service.steer(params)).resolves.toEqual({turnId:native.turn_id});expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
  expect(rpc.calls.find(c=>c[0]==='turn/steer')?.[1]).toEqual({threadId:native.thread_id,expectedTurnId:native.turn_id,input});
  store.settle('session',native.thread_id,native.turn_id,'completed');await expect(service.steer(params)).rejects.toThrow(/active/);
 }finally{db.close();}
});
test('lost steering acknowledgement marks the current submission unknown and prevents retry',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));let calls=0;
 rpc.client.steerTurn=async()=>{calls++;throw Object.assign(Error('lost steering response'),{code:'CODEX_RPC_UNKNOWN'});};
 try{
  const native=await service.submit(submission()),params={session_key:'session',submission_id:'submission',thread_id:native.thread_id,turn_id:native.turn_id,input:[{type:'text' as const,text:'Answer'}]};
  await expect(service.steer(params)).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});expect(store.submission('submission')?.status).toBe('unknown');
  await expect(service.steer(params)).rejects.toThrow(/active|unknown/);expect(calls).toBe(1);
 }finally{db.close();}
});
test.each(['runtime','authority'])('session steering rechecks %s before native execution',async reason=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));let calls=0;
 rpc.client.steerTurn=async()=>{calls++;return{turnId:'turn-1'};};
 try{
  const native=await service.submit(submission()),params={session_key:'session',submission_id:'submission',thread_id:native.thread_id,turn_id:native.turn_id,input:[{type:'text' as const,text:'Answer'}]};
  if(reason==='runtime')rpc.client.runtimeExecutable=async()=>{throw Error('runtime changed');};
  await expect(service.steer(params,()=>{if(reason==='authority')throw Error('authority changed');})).rejects.toThrow(reason);expect(calls).toBe(0);
 }finally{db.close();}
});
test('native session persists host-generated permissions and resumes the exact scope without legacy sandbox',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit(submission());
  const saved=JSON.parse(store.session('session')!.policy_json!);expect(saved.permissions.config.filesystem).toMatchObject({':minimal':'read','/fixture/workspace':'write','/opt/fixture/native-codex':'read'});
  const sent=rpc.calls.find(c=>c[0]==='thread/start')[1];expect(sent.permissionScope).toEqual(saved.permissions);expect(sent).not.toHaveProperty('sandbox');
  store.settle('session',first.thread_id,first.turn_id,'completed');await new CodexSessionService(store,()=>withNativePolicy(rpc.client)).submit(submission('second'));
  expect(rpc.calls.find(c=>c[0]==='thread/resume')[1].permissionScope).toEqual(saved.permissions);
 }finally{db.close();}
});
test('native session passes the Worker danger-full-access mode into direct App Server threads',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace',sandboxMode:async()=>'danger-full-access'});
 try{
  await service.prepare({session_key:'session',binding,workspace_id:'workspace'});
  const params=rpc.calls.find(c=>c[0]==='thread/start')?.[1];
  expect(params.permissionScope.config).toEqual({filesystem:{':root':'write'},network:{enabled:true}});
  expect(params.permissionScope.config.filesystem).not.toHaveProperty('/fixture/workspace');
 }finally{db.close();}
});
test('changing Worker sandbox mode replaces a persisted workspace Session policy before the next turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),firstService=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{sandboxMode:async()=>'workspace-write'});
 try{
  const first=await firstService.submit(submission());store.settle('session',first.thread_id,first.turn_id,'completed');
  const secondService=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{sandboxMode:async()=>'danger-full-access'});
  await secondService.submit(submission('full-access'));
  const resumed=rpc.calls.filter(c=>c[0]==='thread/resume').at(-1)?.[1];
  expect(resumed.permissionScope.config).toEqual({filesystem:{':root':'write'},network:{enabled:true}});
  expect(JSON.parse(store.session('session')!.policy_json!).permissions.config).toEqual({filesystem:{':root':'write'},network:{enabled:true}});
 }finally{db.close();}
});
test('native session refuses a changed runtime or missing profile before a new turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let runtime='/opt/fixture/native-codex';
 (rpc.client as any).runtimeExecutable=async()=>runtime;
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit(submission());store.settle('session',first.thread_id,first.turn_id,'completed');runtime='/fixture/changed-codex';
  await expect(service.submit(submission('changed'))).rejects.toThrow(/runtime|scope/);
  expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
test.each(['submit','prepare'] as const)('runtime drift before %s does not poison an untouched session or reserve an unknown turn',async action=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace'});
 const prepare={session_key:'session',binding,workspace_id:'workspace'};
 try{
  await service.prepare(prepare);const first=await service.submit(submission());store.settle('session',first.thread_id,first.turn_id,'completed');
  const before=store.session('session'),calls=rpc.calls.length;
  rpc.client.runtimeExecutable=async()=>{throw Object.assign(Error('runtime replaced'),{code:'CODEX_RUNTIME_CHANGED'});};
  await expect(action==='submit'?service.submit(submission('second')):service.prepare(prepare)).rejects.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
  expect(store.session('session')).toEqual(before);expect(store.submission('second')).toBeUndefined();expect(rpc.calls).toHaveLength(calls);
  expect(await service.submit(submission())).toEqual(first);expect(rpc.calls).toHaveLength(calls);
 }finally{db.close();}
});
test('runtime drift never prevents interrupting a turn that was already accepted',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit(submission());
  rpc.client.runtimeExecutable=async()=>{throw Object.assign(Error('runtime replaced'),{code:'CODEX_RUNTIME_CHANGED'});};
  await service.interrupt('session',first.turn_id);expect(rpc.calls.at(-1)).toEqual(['turn/interrupt',{threadId:first.thread_id,turnId:first.turn_id}]);
 }finally{db.close();}
});
test('native session cannot start or resume with an inherited colliding permissions profile',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();
 (rpc.client as any).assertPermissionProfileAvailable=async()=>{throw Error('Native permission profile name collides with inherited configuration');};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  await expect(service.submit(submission())).rejects.toThrow(/collides/);
  expect(rpc.calls).toEqual([]);expect(store.active('session')?.status).toBe('unknown');
 }finally{db.close();}
});
test('prepared empty native thread is used in-place instead of resuming an unavailable rollout',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();
 rpc.client.resumeThread=async()=>{throw Error('no rollout found');};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace'});
 try{
  await service.prepare({session_key:'session',binding,workspace_id:'workspace'});
  await expect(service.submit(submission())).resolves.toMatchObject({thread_id:'thread-1',turn_id:'turn-1'});
  expect(rpc.calls.filter(c=>c[0]==='thread/start')).toHaveLength(1);
 }finally{db.close();}
});
test('native thread closed notification invalidates only that loaded thread and next turn resumes its exact identity',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit(submission());store.settle('session',first.thread_id,first.turn_id,'completed');
  service.threadClosed('foreign');await service.submit(submission('second'));expect(rpc.calls.filter(c=>c[0]==='thread/resume')).toHaveLength(0);
  store.settle('session',first.thread_id,'turn-2','completed');service.threadClosed(first.thread_id);
  const third=await service.submit(submission('third'));expect(third.thread_id).toBe(first.thread_id);
  expect(rpc.calls.filter(c=>c[0]==='thread/resume')).toMatchObject([['thread/resume',{threadId:first.thread_id}]]);
 }finally{db.close();}
});
test('Run roots are replaced on the loaded thread without resume or a changed permission profile',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace'});
 const resources={resourceRoot:'/state/run-a',read:['/state/run-a/references/app'],write:['/state/run-a/targets/app']};
 try{
  await service.prepare({session_key:'session',binding,workspace_id:'workspace',resources});
  const first=await service.submit({...submission(),resources});
  expect(rpc.calls.filter(c=>c[0]==='thread/resume')).toHaveLength(0);
  const policy=JSON.parse(store.session('session')!.policy_json!);expect(policy.permissions.config.filesystem[':workspace_roots']).toEqual({'references/app':'read','targets/app':'write'});
  store.settle('session',first.thread_id,first.turn_id,'completed');
  await service.submit({...submission('second'),resources:{resourceRoot:'/state/run-b',read:['/state/run-b/references/app'],write:['/state/run-b/targets/app']}});
  const next=JSON.parse(store.session('session')!.policy_json!);expect(next.permissions.id).toBe(policy.permissions.id);expect(next.permissions.runtimeWorkspaceRoots).toEqual(['/state/run-b']);expect(next.model).toBe(policy.model);
  store.settle('session',first.thread_id,'turn-2','completed');await service.submit(submission('plain'));
  expect(rpc.calls.filter(c=>c[0]==='thread/resume')).toHaveLength(0);
  expect(rpc.calls.filter(c=>c[0]==='turn/start').map(c=>c[1].runtimeWorkspaceRoots)).toEqual([['/state/run-a'],['/state/run-b'],[]]);
  expect(store.submissionPolicy('second')?.policy.permissions.runtimeWorkspaceRoots).toEqual(['/state/run-b']);
 }finally{db.close();}
});
test('an empty prepared Codebase thread can change Run roots before its first turn without requiring a rollout',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();rpc.client.resumeThread=async()=>{throw Error('no rollout found');};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace'});
 try{
  await service.prepare({session_key:'session',binding,workspace_id:'workspace',resources:{resourceRoot:'/state/first',read:[],write:['/state/first/targets/app']}});
  await expect(service.submit({...submission(),resources:{resourceRoot:'/state/second',read:[],write:['/state/second/targets/app']}})).resolves.toMatchObject({thread_id:'thread-1'});
  expect(rpc.calls.filter(c=>c[0]==='thread/start')).toHaveLength(1);expect(rpc.calls.find(c=>c[0]==='turn/start')[1].runtimeWorkspaceRoots).toEqual(['/state/second']);
 }finally{db.close();}
});
test('real native loaded-thread behavior returning its old profile cannot start the next Codebase turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit({...submission(),resources:{read:[],write:['/state/first']}});
  store.settle('session',first.thread_id,first.turn_id,'completed');
  const saved=JSON.parse(store.session('session')!.policy_json!);
  // Codex 0.160.0 resume on an already-loaded thread ignores changed profile.
  rpc.client.resumeThread=async()=>({id:first.thread_id,policy:saved,activePermissionProfile:{id:saved.permissions.id,extends:null},runtimeWorkspaceRoots:[saved.cwd]});
  await expect(service.submit({...submission('second'),resources:{read:[],write:['/state/second']}})).rejects.toThrow(/profile identity/);
  expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
  expect(store.session('session')?.native_status).toBe('unknown');expect(store.submission('second')?.status).toBe('unknown');
  expect(JSON.parse(store.session('session')!.policy_json!)).toEqual(saved);
 }finally{db.close();}
});
const binding={conversation_id:'conversation',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'worker',agent:'codex' as const,adapter_version:1}};
test('prepare maps a workspace through the Worker resolver and persists one thread',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async id=>id==='workspace'?'/home/alice/luoshu':null});
 const prepared=await service.prepare({session_key:'conversation:agent:alice:1',binding,workspace_id:'workspace'});expect(prepared).toMatchObject({thread_id:'thread-1'});expect(rpc.calls).toMatchObject([['thread/start',{cwd:'/home/alice/luoshu',serviceName:'luoshu',permissionScope:{cwd:'/home/alice/luoshu'},approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user'}]]);expect(await service.prepare({session_key:'conversation:agent:alice:1',binding,workspace_id:'workspace'})).toEqual(prepared);expect(rpc.calls).toHaveLength(1);db.close();
});
test('unknown workspace is rejected before spawning App Server',async()=>{const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>null});await expect(service.prepare({session_key:'key',binding,workspace_id:'missing'})).rejects.toThrow(/workspace/i);expect(rpc.calls).toEqual([]);db.close();});
test('native thread start and resume enforce workspace sandbox and user approvals',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
  try{const first=await service.submit(submission());expect(rpc.calls[0][1]).toMatchObject({permissionScope:{cwd:'/fixture/workspace'},approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user'});
  store.settle('session',first.thread_id,first.turn_id,'completed');await new CodexSessionService(store,()=>withNativePolicy(rpc.client)).submit(submission('next'));
  expect(rpc.calls.find(c=>c[0]==='thread/resume')[1]).toMatchObject({cwd:'/fixture/workspace',permissionScope:{cwd:'/fixture/workspace'},approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user'});
 }finally{db.close();}
});
test('resolved native model policy persists and a silently changed resume never starts a second turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 const policy={cwd:'/fixture/workspace',model:'fixture-model',modelProvider:'fixture-provider',reasoningEffort:'low',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
 rpc.client.startThread=async()=>({id:'thread',policy}) as any;rpc.client.resumeThread=async()=>({id:'thread',policy:{...policy,model:'different'}}) as any;
 try{
  const first=await service.submit(submission());expect(JSON.parse(store.session('session')!.policy_json!)).toMatchObject(policy);store.settle('session',first.thread_id,first.turn_id,'completed');
  await expect(new CodexSessionService(store,()=>withNativePolicy(rpc.client)).submit(submission('next'))).rejects.toThrow(/policy|configuration|model/i);expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
test('first submit creates one native thread; later submit reuses the loaded thread',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 const binding={conversation_id:'conversation',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1} as const};
 const firstInput=[{type:'text',text:'hello'}],first=await service.submit({session_key:'conversation:agent:alice:1',binding,cwd:'/tmp/workspace',input:firstInput,input_sha256:createHash('sha256').update(JSON.stringify(firstInput)).digest('hex'),submission_id:'11111111-1111-4111-8111-111111111111'});
 expect(first.thread_id).toBe('thread-1');expect(first.turn_id).toBe('turn-1');
 store.settle('conversation:agent:alice:1',first.thread_id,first.turn_id,'completed');
 const secondInput=[{type:'text',text:'again'}],second=await service.submit({session_key:'conversation:agent:alice:1',binding,cwd:'/tmp/workspace',input:secondInput,input_sha256:createHash('sha256').update(JSON.stringify(secondInput)).digest('hex'),submission_id:'22222222-2222-4222-8222-222222222222'});
 expect(second.thread_id).toBe('thread-1');expect(rpc.calls.map(c=>c[0])).toEqual(['thread/start','turn/start','turn/start']);
 db.close();
});
test('loaded thread cannot reuse a saved approval policy permitting escalation',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{
  const first=await service.submit(submission());store.settle('session',first.thread_id,first.turn_id,'completed');
  const saved=JSON.parse(store.session('session')!.policy_json!);saved.approvalPolicy='on-request';
  db.prepare('UPDATE codex_native_sessions SET policy_json=? WHERE session_key=?').run(JSON.stringify(saved),'session');
  await expect(service.submit(submission('next'))).rejects.toThrow();
  expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
function submission(id='submission'){
 const input=[{type:'text',text:'once'}];return{session_key:'session',binding:{...binding,engine:{...binding.engine,adapter_version:1 as const}},cwd:'/fixture/workspace',input,input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),submission_id:id};
}
test('running turn locks its session even after acknowledgement and across service instances',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{const first=await service.submit(submission());const reopened=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
  await expect(reopened.submit(submission('next'))).rejects.toMatchObject({code:'CODEX_SESSION_BUSY'});
  expect(()=>store.settle('session','wrong-thread',first.turn_id,'completed')).toThrow();
  await expect(reopened.submit(submission('next'))).rejects.toThrow(/active|unresolved/i);
  store.settle('session',first.thread_id,first.turn_id,'completed');
  expect((await reopened.submit(submission('next'))).thread_id).toBe(first.thread_id);
 }finally{db.close();}
});
test('reservation is durable before thread creation and blocks a concurrent second submission',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let release!:(v:any)=>void;
 rpc.client.startThread=async()=>{expect(store.submission('submission')).toMatchObject({status:'prepared'});return new Promise(resolve=>release=resolve);};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));try{
  const first=service.submit(submission());await expect.poll(()=>Boolean(release)).toBe(true);
  await expect(new CodexSessionService(store,()=>withNativePolicy(rpc.client)).submit(submission('other'))).rejects.toMatchObject({code:'CODEX_SESSION_BUSY'});
  release({id:'thread'});await first;expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
test('lost thread acknowledgement never causes a new thread or turn on retry',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let calls=0;
 rpc.client.startThread=async()=>{calls++;throw Object.assign(Error('lost response'),{code:'CODEX_RPC_UNKNOWN'});};
 try{const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));await expect(service.submit(submission())).rejects.toThrow();
  expect(store.submission('submission')).toMatchObject({status:'unknown'});
  await expect(service.submit(submission())).rejects.toMatchObject({code:'CODEX_SUBMISSION_UNKNOWN'});
  await expect(service.submit(submission('next'))).rejects.toMatchObject({code:'CODEX_SESSION_BUSY'});expect(calls).toBe(1);
 }finally{db.close();}
});
test('lost turn acknowledgement is unknown and retains the execution lock',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let calls=0;
 rpc.client.startTurn=async()=>{calls++;throw Object.assign(Error('lost response'),{code:'CODEX_RPC_UNKNOWN'});};
 try{const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));await expect(service.submit(submission())).rejects.toThrow();
  expect(store.submission('submission')).toMatchObject({status:'unknown',turn_id:null,thread_id:'thread-1'});
  await expect(service.submit(submission('next'))).rejects.toThrow();expect(calls).toBe(1);
 }finally{db.close();}
});
test.each(['actor','worker','revision','cwd'])('submission replay validates the complete %s binding',async field=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{const input=submission();await service.submit(input);const next=structuredClone(input);
  if(field==='actor')next.binding.actor_id='bob';if(field==='worker')next.binding.engine.worker_id='other';if(field==='revision')next.binding.authorization_revision=2;if(field==='cwd')next.cwd='/another';
  await expect(service.submit(next)).rejects.toThrow(/binding|workspace|conflict|revision/i);
 }finally{db.close();}
});
test('concurrent duplicate submission reuses one outstanding promise and native turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{const [one,two]=await Promise.all([service.submit(submission()),service.submit(submission())]);expect(one).toEqual(two);expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);}finally{db.close();}
});
test('duplicate submission is idempotent; same ID with changed input conflicts',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client)),binding={conversation_id:'conversation',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1} as const};
 const inputBody=[{type:'text',text:'once'}],input={session_key:'key',binding,cwd:'/tmp/workspace',input:inputBody,input_sha256:createHash('sha256').update(JSON.stringify(inputBody)).digest('hex'),submission_id:'33333333-3333-4333-8333-333333333333'};const one=await service.submit(input),two=await service.submit(input);expect(two).toEqual(one);expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);await expect(service.submit({...input,input_sha256:'b'.repeat(64)})).rejects.toThrow(/conflict|digest/i);db.close();
});
test('interrupt acknowledgement retains lock until exact native terminal reconciliation',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));let nativeStatus='inProgress';
 rpc.client.readThread=async()=>({thread:{id:'thread-1',turns:[{id:'turn-1',status:nativeStatus,items:[]}]}});
 try{await service.submit(submission());await service.interrupt('session','turn-1');
  expect(store.active('session')?.status).toBe('stopping');expect(await service.reconcile('session')).toBe('running');
  await expect(service.submit(submission('second'))).rejects.toThrow();nativeStatus='interrupted';
  expect(await service.reconcile('session')).toBe('idle');expect(store.submission('submission')?.status).toBe('cancelled');
  await service.submit(submission('second'));
 }finally{db.close();}
});
test('native read cannot clear a lock with a different thread or a merely similar turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));
 try{await service.submit(submission());rpc.client.readThread=async()=>({thread:{id:'wrong',turns:[{id:'turn-1',status:'completed'}]}});
  await expect(service.reconcile('session')).rejects.toThrow(/identity|thread/i);
  rpc.client.readThread=async()=>({thread:{id:'thread-1',turns:[{id:'other-turn',status:'completed'}]}});
  expect(await service.reconcile('session')).toBe('unknown');expect(store.active('session')).toBeDefined();
 }finally{db.close();}
});
test('unacknowledged native turn cannot be identified by similar input on reconciliation',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client));let reads=0;
 rpc.client.startTurn=async()=>{throw Error('lost acknowledgement');};rpc.client.readThread=async()=>{reads++;return{thread:{id:'thread-1',turns:[{id:'looks-similar',status:'completed',items:[]}]}};};
 try{await expect(service.submit(submission())).rejects.toThrow();expect(await service.reconcile('session')).toBe('unknown');expect(reads).toBe(0);expect(store.active('session')).toBeDefined();}finally{db.close();}
});
test('session binding revision change refuses thread reuse and unknown native turn is explicit',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc(),service=new CodexSessionService(store,()=>withNativePolicy(rpc.client)),base={session_key:'key',binding:{conversation_id:'conversation',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1} as const},input:[{type:'text',text:'once'}],input_sha256:'a'.repeat(64),submission_id:'44444444-4444-4444-8444-444444444444'};
 const digest=createHash('sha256').update(JSON.stringify(base.input)).digest('hex');await service.submit({...base,cwd:'/tmp/workspace',input_sha256:digest});const nextInput=[{type:'text',text:'next'}];await expect(service.submit({...base,cwd:'/tmp/workspace',submission_id:'55555555-5555-4555-8555-555555555555',binding:{...base.binding,authorization_revision:2},input:nextInput,input_sha256:createHash('sha256').update(JSON.stringify(nextInput)).digest('hex')})).rejects.toThrow(/authorization|binding|revision/i);db.close();
});
test('reconciliation persists recovered final content before releasing its session lock',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let saved=false;
 rpc.client.readThread=async()=>({thread:{id:'thread-1',turns:[{id:'turn-1',status:'completed',items:[{type:'agentMessage',id:'answer',text:'Saved final',phase:'final_answer'}]}]}});
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>null,onRecoveredTurn:(row,turn)=>{expect(store.active('session')).toBeDefined();expect(turn.items).toHaveLength(1);saved=true;}});
 try{await service.submit(submission());expect(await service.reconcile('session')).toBe('idle');expect(saved).toBe(true);}finally{db.close();}
});
test('a dead native client is replaced only for explicit reconciliation, never by replaying a turn',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let dead=false,replacements=0;
 Object.defineProperty(rpc.client,'isClosed',{get:()=>dead});
 const initialize=rpc.client.initialize.bind(rpc.client);rpc.client.initialize=async p=>{if(dead)throw Error('native process closed');return initialize(p);};
 const reader:any={initialize:async()=>({}),readThread:async({threadId}:any)=>({thread:{id:threadId,turns:[{id:'turn-1',status:'completed',items:[]}]}})};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace',recoverClient:()=>{replacements++;return reader;}});
 try{
  await service.submit(submission());dead=true;
  await expect(service.submit(submission('different'))).rejects.toThrow(/unresolved|active/);expect(replacements).toBe(0);
  expect(await service.reconcile('session')).toBe('idle');expect(replacements).toBe(1);
  expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
test('concurrent explicit reconciliation has one replacement-client owner',async()=>{
 const db=new Database(':memory:'),store=new CodexSessionStore(db),rpc=fakeRpc();let dead=false,replacements=0;
 Object.defineProperty(rpc.client,'isClosed',{get:()=>dead});
 const reader:any={initialize:async()=>({}),readThread:async({threadId}:any)=>({thread:{id:threadId,turns:[{id:'turn-1',status:'completed',items:[]}]}})};
 const service=new CodexSessionService(store,()=>withNativePolicy(rpc.client),{workspacePath:async()=>'/fixture/workspace',recoverClient:async()=>{replacements++;await Promise.resolve();return reader;}});
 try{
  await service.submit(submission());dead=true;
  expect(await Promise.all([service.reconcile('session'),service.reconcile('session')])).toEqual(['idle','idle']);
  expect(replacements).toBe(1);expect(rpc.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1);
 }finally{db.close();}
});
