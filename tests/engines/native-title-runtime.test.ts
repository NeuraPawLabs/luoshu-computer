import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {WorkerClient} from '../../src/runtime/client.js';
import {attachAssistantEngine} from '../../src/engines/runtime.js';
import {withNativePolicy} from '../helpers/native-policy.js';

test('actual native runtime propagates Worker send rejection to one cached title failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-title-runtime-')),client=new WorkerClient({stateDir:root});
 const connection=vi.spyOn(client,'assistantEngineConnection','get').mockReturnValue({authenticated:true,generation:1});
 const sent=vi.spyOn(client,'send').mockRejectedValue(Error('socket write failed'));
 let exited=false;
 const native:any={get hasExited(){return exited;},initialize:async()=>({}),startThread:async()=>({id:'thread'}),startTurn:async()=>({id:'turn'}),interruptTurn:async()=>{},close:async()=>{exited=true;}};
 const engine=attachAssistantEngine({client,stateDir:root,workerId:'worker',rpcFactory:()=>withNativePolicy(native)});
 try{
  const binding={conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}},input=[{type:'text',text:'Company research'}];
  await engine.service.handle({action:'session_prepare',request_id:'prepare',session_id:'session',binding,workspace_id:'workspace'});
  await engine.service.handle({action:'submit',request_id:'submit',lease_ms:120000,submission:{session_id:'session',submission_id:'submission',run_id:'run',batch_id:'batch',binding,input_message_ids:['message'],context_message_ids:[],input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),task_id:null,task_revision:null},input});
  const call=()=>engine.service.serverRequest({id:'native-call',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'native-call',tool:'luoshu_conversation_title',arguments:{title:'公司研究',expected_version:1}}}) as Promise<any>;
  let reply:any;const pending=call();void pending.then(value=>reply=value);
  await engine.service.handle({action:'renew',request_id:'renew',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,lease_ms:120000});
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(reply?.success).toBe(false);expect(JSON.parse(reply.contentItems[0].text).error).toMatch(/transport|unknown/i);
  expect(await call()).toEqual(reply);expect(sent).toHaveBeenCalledTimes(1);
  expect(sent.mock.calls[0]?.[0]).toMatchObject({event:{kind:'conversation.title.request',request_id:'native-call'}});
  engine.service.notification('item/started',{threadId:'thread',turnId:'turn',item:{id:'progress',type:'commandExecution',command:'research',status:'inProgress'}});
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(engine.store.submission('submission')?.status).toBe('running');
 }finally{await engine.close();sent.mockRestore();connection.mockRestore();client.stop();await rm(root,{recursive:true,force:true});}
});
