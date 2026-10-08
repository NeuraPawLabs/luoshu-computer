import {z} from 'zod';
export const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const text=(max:number)=>z.string().min(1).max(max);
export const positive=z.number().int().positive();
export const PROTOCOL_VERSION=8;
export const agentIdSchema=z.enum(['codex','opencode']);
export type AgentId=z.infer<typeof agentIdSchema>;
export const agentReportSchema=z.object({id:agentIdSchema,version:z.string().max(120).optional(),detected:z.boolean()}).strict();
export type AgentReport=z.infer<typeof agentReportSchema>;
