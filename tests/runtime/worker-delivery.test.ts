import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import type {Assignment,RecoveryCommand} from '../../src/protocol/index.js';
import {WorkerState} from '../../src/runtime/state.js';
import {CheckpointStore} from '../../src/runtime/checkpoints.js';
import {prepareWorkspace} from '../../src/runtime/files.js';
import {WorkerDeliveryService} from '../../src/runtime/delivery.js';

const assignment:Assignment={attempt_id:'execution_1',lease_epoch:1,agent:'codex',instruction:'build',input_files:[],codebases:[],timeout_seconds:null};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'luoshu-delivery-'));const state=new WorkerState(join(root,'worker.db'));state.recordStart(assignment.attempt_id,1,assignment);
 const checkpoints=new CheckpointStore(state.db);checkpoints.begin(assignment);checkpoints.agentFinished(assignment.attempt_id,{outcome:'succeeded',exit_code:0,summary:'done',session_id:'session_1',checks:[{command:'check',exit_code:0}],output_snapshot_sha256:null,codebases:[]});
 const workspace=await prepareWorkspace({stateDir:root,attemptId:assignment.attempt_id,inputFiles:[]});await mkdir(join(workspace.outputs,'project','src'),{recursive:true});await writeFile(join(workspace.outputs,'project','src','main.js'),'v1');
 state.finish(assignment.attempt_id,'finished');
 const service=new WorkerDeliveryService({state,checkpoints,stateDir:root,isExecutionActive:()=>false});
 return{root,state,checkpoints,workspace,service};
}
test('collects an immutable delivery and resends the original bytes after outputs change',async()=>{
 const f=await fixture();try{
  const first=await f.service.collect(assignment.attempt_id,'execution_result');
  await writeFile(join(f.workspace.outputs,'project','src','main.js'),'v2');
  const resent=await f.service.resend(assignment.attempt_id,first.delivery_id);
  expect(resent).toEqual(first);
  const recollected=await f.service.collect(assignment.attempt_id,'execution_result');
  expect(recollected.delivery_id).not.toBe(first.delivery_id);
  expect(recollected.files[0].content_base64).not.toBe(first.files[0].content_base64);
  expect(Buffer.from(resent.files[0]!.content_base64,'base64')).toBeTruthy();
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('different authorized operations cannot collect the same execution concurrently',async()=>{
 const f=await fixture();try{
  const cp=f.checkpoints.read(assignment.attempt_id)!;
  const command:RecoveryCommand={type:'execution_recovery_request',request_id:'req',operation_id:'op',execution_id:assignment.attempt_id,assignment_sha256:cp.assignment_sha256,connection_generation:1,expected_checkpoint_version:null,lease_ms:120000,action:'collect_result',delivery_id:null};
  const first=f.service.handle(command);
  const second=await f.service.handle({...command,operation_id:'op2'});
  expect(second).toMatchObject({error:{code:'RECOVERY_ACTIVE'}});
  expect(await first).not.toHaveProperty('error');
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('concurrent collection operations produce one delivery package',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.service.collect(assignment.attempt_id,'execution_result'),f.service.collect(assignment.attempt_id,'execution_result')]);
  expect(a.delivery_id).toBe(b.delivery_id);
  expect(f.state.db.prepare('SELECT COUNT(*) count FROM worker_delivery_packages').get()).toMatchObject({count:1});
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('recovery request rejects an active execution and does not invoke an Agent',async()=>{
 const f=await fixture();try{
  f.state.recordStart('execution_2',1,{...assignment,attempt_id:'execution_2'});
  const command:RecoveryCommand={type:'execution_recovery_request',request_id:'req',operation_id:'op',execution_id:'execution_2',assignment_sha256:'a'.repeat(64),connection_generation:1,expected_checkpoint_version:null,lease_ms:120000,action:'collect_result',delivery_id:null};
  expect(await f.service.handle(command)).toMatchObject({error:{code:expect.stringMatching(/RECOVERY_ACTIVE|RECOVERY_UNAUTHORIZED/)}});
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('inspection never exposes local absolute paths',async()=>{
 const f=await fixture();try{const inspection=await f.service.inspect(assignment.attempt_id);expect(inspection).toMatchObject({execution_id:assignment.attempt_id,agent_outcome:'succeeded',stopped:true,has_workspace:true});expect(JSON.stringify(inspection)).not.toContain(f.root);}finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});

test('resend verifies content bytes instead of trusting the stored hash field',async()=>{
 const f=await fixture();try{
  const packet=await f.service.collect(assignment.attempt_id,'execution_result');
  const row=f.state.db.prepare('SELECT relative_package_path FROM worker_delivery_packages WHERE delivery_id=?').get(packet.delivery_id) as {relative_package_path:string};
  const bytes=Buffer.from(packet.files[0].content_base64,'base64');bytes[0]^=0xff;
  const corrupted={...packet,files:[{...packet.files[0],content_base64:bytes.toString('base64')}]};
  await writeFile(join(f.root,row.relative_package_path),JSON.stringify(corrupted));
  await expect(f.service.resend(assignment.attempt_id,packet.delivery_id)).rejects.toThrow(/corrupt|hash|manifest/i);
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('inspect_result does not collect and assignment mismatches are rejected',async()=>{
 const f=await fixture();try{
  const cp=f.checkpoints.read(assignment.attempt_id)!;
  const command:RecoveryCommand={type:'execution_recovery_request',request_id:'req',operation_id:'op',execution_id:assignment.attempt_id,assignment_sha256:cp.assignment_sha256,connection_generation:1,expected_checkpoint_version:cp.version,lease_ms:120000,action:'inspect_result',delivery_id:null};
  const result=await f.service.handle(command);
  expect('delivery'in result&&result.delivery).toBeNull();
  expect(f.state.db.prepare('SELECT COUNT(*) count FROM worker_delivery_packages').get()).toMatchObject({count:0});
  const denied=await f.service.handle({...command,operation_id:'bad',assignment_sha256:'0'.repeat(64)});
  expect(denied).toMatchObject({error:{code:'RECOVERY_UNAUTHORIZED'}});
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('finished old executions can retrieve unverified artifacts without fabricated evidence',async()=>{
 const f=await fixture();try{
  f.state.db.prepare('DELETE FROM worker_checkpoints WHERE execution_id=?').run(assignment.attempt_id);
  const result=await f.service.collect(assignment.attempt_id,'recovered_artifacts');
  expect(result.evidence).toBeNull();
  expect(result.verification_binding).toBe('unbound');
  expect(f.checkpoints.read(assignment.attempt_id)).toBeNull();
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('unknown local state is not treated as stopped just because no controller exists',async()=>{
 const f=await fixture();try{
  f.state.finish(assignment.attempt_id,'unknown');
  expect((await f.service.inspect(assignment.attempt_id)).stopped).toBe(false);
  await expect(f.service.collect(assignment.attempt_id,'recovered_artifacts')).rejects.toThrow(/active|unknown/i);
 }finally{await f.service.close();f.state.close();await rm(f.root,{recursive:true,force:true});}
});
test('closing the delivery service prevents new collection work',async()=>{
 const f=await fixture();try{
  await f.service.close();
  await expect(f.service.collect(assignment.attempt_id,'execution_result')).rejects.toThrow(/closed/i);
 }finally{f.state.close();await rm(f.root,{recursive:true,force:true});}
});
