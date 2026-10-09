import {expect,test} from 'vitest';
import {sealNativeDelivery,verifyNativeDelivery} from '../../src/protocol/assistant-engine-files-hash.js';

const packet=()=>({session_id:'session',submission_id:'submission',run_id:'run',delivery_id:'delivery',source_sha256:'a'.repeat(64),files:[{name:'project.zip',mime_type:'application/zip',content_base64:Buffer.from('file bytes').toString('base64')}]});
const codebase={codebase_id:'11111111-1111-4111-8111-111111111111',base_commit:'a'.repeat(40),head_commit:'b'.repeat(40),branch:'luoshu/feature/run',access_mode:'write' as const,result:'changed' as const,changed_paths:['index.ts']};
test('native delivery seals Codebase base/head/branch and changes with stable receipt ordering',()=>{
 const other={...codebase,codebase_id:'22222222-2222-4222-8222-222222222222'},sealed=sealNativeDelivery({...packet(),codebases:[codebase,other]});
 expect(sealed.codebases).toHaveLength(2);expect(verifyNativeDelivery(sealed)).toEqual(sealed);
 expect(sealNativeDelivery({...packet(),codebases:[other,codebase]}).package_sha256).toBe(sealed.package_sha256);
 for(const patch of [{base_commit:'c'.repeat(40)},{head_commit:'c'.repeat(40)},{branch:'luoshu/feature/other'},{changed_paths:['other.ts']}])expect(()=>verifyNativeDelivery({...sealed,codebases:[{...codebase,...patch},other]})).toThrow(/hash|checksum/);
});
test('native delivery rejects duplicate/incomplete/mutated Codebase evidence and absent receipt list',()=>{
 expect(()=>sealNativeDelivery({...packet(),codebases:[codebase,codebase]})).toThrow();
 expect(()=>sealNativeDelivery({...packet(),codebases:[{...codebase,base_commit:null}]})).toThrow();
 expect(()=>sealNativeDelivery({...packet(),codebases:[{...codebase,access_mode:'read'}]})).toThrow();
 expect(()=>sealNativeDelivery({...packet(),codebases:[{...codebase,changed_paths:['../secret']}]})).toThrow();
 const {codebases:_,...missing}=sealNativeDelivery({...packet(),codebases:[]});expect(()=>verifyNativeDelivery(missing)).toThrow();
});
test('native delivery manifest authenticates bytes and all native execution identities',()=>{
 const sealed=sealNativeDelivery(packet());expect(verifyNativeDelivery(sealed)).toEqual(sealed);
 expect(sealed.manifest).toMatchObject([{file_key:'file_0',name:'project.zip',size_bytes:10}]);
 for(const field of ['session_id','submission_id','run_id','delivery_id','source_sha256'])expect(()=>verifyNativeDelivery({...sealed,[field]:field==='source_sha256'?'b'.repeat(64):'other'})).toThrow(/hash|checksum/i);
 expect(()=>verifyNativeDelivery({...sealed,files:[{...sealed.files[0],content_base64:Buffer.from('other bytes').toString('base64')}]})).toThrow();
});
test('native delivery rejects duplicate filenames, unsafe paths and inconsistent manifests',()=>{
 expect(()=>sealNativeDelivery({...packet(),files:[packet().files[0],packet().files[0]]})).toThrow();
 expect(()=>sealNativeDelivery({...packet(),files:[{...packet().files[0],name:'../outside'}]})).toThrow();
 const sealed=sealNativeDelivery(packet());expect(()=>verifyNativeDelivery({...sealed,manifest:[]})).toThrow();
 expect(()=>verifyNativeDelivery({...sealed,manifest:[{...sealed.manifest[0],size_bytes:1}]})).toThrow();
});
test('empty output is a valid immutable delivery, but no unrelated transport fields are accepted',()=>{
 const sealed=sealNativeDelivery({...packet(),files:[]});expect(verifyNativeDelivery(sealed).files).toEqual([]);
 expect(()=>verifyNativeDelivery({...sealed,actor_id:'forged'})).toThrow();
});
test('native command receipts are sealed with delivery without pretending to be verification',()=>{
 const command={thread_id:'thread',turn_id:'turn',item_id:'command',command:'npm test',cwd:'/workspace',status:'completed' as const,exit_code:0,duration_ms:42};
 const sealed=sealNativeDelivery({...packet(),commands:[command]});
 expect(sealed.commands).toEqual([command]);
 expect(()=>verifyNativeDelivery({...sealed,commands:[{...command,exit_code:1}]})).toThrow(/hash/);
 expect(()=>verifyNativeDelivery({...sealed,commands:[{...command,stdout:'RAW'}]})).toThrow();
 expect(()=>sealNativeDelivery({...packet(),commands:[command,command]})).toThrow();
 const {commands:_,...missing}=sealed;expect(()=>verifyNativeDelivery(missing)).toThrow();
 expect(sealed).not.toHaveProperty('verified');
});
test('native receipt ordering is canonical and missing execution fields remain unknown',()=>{
 const command={thread_id:'thread',turn_id:'turn',item_id:'one',command:null,cwd:null,status:'declined' as const,exit_code:null,duration_ms:null},other={...command,item_id:'two'};
 expect(sealNativeDelivery({...packet(),commands:[command,other]}).package_sha256).toBe(sealNativeDelivery({...packet(),commands:[other,command]}).package_sha256);
});
