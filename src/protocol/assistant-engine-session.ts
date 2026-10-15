import {z} from 'zod';
import {idSchema} from './wire-base.js';
import {agentEngineConfigSchema} from './assistant-engine.js';
import {nativeCodebaseSpecsSchema} from './assistant-engine-codebases.js';

export const nativeSessionRefSchema = z.object({
  thread_id: z.string().min(1).max(200),
  session_tree_id: z.string().min(1).max(200).nullable(),
}).strict();
export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;

export const engineBindingSchema = z.object({
  conversation_id: idSchema,
  agent_id: idSchema,
  actor_id: z.string().min(1).max(200),
  agent_revision: z.number().int().positive(),
  authorization_revision: z.number().int().positive(),
  engine: agentEngineConfigSchema,
  topic_thread_id: idSchema.optional(),
  context_generation: z.number().int().positive().optional(),
  /** Core sessions ask Codex for a decision envelope; Worker sessions execute a task. */
  role: z.enum(['core','worker']).optional(),
}).strict().superRefine((value,ctx)=>{
  if((value.topic_thread_id===undefined)!==(value.context_generation===undefined)){
    ctx.addIssue({code:'custom',message:'Topic and context generation must be provided together'});
  }
});
export type EngineBinding = z.infer<typeof engineBindingSchema>;

const ids = z.array(idSchema).refine(value => new Set(value).size === value.length, 'Duplicate message ID');
export const engineSubmissionSchema = z.object({
  submission_id: idSchema,
  batch_id: idSchema,
  run_id: idSchema,
  session_id: idSchema,
  binding: engineBindingSchema,
  input_message_ids: ids.refine(value => value.length > 0, 'Input messages are required'),
  context_message_ids: ids,
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  input_files_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  task_id: idSchema.nullable(),
  task_revision: z.number().int().positive().nullable(),
  codebases:nativeCodebaseSpecsSchema.optional(),
  output_schema:z.record(z.string(),z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.task_id === null) !== (value.task_revision === null)) {
    ctx.addIssue({code: 'custom', message: 'Task ID and revision must be provided together'});
  }
  const input = new Set(value.input_message_ids);
  if (value.context_message_ids.some(id => input.has(id))) {
    ctx.addIssue({code: 'custom', message: 'Input messages cannot be repeated in context'});
  }
  if (value.binding.role === 'core' && value.output_schema === undefined) {
    ctx.addIssue({code:'custom',path:['output_schema'],message:'Core submissions require an output schema'});
  }
  if (value.binding.role === 'core' && value.codebases?.length) {
    ctx.addIssue({code:'custom',path:['codebases'],message:'Core submissions cannot carry Worker codebase authority'});
  }
  if (value.binding.role !== 'core' && value.output_schema !== undefined) {
    ctx.addIssue({code:'custom',path:['output_schema'],message:'Only Core submissions may request structured model decisions'});
  }
});
export type EngineSubmission = z.infer<typeof engineSubmissionSchema>;
