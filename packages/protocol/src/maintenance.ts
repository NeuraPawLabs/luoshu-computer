import {z} from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const relativePath = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid maintenance path');
const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'), 'Maintenance repository must be absolute');
const branch = z.string().min(1).max(240).regex(/^luoshu\/(?:repair|verify)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
const safeArgument = z.string().max(2_000).refine(value => !/[\u0000\r\n;&|<>`$]/u.test(value), 'Unsafe command argument');

export const maintenanceCheckCommandSchema = z.object({
  name: z.string().trim().min(1).max(200),
  executable: z.string().trim().min(1).max(4096).refine(value => !/[\s\u0000;&|<>`$]/u.test(value), 'Unsafe executable'),
  args: z.array(safeArgument).max(100),
  timeout_seconds: z.number().int().min(1).max(1800),
}).strict();

export const maintenanceRequestSchema = z.object({
  type: z.literal('maintenance_request'), request_id: id, attempt_id: id, lease_epoch: z.number().int().positive(),
  operation: z.enum(['repair', 'verify']), repository: absolutePath, base_sha: sha, branch,
  agent: z.enum(['codex', 'opencode']), instruction: z.string().trim().min(1).max(64_000),
  allowed_paths: z.array(relativePath).min(1).max(100), checks: z.array(maintenanceCheckCommandSchema).min(1).max(50),
  timeout_seconds: z.number().int().min(1).max(7200),
}).strict();
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

export const maintenanceCheckResultSchema = z.object({
  name: z.string().min(1).max(200), command: z.string().max(2_000), exit_code: z.number().int(), output: z.string().max(8_000),
}).strict();

export const maintenanceResultSchema = z.object({
  status: z.enum(['patch_ready', 'passed', 'failed', 'unknown']), summary: z.string().max(16_000),
  base_sha: sha, commit_sha: sha.optional(), branch, changed_paths: z.array(relativePath).max(200),
  checks: z.array(maintenanceCheckResultSchema).max(50),
}).strict().superRefine((value, context) => {
  if ((value.status === 'patch_ready' || value.status === 'passed') && !value.commit_sha) context.addIssue({code: 'custom', message: 'Successful maintenance requires a commit SHA'});
});
export type MaintenanceResult = z.infer<typeof maintenanceResultSchema>;

export const maintenanceResponseSuccessSchema = z.object({
  type: z.literal('maintenance_response'), request_id: id, attempt_id: id, lease_epoch: z.number().int().positive(), result: maintenanceResultSchema,
}).strict();
export const maintenanceResponseErrorSchema = z.object({
  type: z.literal('maintenance_response'), request_id: id, attempt_id: id, lease_epoch: z.number().int().positive(),
  error: z.string().min(1).max(2_000), execution_unknown: z.boolean(),
}).strict();
export const maintenanceResponseSchema = z.union([maintenanceResponseSuccessSchema, maintenanceResponseErrorSchema]);
export type MaintenanceResponse = z.infer<typeof maintenanceResponseSchema>;
