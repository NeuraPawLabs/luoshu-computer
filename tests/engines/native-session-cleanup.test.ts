import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {CodexEngineService} from '../../src/engines/service.js';
import {withNativePolicy} from '../helpers/native-policy.js';
import {mkdtemp,rm,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeRunFiles} from '../../src/engines/native-files.js';
const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device' as const,worker_id:'worker',agent:'codex' as const,adapter_version:1 as const}};
const prepare={action:'session_prepare',request_id:'p',session_id:'s',workspace_id:'s',binding};
const close={action:'session_close',request_id:'c',session_id:'s',binding};
const input=[{type:'text',text:'hello'}],submission={session_id:'s',submission_id:'sub',run_id:'run',batch_id:'batch',binding,input_message_ids:['m'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
function fixture(events:any[]=[]){
 const db=new Database(':memory:'),store=new CodexSessionStore(db),calls:string[]=[];
 const rpc:any={initialize:async()=>{},startThread:async()=>{calls.push('start');return{id:'thread'};},resumeThread:async()=>{calls.push('resume');return{id:'thread'};},startTurn:async()=>{calls.push('turn');return{id:'turn'};},interruptTurn:async()=>{},unsubscribeThread:async({threadId}:any)=>{calls.push('unsubscribe:'+threadId);return{status:'unsubscribed'};}};
 const create=()=>new CodexEngineService(new CodexSessionStore(db),'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture',emit:e=>events.push(e)});
 const service=create();return{db,store,rpc,calls,create,service,async done(){await service.close();db.close();}};
}
test('close before prepare persists a tombstone without creating a native thread',async()=>{
 const f=fixture();let reopened:CodexEngineService|undefined;try{
  expect(await f.service.handle(close)).toMatchObject({state:'closed',binding});
  reopened=f.create();await expect(reopened.handle(prepare)).rejects.toThrow(/clos|revok/i);
  expect(f.calls).toEqual([]);
 }finally{await reopened?.close();await f.done();}
});
test('only the saved binding and thread can be closed, once, without deleting history',async()=>{
 const f=fixture();try{
  await f.service.handle(prepare);
  await expect(f.service.handle({...close,binding:{...binding,actor_id:'bob'}})).rejects.toThrow(/binding/i);
  await f.service.handle(close);await f.service.handle(close);
  expect(f.store.session('s')).toMatchObject({thread_id:'thread',native_status:'closed'});
  expect(f.calls).toEqual(['start','unsubscribe:thread']);
  await expect(f.service.handle(prepare)).rejects.toThrow(/clos|revok/i);
 }finally{await f.done();}
});
test('unknown/active native work is revoked but never acknowledged as stopped by cleanup',async()=>{
 const f=fixture();try{
  await f.service.handle(prepare);await f.service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  await expect(f.service.handle(close)).rejects.toThrow(/active|unresolved/i);
  expect(f.store.active('s')).toBeDefined();expect(f.calls).not.toContain('unsubscribe:thread');
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await f.service.handle(close);
  await expect(f.service.handle({action:'submit',request_id:'replay',lease_ms:120000,submission,input})).rejects.toThrow(/clos|revok/i);
 }finally{await f.done();}
});
test('failed native unsubscribe retains revoked binding and retry only closes the saved thread',async()=>{
 const f=fixture();let succeed=false;try{
  await f.service.handle(prepare);f.rpc.unsubscribeThread=async()=>{if(!succeed)throw Error('lost receipt');return{status:'notSubscribed'};};
  await expect(f.service.handle(close)).rejects.toThrow('lost receipt');
  await expect(f.service.handle(prepare)).rejects.toThrow(/clos|revok/i);
  succeed=true;await expect(f.service.handle(close)).resolves.toMatchObject({state:'closed'});
  expect(f.calls).toEqual(['start']);
 }finally{await f.done();}
});
test('close waits for in-flight thread creation then closes its exact late identity',async()=>{
 const f=fixture();let release!:(v:any)=>void;try{
  f.rpc.startThread=()=>new Promise(r=>release=r);
  const preparing=f.service.handle(prepare),rejected=expect(preparing).rejects.toThrow(/clos|revok/i);
  await expect.poll(()=>Boolean(release)).toBe(true);
  let closed=false;const closing=f.service.handle(close).then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);
  release({id:'late-thread'});await rejected;await closing;
  expect(f.calls).toEqual(['unsubscribe:late-thread']);expect(f.store.session('s')?.thread_id).toBe('late-thread');
 }finally{release?.({id:'late-thread'});await f.done();}
});
test('binding tombstone survives closing and reopening the actual Worker database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-persist-')),path=join(root,'worker.db');let db=new Database(path);
 try{
  const first=new CodexSessionStore(db);first.revokeSession('s',binding);first.finishSessionUnsubscribe('s',null);first.finishSessionClose('s');db.close();db=new Database(path);
  const restored=new CodexSessionStore(db);
  expect(()=>restored.ensure(binding,'s','/fixture')).toThrow(/closed|revoked/i);
  expect(()=>restored.revokeSession('s',{...binding,actor_id:'bob'})).toThrow(/binding/);
  expect(restored.closedBinding('s')?.closed_at).toEqual(expect.any(Number));
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
test('store cannot report final close without the exact unsubscribe phase',()=>{
 const f=fixture();try{
  f.store.revokeSession('s',binding);
  expect(()=>f.store.finishSessionClose('s')).toThrow(/unsubscribe|phase/);
  expect(f.store.closedBinding('s')?.closed_at).toBeNull();
  expect(()=>f.store.finishSessionUnsubscribe('s','foreign-thread')).toThrow(/thread|binding/);
  f.store.finishSessionUnsubscribe('s',null);f.store.finishSessionClose('s');
  expect(f.store.closedBinding('s')?.closed_at).toEqual(expect.any(Number));
 }finally{f.db.close();}
});
test('cleanup never discards a terminal but uncollected delivery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-delivery-')),f=fixture();let service:CodexEngineService|undefined;
 try{
  f.rpc.backgroundTerminals=async()=>({data:[],nextCursor:null});const files=new NativeRunFiles(f.db,i=>Boolean(f.store.result(i.session_id,i.submission_id)));
  service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>root,files,quiesce:async()=>{},cleanupOwned:session=>files.cleanupSession(session)});
  await service.handle(prepare);await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await expect(service.handle(close)).rejects.toThrow(/delivery.*pending/i);
  expect(files.pending()).toHaveLength(1);expect(f.store.result('s','sub')?.status).toBe('completed');
  expect(f.calls).not.toContain('unsubscribe:thread');
 }finally{await service?.close();await f.done();await rm(root,{recursive:true,force:true});}
});
test('unknown thread creation without an identity cannot be called closed',async()=>{
 const f=fixture();try{
  f.rpc.startThread=async()=>{throw Error('lost creation response');};await expect(f.service.handle(prepare)).rejects.toThrow();
  await expect(f.service.handle(close)).rejects.toThrow(/identity.*unknown/);
  expect(f.store.closedBinding('s')?.closed_at).toBeNull();
 }finally{await f.done();}
});
test('close revokes outstanding approval synchronously before any cleanup await',async()=>{
 const events:any[]=[],f=fixture(events);try{
  await f.service.handle(prepare);await f.service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  const approval=f.service.serverRequest({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'command',command:'test'}});void approval.catch(()=>{});
  const id=events.find(e=>e.event.kind==='waiting_approval').event.request_id;
  const closing=f.service.handle(close);void closing.catch(()=>{});
  await expect(f.service.handle({action:'interaction_response',request_id:'answer',session_id:'s',submission_id:'sub',run_id:'run',authorization_revision:1,turn_id:'turn',interaction_id:id,response:{kind:'approval',decision:'allow_once'}})).rejects.toThrow(/authorized|revoked|closed/i);
  await expect(closing).rejects.toThrow(/active|unresolved/i);await expect(approval).rejects.toThrow();
 }finally{await f.done();}
});
test('closing a completed session removes only its owned output run and preserves the source workspace',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-owned-')),f=fixture();let service:CodexEngineService|undefined;
 try{
  f.rpc.backgroundTerminals=async()=>({data:[],nextCursor:null});const files=new NativeRunFiles(f.db,i=>Boolean(f.store.result(i.session_id,i.submission_id)));
  service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>root,files,quiesce:async()=>{},cleanupOwned:session=>files.cleanupSession(session)});
  await service.handle(prepare);await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  const paths=await files.prepare({cwd:root,session_id:'s',run_id:'run',submission_id:'sub',input_files:[]});
  await writeFile(join(paths.outputs,'nested.txt'),'owned');
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await service.handle({action:'collect_result',request_id:'collect',session_id:'s',run_id:'run',submission_id:'sub',authorization_revision:1});
  await expect(service.handle(close)).resolves.toMatchObject({state:'closed'});
  await expect(lstat(join(root,'runs','run'))).rejects.toMatchObject({code:'ENOENT'});
  expect(f.store.closedBinding('s')?.closed_at).toEqual(expect.any(Number));
 }finally{await service?.close();await f.done();await rm(root,{recursive:true,force:true});}
});
test('failed Worker-owned cleanup keeps binding pending and retry removes the exact remaining run',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-retry-')),f=fixture();let service:CodexEngineService|undefined,fail=true;
 try{
  f.rpc.backgroundTerminals=async()=>({data:[],nextCursor:null});const files=new NativeRunFiles(f.db,i=>Boolean(f.store.result(i.session_id,i.submission_id)));
  service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>root,files,quiesce:async()=>{},cleanupOwned:async()=>{if(fail)throw Error('cleanup unavailable');await files.cleanupSession('s');}});
  await service.handle(prepare);await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  const paths=await files.prepare({cwd:root,session_id:'s',run_id:'run',submission_id:'sub',input_files:[]});await writeFile(join(paths.outputs,'owned.txt'),'owned');
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  await service.handle({action:'collect_result',request_id:'collect',session_id:'s',run_id:'run',submission_id:'sub',authorization_revision:1});
  await expect(service.handle(close)).rejects.toThrow('cleanup unavailable');expect(f.store.closedBinding('s')?.closed_at).toBeNull();
  fail=false;await expect(service.handle(close)).resolves.toMatchObject({state:'closed'});expect(f.store.closedBinding('s')?.closed_at).toEqual(expect.any(Number));
  expect(f.calls.filter(c=>c==='unsubscribe:thread')).toHaveLength(1);
 }finally{await service?.close();await f.done();await rm(root,{recursive:true,force:true});}
});
test('native unsubscribe phase survives a real database reopen when file cleanup failed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-phase-')),path=join(root,'worker.db');let db=new Database(path),service:CodexEngineService|undefined;
 const calls:string[]=[],rpc=withNativePolicy({initialize:async()=>{},startThread:async()=>({id:'saved-thread'}),unsubscribeThread:async({threadId}:any)=>{calls.push(threadId);return{status:'unsubscribed'};}});
 try{
  service=new CodexEngineService(new CodexSessionStore(db),'worker',()=>rpc as any,{workspacePath:async()=>root,quiesce:async()=>{},cleanupOwned:async()=>{throw Error('disk unavailable');}});
  await service.handle(prepare);await expect(service.handle(close)).rejects.toThrow('disk unavailable');await service.close();db.close();db=new Database(path);
  const store=new CodexSessionStore(db);service=new CodexEngineService(store,'worker',()=>{throw Error('File cleanup must not respawn native process');},{workspacePath:async()=>root,quiesce:async()=>{},cleanupOwned:async()=>{}});
  await expect(service.handle(close)).resolves.toMatchObject({state:'closed'});
  expect(calls).toEqual(['saved-thread']);expect(store.closedBinding('s')?.closed_at).toEqual(expect.any(Number));
 }finally{await service?.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('cleanup receives original authority and stops before removal after generation changes',async()=>{
 const f=fixture();let generation=1,release!:()=>void,entered=false,deleted=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',generation:()=>generation,quiesce:async()=>{},cleanupOwned:async(_session,current)=>{entered=true;await new Promise<void>(r=>release=r);current();deleted=true;}});
 try{
  await service.handle(prepare);const pending=service.handle(close);void pending.catch(()=>{});
  await expect.poll(()=>entered).toBe(true);generation++;release();
  await expect(pending).rejects.toThrow(/authority|generation/);expect(deleted).toBe(false);expect(f.store.closedBinding('s')?.closed_at).toBeNull();
 }finally{release?.();await service.close();await f.done();}
});
test.each(['thread','binding'] as const)('a cleanup retry cannot use an unsubscribe receipt after %s mutation',async field=>{
 const f=fixture();let cleanups=0;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{},cleanupOwned:async()=>{cleanups++;throw Error('cleanup pending');}});
 try{
  await service.handle(prepare);await expect(service.handle(close)).rejects.toThrow('cleanup pending');
  if(field==='thread')f.db.prepare("UPDATE codex_native_sessions SET thread_id='replacement'").run();
  else f.db.prepare("UPDATE codex_session_unsubscriptions SET binding_json='{}'").run();
  await expect(service.handle(close)).rejects.toThrow(/binding|thread/);
  expect(cleanups).toBe(1);expect(f.calls.filter(c=>c.startsWith('unsubscribe'))).toEqual(['unsubscribe:thread']);
  expect(f.store.closedBinding('s')?.closed_at).toBeNull();
 }finally{await service.close();await f.done();}
});
test('an old-generation unsubscribe response cannot record a phase or start cleanup',async()=>{
 const f=fixture();let generation=1,release!:(v:any)=>void,deleted=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',generation:()=>generation,quiesce:async()=>{},cleanupOwned:async()=>{deleted=true;}});
 try{
  await service.handle(prepare);f.rpc.unsubscribeThread=()=>new Promise(r=>release=r);
  const pending=service.handle(close);void pending.catch(()=>{});await expect.poll(()=>Boolean(release)).toBe(true);generation++;release({status:'unsubscribed'});
  await expect(pending).rejects.toThrow(/authority|generation/);expect(f.store.unsubscribed('s')).toBe(false);expect(deleted).toBe(false);
 }finally{release?.({status:'unsubscribed'});await service.close();await f.done();}
});
test('a lost unsubscribe response retries the saved native operation, never the file phase first',async()=>{
 const f=fixture();let attempts=0,cleanups=0;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{},cleanupOwned:async()=>{cleanups++;}});
 try{
  await service.handle(prepare);f.rpc.unsubscribeThread=async()=>{if(++attempts===1)throw Error('lost response');return{status:'notSubscribed'};};
  await expect(service.handle(close)).rejects.toThrow('lost response');expect(f.store.unsubscribed('s')).toBe(false);expect(cleanups).toBe(0);
  await service.handle(close);expect(attempts).toBe(2);expect(cleanups).toBe(1);
 }finally{await service.close();await f.done();}
});
test('final close purges only its own execution content while retaining revocation identity',async()=>{
 const f=fixture();try{
  await f.service.handle({...prepare,developer_instructions:'PRIVATE_INSTRUCTIONS'});
  f.store.registerSubmission(submission);f.store.renewPreparation(submission,120000);
  await f.service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  const command={thread_id:'thread',turn_id:'turn',item_id:'command',command:'check private',cwd:'/fixture',status:'completed' as const,exit_code:0,duration_ms:1};
  const targets=[{kind:'outputs' as const,sha256:'a'.repeat(64)}];
  const check={check_id:'check',thread_id:'thread',turn_id:'turn',purpose:'private purpose',command_ids:['command'],before:targets,after:targets,status:'passed' as const};
  f.store.recordCommand('s','sub',command);f.store.recordCheck('s','sub',check);
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'PRIVATE_REPLY'}]}});
  const foreign={...binding,conversation_id:'foreign'};f.store.ensure(foreign,'other','/fixture/other','FOREIGN_INSTRUCTIONS');
  const other={...submission,session_id:'other',submission_id:'other-sub',binding:foreign,context_message_ids:['foreign-context']};
  f.store.registerSubmission(other);f.store.renewPreparation(other,120000);f.store.reserve(foreign,'other','/fixture/other','other-sub',other.input_sha256);
  f.store.beginThread('other','other-sub');f.store.attachConfiguredThread('other','other-thread',null,JSON.parse(f.store.session('s')!.policy_json!));
  f.store.start('other-sub','other-thread');f.store.acknowledge('other-sub','other-thread','other-turn');
  f.store.recordCommand('other','other-sub',{...command,thread_id:'other-thread',turn_id:'other-turn'});
  f.store.recordCheck('other','other-sub',{...check,thread_id:'other-thread',turn_id:'other-turn'});
  f.store.finishResult('other','other-sub',{status:'completed',replies:[],reason:null});
  const tables=['codex_native_submissions','codex_native_turn_results','codex_native_submission_policies','codex_native_command_receipts','codex_native_check_receipts','codex_preparation_leases'];
  const foreignRows=tables.map(table=>f.db.prepare(`SELECT * FROM ${table} WHERE submission_id='other-sub'`).all());
  for(const table of tables)expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE submission_id='sub'`).get()).toEqual({n:1});
  const foreignBefore=f.store.session('other');
  await f.service.handle(close);
  for(const [index,table] of tables.entries())expect(f.db.prepare(`SELECT * FROM ${table}`).all(),table).toEqual(foreignRows[index]);
  expect(f.store.session('s')).toMatchObject({thread_id:'thread',native_status:'closed',developer_instructions:'',policy_json:null});
  expect(f.store.session('other')).toEqual(foreignBefore);expect(f.store.result('s','sub')).toBeNull();
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
  await f.service.handle(close);await expect(f.service.handle({action:'submit',request_id:'replay',lease_ms:120000,submission,input})).rejects.toThrow(/revoked|closed/);
  expect(f.calls).toEqual(['start','turn','unsubscribe:thread']);
 }finally{await f.done();}
});
test('closing an unprepared cancelled session removes its frozen cancellation contents only',async()=>{
 const f=fixture();try{
  const cancelled={...submission,codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'read' as const,source:{kind:'local' as const,path:'/fixture'},root_path:'.',default_branch:'main'}]};
  f.store.cancelPreparation(cancelled);
  f.store.cancelPreparation({...submission,session_id:'foreign',submission_id:'foreign-sub',binding:{...binding,conversation_id:'other'}});
  const foreign=f.db.prepare("SELECT * FROM codex_cancelled_preparations WHERE submission_id='foreign-sub'").get();
  await f.service.handle(close);
  expect(f.db.prepare('SELECT * FROM codex_cancelled_preparations').all()).toEqual([foreign]);
  await expect(f.service.handle({action:'workspace_cancel',request_id:'late-cancel',submission:cancelled})).rejects.toThrow(/revoked|closed/);
  expect(f.db.prepare('SELECT * FROM codex_cancelled_preparations').all()).toEqual([foreign]);
  await expect(f.service.handle(prepare)).rejects.toThrow(/revoked|closed/);
 }finally{await f.done();}
});

test('final database failure rolls back content purge and reopen retries without native work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-purge-rollback-')),path=join(root,'worker.db');let db=new Database(path),service:CodexEngineService|undefined;
 const calls:string[]=[];
 const rpc=withNativePolicy({initialize:async()=>{},startThread:async()=>({id:'thread'}),startTurn:async()=>{calls.push('turn');return{id:'turn'};},backgroundTerminals:async()=>({data:[],nextCursor:null}),unsubscribeThread:async()=>{calls.push('unsubscribe');return{status:'unsubscribed'};}});
 try{
  let store=new CodexSessionStore(db),files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));
  const create=(client:()=>any)=>new CodexEngineService(store,'worker',client,{workspacePath:async()=>root,files,quiesce:async()=>{},cleanupOwned:(s,current)=>files.cleanupSession(s,current),finalizeCleanup:s=>files.purgeSessionData(s)});
  service=create(()=>rpc);await service.handle({...prepare,developer_instructions:'PRIVATE_INSTRUCTIONS'});
  await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission,input});
  await writeFile(join(root,'runs','run','outputs','private.txt'),'PRIVATE_BYTES');
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'PRIVATE_REPLY'}]}});
  await service.handle({action:'collect_result',request_id:'collect',session_id:'s',run_id:'run',submission_id:'sub',authorization_revision:1});
  const before={session:store.session('s'),result:store.result('s','sub'),file:db.prepare('SELECT * FROM assistant_native_run_files').get()};
  db.exec(`CREATE TRIGGER fail_final_close BEFORE UPDATE OF closed_at ON codex_closed_bindings BEGIN
   SELECT CASE WHEN EXISTS(SELECT 1 FROM codex_native_turn_results WHERE session_key=NEW.session_key)
    OR EXISTS(SELECT 1 FROM assistant_native_run_files WHERE session_id=NEW.session_key)
    THEN RAISE(ABORT,'purge missing') ELSE RAISE(ABORT,'injected close failure') END;
  END;`);
  await expect(service.handle(close)).rejects.toThrow('injected close failure');
  expect(store.closedBinding('s')?.closed_at).toBeNull();expect(store.unsubscribed('s')).toBe(true);
  expect({session:store.session('s'),result:store.result('s','sub'),file:db.prepare('SELECT * FROM assistant_native_run_files').get()}).toEqual(before);
  await expect(lstat(join(root,'runs','run'))).rejects.toMatchObject({code:'ENOENT'});
  await service.close();db.close();db=new Database(path);store=new CodexSessionStore(db);files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)));
  db.exec('DROP TRIGGER fail_final_close');service=create(()=>{throw Error('Retry must not start native work');});
  await expect(service.handle(close)).resolves.toMatchObject({state:'closed'});
  expect(store.result('s','sub')).toBeNull();expect(db.prepare('SELECT * FROM assistant_native_run_files').all()).toEqual([]);
  expect(store.session('s')).toMatchObject({developer_instructions:'',policy_json:null,native_status:'closed'});
  expect(db.pragma('foreign_key_check')).toEqual([]);expect(calls).toEqual(['turn','unsubscribe']);
 }finally{await service?.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('filesystem cleanup waits for native quiescence and fences a new session until removal finishes',async()=>{
 const f=fixture();let stop!:()=>void,remove!:()=>void,quiescing=false,removing=false,removed=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{quiescing=true;await new Promise<void>(r=>stop=r);},cleanupOwned:async()=>{removing=true;await new Promise<void>(r=>remove=r);removed=true;}});
 try{
  await service.handle(prepare);const closing=service.handle(close);void closing.catch(()=>{});
  await expect.poll(()=>quiescing).toBe(true);expect(removing).toBe(false);expect(f.store.closedBinding('s')?.closed_at).toBeNull();
  const next=service.handle({...prepare,session_id:'next',workspace_id:'next',binding:{...binding,conversation_id:'next'}});void next.catch(()=>{});
  await new Promise(r=>setImmediate(r));expect(f.store.session('next')).toBeUndefined();
  stop();await expect.poll(()=>removing).toBe(true);expect(f.store.session('next')).toBeUndefined();
  f.rpc.startThread=async()=>({id:'next-thread'});remove();await closing;await next;expect(removed).toBe(true);
 }finally{stop?.();remove?.();await service.close();await f.done();}
});
test('failed quiescence leaves files intact and rejects new execution until cleanup retry proves exit',async()=>{
 const f=fixture();let canStop=false,removed=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{if(!canStop)throw Error('native exit unconfirmed');},cleanupOwned:async()=>{removed=true;}});
 try{
  await service.handle(prepare);await expect(service.handle(close)).rejects.toThrow('native exit unconfirmed');expect(removed).toBe(false);
  await expect(service.handle({...prepare,session_id:'next',workspace_id:'next'})).rejects.toThrow('native exit unconfirmed');
  canStop=true;await service.handle(close);expect(removed).toBe(true);expect(f.calls).toEqual(['start','unsubscribe:thread']);
 }finally{await service.close();await f.done();}
});
test.each(['running','empty'] as const)('another %s native session defers cleanup without closing its shared process',async state=>{
 const f=fixture();let quiesced=false,removed=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{quiesced=true;},cleanupOwned:async()=>{removed=true;}});
 try{
  await service.handle(prepare);f.rpc.startThread=async()=>({id:'other-thread'});
  await service.handle({...prepare,session_id:'other',workspace_id:'other'});
  if(state==='running')await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission:{...submission,session_id:'other'},input});
  await expect(service.handle(close)).rejects.toThrow(/busy|pending|quiescen/i);expect(quiesced).toBe(false);expect(removed).toBe(false);
  expect(f.store.closedBinding('s')?.closed_at).toBeNull();expect(f.store.session('other')?.native_status).toBe('idle');
 }finally{await service.close();await f.done();}
});
test('concurrent session deletions serialize quiescence instead of permanently deferring each other',async()=>{
 const f=fixture();let cleanups=0;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',quiesce:async()=>{},cleanupOwned:async()=>{cleanups++;}});
 try{
  // These bindings have no native thread and can safely close together.
  const responses=await Promise.all([service.handle(close),service.handle({...close,session_id:'other',binding:{...binding,conversation_id:'other'}})]);
  expect(responses.every(r=>'state'in r&&r.state==='closed')).toBe(true);expect(cleanups).toBe(2);
 }finally{await service.close();await f.done();}
});
test('request waiting for filesystem cleanup cannot adopt a newer authorization generation',async()=>{
 const f=fixture();let generation=1,release!:()=>void,removing=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',generation:()=>generation,quiesce:async()=>{},cleanupOwned:async()=>{removing=true;await new Promise<void>(r=>release=r);}});
 try{
  await service.handle(prepare);const closing=service.handle(close);void closing.catch(()=>{});await expect.poll(()=>removing).toBe(true);
  const next=service.handle({...prepare,session_id:'next'});void next.catch(()=>{});generation++;release();
  await expect(closing).rejects.toThrow(/authority|generation/);await expect(next).rejects.toThrow(/authority|generation/);expect(f.store.session('next')).toBeUndefined();expect(f.store.closedBinding('s')?.closed_at).toBeNull();
 }finally{release?.();await service.close();await f.done();}
});
test('filesystem cleanup is refused if no native exit authority is wired',async()=>{
 const f=fixture();let removed=false;
 const service=new CodexEngineService(f.store,'worker',()=>withNativePolicy(f.rpc),{workspacePath:async()=>'/fixture',cleanupOwned:async()=>{removed=true;}});
 try{await service.handle(prepare);await expect(service.handle(close)).rejects.toThrow(/quiescence.*unavailable/);expect(removed).toBe(false);expect(f.store.closedBinding('s')?.closed_at).toBeNull();}
 finally{await service.close();await f.done();}
});
