import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {CodexEngineService} from '../../src/engines/service.js';
import {CodexSessionStore} from '../../src/engines/session-store.js';
import {withNativePolicy} from '../helpers/native-policy.js';
async function fixture(){
 const db=new Database(':memory:'),store=new CodexSessionStore(db);let turns=0;
 const rpc:any={initialize:async()=>({}),startThread:async()=>({id:'thread'}),resumeThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn-'+ ++turns}),interruptTurn:async()=>{},readThread:async()=>({thread:{id:'thread',turns:[{id:'turn-1',status:'completed',items:[{id:'recovered',type:'commandExecution',command:'npm test',cwd:'/fixture',status:'completed',exitCode:0,durationMs:23,aggregatedOutput:'RAW_RECOVERED'}]}]}})};
 const service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{workspacePath:async()=>'/fixture'});
 const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'do work'}];
 const submission={submission_id:'s',batch_id:'b',run_id:'r',session_id:'session',binding,input_message_ids:['m'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null};
 await service.handle({action:'session_prepare',request_id:'p',session_id:'session',binding,workspace_id:'workspace'});
 await service.handle({action:'submit',request_id:'send',submission,input,lease_ms:120000});
 return{db,store,service,rpc,close:async()=>{await service.close();db.close();}};
}
test('native completion journals real command identity and result but no raw output, arguments or content',async()=>{
 const f=await fixture();try{
  const item={id:'command',type:'commandExecution',command:'npm test',cwd:'/fixture',status:'completed',exitCode:1,durationMs:20,aggregatedOutput:'RAW_PRIVATE',content:'RAW_REASONING',arguments:{secret:'RAW_ARGUMENT'}};
  f.service.notification('item/completed',{threadId:'other',turnId:'turn-1',item});
  f.service.notification('item/completed',{threadId:'thread',turnId:'wrong',item});
  expect(f.store.commandReceipts('session','s')).toEqual([]);
  f.service.notification('item/completed',{threadId:'thread',turnId:'turn-1',item});f.service.notification('item/completed',{threadId:'thread',turnId:'turn-1',item});
  expect(f.store.commandReceipts('session','s')).toEqual([{thread_id:'thread',turn_id:'turn-1',item_id:'command',command:'npm test',cwd:'/fixture',status:'completed',exit_code:1,duration_ms:20}]);
  expect(f.store.submission('s')?.status).toBe('running');
  f.service.notification('turn/completed',{threadId:'thread',turn:{id:'turn-1',status:'completed',items:[item]}});
  expect(new CodexSessionStore(f.db).commandReceipts('session','s')).toHaveLength(1);
  f.service.notification('item/completed',{threadId:'thread',turnId:'turn-1',item:{...item,id:'late'}});
  expect(f.store.commandReceipts('session','s')).toHaveLength(1);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM codex_native_command_receipts').all())).not.toContain('RAW_');
 }finally{await f.close();}
});
test('exact native reconciliation recovers command provenance and leaves absent fields unknown',async()=>{
 const f=await fixture();try{
  f.service.notification('item/completed',{threadId:'thread',turnId:'turn-1',item:{id:'declined',type:'commandExecution',status:'declined'}});
  expect(f.store.commandReceipts('session','s')[0]).toMatchObject({command:null,cwd:null,exit_code:null,duration_ms:null,status:'declined'});
  f.service.nativeConnectionLost();await f.service.handle({action:'reconcile',request_id:'recover',session_id:'session',submission_id:'s',run_id:'r',authorization_revision:1});
  expect(f.store.commandReceipts('session','s')).toEqual(expect.arrayContaining([expect.objectContaining({item_id:'recovered',exit_code:0})]));
  expect(JSON.stringify(f.db.prepare('SELECT * FROM codex_native_command_receipts').all())).not.toContain('RAW_RECOVERED');
 }finally{await f.close();}
});
