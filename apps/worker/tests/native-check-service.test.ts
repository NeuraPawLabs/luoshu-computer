import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {CodexEngineService} from '../src/agent-engines/service.js';
import {CodexSessionStore} from '../src/agent-engines/session-store.js';
import {NativeRunFiles} from '../src/agent-engines/native-files.js';
import {withNativePolicy} from './helpers/native-policy.js';
test.each([false,true])('native service check tools bind real commands to outputs; changed after check=%s',async changed=>{
 const root=await mkdtemp(join(tmpdir(),'native-check-service-')),db=new Database(':memory:'),store=new CodexSessionStore(db);let service!:CodexEngineService;
 const files=new NativeRunFiles(db,i=>Boolean(store.result(i.session_id,i.submission_id)),async()=>[],async i=>service.commandReceipts(i),async(i,sha,current)=>service.checkEvidence(i,sha,current));
 const rpc:any={initialize:async()=>({}),startThread:async(p:any)=>{expect(p.dynamicTools.map((t:any)=>t.name)).toContain('luoshu_check_begin');return{id:'thread'};},startTurn:async()=>({id:'turn'}),interruptTurn:async()=>{},backgroundTerminals:async()=>({data:[],nextCursor:null})};
 service=new CodexEngineService(store,'worker',()=>withNativePolicy(rpc),{files,workspacePath:async()=>root});
 try{
  const binding={conversation_id:'c',agent_id:'a',actor_id:'owner',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'test'}];
  await service.handle({action:'session_prepare',request_id:'p',session_id:'s',workspace_id:'s',binding});
  await service.handle({action:'submit',request_id:'send',lease_ms:120000,submission:{submission_id:'sub',batch_id:'b',run_id:'run',session_id:'s',binding,input_message_ids:['m'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  await writeFile(join(root,'runs/run/outputs/result.txt'),'checked content');
  const call=(id:string,tool:string,args:unknown)=>service.serverRequest({id,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:id,tool,arguments:args}}) as Promise<any>;
  const begun=await call('begin','luoshu_check_begin',{purpose:'Read the produced file'});expect(begun.success).toBe(true);const check=JSON.parse(begun.contentItems[0].text);
  service.notification('item/started',{threadId:'thread',turnId:'turn',item:{id:'cmd',type:'commandExecution',command:'test -s result.txt',cwd:root,status:'inProgress'}});
  service.notification('item/completed',{threadId:'thread',turnId:'turn',item:{id:'cmd',type:'commandExecution',command:'test -s result.txt',cwd:root,status:'completed',exitCode:0,durationMs:2,aggregatedOutput:'RAW_PRIVATE'}});
  const ended=await call('end','luoshu_check_end',{check_id:check.check_id});expect(JSON.parse(ended.contentItems[0].text)).toMatchObject({status:'passed',command_ids:['cmd']});
  expect(new CodexSessionStore(db).checkReceipts('s','sub')).toMatchObject([{check_id:check.check_id,status:'passed'}]);
  if(changed)await writeFile(join(root,'runs/run/outputs/result.txt'),'later edit');
  service.notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
  const packet=await service.handle({action:'collect_result',request_id:'collect',session_id:'s',submission_id:'sub',run_id:'run',authorization_revision:1});
  expect(packet).toMatchObject({delivery:{checks:[{status:'passed',binding:changed?'changed':'current'}],commands:[{item_id:'cmd'}],content:[{kind:'outputs'}]}});
  await writeFile(join(root,'runs/run/outputs/result.txt'),'post delivery');
  const cached=await new NativeRunFiles(db,()=>true).collect('s','run','sub');expect(packet).toMatchObject({delivery:cached});
  expect(JSON.stringify(db.prepare('SELECT * FROM codex_native_check_receipts').all())).not.toContain('RAW_PRIVATE');
 }finally{await service.close();db.close();await rm(root,{recursive:true,force:true});}
});
