import {z} from 'zod';
import {engineBindingSchema,engineSubmissionSchema,nativeSessionRefSchema} from './assistant-engine-session.js';
import {engineEventPayloadSchema,engineEventSourceSchema,engineWaitingInputSchema,engineWaitingApprovalSchema,engineInteractionOutcomeSchema} from './assistant-engine-events.js';
import {idSchema,positive} from './wire-base.js';
import {engineTaskResultSchema} from './assistant-engine-tasks.js';
import {engineTitleResultSchema} from './assistant-engine-titles.js';
import {engineKnowledgeResultSchema} from './project-knowledge.js';
import {nativeDeliverySchema} from './assistant-engine-files.js';
import {taskFilesSchema} from './task-files.js';
import {codebasePrepareResultSchema} from './execution.js';

const requestId=idSchema;
const text=z.string().max(64_000);
const control={request_id:requestId,session_id:idSchema,submission_id:idSchema,run_id:idSchema,authorization_revision:positive};
const lease=z.number().int().min(1).max(120000);
export const engineNativeResultSchema=z.object({status:z.enum(['completed','failed','cancelled']),replies:z.array(engineEventPayloadSchema.options[1]),reason:z.string().nullable()}).strict();
export const engineWireRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('session_close'),request_id:requestId,session_id:idSchema,binding:engineBindingSchema}).strict(),
 z.object({action:z.literal('session_prepare'),request_id:requestId,session_id:idSchema,binding:engineBindingSchema,workspace_id:idSchema,developer_instructions:z.string().max(32000).optional(),resources:z.object({run_id:idSchema,submission_id:idSchema}).strict().optional()}).strict(),
 z.object({action:z.literal('workspace_prepare'),request_id:requestId,submission:engineSubmissionSchema.refine(s=>Boolean(s.codebases?.length),'Native Codebase source specs required'),workspace_id:idSchema,developer_instructions:z.string().max(32000).optional(),input_files:taskFilesSchema,lease_ms:lease}).strict(),
 z.object({action:z.literal('workspace_cancel'),request_id:requestId,submission:engineSubmissionSchema.refine(s=>Boolean(s.codebases?.length),'Native Codebase source specs required')}).strict(),
 z.object({action:z.literal('workspace_inspect'),request_id:requestId,submission:engineSubmissionSchema.refine(s=>Boolean(s.codebases?.length),'Native Codebase source specs required')}).strict(),
 z.object({action:z.literal('workspace_renew'),request_id:requestId,submission:engineSubmissionSchema.refine(s=>Boolean(s.codebases?.length),'Native Codebase source specs required'),lease_ms:lease}).strict(),
 z.object({action:z.literal('session_inspect'),request_id:requestId,session_id:idSchema,binding:engineBindingSchema}).strict(),
 z.object({action:z.literal('submit'),request_id:requestId,submission:engineSubmissionSchema,input:z.array(z.object({type:z.literal('text'),text}).strict()).min(1).max(128),input_files:taskFilesSchema.optional(),lease_ms:lease}).strict(),
 z.object({action:z.literal('renew'),...control,lease_ms:lease}).strict(),
 z.object({action:z.literal('result'),...control}).strict(),
 z.object({action:z.literal('collect_result'),...control}).strict(),
 z.object({action:z.literal('inspect'),...control}).strict(),
 z.object({action:z.literal('interrupt'),...control,turn_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('interaction_response'),...control,turn_id:z.string().min(1).max(200),interaction_id:z.string().min(1).max(200),response:z.unknown()}).strict(),
 z.object({action:z.literal('reconcile'),...control}).strict(),
 z.object({action:z.literal('task_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200),result:engineTaskResultSchema}).strict(),
 z.object({action:z.literal('title_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200),result:engineTitleResultSchema}).strict(),
 z.object({action:z.literal('knowledge_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200),result:engineKnowledgeResultSchema}).strict(),
]);
export type EngineWireRequest=z.infer<typeof engineWireRequestSchema>;

export const engineWireResponseSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('session_close'),request_id:requestId,session_id:idSchema,binding:engineBindingSchema,state:z.literal('closed')}).strict(),
 z.object({action:z.literal('workspace_prepare'),...control,codebases:z.array(codebasePrepareResultSchema).min(1).max(32)}).strict(),
 z.object({action:z.literal('workspace_cancel'),...control,session_state:z.enum(['idle','creating','unknown','closed','missing']),native:nativeSessionRefSchema.nullable()}).strict(),
 z.object({action:z.literal('workspace_inspect'),...control,state:z.enum(['missing','open','submitted','cancelling','cancelled']),session_state:z.enum(['idle','creating','unknown','closed','missing']),native:nativeSessionRefSchema.nullable()}).strict(),
 z.object({action:z.literal('workspace_renew'),...control}).strict(),
 z.object({action:z.literal('session_prepare'),request_id:requestId,session_id:idSchema,native:nativeSessionRefSchema}).strict(),
 z.object({action:z.literal('session_inspect'),request_id:requestId,session_id:idSchema,binding:engineBindingSchema,state:z.enum(['idle','creating','unknown','closed','missing']),native:nativeSessionRefSchema.nullable()}).strict(),
 z.object({action:z.literal('submit'),request_id:requestId,session_id:idSchema,turn_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('renew'),...control}).strict(),
 z.object({action:z.literal('result'),...control,result:engineNativeResultSchema.nullable()}).strict(),
 z.object({action:z.literal('collect_result'),...control,delivery:nativeDeliverySchema}).strict(),
 z.object({action:z.literal('inspect'),...control,native:z.object({thread_id:z.string().min(1).max(200),turn_id:z.string().min(1).max(200).nullable()}).strict().nullable(),state:z.enum(['prepared','starting','running','stopping','unknown','completed','failed','cancelled']),attached:z.boolean(),event_sequence:z.number().int().nonnegative(),interactions:z.array(z.union([engineWaitingInputSchema,engineWaitingApprovalSchema])),interaction_outcomes:z.array(engineInteractionOutcomeSchema)}).strict(),
 z.object({action:z.literal('interrupt'),...control,turn_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('interaction_response'),...control,turn_id:z.string().min(1).max(200),interaction_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('reconcile'),...control,status:z.enum(['idle','running','unknown'])}).strict(),
 z.object({action:z.literal('task_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('title_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('knowledge_response'),...control,turn_id:z.string().min(1).max(200),call_id:z.string().min(1).max(200)}).strict(),
]);
export type EngineWireResponse=z.infer<typeof engineWireResponseSchema>;

export const engineWireEventSchema=z.object({
 type:z.literal('assistant_engine_event'),event_id:idSchema,session_id:idSchema,worker_generation:positive,event_sequence:positive,
 source:engineEventSourceSchema,event:engineEventPayloadSchema,
}).strict().superRefine((value,ctx)=>{
 if(value.source.worker_id===null||value.source.worker_generation!==value.worker_generation||value.source.session_id!==value.session_id)ctx.addIssue({code:'custom',message:'Device event provenance mismatch'});
});
export type EngineWireEvent=z.infer<typeof engineWireEventSchema>;

export const engineWireRequestMessageSchema=z.object({type:z.literal('assistant_engine_request'),request:engineWireRequestSchema}).strict();
export const engineWireResponseMessageSchema=z.object({type:z.literal('assistant_engine_response'),response:engineWireResponseSchema}).strict();
export const engineWireErrorMessageSchema=z.object({type:z.literal('assistant_engine_error'),request_id:requestId,code:z.string().max(100),message:z.string().max(2000),retryable:z.boolean()}).strict();
export const engineWireMessageSchema=z.discriminatedUnion('type',[engineWireRequestMessageSchema,engineWireResponseMessageSchema,engineWireErrorMessageSchema,engineWireEventSchema]);
export type EngineWireMessage=z.infer<typeof engineWireMessageSchema>;
