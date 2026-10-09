import {z} from 'zod';
import {idSchema as id,agentIdSchema as agent,positive} from './wire-base.js';
import {MAX_FILE_BYTES,MAX_TASK_FILES,taskFileSchema,taskFilesSchema,fileByteLength} from './task-files.js';
import {codebaseExecutionResultSchema} from './execution.js';

export const sha256Schema=z.string().regex(/^[a-f0-9]{64}$/);
export const agentOutcomeSchema=z.enum(['succeeded','failed','cancelled','unknown']);
export const agentEvidenceSchema=z.object({
 outcome:agentOutcomeSchema,exit_code:z.number().int().nullable(),
 summary:z.string().max(16000),session_id:z.string().max(200).nullable(),
 checks:z.array(z.object({command:z.string().min(1).max(2000),exit_code:z.number().int()}).strict()).max(50),
 output_snapshot_sha256:sha256Schema.nullable(),codebases:z.array(codebaseExecutionResultSchema).max(32),
}).strict().superRefine((v,c)=>{
 if(v.outcome==='succeeded'&&v.exit_code!==0)c.addIssue({code:'custom',message:'Successful Agent requires zero exit code'});
 if(new Set(v.codebases.map(x=>x.codebase_id)).size!==v.codebases.length)c.addIssue({code:'custom',message:'Duplicate Codebase evidence'});
});
export type AgentEvidence=z.infer<typeof agentEvidenceSchema>;
export const deliveryManifestItemSchema=z.object({
 file_key:id,name:taskFileSchema.shape.name,mime_type:taskFileSchema.shape.mime_type,
 size_bytes:z.number().int().nonnegative().max(MAX_FILE_BYTES),sha256:sha256Schema,
}).strict();
export type DeliveryManifestItem=z.infer<typeof deliveryManifestItemSchema>;
export const deliveryEnvelopeSchema=z.object({
 execution_id:id,delivery_id:id,assignment_sha256:sha256Schema,checkpoint_version:z.number().int().nonnegative(),
 purpose:z.enum(['execution_result','recovered_artifacts']),agent,evidence:agentEvidenceSchema.nullable(),
 manifest:z.array(deliveryManifestItemSchema).max(MAX_TASK_FILES),files:taskFilesSchema,
 package_sha256:sha256Schema,verification_binding:z.enum(['same_snapshot','unbound']),
}).strict().superRefine((v,c)=>{
 const issue=(message:string)=>c.addIssue({code:'custom',message});
 if(new Set(v.manifest.map(x=>x.file_key)).size!==v.manifest.length)issue('Duplicate delivery file key');
 if(new Set(v.manifest.map(x=>x.name.normalize('NFC').toLowerCase())).size!==v.manifest.length)issue('Duplicate delivery filename');
 if(v.files.length!==v.manifest.length)issue('Delivery files must match manifest');
 for(const item of v.manifest){
  const file=v.files.find(f=>f.name===item.name);
  if(!file||file.mime_type!==item.mime_type||fileByteLength(file.content_base64)!==item.size_bytes)issue('Delivery file does not match manifest');
 }
 if(v.purpose==='execution_result'&&!v.evidence)issue('Execution delivery requires Agent evidence');
 if(v.purpose==='recovered_artifacts'&&(v.evidence!==null||v.verification_binding!=='unbound'))issue('Recovered artifacts have no verified execution evidence');
 if(v.verification_binding==='same_snapshot'&&(!v.evidence?.output_snapshot_sha256||v.evidence.outcome!=='succeeded'))issue('Snapshot binding requires successful evidence');
});
export type DeliveryEnvelope=z.infer<typeof deliveryEnvelopeSchema>;
export const recoveryRequestSchema=z.object({
 type:z.literal('execution_recovery_request'),request_id:id,operation_id:id,execution_id:id,
 assignment_sha256:sha256Schema,connection_generation:positive,
 expected_checkpoint_version:z.number().int().nonnegative().nullable(),lease_ms:z.number().int().min(1000).max(300000),
 action:z.enum(['inspect_result','collect_result','resend_result','recover_artifacts']),delivery_id:id.nullable(),
}).strict().superRefine((v,c)=>{
 if((v.action==='resend_result')!==(v.delivery_id!==null))c.addIssue({code:'custom',message:'Only resend_result requires a delivery ID'});
});
export type RecoveryCommand=z.infer<typeof recoveryRequestSchema>;
export const recoveryInspectionSchema=z.object({
 execution_id:id,checkpoint_version:z.number().int().nonnegative().nullable(),agent_outcome:agentOutcomeSchema,
 stopped:z.boolean(),delivery_id:id.nullable(),package_sha256:sha256Schema.nullable(),has_workspace:z.boolean(),
}).strict().refine(v=>(v.delivery_id===null)===(v.package_sha256===null),'Delivery reference requires ID and hash');
export type DeliveryInspection=z.infer<typeof recoveryInspectionSchema>;
export const recoveryErrorSchema=z.object({
 code:z.enum(['RECOVERY_NOT_FOUND','RECOVERY_UNAUTHORIZED','RECOVERY_STALE','RECOVERY_ACTIVE','DELIVERY_MISSING','DELIVERY_CORRUPT','RECOVERY_EXPIRED','RECOVERY_STOPPED','RECOVERY_UNAVAILABLE']),
 message:z.string().min(1).max(2000),
}).strict();
const responseFields={type:z.literal('execution_recovery_response'),request_id:id,operation_id:id,execution_id:id,connection_generation:positive};
export const recoveryResponseSuccessSchema=z.object({...responseFields,inspection:recoveryInspectionSchema,delivery:deliveryEnvelopeSchema.nullable()}).strict().superRefine((v,c)=>{
 if(v.inspection.execution_id!==v.execution_id||v.delivery&&(v.delivery.execution_id!==v.execution_id||v.delivery.delivery_id!==v.inspection.delivery_id||v.delivery.package_sha256!==v.inspection.package_sha256))
  c.addIssue({code:'custom',message:'Mismatched recovery response identities'});
});
export const recoveryResponseErrorSchema=z.object({...responseFields,error:recoveryErrorSchema}).strict();
export const recoveryResponseSchema=z.union([recoveryResponseSuccessSchema,recoveryResponseErrorSchema]);
export type RecoveryResponse=z.infer<typeof recoveryResponseSchema>;
export const importedAckSchema=z.object({type:z.literal('execution_delivery_imported'),execution_id:id,delivery_id:id,package_sha256:sha256Schema}).strict();
export type ImportedAck=z.infer<typeof importedAckSchema>;
