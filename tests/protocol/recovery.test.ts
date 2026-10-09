import {expect,test} from 'vitest';
import {
  PROTOCOL_VERSION,
  recoveryRequestSchema,
  recoveryResponseSchema,
  deliveryEnvelopeSchema,
  type RecoveryCommand,
} from '../../src/protocol/index.js';
import {hashDelivery} from '../../src/protocol/recovery-hash.js';

const request:RecoveryCommand={
 type:'execution_recovery_request',request_id:'request_1',operation_id:'op_1',
 execution_id:'execution_1',assignment_sha256:'a'.repeat(64),
 connection_generation:1,expected_checkpoint_version:null,lease_ms:120000,
 action:'recover_artifacts',delivery_id:null,
};
test('recovery protocol requires the new version and rejects executable/path input',()=>{
 expect(PROTOCOL_VERSION).toBe(8);
 expect(recoveryRequestSchema.parse(request)).toEqual(request);
 expect(recoveryRequestSchema.safeParse({...request,path:'/etc/passwd'}).success).toBe(false);
 expect(recoveryRequestSchema.safeParse({...request,instruction:'run again'}).success).toBe(false);
});
test('delivery envelope binds manifest entries to exact files and hashes',()=>{
 const base={execution_id:'execution_1',delivery_id:'delivery_1',assignment_sha256:'a'.repeat(64),checkpoint_version:2,purpose:'execution_result' as const,agent:'codex' as const,evidence:{outcome:'succeeded' as const,exit_code:0,summary:'done',session_id:'session_1',checks:[{command:'node --check app.js',exit_code:0}],output_snapshot_sha256:'b'.repeat(64),codebases:[]},manifest:[{file_key:'file_1',name:'app.js',mime_type:'text/javascript',size_bytes:2,sha256:'c'.repeat(64)}],files:[{name:'app.js',mime_type:'text/javascript',content_base64:'b2s='}],package_sha256:'d'.repeat(64),verification_binding:'same_snapshot' as const};
 expect(deliveryEnvelopeSchema.parse(base)).toEqual(base);
 expect(deliveryEnvelopeSchema.safeParse({...base,files:[{...base.files[0],name:'other.js'}]}).success).toBe(false);
 expect(deliveryEnvelopeSchema.safeParse({...base,evidence:null,verification_binding:'same_snapshot'}).success).toBe(false);
});
test('recovery response has exclusive success and error branches',()=>{
 const error={type:'execution_recovery_response' as const,request_id:'request_1',operation_id:'op_1',execution_id:'execution_1',connection_generation:1,error:{code:'DELIVERY_MISSING',message:'missing'}};
 expect(recoveryResponseSchema.parse(error)).toEqual(error);
 expect(recoveryResponseSchema.safeParse({...error,delivery:{}}).success).toBe(false);
});
test('delivery hash is deterministic and excludes transport metadata',()=>{
 const envelope={
  execution_id:'execution_1',delivery_id:'delivery_1',assignment_sha256:'a'.repeat(64),checkpoint_version:2,
  purpose:'execution_result' as const,agent:'codex' as const,
  evidence:{outcome:'succeeded' as const,exit_code:0,summary:'done',session_id:'session_1',checks:[],output_snapshot_sha256:'b'.repeat(64),codebases:[]},
  manifest:[{file_key:'file_1',name:'app.js',mime_type:'text/javascript',size_bytes:2,sha256:'c'.repeat(64)}],
  files:[{name:'app.js',mime_type:'text/javascript',content_base64:'b2s='}],
  verification_binding:'same_snapshot' as const,
 };
 const first=hashDelivery(envelope);
 expect(first).toMatch(/^[a-f0-9]{64}$/);
 expect(hashDelivery({...envelope,delivery_id:'delivery_2'})).not.toBe(first);
 expect(hashDelivery({...envelope,execution_id:'execution_2'})).not.toBe(first);
});
