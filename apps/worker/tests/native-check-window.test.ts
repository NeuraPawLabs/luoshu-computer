import {expect,test} from 'vitest';
import {NativeCheckWindow} from '../src/agent-engines/native-check-window.js';
import type {NativeCheckReceipt,NativeCheckTarget,NativeCommandReceipt} from '@luoshu/protocol';
function fixture(){
 const saved:NativeCheckReceipt[]=[],commands:NativeCommandReceipt[]=[];let hash='a'.repeat(64),authorized=true,busy=false;
 const window=new NativeCheckWindow({thread:'thread',turn:'turn',assertCurrent:()=>{if(!authorized)throw Error('revoked');},snapshot:async()=>[{kind:'outputs',sha256:hash}] as NativeCheckTarget[],quiescent:async()=>{if(busy)throw Error('background process');},commands:()=>commands,save:r=>saved.push(r)});
 const event=(method:string,id='cmd',type='commandExecution',exit=0)=>{
  if(method==='item/completed'&&type==='commandExecution')commands.push({thread_id:'thread',turn_id:'turn',item_id:id,command:'test',cwd:'/workspace',status:'completed',exit_code:exit,duration_ms:1});
  window.observe(method,{threadId:'thread',turnId:'turn',item:{id,type}});
 };
 return{window,saved,commands,event,change:()=>hash='b'.repeat(64),revoke:()=>authorized=false,busy:()=>busy=true};
}
test('check window records only sequential commands observed between matching begin/end with unchanged content',async()=>{
 const f=fixture();f.event('item/started','old');f.event('item/completed','old');
 const start=await f.window.begin('begin','Unit tests');f.event('item/started');f.event('item/completed');
 const end=await f.window.end('end',start.check_id);
 expect(end).toMatchObject({status:'passed',purpose:'Unit tests',command_ids:['cmd']});expect(f.saved).toEqual([end]);
 expect(await f.window.end('end',start.check_id)).toEqual(end);expect(f.saved).toHaveLength(1);
});
test.each(['no_commands','changed','overlap','file_change','missing_start','failed'] as const)('check cannot pass with %s',async scenario=>{
 const f=fixture(),start=await f.window.begin('begin','test');
 if(scenario!=='no_commands'){
  if(scenario!=='missing_start')f.event('item/started');
  if(scenario==='overlap'){f.event('item/started','other');f.event('item/completed','other');}
  if(scenario==='file_change'){f.event('item/started','edit','fileChange');f.event('item/completed','edit','fileChange');}
  f.event('item/completed','cmd','commandExecution',scenario==='failed'?1:0);
 }
 if(scenario==='changed')f.change();expect((await f.window.end('end',start.check_id)).status).not.toBe('passed');
});
test('revocation, open tools, background work and closed windows cannot produce a check receipt',async()=>{
 const f=fixture();f.event('item/started');await expect(f.window.begin('begin','test')).rejects.toThrow(/active|pending/);
 f.event('item/completed');f.busy();await expect(f.window.begin('begin2','test')).rejects.toThrow(/background/);
 const g=fixture(),start=await g.window.begin('begin','test');g.revoke();await expect(g.window.end('end',start.check_id)).rejects.toThrow(/revoked/);expect(g.saved).toEqual([]);
 const h=fixture(),open=await h.window.begin('begin','test');h.window.close();await expect(h.window.end('end',open.check_id)).rejects.toThrow(/closed/);
});
test('native event during an asynchronous fingerprint cannot pass a check',async()=>{
 const commands:NativeCommandReceipt[]=[],saved:NativeCheckReceipt[]=[];let release!:()=>void,block=false;
 const w=new NativeCheckWindow({thread:'t',turn:'u',assertCurrent:()=>{},quiescent:async()=>{},commands:()=>commands,save:r=>saved.push(r),snapshot:async()=>{if(block)await new Promise<void>(r=>release=r);return[{kind:'outputs',sha256:'a'.repeat(64)}];}});
 const start=await w.begin('b','test');w.observe('item/started',{threadId:'t',turnId:'u',item:{id:'cmd',type:'commandExecution'}});commands.push({thread_id:'t',turn_id:'u',item_id:'cmd',command:'test',cwd:'/x',status:'completed',exit_code:0,duration_ms:1});w.observe('item/completed',{threadId:'t',turnId:'u',item:{id:'cmd',type:'commandExecution'}});
 block=true;const end=w.end('e',start.check_id);await new Promise(r=>setImmediate(r));w.observe('item/started',{threadId:'t',turnId:'u',item:{id:'late',type:'fileChange'}});release();expect((await end).status).toBe('invalidated');
});
test('foreign native events cannot contribute check commands and call replay cannot change purpose',async()=>{
 const f=fixture(),start=await f.window.begin('begin','test');
 for(const method of ['item/started','item/completed'])f.window.observe(method,{threadId:'foreign',turnId:'turn',item:{id:'cmd',type:'commandExecution'}});
 await expect(f.window.begin('begin','new purpose')).rejects.toThrow(/conflict/);
 expect((await f.window.end('end',start.check_id)).status).toBe('invalidated');
});
