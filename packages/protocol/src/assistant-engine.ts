import {z} from 'zod';
import {agentIdSchema, idSchema} from './wire-base.js';

export const agentEngineConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('builtin'),
    model_connection_id: z.string().uuid(),
    model_id: z.string().trim().min(1).max(200),
    reasoning_effort: z.string().trim().min(1).max(32).refine(value => value !== 'auto').nullable(),
    thinking_budget_tokens: z.number().int().min(1024).max(16384).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('device'),
    worker_id: idSchema,
    agent: z.literal('codex'),
    adapter_version: z.literal(1),
  }).strict(),
]);
export type AgentEngineConfig = z.infer<typeof agentEngineConfigSchema>;

export const requiredDeviceEngineFeatures = [
  'session_resume', 'turn_status', 'turn_interrupt', 'interaction_response',
  'structured_events', 'attachments', 'task_operations', 'delivery',
] as const;

export const deviceEngineReportSchema = z.object({
  agent: agentIdSchema,
  agent_version: z.string().min(1).max(120),
  adapter_version: z.number().int().positive().nullable(),
  status: z.enum(['ready', 'unavailable']),
  reason: z.enum(['adapter_missing', 'protocol_unsupported', 'login_required', 'permissions_unavailable', 'supervisor_unavailable']).nullable(),
  features: z.array(z.enum(requiredDeviceEngineFeatures)),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.features).size !== value.features.length) {
    ctx.addIssue({code: 'custom', message: 'Duplicate engine feature'});
  }
  if (value.status === 'unavailable' && value.reason === null) {
    ctx.addIssue({code: 'custom', message: 'An unavailable engine needs a reason'});
  }
  if (value.status === 'ready' && (
    value.agent !== 'codex' || value.adapter_version !== 1 || value.reason !== null ||
    requiredDeviceEngineFeatures.some(feature => !value.features.includes(feature))
  )) ctx.addIssue({code: 'custom', message: 'Direct conversation requirements are not met'});
});
export type DeviceEngineReport = z.infer<typeof deviceEngineReportSchema>;
