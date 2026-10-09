import { z } from 'zod';
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const agentIdSchema = z.enum(['codex', 'opencode']);

const pathValue = z.string().min(1).max(4096);
const dimensions = z.number().int().min(1).max(1000);
const sessionId = idSchema;
export const developmentRootsSchema = z.array(z.string().min(1).max(4096).startsWith('/').refine(value => !/[\x00-\x1f\x7f]/.test(value))).max(32).nullable();
export const developmentRootStateSchema = z.object({ roots: z.array(pathValue).max(32), configured_roots: developmentRootsSchema,
  revision: z.string().max(100), default_root: pathValue }).strict();
export const developmentRootBlockerSchema = z.object({ id: z.string().min(1).max(200), kind: z.enum(['session','task','preparation']), path: pathValue, stoppable: z.boolean() }).strict();
export type DevelopmentRootState = z.infer<typeof developmentRootStateSchema>;
export type DevelopmentRootBlocker = z.infer<typeof developmentRootBlockerSchema>;
export const codexSandboxModeSchema = z.enum(['workspace-write', 'danger-full-access']);
export type CodexSandboxMode = z.infer<typeof codexSandboxModeSchema>;
export const codexSettingsStateSchema = z.object({mode:codexSandboxModeSchema, revision:z.string().max(100)}).strict();
export type CodexSettingsState = z.infer<typeof codexSettingsStateSchema>;

const agentPathSchema = z.string().min(1).max(4096).startsWith('/').refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const workerMutableConfigSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capacity: z.number().int().min(1).max(16),
  agent_paths: z.object({ codex: agentPathSchema.optional(), opencode: agentPathSchema.optional() }).strict(),
  development_roots: developmentRootsSchema,
  maintenance_roots: z.array(agentPathSchema).max(32),
  codex_sandbox: codexSandboxModeSchema,
}).strict();
export type WorkerMutableConfig = z.infer<typeof workerMutableConfigSchema>;
export const workerConfigRequestSchema = z.object({
  type: z.literal('worker_config_request'), request_id: idSchema, revision: z.string().uuid(), expected_revision:z.string().min(1).max(100), config: workerMutableConfigSchema,
}).strict();
export const workerConfigReadSchema=z.object({type:z.literal('worker_config_read'),request_id:idSchema}).strict();
export const workerConfigStateSchema=z.object({type:z.literal('worker_config_state'),request_id:idSchema,revision:z.string().min(1).max(100),request_revision:z.string().uuid().nullable(),config:workerMutableConfigSchema}).strict();
export type WorkerConfigState=z.infer<typeof workerConfigStateSchema>;
export const workerConfigResponseSchema = z.object({
  type: z.literal('worker_config_response'), request_id: idSchema, revision: z.string().uuid(),
  status: z.enum(['applied','failed']), applied_revision:z.string().min(1).max(100), config: workerMutableConfigSchema, error: z.string().max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'failed' && !value.error) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed configuration requires an error' });
  if (value.status === 'applied' && value.error) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Applied configuration cannot include an error' });
});
export type WorkerConfigRequest = z.infer<typeof workerConfigRequestSchema>;
export type WorkerConfigResponse = z.infer<typeof workerConfigResponseSchema>;

export const developmentSessionSchema = z.object({
  id: sessionId,
  agent: agentIdSchema,
  cwd: pathValue,
  mode: z.enum(['new', 'resume']),
  status: z.enum(['running', 'exited']),
  agent_session_id: sessionId.optional(),
  exit_code: z.number().int().optional(),
  reason: z.string().max(2000).optional(),
}).strict();
export type DevelopmentSession = z.infer<typeof developmentSessionSchema>;

const timestamp = z.number().int().min(0);
export const developmentAgentSessionSummarySchema = z.object({
  id: sessionId,
  agent: agentIdSchema,
  cwd: pathValue,
  title: z.string().min(1).max(1000),
  created_at: timestamp,
  updated_at: timestamp,
}).strict();
export type DevelopmentAgentSessionSummary = z.infer<typeof developmentAgentSessionSummarySchema>;
export const developmentActiveSessionSchema = developmentAgentSessionSummarySchema.extend({ status: z.literal('running') }).strict();
export type DevelopmentActiveSession = z.infer<typeof developmentActiveSessionSchema>;

const openCommandSchema = z.object({
  action: z.literal('open'), session_id: sessionId, agent: agentIdSchema,
  agent_session_id: sessionId.optional(), cwd: pathValue, mode: z.enum(['new', 'resume']), cols: dimensions, rows: dimensions,
}).strict().superRefine((value, context) => {
  if (value.mode === 'resume' && !value.agent_session_id) context.addIssue({ code: 'custom', path: ['agent_session_id'], message: 'A native Agent session is required to resume' });
});

