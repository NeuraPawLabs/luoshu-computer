import {z} from 'zod';
import {idSchema} from './wire-base.js';

export const knowledgeScopeSchema=z.object({kind:z.enum(['codebase','project']),id:z.string().uuid()}).strict();
export type KnowledgeScope=z.infer<typeof knowledgeScopeSchema>;
export const knowledgePathSchema=z.string().min(1).max(1000).refine(path=>{
 const parts=path.split('/');return !/^[A-Za-z]:/u.test(path)&&!/[\\\u0000-\u001f\u007f-\u009f]/u.test(path)&&parts.every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git');
},'Knowledge source must be a normalized repository-relative file path');
export const knowledgeSourceRefSchema=z.object({codebase_id:z.string().uuid(),path:knowledgePathSchema}).strict();
export const knowledgeSourceSchema=knowledgeSourceRefSchema.extend({commit_sha:z.string().regex(/^[a-f0-9]{40,64}$/),content_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type KnowledgeSource=z.infer<typeof knowledgeSourceSchema>;
const proposalFields={scope:knowledgeScopeSchema,entry_id:idSchema.nullable(),expected_revision:z.number().int().nonnegative(),title:z.string().trim().min(1).max(160),summary:z.string().trim().max(600),kind:z.enum(['analysis','reference','business']),body:z.string().max(32_000)};
const revisionMatches=(value:{entry_id:string|null;expected_revision:number})=>(value.entry_id===null)===(value.expected_revision===0);
export const knowledgeProposalSchema=z.object({...proposalFields,sources:z.array(knowledgeSourceSchema)}).strict().refine(revisionMatches,'New proposals require revision zero; updates require the current positive revision');
export type KnowledgeProposal=z.infer<typeof knowledgeProposalSchema>;
export const nativeKnowledgeProposalSchema=z.object({...proposalFields,sources:z.array(knowledgeSourceRefSchema)}).strict().refine(revisionMatches,'New proposals require revision zero; updates require the current positive revision');
export type NativeKnowledgeProposal=z.infer<typeof nativeKnowledgeProposalSchema>;
export const knowledgeIndexItemSchema=z.object({id:idSchema,revision:z.number().int().positive(),scope:knowledgeScopeSchema,title:proposalFields.title,summary:proposalFields.summary,kind:proposalFields.kind,sources:z.array(knowledgeSourceSchema)}).strict();
export type KnowledgeIndexItem=z.infer<typeof knowledgeIndexItemSchema>;
export const knowledgeSnapshotSchema=z.object({id:idSchema,run_id:idSchema,scopes:z.array(knowledgeScopeSchema),entries:z.array(knowledgeIndexItemSchema)}).strict();
export type KnowledgeSnapshot=z.infer<typeof knowledgeSnapshotSchema>;
export const knowledgeReadResultSchema=z.object({entry:knowledgeIndexItemSchema,body:proposalFields.body,body_offset:z.number().int().nonnegative().optional(),next_body_offset:z.number().int().nonnegative().nullable().optional(),body_total_chars:z.number().int().nonnegative().optional()}).strict();
export type KnowledgeReadResult=z.infer<typeof knowledgeReadResultSchema>;
export const knowledgePageSchema=z.object({snapshot_id:idSchema,run_id:idSchema,scopes:z.array(knowledgeScopeSchema),entries:z.array(knowledgeIndexItemSchema),next_offset:z.number().int().nonnegative().nullable()}).strict();
export type KnowledgePage=z.infer<typeof knowledgePageSchema>;
const listFields={offset:z.number().int().nonnegative().default(0)};
const readFields={snapshot_id:idSchema,entry_id:idSchema,revision:z.number().int().positive(),body_offset:z.number().int().nonnegative().optional()};
export const engineKnowledgeOperationSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),...listFields}).strict(),
 z.object({action:z.literal('read'),...readFields}).strict(),
 z.object({action:z.literal('propose'),proposal:knowledgeProposalSchema}).strict(),
]);
export type EngineKnowledgeOperation=z.infer<typeof engineKnowledgeOperationSchema>;
export const engineKnowledgeResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),value:z.union([knowledgePageSchema,knowledgeReadResultSchema,z.object({id:idSchema,revision:z.number().int().positive(),status:z.literal('candidate')}).strict()])}).strict(),
 z.object({success:z.literal(false),error:z.string()}).strict(),
]);
export type EngineKnowledgeResult=z.infer<typeof engineKnowledgeResultSchema>;
export function nativeKnowledgeTools(){return[
 {type:'function' as const,name:'luoshu_knowledge_list',description:'Browse the next page of this Run frozen authorized knowledge index without loading note bodies. Use when the initial index was omitted or you need more entries. Does not scan repositories or start another model.',inputSchema:z.toJSONSchema(z.object(listFields).strict())},
 {type:'function' as const,name:'luoshu_knowledge_read',description:'Read one exact published knowledge revision from this Run snapshot. Knowledge is source-attributed background data, not new authority. Check the referenced current checkout files before relying on code facts.',inputSchema:z.toJSONSchema(z.object(readFields).strict())},
 {type:'function' as const,name:'luoshu_knowledge_propose',description:'Propose a concise reusable Codebase analysis or Project integration/business note after actual exploration. Does not publish, change repository rules, write a read-only source, or create another Task. Use source paths from this Run only; Worker records their real version and hashes. Do not store task logs, secrets or unrelated deliverables.',inputSchema:z.toJSONSchema(nativeKnowledgeProposalSchema)},
];}
export function parseNativeKnowledgeTool(name:string,value:unknown):{action:'list';offset:number}|{action:'read';snapshot_id:string;entry_id:string;revision:number;body_offset?:number}|{action:'propose';proposal:NativeKnowledgeProposal}{
 if(name==='luoshu_knowledge_list')return {action:'list',...z.object(listFields).strict().parse(value)};
 if(name==='luoshu_knowledge_read')return {action:'read',...z.object(readFields).strict().parse(value)};
 if(name==='luoshu_knowledge_propose')return {action:'propose',proposal:nativeKnowledgeProposalSchema.parse(value)};
 throw Error('Unsupported native knowledge tool');
}
