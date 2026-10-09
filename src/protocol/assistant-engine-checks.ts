import {z} from 'zod';
const id=z.string().min(1).max(200),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const nativeCheckTargetSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('outputs'),sha256:sha}).strict(),
 z.object({kind:z.literal('codebase'),codebase_id:z.string().uuid(),sha256:sha}).strict(),
]);
export type NativeCheckTarget=z.infer<typeof nativeCheckTargetSchema>;
export const checkTargetKey=(t:NativeCheckTarget)=>t.kind==='outputs'?'outputs':'codebase:'+t.codebase_id;
export const nativeCheckTargetsSchema=z.array(nativeCheckTargetSchema).min(1).refine(ts=>new Set(ts.map(checkTargetKey)).size===ts.length,'Duplicate check target');
export const sameCheckTargets=(a:NativeCheckTarget[],b:NativeCheckTarget[])=>a.length===b.length&&a.every(t=>b.some(s=>checkTargetKey(s)===checkTargetKey(t)&&s.sha256===t.sha256));
export const nativeCheckOperationSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('begin'),purpose:z.string().trim().min(1).max(2000)}).strict(),
 z.object({action:z.literal('end'),check_id:id}).strict(),
]);
export type NativeCheckOperation=z.infer<typeof nativeCheckOperationSchema>;
export const nativeCheckReceiptSchema=z.object({check_id:id,thread_id:id,turn_id:id,purpose:z.string().min(1).max(2000),command_ids:z.array(id).refine(ids=>new Set(ids).size===ids.length,'Duplicate check command'),before:nativeCheckTargetsSchema,after:nativeCheckTargetsSchema,status:z.enum(['passed','failed','invalidated'])}).strict().refine(r=>r.status!=='passed'||r.command_ids.length>0&&sameCheckTargets(r.before,r.after),'Passed check must have commands and unchanged content');
export type NativeCheckReceipt=z.infer<typeof nativeCheckReceiptSchema>;
export const nativeDeliveredCheckSchema=nativeCheckReceiptSchema.safeExtend({binding:z.enum(['current','changed'])});
export type NativeDeliveredCheck=z.infer<typeof nativeDeliveredCheckSchema>;
export const nativeDeliveredChecksSchema=z.array(nativeDeliveredCheckSchema).refine(cs=>new Set(cs.map(c=>c.check_id)).size===cs.length,'Duplicate check receipt');
export function nativeCheckTools(){return nativeCheckOperationSchema.options.map(schema=>{
 const {action,...fields}=schema.shape;
 return{type:'function' as const,name:'luoshu_check_'+action.value,description:action.value==='begin'?'Declare a check of ALL current Run outputs and selected Codebase contents. Begin only after other tools finish, then run sequential native commands that test the declared purpose without changing deliverable content. This records Agent-declared checks, not independent verification.':'End the check started in this native turn. All commands and background processes must be complete; changed content, missing or failed commands cannot pass.',inputSchema:z.toJSONSchema(z.object(fields).strict())};
});}
export function parseNativeCheckTool(tool:string,args:unknown):NativeCheckOperation{
 const schema=nativeCheckOperationSchema.options.find(s=>'luoshu_check_'+s.shape.action.value===tool);if(!schema)throw Error('Unknown native check tool');
 const {action,...fields}=schema.shape;return nativeCheckOperationSchema.parse({...z.object(fields).strict().parse(args),action:action.value});
}
