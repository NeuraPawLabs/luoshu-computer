import { z } from 'zod';
import { agentIdSchema, idSchema, PROTOCOL_VERSION } from './wire-base.js';
import { gitHostSchema } from './git.js';

const nonEmpty = z.string().trim().min(1);
const absolutePath = z.string().min(1).max(4096).startsWith('/').refine(v => !/[\x00-\x1f\x7f]/.test(v));

export const developmentPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('home'), roots: z.tuple([]) }).strict(),
  z.object({ mode: z.literal('custom'), roots: z.tuple([absolutePath]).rest(absolutePath) }).strict(),
  z.object({ mode: z.literal('disabled'), roots: z.tuple([]) }).strict(),
]);
export type DevelopmentPolicy = z.infer<typeof developmentPolicySchema>;

export const deviceAgentReportSchema = z.object({
  id: agentIdSchema,
  version: z.string().max(120).nullable(),
  detected: z.boolean(),
}).strict();
export type DeviceAgentReport = z.infer<typeof deviceAgentReportSchema>;

const knownServiceTypes = new Set(['development', 'task_execution', 'assistant_engine', 'maintenance']);
const serviceFeatureSchema = z.enum([
  'task_scope', 'live_progress',
  'browse', 'repository', 'native_history', 'terminal', 'codebase_preparation',
  'session_resume', 'turn_status', 'turn_interrupt', 'interaction_response', 'structured_events', 'attachments', 'task_operations', 'delivery', 'core_agent_runtime',
  'git',
]);
const diagnosticSchema = z.object({
  message: z.string().max(2000),
  resolver_hint: z.literal('UNSUPPORTED_SERVICE'),
}).strict();

export const deviceServiceReportSchema = z.object({
  id: idSchema,
  type: nonEmpty.max(100),
  version: nonEmpty.max(120),
  agent_id: agentIdSchema.nullable(),
  status: z.enum(['ready', 'unavailable']),
  reason: nonEmpty.max(500).nullable(),
  features: z.array(serviceFeatureSchema).max(100),
  diagnostic: diagnosticSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.features).size !== value.features.length) {
    ctx.addIssue({ code: 'custom', path: ['features'], message: 'Duplicate service feature' });
  }
  if (value.status === 'unavailable' && value.reason === null) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Unavailable service requires a reason' });
  }
  if (value.status === 'ready' && value.reason !== null) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Ready service cannot include an unavailable reason' });
  }
  if (!knownServiceTypes.has(value.type) && value.diagnostic === undefined) {
    ctx.addIssue({ code: 'custom', path: ['diagnostic'], message: 'Unknown service requires bounded diagnostic' });
  }
  if (knownServiceTypes.has(value.type) && value.diagnostic !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['diagnostic'], message: 'Known service cannot include unknown-service diagnostic' });
  }
  if (!knownServiceTypes.has(value.type) && value.features.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['features'], message: 'Unknown service features are not callable' });
  }
  if (!knownServiceTypes.has(value.type) && value.status !== 'unavailable') {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'Unknown services must be unavailable' });
  }
  const required: Record<string, string[]> = {
    task_execution: ['task_scope', 'live_progress'],
    development: ['browse', 'repository', 'native_history', 'terminal', 'codebase_preparation'],
    assistant_engine: ['session_resume', 'turn_status', 'turn_interrupt', 'interaction_response', 'structured_events', 'attachments', 'task_operations', 'delivery', 'core_agent_runtime'],
    maintenance: ['git'],
  };
  if (knownServiceTypes.has(value.type) && value.features.some(feature => !required[value.type].includes(feature))) {
    ctx.addIssue({ code: 'custom', path: ['features'], message: 'Unsupported feature for service type' });
  }
  if (value.type === 'assistant_engine' && value.status === 'ready' && (value.version !== '1' || value.agent_id !== 'codex')) {
    ctx.addIssue({ code: 'custom', message: 'Ready assistant engine requires the Codex v1 adapter' });
  }
  if (value.status === 'ready' && knownServiceTypes.has(value.type) && required[value.type].some(feature => !value.features.includes(feature as any))) {
    ctx.addIssue({ code: 'custom', path: ['features'], message: 'Ready service is missing required features' });
  }
});
export type DeviceServiceReport = z.infer<typeof deviceServiceReportSchema>;

const softwareReportSchema = z.object({ id: nonEmpty.max(100), version: z.string().max(120).nullable(), detected: z.boolean() }).strict();
const gitCredentialSchema = z.object({
  host: gitHostSchema,
  configured: z.boolean(),
  checked_at: z.number().int().nonnegative().nullable(),
  error: z.string().max(500).optional(),
}).strict();

