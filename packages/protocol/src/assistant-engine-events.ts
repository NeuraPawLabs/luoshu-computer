import {z} from 'zod';
import {idSchema} from './wire-base.js';
import {engineTaskOperationSchema} from './assistant-engine-tasks.js';
import {conversationTitleUpdateSchema} from './assistant-engine-titles.js';
import {engineKnowledgeOperationSchema} from './project-knowledge.js';

const nativeId = z.string().min(1).max(200);
export const engineEventSourceSchema = z.object({
  conversation_id: idSchema, agent_id: idSchema,
  actor_id: z.string().min(1).max(200),
  session_id: idSchema, run_id: idSchema, submission_id: idSchema,
  authorization_revision: z.number().int().positive(),
  worker_id: idSchema.nullable(),
  worker_generation: z.number().int().positive().nullable(),
  native: z.object({thread_id: nativeId, turn_id: nativeId, item_id: nativeId.nullable()}).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.worker_id === null) !== (value.worker_generation === null)) {
    ctx.addIssue({code: 'custom', message: 'Worker identity and generation must be provided together'});
  }
});
export type EngineEventSource = z.infer<typeof engineEventSourceSchema>;

const citation = z.object({
  url: z.url({protocol: /^https?$/}),
  title: z.string(),
}).strict();
const approvalDecisions = z.array(z.enum(['allow_once', 'deny', 'cancel'])).min(1)
  .refine(value => new Set(value).size === value.length, 'Duplicate approval decision');

export const engineWaitingInputSchema = z.object({kind: z.literal('waiting_input'), request_id: nativeId,
  is_blocking: z.boolean(),
  questions: z.array(z.object({id: nativeId, text: z.string().min(1), options: z.array(z.string()),
    header: z.string().optional(), option_descriptions: z.array(z.string()).optional(),
    is_other: z.boolean().optional()}).strict()).min(1),
  expires_at: z.number().int().nonnegative().nullable()}).strict();
export const engineWaitingApprovalSchema = z.object({kind: z.literal('waiting_approval'), request_id: nativeId, item_id: nativeId,
  summary: z.string().min(1), decisions: approvalDecisions,
  expires_at: z.number().int().nonnegative().nullable()}).strict();
export const engineInteractionOutcomeSchema = z.object({request_id: nativeId,
  resolution: z.enum(['answered', 'dismissed'])}).strict();
export type EngineInteractionOutcome = z.infer<typeof engineInteractionOutcomeSchema>;

export const engineEventPayloadSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('reply.delta'), item_id: nativeId, text: z.string()}).strict(),
  z.object({kind: z.literal('reply.final'), item_id: nativeId, text: z.string(),
    citations: z.array(citation), artifact_ids: z.array(idSchema)}).strict(),
  z.object({kind: z.literal('progress'), text: z.string()}).strict(),
  z.object({kind: z.literal('reasoning.summary'), item_id: nativeId,
    mode: z.enum(['append', 'replace']), text: z.string()}).strict(),
  z.object({kind: z.literal('tool.started'), item_id: nativeId, name: z.string().min(1),
    command: z.string().nullable()}).strict(),
  z.object({kind: z.literal('tool.output'), item_id: nativeId, text: z.string()}).strict(),
  z.object({kind: z.literal('tool.finished'), item_id: nativeId,
    status: z.enum(['completed', 'failed', 'declined']), exit_code: z.number().int().nullable()}).strict(),
  engineWaitingInputSchema,
  engineWaitingApprovalSchema,
  engineInteractionOutcomeSchema.extend({kind: z.literal('interaction.resolved')}).strict(),
  z.object({kind: z.literal('turn.status'),
    state: z.enum(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'delivering',
      'completed', 'failed', 'stopping', 'cancelled', 'unknown']),
    reason: z.string().nullable()}).strict(),
  z.object({kind: z.literal('delivery.ready'), delivery_id: idSchema,
    manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('task.request'),request_id:nativeId,operation:engineTaskOperationSchema}).strict(),
  z.object({kind: z.literal('progress.delta'), item_id: nativeId, text: z.string()}).strict(),
  z.object({kind: z.literal('progress.final'), item_id: nativeId, text: z.string()}).strict(),
  z.object({kind: z.literal('conversation.title.request'), request_id: nativeId, update: conversationTitleUpdateSchema}).strict(),
  z.object({kind:z.literal('knowledge.request'),request_id:nativeId,operation:engineKnowledgeOperationSchema}).strict(),
]);
export type EngineEventPayload = z.infer<typeof engineEventPayloadSchema>;

export const engineTurnEventSchema = z.object({
  source: engineEventSourceSchema,
  sequence: z.number().int().positive(),
  event: engineEventPayloadSchema,
}).strict();
export type EngineTurnEvent = z.infer<typeof engineTurnEventSchema>;
