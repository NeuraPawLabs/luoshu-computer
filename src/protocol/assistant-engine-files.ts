import {z} from 'zod';
import {idSchema} from './wire-base.js';
import {taskFilesSchema,MAX_FILE_BYTES,fileByteLength} from './task-files.js';
import {codebaseExecutionResultSchema} from './execution.js';
import {nativeCommandReceiptsSchema} from './assistant-engine-evidence.js';
import {nativeCheckTargetsSchema,nativeDeliveredChecksSchema,sameCheckTargets} from './assistant-engine-checks.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const nativeCodebaseReceiptSchema=codebaseExecutionResultSchema.safeExtend({base_commit:z.string().regex(/^[a-f0-9]{40,64}$/)});
export const nativeCodebaseReceiptsSchema=z.array(nativeCodebaseReceiptSchema).max(32).refine(rows=>new Set(rows.map(r=>r.codebase_id)).size===rows.length,'Duplicate native Codebase receipt');
export type NativeCodebaseReceipt=z.infer<typeof nativeCodebaseReceiptSchema>;
export const nativeDeliverySchema=z.object({
 session_id:idSchema,submission_id:idSchema,run_id:idSchema,delivery_id:idSchema,
 source_sha256:sha,package_sha256:sha,
 manifest:z.array(z.object({file_key:idSchema,name:z.string().min(1).max(240),mime_type:z.string().min(1),size_bytes:z.number().int().min(0).max(MAX_FILE_BYTES),sha256:sha}).strict()).max(4),
 files:taskFilesSchema,
 codebases:nativeCodebaseReceiptsSchema,
 commands:nativeCommandReceiptsSchema,
 content:nativeCheckTargetsSchema,checks:nativeDeliveredChecksSchema,
}).strict().superRefine((value,ctx)=>{
 if(value.files.length!==value.manifest.length||new Set(value.manifest.map(f=>f.file_key)).size!==value.manifest.length||new Set(value.manifest.map(f=>f.name)).size!==value.manifest.length)ctx.addIssue({code:'custom',message:'Native file manifest mismatch'});
 for(const entry of value.manifest){const file=value.files.find(f=>f.name===entry.name);if(!file||file.mime_type!==entry.mime_type||fileByteLength(file.content_base64)!==entry.size_bytes)ctx.addIssue({code:'custom',message:'Native file metadata mismatch'});}
 if(value.content.find(t=>t.kind==='outputs')?.sha256!==value.source_sha256)ctx.addIssue({code:'custom',message:'Native check output hash mismatch'});
 for(const check of value.checks){
  if((check.binding==='current')!==sameCheckTargets(check.after,value.content))ctx.addIssue({code:'custom',message:'Native check content binding mismatch'});
  if(check.command_ids.some(id=>!value.commands.some(c=>c.thread_id===check.thread_id&&c.turn_id===check.turn_id&&c.item_id===id)))ctx.addIssue({code:'custom',message:'Native check command missing'});
  if(check.status==='passed'&&check.command_ids.some(id=>!value.commands.some(c=>c.item_id===id&&c.thread_id===check.thread_id&&c.turn_id===check.turn_id&&c.status==='completed'&&c.exit_code===0&&c.command!==null&&c.cwd!==null)))ctx.addIssue({code:'custom',message:'Passed native check lacks successful command'});
 }
});
export type NativeDelivery=z.infer<typeof nativeDeliverySchema>;
