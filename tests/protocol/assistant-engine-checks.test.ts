import {expect,test} from 'vitest';
import {nativeCheckOperationSchema,nativeCheckReceiptSchema,nativeCheckTools} from '../../src/protocol/assistant-engine-checks.js';
import {sealNativeDelivery,verifyNativeDelivery} from '../../src/protocol/assistant-engine-files-hash.js';
test('native check tools accept purpose or saved check ID, never caller identities, paths or results',()=>{
 expect(nativeCheckTools().map(t=>t.name)).toEqual(['luoshu_check_begin','luoshu_check_end']);
 expect(nativeCheckOperationSchema.parse({action:'begin',purpose:'Run unit tests'})).toEqual({action:'begin',purpose:'Run unit tests'});
 for(const patch of [{cwd:'/secret'},{exit_code:0},{actor:'forged'},{passed:true}])expect(()=>nativeCheckOperationSchema.parse({action:'begin',purpose:'test',...patch})).toThrow();
 expect(()=>nativeCheckOperationSchema.parse({action:'end',check_id:'check',purpose:'changed'})).toThrow();
});
test('delivery seals check claims, content, binding and commands without accepting fabricated successful checks',()=>{
 const target={kind:'outputs' as const,sha256:'a'.repeat(64)},command={thread_id:'thread',turn_id:'turn',item_id:'cmd',command:'test',cwd:'/work',status:'completed' as const,exit_code:0,duration_ms:1};
 const check={check_id:'check',thread_id:'thread',turn_id:'turn',purpose:'test',command_ids:['cmd'],before:[target],after:[target],status:'passed' as const,binding:'current' as const};
 const value={session_id:'s',submission_id:'sub',run_id:'run',delivery_id:'d',source_sha256:target.sha256,files:[],commands:[command],content:[target],checks:[check]};
 const packet=sealNativeDelivery(value);expect(verifyNativeDelivery(packet)).toEqual(packet);
 expect(()=>verifyNativeDelivery({...packet,checks:[{...check,purpose:'different'}]})).toThrow(/hash/);
 expect(()=>sealNativeDelivery({...value,commands:[]})).toThrow(/command/);
 expect(()=>sealNativeDelivery({...value,commands:[{...command,exit_code:1}]})).toThrow(/successful/);
 expect(()=>sealNativeDelivery({...value,checks:[{...check,binding:'changed'}]})).toThrow(/binding/);
 const {checks:_,...missing}=packet;expect(()=>verifyNativeDelivery(missing)).toThrow();
 const second={...check,check_id:'second',status:'failed' as const};const ordered=sealNativeDelivery({...value,checks:[check,second]});
 expect(()=>verifyNativeDelivery({...ordered,checks:[second,check]})).toThrow(/hash/);
});
test('check evidence is scoped to native command IDs and explicit content fingerprints',()=>{
 const target={kind:'outputs',sha256:'a'.repeat(64)},receipt={check_id:'check',thread_id:'thread',turn_id:'turn',purpose:'tests',command_ids:['cmd'],before:[target],after:[target],status:'passed'};
 expect(nativeCheckReceiptSchema.parse(receipt)).toEqual(receipt);
 for(const patch of [{command_ids:[]},{command_ids:['cmd','cmd']},{after:[{...target,sha256:'b'.repeat(64)}]},{stdout:'raw'}])expect(()=>nativeCheckReceiptSchema.parse({...receipt,...patch})).toThrow();
});