export const deviceObservationSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  report_revision: z.number().int().positive(),
  platform: z.object({ os: nonEmpty.max(50), arch: nonEmpty.max(50), computer_version: nonEmpty.max(120) }).strict(),
  software: z.array(softwareReportSchema).max(100),
  agents: z.array(deviceAgentReportSchema).max(2),
  services: z.array(deviceServiceReportSchema).max(100),
  git_credentials: z.array(gitCredentialSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.agents.map(a => a.id)).size !== value.agents.length) ctx.addIssue({ code: 'custom', path: ['agents'], message: 'Duplicate agents' });
  if (new Set(value.services.map(s => s.id)).size !== value.services.length) ctx.addIssue({ code: 'custom', path: ['services'], message: 'Duplicate services' });
  if (new Set(value.software.map(s => s.id)).size !== value.software.length) ctx.addIssue({ code: 'custom', path: ['software'], message: 'Duplicate software' });
  if (new Set(value.git_credentials.map(s => s.host)).size !== value.git_credentials.length) ctx.addIssue({ code: 'custom', path: ['git_credentials'], message: 'Duplicate git credential hosts' });
});
export type DeviceObservation = z.infer<typeof deviceObservationSchema>;

export const deviceMutableConfigurationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capacity: z.number().int().min(1).max(16),
  agent_paths: z.object({ codex: absolutePath.optional(), opencode: absolutePath.optional() }).strict(),
  development_policy: developmentPolicySchema,
  maintenance_roots: z.array(absolutePath).max(32),
  codex_sandbox: z.enum(['workspace-write', 'danger-full-access']),
}).strict();
export type DeviceMutableConfiguration = z.infer<typeof deviceMutableConfigurationSchema>;

export const deviceConfigurationStateSchema = z.object({
  desired_revision: z.string().min(1).max(100),
  applied_revision: z.string().min(1).max(100).nullable(),
  desired: deviceMutableConfigurationSchema,
  applied: deviceMutableConfigurationSchema.nullable(),
  status: z.enum(['applied', 'pending', 'blocked', 'failed']),
  error: z.string().max(2000).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.applied === null) !== (value.applied_revision === null)) ctx.addIssue({ code: 'custom', message: 'Applied value and revision must be provided together' });
  if (value.status === 'applied' && (value.applied === null || value.error !== null || value.applied_revision !== value.desired_revision || JSON.stringify(value.applied) !== JSON.stringify(value.desired))) ctx.addIssue({ code: 'custom', message: 'Applied configuration must match desired value and revision with no error' });
  if ((value.status === 'blocked' || value.status === 'failed') && value.error === null) ctx.addIssue({ code: 'custom', message: 'Blocked or failed configuration requires an error' });
});
export type DeviceConfigurationState = z.infer<typeof deviceConfigurationStateSchema>;

export const deviceConfigurationRequestSchema = z.object({
  type: z.literal('device_configuration_request'), request_id: idSchema,
  device_id: idSchema, connection_generation: z.number().int().positive(), desired_revision: z.string().min(1).max(100), expected_revision: z.string().min(1).max(100),
  config: deviceMutableConfigurationSchema,
}).strict();
export const deviceConfigurationReadSchema = z.object({
  type: z.literal('device_configuration_read'), request_id: idSchema, device_id: idSchema, connection_generation: z.number().int().positive(),
}).strict();
export const deviceConfigurationStateMessageSchema = z.object({
  type: z.literal('device_configuration_state'), request_id: idSchema, device_id: idSchema, connection_generation: z.number().int().positive(),
  state: deviceConfigurationStateSchema,
}).strict();
export const deviceConfigurationResponseSchema = z.object({
  type: z.literal('device_configuration_response'), request_id: idSchema, device_id: idSchema, connection_generation: z.number().int().positive(),
  requested_revision: z.string().min(1).max(100), status: z.enum(['applied', 'pending', 'blocked', 'failed']),
  state: deviceConfigurationStateSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status !== value.state.status) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'Response status must match configuration state status' });
  }
  if (value.requested_revision !== value.state.desired_revision) {
    ctx.addIssue({ code: 'custom', path: ['requested_revision'], message: 'Response revision must match state desired revision' });
  }
  if (value.status === 'applied' && (
    value.state.applied === null ||
    value.state.applied_revision !== value.state.desired_revision ||
    JSON.stringify(value.state.applied) !== JSON.stringify(value.state.desired) ||
    value.state.error !== null
  )) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'Applied response requires the matching actual configuration' });
  }
});
