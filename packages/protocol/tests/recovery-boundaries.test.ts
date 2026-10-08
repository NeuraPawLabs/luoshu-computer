import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import * as p from '../src/index.js';
import * as hashing from '../src/recovery-hash.js';

const command={type:'execution_recovery_request',request_id:'r1',operation_id:'op1',execution_id:'e1',assignment_sha256:'a'.repeat(64),connection_generation:1,expected_checkpoint_version:1,lease_ms:120000,action:'inspect_result',delivery_id:null};
const evidence={outcome:'succeeded',exit_code:0,summary:'done',session_id:null,checks:[],output_snapshot_sha256:null,codebases:[]};
const packet=()=>({
 execution_id:'e1',delivery_id:'d1',assignment_sha256:'a'.repeat(64),checkpoint_version:1,
 purpose:'execution_result' as const,agent:'codex' as const,evidence:{...evidence,outcome:'succeeded' as const},
 verification_binding:'unbound' as const,
 manifest:[{file_key:'f1',name:'a.txt',mime_type:'text/plain',size_bytes:2,sha256:createHash('sha256').update('ok').digest('hex')}],
 files:[{name:'a.txt',mime_type:'text/plain',content_base64:'b2s='}],
});
test('server recovery commands and import acknowledgements cannot be sent as Worker messages',()=>{
 const ack={type:'execution_delivery_imported',execution_id:'e1',delivery_id:'d1',package_sha256:'c'.repeat(64)};
 for(const value of [command,ack]){
  expect(p.serverMessageSchema.safeParse(value).success).toBe(true);
  expect(p.workerMessageSchema.safeParse(value).success).toBe(false);
 }
});
test('manifest rejects duplicate bytes entries, wrong sizes and noncanonical base64',()=>{
 const env={...packet(),package_sha256:'c'.repeat(64)};
 expect(p.deliveryEnvelopeSchema.safeParse({...env,files:[env.files[0],env.files[0]],manifest:[env.manifest[0],{...env.manifest[0],file_key:'f2',name:'b.txt'}]}).success).toBe(false);
 expect(p.deliveryEnvelopeSchema.safeParse({...env,manifest:[{...env.manifest[0],size_bytes:100}]}).success).toBe(false);
 expect(p.deliveryEnvelopeSchema.safeParse({...env,files:[{...env.files[0],content_base64:'b2t='}]}).success).toBe(false);
});
test('Agent and Codebase evidence cannot declare contradictory success',()=>{
 expect(p.agentEvidenceSchema.safeParse({...evidence,exit_code:1}).success).toBe(false);
 expect(p.agentEvidenceSchema.safeParse({...evidence,exit_code:null}).success).toBe(false);
 expect(p.agentEvidenceSchema.safeParse({...evidence,codebases:[{codebase_id:'11111111-1111-4111-8111-111111111111',access_mode:'read',head_commit:'a'.repeat(40),branch:null,result:'changed',changed_paths:[]}]}).success).toBe(false);
 const env={...packet(),purpose:'recovered_artifacts',package_sha256:'c'.repeat(64)};
 expect(p.deliveryEnvelopeSchema.safeParse(env).success).toBe(false);
});
test('delivery hash pins identity and is invariant to object property insertion order',()=>{
 const env=packet(),hash=hashing.hashDelivery(env);
 expect(hashing.hashDelivery({...env,delivery_id:'d2'})).not.toBe(hash);
 const reordered=JSON.parse(JSON.stringify(env,(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
 expect(hashing.hashDelivery(reordered)).toBe(hash);
});
test('independent verification recomputes file content hash and package hash',()=>{
 const env=packet(),complete={...env,package_sha256:hashing.hashDelivery(env)};
 expect(hashing.verifyDelivery(complete)).toEqual(complete);
 expect(()=>hashing.verifyDelivery({...complete,files:[{...env.files[0],content_base64:'bm8='}]})).toThrow(/hash|digest/i);
 expect(()=>hashing.verifyDelivery({...complete,package_sha256:'0'.repeat(64)})).toThrow(/hash|digest/i);
});
test('responses must correlate inspection and embedded delivery identities',()=>{
 const env=packet();
 const response={type:'execution_recovery_response',request_id:'r1',operation_id:'op1',execution_id:'e1',connection_generation:1,inspection:{execution_id:'foreign',checkpoint_version:1,agent_outcome:'succeeded',stopped:true,delivery_id:'d1',package_sha256:'a'.repeat(64),has_workspace:true},delivery:null};
 expect(p.recoveryResponseSchema.safeParse(response).success).toBe(false);
 expect(p.recoveryRequestSchema.safeParse({...command,action:'resend_result'}).success).toBe(false);
});
test('Worker execution and delivery are distinct durable events, not legacy combined results',()=>{
 const assignment={attempt_id:'e1',lease_epoch:1,agent:'codex',instruction:'build',input_files:[],codebases:[],timeout_seconds:null};
 const value={...packet(),assignment_sha256:hashing.hashAssignment(assignment)};
 const delivery={...value,package_sha256:hashing.hashDelivery(value)};
 const wrap=(event:unknown)=>({type:'event',attempt_id:'e1',lease_epoch:1,sequence:1,event});
 expect(p.workerMessageSchema.safeParse(wrap({type:'agent_finished',agent:'codex',assignment_sha256:value.assignment_sha256,checkpoint_version:2,evidence})).success).toBe(true);
 expect(p.workerMessageSchema.safeParse(wrap({type:'delivery_ready',delivery})).success).toBe(true);
 expect(p.workerMessageSchema.safeParse(wrap({type:'delivery_failed',checkpoint_version:3,code:'COLLECT_FAILED',message:'cannot package'})).success).toBe(true);
 expect(p.workerMessageSchema.safeParse(wrap({type:'result',result:{status:'succeeded',summary:'done',agent:'codex',checks:[]}})).success).toBe(false);
});
