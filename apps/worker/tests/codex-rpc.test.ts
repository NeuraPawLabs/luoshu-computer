import {nativeApprovalPolicy} from '../src/agent-engines/codex-policy.js';
import {EventEmitter} from 'node:events';
import {spawn as spawnProcess} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {expect,test,vi} from 'vitest';
import {CodexAppServerClient,type CodexRpcProcess} from '../src/agent-engines/codex-rpc.js';
import {nativePermissions} from '../src/agent-engines/native-permissions.js';

class FakeProcess extends EventEmitter implements CodexRpcProcess {
 readonly sent:any[]=[];readonly stdout=new PassThrough();readonly stderr=new PassThrough();
 readonly stdin=new Writable({write:(value,_encoding,done)=>{const request=JSON.parse(value.toString());this.sent.push(request);this.emit('request',request);done();},final:done=>{done();queueMicrotask(()=>this.emit('close',0));}});
 killed=false;
 kill(){this.killed=true;queueMicrotask(()=>this.emit('close',null));return true;}
 line(value:unknown){this.stdout.write(Buffer.from(JSON.stringify(value)+'\n'));}
 respond(id:number|string,result:unknown){this.line({id,result});}
}
test('managed wrapper close retains RPC fence until independent native exit confirmation succeeds',async()=>{
 const child=new FakeProcess();let verified=false,checks=0;
 (child as any).confirmNativeExit=async()=>{checks++;if(!verified)throw Error('cgroup remains active');};
 const client=new CodexAppServerClient({spawn:()=>child});
 const initial=client.initialize({clientInfo:{name:'fixture',version:'1'}});child.respond(1,{userAgent:'fixture/0.160.0'});await initial;
 child.emit('exit',0);child.emit('close',0);await new Promise(r=>setImmediate(r));
 expect(client.hasExited).toBe(false);expect(checks).toBeGreaterThan(0);
 verified=true;await client.close();expect(client.hasExited).toBe(true);expect(checks).toBeGreaterThan(1);
 expect(child.sent.filter(x=>x.method==='initialize')).toHaveLength(1);
});
test('managed close can retry after timeout without leaving an immutable rejected close promise',async()=>{
 const child=new FakeProcess();child.stdin.end=()=>child.stdin;child.kill=()=>true;
 let verified=false;(child as any).confirmNativeExit=async()=>{if(!verified)throw Error('not stopped');};
 const client=new CodexAppServerClient({spawn:()=>child});const initial=client.initialize({clientInfo:{name:'fixture',version:'1'}});child.respond(1,{userAgent:'fixture/0.160.0'});await initial;
 vi.useFakeTimers();
 try{
  const closing=client.close(),rejected=expect(closing).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});await vi.advanceTimersByTimeAsync(6001);await rejected;
  child.emit('exit',0);child.emit('close',0);await vi.advanceTimersByTimeAsync(1);expect(client.hasExited).toBe(false);
  verified=true;await expect(client.close()).resolves.toBeUndefined();expect(client.hasExited).toBe(true);
 }finally{vi.useRealTimers();}
});
test('close drains pending durable lease acquisition before callers can close the database',async()=>{
 let resolveLease!:(lease:any)=>void,entered=false,released=false;
 const client=new CodexAppServerClient({executable:process.execPath,nativeLease:()=>{entered=true;return new Promise(resolve=>resolveLease=resolve);}});
 const initializing=client.initialize({clientInfo:{name:'fixture',version:'1'}});void initializing.catch(()=>{});
 await expect.poll(()=>entered).toBe(true);let closed=false;const closing=client.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));
 try{
  expect(closed).toBe(false);resolveLease({released:()=>released=true});
  await expect(initializing).rejects.toThrow(/closed/);await closing;expect(released).toBe(true);expect(client.hasExited).toBe(true);
 }finally{resolveLease({released:()=>released=true});await initializing.catch(()=>{});await closing;}
});
const initParams={clientInfo:{name:'luoshu',version:'test'},capabilities:{experimentalApi:true}};
const initResult={userAgent:'codex/0.160.0',platformFamily:'unix',platformOs:'linux',codexHome:'/fixture'};
const permissionScope=nativePermissions({session:'rpc-test',cwd:'/fixture',runtime:'/opt/codex',read:[],write:[]});
const provenance={activePermissionProfile:{id:permissionScope.id,extends:null},runtimeWorkspaceRoots:['/fixture']};
test('turn steering targets the expected native turn and accepts only that turn acknowledgement',async()=>{
 const {process,client}=await ready();try{
  const params={threadId:'thread',expectedTurnId:'turn',input:[{type:'text' as const,text:'Answer'}]};
  const pending=client.steerTurn(params);expect(process.sent.at(-1)).toMatchObject({method:'turn/steer',params});
  process.respond(process.sent.at(-1).id,{turnId:'turn'});await expect(pending).resolves.toEqual({turnId:'turn'});
  const mismatch=client.steerTurn(params);process.respond(process.sent.at(-1).id,{turnId:'other'});await expect(mismatch).rejects.toMatchObject({code:'CODEX_RPC_PROTOCOL_ERROR'});
  const invalid=client.steerTurn(params);process.respond(process.sent.at(-1).id,{});await expect(invalid).rejects.toMatchObject({code:'CODEX_RPC_PROTOCOL_ERROR'});
 }finally{await client.close();}
});
test('lost exact-turn steering acknowledgement never creates or queues another turn',async()=>{
 const {process,client}=await ready();try{
  const pending=client.steerTurn({threadId:'thread',expectedTurnId:'turn',input:[{type:'text',text:'Answer'}]});void pending.catch(()=>{});
  process.emit('close',1);await expect(pending).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
  expect(process.sent.map(m=>m.method)).toEqual(['initialize','initialized','turn/steer']);
 }finally{await client.close();}
});
test('host-scoped thread request sends named permissions and validates actual profile without retaining full response',async()=>{
 const {process,client}=await ready(),permissions=nativePermissions({session:'test',cwd:'/fixture',runtime:'/opt/codex',read:[],write:[]});
 try{
  const pending=client.startThread({cwd:'/fixture',permissionScope:permissions});void pending.catch(()=>{});
  expect(process.sent.at(-1).params).toMatchObject({permissions:permissions.id,config:{['permissions.'+permissions.id]:permissions.config}});
  expect(process.sent.at(-1).params).not.toHaveProperty('permissionScope');expect(process.sent.at(-1).params).not.toHaveProperty('sandbox');
  process.respond(process.sent.at(-1).id,{thread:{id:'t'},cwd:'/fixture',model:'fixture',modelProvider:'fixture',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true},activePermissionProfile:{id:permissions.id,extends:null},runtimeWorkspaceRoots:['/fixture'],private:'DO_NOT_SAVE'});
  const result=await pending;expect(result.policy.permissions).toEqual(permissions);expect(JSON.stringify(result)).not.toContain('DO_NOT_SAVE');
 }finally{await client.close();}
});
test.each([
 {activePermissionProfile:{id:permissionScope.id,extends:':workspace'}},
 {activePermissionProfile:{id:'different'}},
 {runtimeWorkspaceRoots:['/fixture','/home/user']},
])('native RPC refuses mismatched named permission provenance: %j',async patch=>{
 const {process,client}=await ready();try{
  const pending=client.startThread({cwd:'/fixture',permissionScope});
  process.respond(process.sent.at(-1).id,{...provenance,...patch,thread:{id:'thread'},cwd:'/fixture',model:'m',modelProvider:'p',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}});
  await expect(pending).rejects.toThrow();
 }finally{await client.close();}
});
test('native host permission scope cannot be overwritten with legacy sandbox config or mixed selectors',async()=>{
 const {process,client}=await ready();try{
  for(const params of [{cwd:'/fixture',permissionScope,sandbox:'workspace-write'},{cwd:'/fixture',permissionScope,config:{sandbox_mode:'danger-full-access'}},{cwd:'/fixture',permissionScope,config:{permissions:{broad:{filesystem:{':root':'write'}}}}}])expect(()=>client.startThread(params as any)).toThrow(/permission/);
  expect(process.sent.map(m=>m.method)).toEqual(['initialize','initialized']);
 }finally{await client.close();}
});
test('inherited native profile definitions cannot merge extra roots into the host profile',async()=>{
 const {process,client}=await ready();try{
  const pending=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);
  expect(process.sent.at(-1)).toMatchObject({method:'config/read',params:{cwd:'/fixture',includeLayers:false}});
  process.respond(process.sent.at(-1).id,{config:{permissions:{[permissionScope.id]:{filesystem:{':root':'write'}}},provider_credentials:'DO_NOT_EXPOSE'}});
  await expect(pending).rejects.toThrow('Native permission profile name collides with inherited configuration');
  const allowed=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);process.respond(process.sent.at(-1).id,{config:{permissions:{unrelated:{filesystem:{':root':'write'}}}}});
  await expect(allowed).resolves.toBeUndefined();
  const empty=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);process.respond(process.sent.at(-1).id,{config:{permissions:null}});await expect(empty).resolves.toBeUndefined();
 }finally{await client.close();}
});
test('native profile check accepts unrelated extensions and security settings without exporting them',async()=>{
 const {process,client}=await ready();try{
  const pending=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);
  process.respond(process.sent.at(-1).id,{config:{mcp_servers:{fixture:{bearer_token:'FIXTURE_MCP_SECRET'}},plugins:{fixture:{enabled:true}},approval_policy:'on-request',sandbox_mode:'workspace-write',permissions:{unrelated:{filesystem:{':root':'write'}}}}});
  await expect(pending).resolves.toBeUndefined();
  expect(process.sent.at(-1)).toMatchObject({method:'config/read',params:{cwd:'/fixture',includeLayers:false}});
  expect(JSON.stringify(process.sent)).not.toContain('FIXTURE_MCP_SECRET');
 }finally{await client.close();}
});
test.each([{}, {config:null}, {config:[]}, {config:{permissions:42}}])('native profile check still rejects malformed effective configuration: %j',async response=>{
 const {process,client}=await ready();try{
  const pending=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);
  process.respond(process.sent.at(-1).id,response);
  await expect(pending).rejects.toThrow('Native effective configuration is unavailable');
 }finally{await client.close();}
});
test('native profile check does not require a native home or enumerate user skills',async()=>{
 const {process,client}=await ready({}, {userAgent:initResult.userAgent});try{
  const pending=client.assertPermissionProfileAvailable('/fixture',permissionScope.id);
  process.respond(process.sent.at(-1).id,{config:{permissions:null}});
  await expect(pending).resolves.toBeUndefined();
  expect(process.sent.map(r=>r.method)).toEqual(['initialize','initialized','config/read']);
 }finally{await client.close();}
});
test('thread config cannot override the host approval policy or reviewer',async()=>{
 const {process,client}=await ready();try{
  for(const config of [{approval_policy:'on-request'},{'approval_policy.granular.sandbox_approval':true},{approvals_reviewer:'auto_review'}])expect(()=>{const result=client.startThread({cwd:'/fixture',permissionScope,config});void result.catch(()=>{});}).toThrow(/approval|permission/i);
  expect(process.sent.map(m=>m.method)).toEqual(['initialize','initialized']);
 }finally{await client.close();}
});
test('background stop uses app-server process identity and validates its acknowledgement',async()=>{
 const {process,client}=await ready();try{
  const pending=client.terminateBackgroundTerminal({threadId:'thread',processId:'app-process'});
  expect(process.sent.at(-1)).toMatchObject({method:'thread/backgroundTerminals/terminate',params:{threadId:'thread',processId:'app-process'}});
  process.respond(process.sent.at(-1).id,{terminated:true});expect(await pending).toEqual({terminated:true});
  const malformed=client.terminateBackgroundTerminal({threadId:'thread',processId:'app-process'});
  process.respond(process.sent.at(-1).id,{});await expect(malformed).rejects.toThrow();
 }finally{await client.close();}
});
async function ready(options:Record<string,unknown>={},handshake:unknown=initResult){
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process,requestTimeoutMs:1000,...options});
 const initialize=client.initialize(initParams);process.respond(process.sent[0].id,handshake);await initialize;return{process,client};
}
test('binding cleanup unsubscribes by saved thread and validates the native acknowledgement',async()=>{
 const {process,client}=await ready();try{
  const first=client.unsubscribeThread({threadId:'owned'});expect(process.sent.at(-1)).toMatchObject({method:'thread/unsubscribe',params:{threadId:'owned'}});
  process.respond(process.sent.at(-1).id,{status:'notLoaded'});await expect(first).resolves.toEqual({status:'notLoaded'});
  const second=client.unsubscribeThread({threadId:'owned'});process.respond(process.sent.at(-1).id,{});await expect(second).rejects.toThrow();
  expect(process.sent.some(m=>m.method==='thread/delete'||m.method==='thread/start')).toBe(false);
 }finally{await client.close();}
});
test('initialize is once per connection and acknowledged before native requests',async()=>{
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process});
 const first=client.initialize(initParams),second=client.initialize(initParams);expect(process.sent).toHaveLength(1);
 expect(process.sent[0]).toEqual({method:'initialize',id:1,params:initParams});
 process.respond(1,initResult);await Promise.all([first,second]);
 expect(process.sent[1]).toEqual({method:'initialized',params:{}});
 const thread=client.startThread({cwd:'/fixture',permissionScope,developerInstructions:'Extra instructions',approvalPolicy:nativeApprovalPolicy});
 expect(process.sent[2]).toMatchObject({method:'thread/start',params:{cwd:'/fixture',developerInstructions:'Extra instructions',permissions:permissionScope.id,approvalPolicy:nativeApprovalPolicy}});
 process.respond(process.sent[2].id,{...provenance,thread:{id:'thread',sessionId:'root'},cwd:'/fixture',model:'fixture',modelProvider:'fixture',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}});await expect(thread).resolves.toMatchObject({id:'thread',sessionId:'root'});
 await client.close();
});
test.each(['codex/ (Linux)','missing version'])('initialize refuses malformed native protocol handshake: %s',async userAgent=>{
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process});
 const pending=client.initialize(initParams);process.respond(1,{...initResult,userAgent});
 await expect(pending).rejects.toThrow(/version|protocol/i);expect(process.sent.some(m=>m.method==='initialized')).toBe(false);await client.close();
});
test('initialize accepts the verified Codex patch release',async()=>{
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process});
 const pending=client.initialize(initParams);process.respond(1,{...initResult,userAgent:'codex/0.160.1 (Linux)'});
 await expect(pending).resolves.toMatchObject({userAgent:'codex/0.160.1 (Linux)'});await client.close();
});
test('initialize accepts a newer semver without a hard-coded version gate',async()=>{
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process});
 const pending=client.initialize(initParams);process.respond(1,{...initResult,userAgent:'codex/0.161.0 (Linux)'});
 await expect(pending).resolves.toMatchObject({userAgent:'codex/0.161.0 (Linux)'});await client.close();
});
test('native operations cannot bypass the initialization handshake',async()=>{
 const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>process});
 expect(()=>client.startTurn({threadId:'thread',input:[{type:'text',text:'hello'}]})).toThrow(/not initialized/i);
 expect(process.sent).toEqual([]);await client.close();
});
test('account readiness reads the active provider without refreshing credentials or exposing account fields',async()=>{
 const {process,client}=await ready();try{
  const pending=client.readAccount();expect(process.sent.at(-1)).toMatchObject({method:'account/read',params:{refreshToken:false}});
  process.respond(process.sent.at(-1).id,{account:null,requiresOpenaiAuth:true});
  await expect(pending).rejects.toMatchObject({code:'CODEX_LOGIN_REQUIRED'});
  const external=client.readAccount();process.respond(process.sent.at(-1).id,{account:null,requiresOpenaiAuth:false});await expect(external).resolves.toEqual({requiresOpenaiAuth:false,accountPresent:false});
  const account=client.readAccount();process.respond(process.sent.at(-1).id,{account:{type:'chatgpt',email:'secret@example.test',planType:'pro'},requiresOpenaiAuth:true});await expect(account).resolves.toEqual({requiresOpenaiAuth:true,accountPresent:true});
 }finally{await client.close();}
});
test('malformed account readiness responses fail closed without accepting arbitrary account data',async()=>{
 const {process,client}=await ready();try{
  const pending=client.readAccount();process.respond(process.sent.at(-1).id,{account:'secret',requiresOpenaiAuth:true});await expect(pending).rejects.toMatchObject({code:'CODEX_PROTOCOL_ERROR'});
 }finally{await client.close();}
});
test.each([{}, {type:'unknown'}, {type:'chatgpt'}, {type:'chatgpt',email:15,planType:'pro'}, {type:'amazonBedrock',usesCodexManagedCredentials:'yes'}])('account/read rejects a malformed account object: %j',async account=>{
 const {process,client}=await ready();try{
  const pending=client.readAccount();process.respond(process.sent.at(-1).id,{account,requiresOpenaiAuth:true});
  await expect(pending).rejects.toMatchObject({code:'CODEX_PROTOCOL_ERROR'});
 }finally{await client.close();}
});
test('UTF-8 split chunks preserve Chinese and stderr is never an RPC input',async()=>{
 const {process,client}=await ready(),seen:unknown[]=[];client.onNotification=(method,params)=>seen.push({method,params});
 const bytes=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'中文，测试'}})+'\n');
 for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
 process.stderr.write(JSON.stringify({method:'fake',params:{secret:'no'}})+'\n');
 expect(seen).toEqual([{method:'item/agentMessage/delta',params:{delta:'中文，测试'}}]);await client.close();
});
test('string and numeric server request ids remain distinct; unknown methods are denied',async()=>{
 const seen:unknown[]=[];const {process,client}=await ready({onServerRequest:async(request:any)=>{seen.push(request.id);if(request.method==='item/commandExecution/requestApproval')return{decision:'accept'};throw Error('unsupported');}});
 process.line({id:'42',method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'u'}});
 process.line({id:42,method:'unknown/request',params:{}});
 await expect.poll(()=>process.sent.length).toBe(4);
 expect(process.sent.slice(2)).toEqual([{id:'42',result:{decision:'accept'}},{id:42,error:{code:-32601,message:'unsupported'}}]);expect(seen).toEqual(['42',42]);await client.close();
});
test('lost turn acknowledgement is unknown, late response does not replay or resolve another call',async()=>{
 const {process,client}=await ready({requestTimeoutMs:20});
 const turn=client.startTurn({threadId:'thread',input:[{type:'text',text:'once'}]}),id=process.sent.at(-1).id;
 await expect(turn).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});process.respond(id,{turn:{id:'late'}});
 expect(process.sent.filter(x=>x.method==='turn/start')).toHaveLength(1);await client.close();
});
test('malformed protocol terminates the connection without leaking payload or reconnecting',async()=>{
 const {process,client}=await ready();const turn=client.startTurn({threadId:'thread',input:[{type:'text',text:'once'}]});
 process.stdout.write('{private:broken-json}\n');await expect(turn).rejects.toMatchObject({code:'CODEX_RPC_PROTOCOL_ERROR'});
 await expect(client.readThread({threadId:'thread'})).rejects.toThrow(/closed|protocol/i);expect(process.killed).toBe(true);await client.close();
});
test('process exit rejects pending calls and never transparently respawns',async()=>{
 let spawns=0;const process=new FakeProcess(),client=new CodexAppServerClient({spawn:()=>{spawns++;return process;}});
 const initialized=client.initialize(initParams);process.respond(1,initResult);await initialized;
 const turn=client.startTurn({threadId:'thread',input:[]});process.emit('close',1);await expect(turn).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
 const next=client.readThread({threadId:'thread'});await expect(next).rejects.toThrow();expect(spawns).toBe(1);await client.close();
});
test('native process loss reports closed once and does not report exited before actual close',async()=>{
 const process=new FakeProcess(),closed:string[]=[],client=new CodexAppServerClient({spawn:()=>process,onClosed:()=>closed.push('closed')});
 process.kill=()=>true;
 const ready=client.initialize(initParams);process.respond(1,initResult);await ready;
 process.stdout.write('invalid json\n');
 expect(client.isClosed).toBe(true);expect(client.hasExited).toBe(false);expect(closed).toEqual(['closed']);
 process.emit('close',1);expect(client.hasExited).toBe(true);expect(closed).toEqual(['closed']);await client.close();
});
test('late server handler completion after close does not cause an unhandled rejection',async()=>{
 let resolve!:(value:unknown)=>void;const {process,client}=await ready({onServerRequest:()=>new Promise(r=>resolve=r)});
 process.line({id:'approval',method:'item/fileChange/requestApproval',params:{}});await client.close();resolve({decision:'accept'});
 await new Promise(r=>setImmediate(r));expect(process.sent).toHaveLength(2);
});
test.each([null,[],{id:1,result:{},error:{}},{id:{},result:{}},{method:45}].map(envelope=>({envelope})))('invalid envelope fails closed: $envelope',async({envelope})=>{
 const {process,client}=await ready();const waiting=client.readThread({threadId:'t'});process.line(envelope);
 await expect(waiting).rejects.toMatchObject({code:'CODEX_RPC_PROTOCOL_ERROR'});await client.close();
});
test('large final items are not truncated by a transport reply-size limit',async()=>{
 const {process,client}=await ready(),text='完整答复'.repeat(600_000),seen:unknown[]=[];
 client.onNotification=(method,params)=>seen.push({method,params});
 process.line({method:'item/completed',params:{item:{type:'agentMessage',text}}});
 expect(seen).toHaveLength(1);expect((seen[0] as any).params.item.text.length).toBe(text.length);expect((seen[0] as any).params.item.text===text).toBe(true);await client.close();
});
test('close waits for child exit and repeated initialization after close cannot claim ready',async()=>{
 const {process,client}=await ready();let closed=false;
 process.stdin.end=(()=>process.stdin) as typeof process.stdin.end;process.kill=()=>{process.killed=true;return true;};
 const closing=client.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));expect(closed).toBe(false);
 process.emit('close',0);await closing;expect(closed).toBe(true);await expect(client.initialize(initParams)).rejects.toThrow(/closed/);
});
test('concurrent close calls share shutdown and never signal an assumed custom process group',async()=>{
 const {process:child,client}=await ready();
 const groupKill=vi.spyOn(process,'kill').mockImplementation(()=>true),signals:string[]=[];
 (child as any).pid=424242;
 child.stdin.end=(()=>child.stdin) as typeof child.stdin.end;
 child.kill=(signal?:string)=>{signals.push(signal??'SIGTERM');return true;};
 try{
  const first=client.close(),second=client.close();
  expect(second).toBe(first);expect(signals).toEqual(['SIGTERM']);expect(groupKill).not.toHaveBeenCalled();
  child.emit('close',0);await first;expect(groupKill).not.toHaveBeenCalled();
 }finally{child.emit('close',0);groupKill.mockRestore();await client.close();}
});
test('shutdown timeout stays unknown without killing the supervisor or claiming exit',async()=>{
 const {process:child,client}=await ready();const signals:string[]=[];
 child.stdin.end=(()=>child.stdin) as typeof child.stdin.end;
 child.kill=(signal?:string)=>{signals.push(signal??'SIGTERM');return true;};
 vi.useFakeTimers();
 try{
  const closing=client.close();const rejected=expect(closing).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
  await vi.advanceTimersByTimeAsync(6001);await rejected;
  expect(signals).toEqual(['SIGTERM']);expect(client.hasExited).toBe(false);
  await expect(client.close()).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
  expect(signals).toEqual(['SIGTERM']);
  child.emit('close',0);expect(client.hasExited).toBe(true);await expect(client.close()).resolves.toBeUndefined();
 }finally{child.emit('close',0);vi.useRealTimers();await client.close();}
});
test('protocol failure and explicit close use one shutdown operation',async()=>{
 const {process:child,client}=await ready();const signals:string[]=[];
 child.stdin.end=(()=>child.stdin) as typeof child.stdin.end;
 child.kill=(signal?:string)=>{signals.push(signal??'SIGTERM');return true;};
 try{
  const pending=client.readThread({threadId:'t'});child.stdout.write('bad json\n');
  await expect(pending).rejects.toMatchObject({code:'CODEX_RPC_PROTOCOL_ERROR'});
  const closing=client.close();expect(signals).toEqual(['SIGTERM']);child.emit('close',0);await closing;
 }finally{child.emit('close',0);await client.close();}
});
test('exit invalidates pending requests but keeps the process fence until inherited pipes close',async()=>{
 const closed:string[]=[];const {process:child,client}=await ready({onClosed:()=>closed.push('closed')});
 const pending=client.readThread({threadId:'t'});
 child.emit('exit',9);const rejected=expect(pending).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
 try{
  expect(client.isClosed).toBe(true);expect(client.hasExited).toBe(false);expect(closed).toEqual(['closed']);
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();await new Promise(r=>setImmediate(r));
  expect(client.hasExited).toBe(true);await rejected;expect(closed).toEqual(['closed']);
 }finally{child.emit('close',0);await rejected;await client.close();}
});
test('destroy requested on every pipe is not evidence that every pipe has closed',async()=>{
 const {process:child,client}=await ready();const release:Array<()=>void>=[];
 for(const stream of [child.stdin,child.stdout,child.stderr])stream._destroy=(_error,callback)=>{release.push(()=>callback(null));};
 try{
  child.emit('exit',0);for(const stream of [child.stdin,child.stdout,child.stderr])stream.destroy();
  expect(release).toHaveLength(3);release[0]!();await new Promise(r=>setImmediate(r));
  expect(client.hasExited).toBe(false);
  release[1]!();release[2]!();await new Promise(r=>setImmediate(r));expect(client.hasExited).toBe(true);
 }finally{for(const done of release)done();child.emit('close',0);await client.close();}
});
test.each(['close','native_exit'] as const)('RPC %s waits for ready stubborn descendants and never respawns',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-codex-process-group-')),marker=join(root,'ready.json');
 const code=`const readline=require('node:readline');const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const descendant=spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);`)}],{stdio:['ignore',1,2,'ipc']});const ready=new Promise(resolve=>descendant.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,descendant.pid]));resolve();}));const rl=readline.createInterface({input:process.stdin});rl.on('line',async line=>{const m=JSON.parse(line);if(m.method==='initialize'){await ready;process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture/0.160.0 (Linux)'}})+'\\n');}else if(m.method==='thread/read')process.exit(9);});process.stdin.resume();`;
 const guardian=new URL('../src/agent-engines/native-guardian.ts',import.meta.url).pathname;
 const child=spawnProcess(process.execPath,['--import',import.meta.resolve('tsx'),guardian,process.execPath,'-e',code],{detached:true,stdio:['pipe','pipe','pipe','ipc']});
 let spawns=0;const closed:string[]=[],client=new CodexAppServerClient({spawn:()=>{spawns++;return child as any;},requestTimeoutMs:5000,onClosed:()=>closed.push('closed')});
 const saved:Array<{pid:number;start:string}>=[];
 const state=async(pid:number)=>{try{const text=await readFile(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');return{start:fields[19],state:fields[0]};}catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}};
 const alive=async(p:{pid:number;start:string})=>{const now=await state(p.pid);return now?.start===p.start&&!['Z','X'].includes(now.state!);};
 try{
  await client.initialize(initParams);
  for(const pid of [child.pid,...JSON.parse(await readFile(marker,'utf8'))]){const value=await state(pid);expect(value).not.toBeNull();saved.push({pid,start:value!.start!});}
  expect(await Promise.all(saved.map(alive))).toEqual([true,true,true]);
  if(mode==='native_exit'){
   await expect(client.readThread({threadId:'t'})).rejects.toMatchObject({code:'CODEX_RPC_UNKNOWN'});
   await expect(client.readThread({threadId:'t'})).rejects.toThrow(/closed/);
  }
  await client.close();expect(client.hasExited).toBe(true);
  expect(await Promise.all(saved.map(alive))).toEqual([false,false,false]);expect(closed).toEqual(['closed']);expect(spawns).toBe(1);
 }finally{
  try{await client.close();}finally{
   for(const member of saved)if(await alive(member))try{process.kill(member.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
   await rm(root,{recursive:true,force:true});
  }
 }
});
test('malformed native thread response is not accepted as a usable session',async()=>{
 const {process,client}=await ready(),thread=client.startThread({cwd:'/fixture',permissionScope});process.respond(process.sent.at(-1).id,{thread:{id:null}});
 await expect(thread).rejects.toThrow(/thread|protocol/i);await client.close();
});
test('thread response retains only validated effective policy and rejects native privilege relaxation',async()=>{
 const {process,client}=await ready();
 const policy={cwd:'/fixture',model:'fixture',modelProvider:'local-provider',reasoningEffort:'low',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
 const first=client.startThread({cwd:'/fixture',permissionScope});process.respond(process.sent.at(-1).id,{...policy,...provenance,thread:{id:'t'},credentials:'DO_NOT_KEEP'});
 const thread=await first;expect(thread.policy).toEqual({...policy,permissions:permissionScope});expect(JSON.stringify(thread)).not.toContain('DO_NOT_KEEP');
 const resume=client.resumeThread({threadId:'t',cwd:'/fixture',permissionScope});process.respond(process.sent.at(-1).id,{...policy,...provenance,approvalPolicy:'never',thread:{id:'t'}});
 await expect(resume).rejects.toThrow();await client.close();
});
