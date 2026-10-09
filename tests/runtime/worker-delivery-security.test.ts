import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test,vi} from 'vitest';
import {WorkerState} from '../../src/runtime/state.js';
import {CheckpointStore} from '../../src/runtime/checkpoints.js';
const injection=vi.hoisted(()=>({source:'',outside:'',replaced:false}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return{...fs,open:async(path:string,...args:any[])=>{
  if(injection.source&&!injection.replaced&&path.endsWith('.json')){
   injection.replaced=true;await fs.rename(injection.source,injection.source+'-original');await fs.symlink(injection.outside,injection.source);
  }
  return (fs.open as any)(path,...args);
 }};
});
import {WorkerDeliveryService} from '../../src/runtime/delivery.js';
test('package resend reads its pinned directory even if an ancestor is replaced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'delivery-parent-')),state=new WorkerState(join(root,'worker.db'));
 const assignment={attempt_id:'execution',lease_epoch:1,agent:'codex' as const,instruction:'build',input_files:[],codebases:[],timeout_seconds:null};
 state.recordStart('execution',1,assignment);state.finish('execution','finished');
 const cp=new CheckpointStore(state.db);cp.begin(assignment);cp.agentFinished('execution',{outcome:'succeeded',exit_code:0,summary:'done',session_id:null,checks:[],codebases:[],output_snapshot_sha256:null});
 const service=new WorkerDeliveryService({state,checkpoints:cp,stateDir:root,isExecutionActive:()=>false});
 try{
  await mkdir(join(root,'workspaces','execution','outputs'),{recursive:true});await writeFile(join(root,'workspaces','execution','outputs','file.txt'),'safe');
  const packet=await service.collect('execution','execution_result');
  injection.source=join(root,'deliveries','execution');injection.outside=join(root,'outside');await mkdir(injection.outside);
  await expect(service.resend('execution',packet.delivery_id)).resolves.toEqual(packet);
  expect(injection.replaced).toBe(true);
 }finally{injection.source='';injection.replaced=false;await service.close();state.close();await rm(root,{recursive:true,force:true});}
});