export const developmentCommandSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('codex_settings')}).strict(),
  z.object({action:z.literal('codex_settings_update'),mode:codexSandboxModeSchema,expected_revision:z.string().max(100)}).strict(),
  z.object({ action: z.literal('roots') }).strict(),
  z.object({ action: z.literal('roots_state') }).strict(),
  z.object({ action: z.literal('roots_update'), roots: developmentRootsSchema, revision: z.string().uuid(), stop_ids: z.array(z.string().min(1).max(200)).max(100).default([]) }).strict(),
  z.object({ action: z.literal('list'), path: pathValue }).strict(),
  z.object({ action: z.literal('repository'), path: pathValue }).strict(),
  z.object({ action: z.literal('sessions'), path: pathValue }).strict(),
  z.object({ action: z.literal('history'), path: pathValue, agent: agentIdSchema, session_id: sessionId }).strict(),
  z.object({ action: z.literal('active_sessions') }).strict(),
  z.object({ action: z.literal('preview'), path: pathValue }).strict(),
  openCommandSchema,
  z.object({ action: z.literal('read'), session_id: sessionId, after: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal('input'), session_id: sessionId, data: z.string().max(256 * 1024) }).strict(),
  z.object({ action: z.literal('resize'), session_id: sessionId, cols: dimensions, rows: dimensions }).strict(),
  z.object({ action: z.literal('stop'), session_id: sessionId }).strict(),
  z.object({ action: z.literal('renew'), session_ids: z.array(sessionId).max(16) }).strict(),
]);
export type DevelopmentCommand = z.infer<typeof developmentCommandSchema>;

export const developmentResultSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('codex_settings'),state:codexSettingsStateSchema}).strict(),
  z.object({action:z.literal('codex_settings_update'),state:codexSettingsStateSchema}).strict(),
  z.object({ action: z.literal('roots'), roots: z.array(pathValue).max(32) }).strict(),
  z.object({ action: z.literal('roots_state'), state: developmentRootStateSchema }).strict(),
  z.object({ action: z.literal('roots_update'), status: z.enum(['applied','blocked']), state: developmentRootStateSchema, blockers: z.array(developmentRootBlockerSchema).max(100) }).strict(),
  z.object({ action: z.literal('repository'), path: pathValue, repository_path: pathValue, root_path: z.string().min(1).max(500), default_branch: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('list'), path: pathValue, entries: z.array(z.object({ path: pathValue, name: z.string().min(1).max(255), kind: z.enum(['directory', 'file']) }).strict()).max(500), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('sessions'), path: pathValue, sessions: z.array(developmentAgentSessionSummarySchema).max(100), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('history'), path: pathValue, agent: agentIdSchema, session_id: sessionId, text: z.string().max(256 * 1024), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('active_sessions'), sessions: z.array(developmentActiveSessionSchema).max(100), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('preview'), path: pathValue, text: z.string().max(256 * 1024), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('open'), session: developmentSessionSchema }).strict(),
  z.object({ action: z.literal('read'), session: developmentSessionSchema, chunks: z.array(z.object({ sequence: z.number().int().positive(), data: z.string() }).strict()).max(2048), next_sequence: z.number().int().positive(), truncated: z.boolean() }).strict(),
  z.object({ action: z.literal('input'), session: developmentSessionSchema }).strict(),
  z.object({ action: z.literal('resize'), session: developmentSessionSchema }).strict(),
  z.object({ action: z.literal('stop'), session: developmentSessionSchema }).strict(),
  z.object({ action: z.literal('renew'), session_ids: z.array(sessionId).max(16) }).strict(),
]);
export type DevelopmentResult = z.infer<typeof developmentResultSchema>;

export const developmentRequestSchema = z.object({ type: z.literal('development_request'), request_id: idSchema, command: developmentCommandSchema }).strict();
export type DevelopmentRequest = z.infer<typeof developmentRequestSchema>;
export const developmentResponseSuccessSchema = z.object({ type: z.literal('development_response'), request_id: idSchema, result: developmentResultSchema }).strict();
export const developmentResponseErrorSchema = z.object({ type: z.literal('development_response'), request_id: idSchema, error: z.string().min(1).max(2000) }).strict();
export const developmentResponseSchema = z.union([developmentResponseSuccessSchema, developmentResponseErrorSchema]);
export type DevelopmentResponse = z.infer<typeof developmentResponseSchema>;

export const developmentOutputSchema = z.object({
  type: z.literal('development_output'),
  session_id: sessionId,
  sequence: z.number().int().positive(),
  data: z.string().max(512 * 1024),
  session: developmentSessionSchema,
}).strict();
export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;
