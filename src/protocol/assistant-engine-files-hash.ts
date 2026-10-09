import {createHash} from 'node:crypto';
import {nativeDeliverySchema,nativeCodebaseReceiptsSchema,type NativeDelivery,type NativeCodebaseReceipt} from './assistant-engine-files.js';
import {MAX_WIRE_BYTES,taskFilesSchema,type TaskFile} from './task-files.js';
import {nativeCommandReceiptsSchema,type NativeCommandReceipt} from './assistant-engine-evidence.js';
import {checkTargetKey,type NativeCheckTarget,type NativeDeliveredCheck} from './assistant-engine-checks.js';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function checksum(value:Omit<NativeDelivery,'package_sha256'>){
 return sha(JSON.stringify({session_id:value.session_id,submission_id:value.submission_id,run_id:value.run_id,delivery_id:value.delivery_id,source_sha256:value.source_sha256,
  manifest:[...value.manifest].sort((a,b)=>a.file_key.localeCompare(b.file_key)).map(m=>({file_key:m.file_key,name:m.name,mime_type:m.mime_type,size_bytes:m.size_bytes,sha256:m.sha256})),
  codebases:[...value.codebases].sort((a,b)=>a.codebase_id.localeCompare(b.codebase_id)).map(c=>({codebase_id:c.codebase_id,base_commit:c.base_commit,access_mode:c.access_mode,head_commit:c.head_commit,branch:c.branch,result:c.result,changed_paths:c.changed_paths,...(c.read_isolation?{read_isolation:c.read_isolation}:{})})),
  commands:[...value.commands].sort((a,b)=>JSON.stringify([a.thread_id,a.turn_id,a.item_id]).localeCompare(JSON.stringify([b.thread_id,b.turn_id,b.item_id]))).map(c=>({thread_id:c.thread_id,turn_id:c.turn_id,item_id:c.item_id,command:c.command,cwd:c.cwd,status:c.status,exit_code:c.exit_code,duration_ms:c.duration_ms})),
  content:[...value.content].sort((a,b)=>checkTargetKey(a).localeCompare(checkTargetKey(b))),checks:value.checks}));
}
export function sealNativeDelivery(value:{session_id:string;submission_id:string;run_id:string;delivery_id:string;source_sha256:string;files:TaskFile[];codebases?:NativeCodebaseReceipt[];commands?:NativeCommandReceipt[];content?:NativeCheckTarget[];checks?:NativeDeliveredCheck[]}):NativeDelivery{
 const files=taskFilesSchema.parse(value.files),manifest=files.map((file,index)=>{const bytes=Buffer.from(file.content_base64,'base64');return{file_key:'file_'+index,name:file.name,mime_type:file.mime_type,size_bytes:bytes.length,sha256:sha(bytes)};});
 const packet={...value,files,manifest,codebases:nativeCodebaseReceiptsSchema.parse(value.codebases??[]),commands:nativeCommandReceiptsSchema.parse(value.commands??[]),content:value.content??[{kind:'outputs' as const,sha256:value.source_sha256}],checks:value.checks??[]};return verifyNativeDelivery({...packet,package_sha256:checksum(packet)});
}
export function verifyNativeDelivery(value:unknown):NativeDelivery{
 const packet=nativeDeliverySchema.parse(value);
 if(Buffer.byteLength(JSON.stringify(packet))>MAX_WIRE_BYTES-4096)throw Error('Native delivery exceeds transport limit');
 for(const entry of packet.manifest){const file=packet.files.find(f=>f.name===entry.name)!;if(sha(Buffer.from(file.content_base64,'base64'))!==entry.sha256)throw Error('Native file checksum mismatch');}
 if(checksum(packet)!==packet.package_sha256)throw Error('Native delivery package hash mismatch');
 return packet;
}
