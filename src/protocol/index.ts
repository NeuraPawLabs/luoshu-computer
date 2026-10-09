import { z } from 'zod';
export * from './computer-release.js';
export * from './assistant-engine.js';
export * from './assistant-engine-session.js';
export * from './assistant-engine-events.js';
export * from './assistant-engine-tasks.js';
export * from './assistant-engine-titles.js';
export * from './project-knowledge.js';
export * from './assistant-engine-native-tools.js';
export * from './assistant-engine-files.js';
export * from './assistant-engine-evidence.js';
export * from './assistant-engine-checks.js';
export * from './assistant-engine-codebases.js';
export * from './assistant-engine-wire.js';
import {gitHostSchema} from './git.js';
export * from './git.js';
import { developmentRequestSchema, developmentResponseSuccessSchema, developmentResponseErrorSchema, developmentOutputSchema, workerConfigRequestSchema, workerConfigResponseSchema, workerConfigReadSchema, workerConfigStateSchema } from './development.js';
import { maintenanceRequestSchema, maintenanceResponseSuccessSchema, maintenanceResponseErrorSchema } from './maintenance.js';
import { recoveryRequestSchema, recoveryResponseSchema, importedAckSchema, agentEvidenceSchema, deliveryEnvelopeSchema, sha256Schema, type AgentEvidence, type DeliveryEnvelope } from './recovery.js';

import {idSchema,text,positive,agentIdSchema,agentReportSchema,PROTOCOL_VERSION,type AgentId} from './wire-base.js';
import {deviceEngineReportSchema,type DeviceEngineReport} from './assistant-engine.js';
import {engineWireRequestMessageSchema,engineWireResponseMessageSchema,engineWireErrorMessageSchema,engineWireEventSchema} from './assistant-engine-wire.js';
import {assignmentSchema,resultSchema,codebasePrepareRequestSchema,codebasePrepareResponseSuccessSchema,codebasePrepareResponseErrorSchema,type Assignment,type ExecutionResult} from './execution.js';
export * from './wire-base.js';
export * from './task-files.js';
export * from './execution.js';
export const reportSchema=z.object({name:text(100),os:text(50),arch:text(50),tools:z.record(z.string().max(100),z.string().max(120)),agents:z.array(agentReportSchema).max(2).refine(agents=>new Set(agents.map(a=>a.id)).size===agents.length,'Duplicate agents'),assistant_engines:z.array(deviceEngineReportSchema).max(2).optional(),capacity:z.number().int().min(1).max(16),revision:positive,protocol_version:z.literal(PROTOCOL_VERSION),computer_version:text(50),development:z.literal(true).optional(),maintenance_git:z.literal(true).optional(),git_credentials:z.array(z.object({host:gitHostSchema,configured:z.literal(true),checked_at:z.number().int().nonnegative().nullable(),error:z.string().max(500).optional()}).strict()).max(100).optional()}).strict();
export type WorkerReport=z.infer<typeof reportSchema>;
export const executionEventSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('started')}).strict(),
 z.object({type:z.literal('progress'),text:z.string().max(8000)}).strict(),
 z.object({type:z.literal('agent_finished'),agent:agentIdSchema,assignment_sha256:sha256Schema,checkpoint_version:positive,evidence:agentEvidenceSchema}).strict(),
 z.object({type:z.literal('delivery_ready'),delivery:deliveryEnvelopeSchema}).strict(),
 z.object({type:z.literal('delivery_failed'),checkpoint_version:positive,code:text(100),message:text(2000)}).strict(),
 z.object({type:z.literal('stopped'),reason:z.string().max(2000)}).strict(),
 z.object({type:z.literal('unknown'),reason:z.string().max(2000)}).strict()
]);
export type ExecutionEvent=z.infer<typeof executionEventSchema>;
export const workerEventSchema=z.object({type:z.literal('event'),attempt_id:idSchema,lease_epoch:positive,sequence:positive,event:executionEventSchema}).strict();
export type WorkerEvent=z.infer<typeof workerEventSchema>;
export const workerMessageSchema=z.union([
  z.object({type:z.literal('auth'),worker_id:idSchema,signature:text(300),report:reportSchema}).strict(),
 z.object({type:z.literal('report'),report:reportSchema}).strict(),
 z.object({type:z.literal('heartbeat'),active:z.array(idSchema).max(16)}).strict(),
 z.object({type:z.literal('accept'),attempt_id:idSchema}).strict(),
 z.object({type:z.literal('reject'),attempt_id:idSchema,reason:text(2000)}).strict(),
 z.object({type:z.literal('live_progress'),attempt_id:idSchema,lease_epoch:positive,text:z.string().min(1).max(8000)}).strict(),
 workerEventSchema,
 developmentResponseSuccessSchema,
 developmentResponseErrorSchema,
 developmentOutputSchema,
 workerConfigResponseSchema,
 workerConfigStateSchema,
 maintenanceResponseSuccessSchema,
 maintenanceResponseErrorSchema,
 codebasePrepareResponseSuccessSchema,
 codebasePrepareResponseErrorSchema,
 recoveryResponseSchema,
 engineWireResponseMessageSchema,
 engineWireErrorMessageSchema,
 engineWireEventSchema,
]);
export type WorkerMessage=z.infer<typeof workerMessageSchema>;
export interface Worker {id:string;owner_id:string;public_key:string;report:WorkerReport;status:'pending'|'approved'|'revoked';generation:number;last_seen:number|null;approved_agents:AgentId[];}
export interface WorkerExecution {id:string;owner_id:string;worker_id:string;invocation_id:string;assignment:Assignment;state:'offered'|'running'|'stopping'|'succeeded'|'failed'|'cancelled'|'unknown';generation:number;lease_until:number;sequence:number;result:ExecutionResult|null;created_at:number;confirmed_stopped?:boolean;evidence?:AgentEvidence;delivery?:DeliveryEnvelope;delivery_error?:{code:string;message:string};checkpoint_version?:number;}
export const serverMessageSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('challenge'),nonce:text(300),protocol_version:z.literal(PROTOCOL_VERSION)}).strict(),
 z.object({type:z.literal('welcome'),worker_id:idSchema,generation:positive,heartbeat_ms:positive,lease_ms:positive,live_progress:z.literal(true).optional()}).strict(),
 z.object({type:z.literal('offer'),assignment:assignmentSchema}).strict(),
 z.object({type:z.literal('start'),assignment:assignmentSchema,lease_ms:positive}).strict(),
 z.object({type:z.literal('lease'),attempt_id:idSchema,lease_epoch:positive,lease_ms:positive}).strict(),
 z.object({type:z.literal('reconciled'),attempt_id:idSchema,lease_epoch:positive}).strict(),
 z.object({type:z.literal('cancel'),attempt_id:idSchema,reason:text(2000)}).strict(),
 z.object({type:z.literal('ack'),attempt_id:idSchema,sequence:positive,accepted:z.boolean()}).strict(),
 z.object({type:z.literal('error'),message:text(2000)}).strict(),
 developmentRequestSchema,
 workerConfigRequestSchema,
 workerConfigReadSchema,
 maintenanceRequestSchema,
 codebasePrepareRequestSchema,
 recoveryRequestSchema,
 engineWireRequestMessageSchema,
 importedAckSchema,
]);
export type ServerMessage=z.infer<typeof serverMessageSchema>;

export * from './recovery.js';


export * from './development.js';
export * from './maintenance.js';
