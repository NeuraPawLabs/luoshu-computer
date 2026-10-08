import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/session-store.js';
import {CodexAppServerPool} from '../src/agent-engines/codex-pool.js';
import {NativeRunFiles} from '../src/agent-engines/native-files.js';
import {withNativePolicy} from './helpers/native-policy.js';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-idle-reload-')),db=new Database(':memory:'),store=new CodexSessionStore(db),calls:string[]=[];
 let service!:CodexEngineService,threads=0,turns=0,clients=0,generation=1;
 const pool=new CodexAppServerPool({stateDir:root,onClosed:()=>service.nativeConnectionLost()}),proxies=new WeakMap();
 const rpc=()=>{
  const client=pool.client('worker');if(proxies.has(client))return proxies.get(client);
  clients++;
  // Replace native method boundary only. Real client.close, pool callbacks,
  // Service authority, Session caches and SQLite/file delivery remain intact.
  Object.assign(client,{initialize:async()=>{if(client.isClosed)throw Error('Closed native client');},runtimeExecutable:async()=>'/opt/fixture/codex',assertPermissionProfileAvailable:async()=>{},
   startThread:async()=>{calls.push('start');return{id:'thread-'+ ++threads};},resumeThread:async(p:any)=>{calls.push('resume:'+p.threadId);return{id:p.threadId};},startTurn:async()=>{calls.push('turn');return{id:'turn-'+ ++turns};},interruptTurn:async()=>{},unsubscribeThread:async(p:any)=>{calls.push('unsubscribe:'+p.threadId);return{status:'unsubscribed'};},backgroundTerminals:async()=>({data:[],nextCursor:null})});
  const proxy=withNativePolicy(client);proxies.set(client,proxy);return proxy;
 };
 const files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));
 service=new CodexEngineService(store,'worker',rpc,{files,generation:()=>generation,workspacePath:id=>pool.workspacePath(id),unloadIdle:()=>pool.unloadIfIdle('worker',()=>store.activeCount()+files.activeCount()),quiesce:()=>pool.quiesce('worker'),cleanupOwned:async()=>{}});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'go'}];
 const prepare=(session='s')=>service.handle({action:'session_prepare',request_id:'prepare',session_id:session,workspace_id:session,binding});
 const submit=(id:string)=>service.handle({action:'submit',request_id:'send-'+id,lease_ms:120000,submission:{session_id:'s',submission_id:id,batch_id:id,run_id:id,binding,input_message_ids:[id],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
 const terminal=(id:string)=>{const row=store.submission(id)!;service.notification('turn/completed',{threadId:row.thread_id,turn:{id:row.turn_id,status:'completed',items:[]}});};
 const collect=(id:string)=>service.handle({action:'collect_result',request_id:'collect-'+id,session_id:'s',run_id:id,submission_id:id,authorization_revision:1});
 return{root,db,store,service,pool,files,calls,rpc,prepare,submit,terminal,collect,binding,changeGeneration:()=>{generation++;},clients:()=>clients,async close(){await service.close();await pool.close();db.close();await rm(root,{recursive:true,force:true});}};
}
test('delivery succeeds, idle release clears both caches and the next input resumes its exact thread',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.submit('one');f.terminal('one');await expect(f.collect('one')).resolves.toMatchObject({action:'collect_result'});
  expect(await f.service.releaseIdle()).toBe(true);
  await f.submit('two');expect(f.store.submission('two')?.thread_id).toBe('thread-1');
  expect(f.clients()).toBe(2);expect(f.calls).toEqual(['start','turn','resume:thread-1','turn']);
 }finally{await f.close();}
});
test('unload refuses empty preparation, running work, uncollected files and another prepared thread',async()=>{
 const f=await fixture();try{
  await f.prepare();expect(await f.service.releaseIdle()).toBe(false);
  await f.submit('one');expect(await f.service.releaseIdle()).toBe(false);
  f.terminal('one');expect(await f.service.releaseIdle()).toBe(false);
  await f.collect('one');await f.prepare('other');expect(await f.service.releaseIdle()).toBe(false);
  expect(f.clients()).toBe(1);
 }finally{await f.close();}
});
test('admission waits for planned release rather than borrowing a closing client',async()=>{
 const f=await fixture();let release!:()=>void;try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');
  const client=f.pool.client('worker'),close=client.close.bind(client);let entered=false;
  vi.spyOn(client,'close').mockImplementation(async()=>{entered=true;await new Promise<void>(r=>release=r);await close();});
  const unloading=f.service.releaseIdle();await expect.poll(()=>entered).toBe(true);
  let admitted=false;const next=f.submit('two').then(()=>{admitted=true;});await new Promise(r=>setImmediate(r));expect(admitted).toBe(false);
  expect(()=>f.pool.client('worker')).toThrow(/unload|releas/i);
  release();expect(await unloading).toBe(true);await next;expect(f.calls).toEqual(['start','turn','resume:thread-1','turn']);
 }finally{release?.();await f.close();}
});
test('failed idle close keeps new submissions fenced without reserving an unknown Run',async()=>{
 const f=await fixture();let restore:()=>void=()=>{};try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');
  const spy=vi.spyOn(f.pool.client('worker'),'close').mockRejectedValue(Error('exit unconfirmed'));restore=()=>spy.mockRestore();
  await expect(f.service.releaseIdle()).rejects.toThrow('exit unconfirmed');
  await expect(f.submit('two')).rejects.toThrow('exit unconfirmed');expect(f.store.submission('two')).toBeUndefined();
 }finally{restore();await f.close();}
});
test('one inactivity timer releases only after the response, never while the Run is active',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.submit('one');
  vi.useFakeTimers();await vi.advanceTimersByTimeAsync(60000);expect(f.pool.client('worker').isClosed).toBe(false);vi.useRealTimers();
  f.terminal('one');await f.collect('one');
  vi.useFakeTimers();
  // A read-only request schedules the same inactivity deadline using fake time.
  await f.service.handle({action:'result',request_id:'read',session_id:'s',run_id:'one',submission_id:'one',authorization_revision:1});
  await vi.advanceTimersByTimeAsync(59999);expect(f.pool.client('worker').isClosed).toBe(false);
  const before=f.pool.client('worker');await vi.advanceTimersByTimeAsync(1);expect(before.isClosed).toBe(true);
  vi.useRealTimers();await f.submit('two');expect(f.calls).toEqual(['start','turn','resume:thread-1','turn']);
 }finally{vi.useRealTimers();await f.close();}
});
test('an in-flight prepare blocks idle release even before it creates a durable row',async()=>{
 const f=await fixture();let release!:(s:string)=>void;try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');
  const path=f.pool.workspacePath.bind(f.pool);const spy=vi.spyOn(f.pool,'workspacePath').mockImplementation(()=>new Promise(r=>release=r));
  const preparing=f.prepare('second');await expect.poll(()=>Boolean(release)).toBe(true);
  expect(await f.service.releaseIdle()).toBe(false);expect(f.pool.client('worker').isClosed).toBe(false);
  release((await path('second'))!);await preparing;spy.mockRestore();
 }finally{release?.(f.root);await f.close();}
});
test('a request waiting for unload cannot acquire a new connection generation',async()=>{
 const f=await fixture();let release!:()=>void;try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');
  const client=f.pool.client('worker'),close=client.close.bind(client);let entered=false;
  vi.spyOn(client,'close').mockImplementation(async()=>{entered=true;await new Promise<void>(r=>release=r);await close();});
  const unloading=f.service.releaseIdle();await expect.poll(()=>entered).toBe(true);
  const next=f.submit('two');void next.catch(()=>{});f.changeGeneration();release();await unloading;
  await expect(next).rejects.toThrow(/generation|authority/i);expect(f.store.submission('two')).toBeUndefined();
 }finally{release?.();await f.close();}
});
test('runtime drift rejects new input without delivery locks and idle reload resumes the exact thread',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');
  const before=f.store.session('s'),client=f.pool.client('worker');
  vi.spyOn(client,'runtimeExecutable').mockRejectedValue(Object.assign(Error('runtime replaced'),{code:'CODEX_RUNTIME_CHANGED'}));
  await expect(f.submit('two')).rejects.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
  expect(f.store.session('s')).toEqual(before);expect(f.store.submission('two')).toBeUndefined();expect(f.files.pending()).toEqual([]);
  expect(client.isClosed).toBe(false);expect(await f.service.releaseIdle()).toBe(true);
  await f.submit('two');expect(f.store.submission('two')?.thread_id).toBe(before?.thread_id);
  expect(f.calls).toEqual(['start','turn','resume:thread-1','turn']);
 }finally{await f.close();}
});
test('deleting a different session releases shared clients but preserves resumable thread identity',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.submit('one');f.terminal('one');await f.collect('one');await f.prepare('deleted');
  await f.service.handle({action:'session_close',request_id:'close',session_id:'deleted',binding:f.binding});
  await f.submit('two');expect(f.store.submission('two')?.thread_id).toBe('thread-1');
  expect(f.calls).toEqual(['start','turn','start','unsubscribe:thread-2','resume:thread-1','turn']);expect(f.clients()).toBe(2);
 }finally{await f.close();}
});
