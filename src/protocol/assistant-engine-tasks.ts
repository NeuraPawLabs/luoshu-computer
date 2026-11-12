import {z} from 'zod';
import {idSchema} from './wire-base.js';

const target = {task_id: idSchema, expected_revision: z.number().int().positive()};
const taskKind = z.enum(['analysis', 'design', 'implementation', 'migration', 'test', 'review', 'integration', 'release', 'documentation']);
const acceptanceCriteria = z.array(z.object({statement: z.string().trim().min(1).max(1000), verification_kind: z.enum(['manual', 'browser', 'check', 'integration', 'health', 'artifact'])}).strict()).max(64);
export const engineTaskOperationSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('create'), title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(16000), task_kind: taskKind.optional(), acceptance_criteria: acceptanceCriteria.optional()}).strict(),
  z.object({action: z.literal('attach'), ...target}).strict(),
  z.object({action: z.literal('revise'), ...target,
    instruction: z.string().trim().min(1).max(16000)}).strict(),
  z.object({action: z.literal('report'), ...target,
    status: z.enum(['in_progress', 'blocked', 'delivered']), summary: z.string()}).strict(),
]);
export type EngineTaskOperation = z.infer<typeof engineTaskOperationSchema>;
export const engineTaskResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),receipt:z.object({task_id:idSchema,task_revision:z.number().int().positive(),action:z.enum(['create','attach','revise','report']),reported_status:z.enum(['in_progress','blocked','delivered']).nullable()}).strict()}).strict(),
 z.object({success:z.literal(false),error:z.string().min(1)}).strict(),
]);
export type EngineTaskResult=z.infer<typeof engineTaskResultSchema>;
