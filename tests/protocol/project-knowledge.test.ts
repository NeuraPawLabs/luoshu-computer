import {expect,test} from 'vitest';
import {knowledgeProposalSchema,knowledgeSnapshotSchema,engineKnowledgeOperationSchema,engineKnowledgeResultSchema,nativeKnowledgeTools,parseNativeKnowledgeTool} from '../../src/protocol/project-knowledge.js';
import {engineEventPayloadSchema} from '../../src/protocol/assistant-engine-events.js';
import {engineWireRequestSchema,engineWireResponseSchema} from '../../src/protocol/assistant-engine-wire.js';

const scope={kind:'codebase' as const,id:'11111111-1111-4111-8111-111111111111'};
const source={codebase_id:scope.id,path:'src/main.ts',commit_sha:'a'.repeat(40),content_sha256:'b'.repeat(64)};
const proposal={scope,entry_id:null,expected_revision:0,title:'Entrypoint',summary:'Start here',kind:'analysis' as const,body:'The current entry is src/main.ts.',sources:[source]};
test('strict knowledge proposal preserves source evidence and rejects unowned payload fields',()=>{
 expect(knowledgeProposalSchema.parse(proposal)).toEqual(proposal);
 expect(knowledgeProposalSchema.safeParse({...proposal,owner_id:'other'}).success).toBe(false);
 expect(knowledgeProposalSchema.safeParse({...proposal,entry_id:'entry',expected_revision:0}).success).toBe(false);
});
test.each(['../secret','/tmp/secret','a/../../secret','a\\secret','.git/config','a//b','a/./b','C:/Windows/system.ini','C:relative','a/\u0085b','a/\u009fb'])('knowledge source paths exclude traversal or metadata: %s',path=>{
 expect(knowledgeProposalSchema.safeParse({...proposal,sources:[{...source,path}]}).success).toBe(false);
});
test('snapshot index has no factual bodies or mutable publication decisions',()=>{
 const entry={id:'entry',revision:1,scope,title:proposal.title,summary:proposal.summary,kind:proposal.kind,sources:[source]};
 expect(knowledgeSnapshotSchema.parse({id:'snapshot',run_id:'run',scopes:[scope],entries:[entry]}).entries).toEqual([entry]);
 expect(knowledgeSnapshotSchema.safeParse({id:'snapshot',run_id:'run',scopes:[scope],entries:[{...entry,body:'full body'}]}).success).toBe(false);
});
test('native tool schemas accept paths, not model-provided source hashes',()=>{
 expect(nativeKnowledgeTools().map(tool=>tool.name)).toEqual(['luoshu_knowledge_list','luoshu_knowledge_read','luoshu_knowledge_propose']);
 expect(parseNativeKnowledgeTool('luoshu_knowledge_list',{})).toEqual({action:'list',offset:0});
 const args={...proposal,sources:[{codebase_id:scope.id,path:'src/main.ts'}]};
 expect(parseNativeKnowledgeTool('luoshu_knowledge_propose',args)).toMatchObject({action:'propose',proposal:args});
 expect(()=>parseNativeKnowledgeTool('luoshu_knowledge_propose',proposal)).toThrow();
 expect(parseNativeKnowledgeTool('luoshu_knowledge_read',{snapshot_id:'snapshot',entry_id:'entry',revision:1})).toEqual({action:'read',snapshot_id:'snapshot',entry_id:'entry',revision:1});
});
test('metadata controls have strict read, candidate and failure result shapes',()=>{
 expect(engineKnowledgeOperationSchema.parse({action:'propose',proposal})).toEqual({action:'propose',proposal});
 expect(engineKnowledgeResultSchema.parse({success:true,value:{id:'entry',revision:1,status:'candidate'}})).toMatchObject({success:true});
 expect(engineKnowledgeResultSchema.safeParse({success:true,value:{id:'entry',revision:1,status:'published'}}).success).toBe(false);
 expect(engineKnowledgeResultSchema.parse({success:false,error:'access denied'})).toEqual({success:false,error:'access denied'});
});
test('knowledge requests and replies preserve the native control identity without task effects',()=>{
 const operation={action:'read' as const,snapshot_id:'snapshot',entry_id:'entry',revision:1};
 expect(engineEventPayloadSchema.parse({kind:'knowledge.request',request_id:'call',operation})).toEqual({kind:'knowledge.request',request_id:'call',operation});
 const control={action:'knowledge_response',request_id:'response',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,turn_id:'turn',call_id:'call'};
 expect(engineWireRequestSchema.parse({...control,result:{success:false,error:'source stale'}})).toMatchObject(control);
 expect(engineWireResponseSchema.parse(control)).toEqual(control);
 expect(engineWireResponseSchema.safeParse({...control,result:{success:false,error:'private'}}).success).toBe(false);
});
