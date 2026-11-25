import {z} from 'zod';
import {agentIdSchema, idSchema} from './wire-base.js';

/** Execution on an authenticated Computer. Model profiles are server-side. */
export const agentEngineConfigSchema = z.object({
  kind: z.literal('device'),
  device_id: idSchema,
  agent: z.literal('codex'),
  adapter_version: z.literal(1),
}).strict();
export type AgentEngineConfig = z.infer<typeof agentEngineConfigSchema>;

export const requiredDeviceEngineFeatures = [
  'session_resume', 'turn_status', 'turn_interrupt', 'interaction_response',
  'structured_events', 'attachments', 'task_operations', 'delivery',
] as const;
export const deviceEngineFeatureSchema = z.enum(requiredDeviceEngineFeatures);
export type DeviceEngineFeature = z.infer<typeof deviceEngineFeatureSchema>;

export const deviceEngineReportSchema = z.object({
  agent: agentIdSchema,
  agent_version: z.string().min(1).max(120),
  adapter_version: z.number().int().positive().nullable(),
  status: z.enum(['ready', 'unavailable']),
  reason: z.enum(['adapter_missing', 'protocol_unsupported', 'login_required', 'permissions_unavailable', 'supervisor_unavailable']).nullable(),
  features: z.array(deviceEngineFeatureSchema),
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
