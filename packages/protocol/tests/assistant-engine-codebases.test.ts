import {expect,test} from 'vitest';
import {engineSubmissionFixture} from './fixtures/assistant-engine.js';
import {engineWireRequestSchema,engineWireResponseSchema,engineSubmissionSchema} from '../src/index.js';
const spec={id:'11111111-1111-4111-8111-111111111111',alias:'app',access_mode:'write',source:{kind:'local',path:'/authorized/source'},root_path:'.',default_branch:'main'};
test('native workspace preparation binds the original submission and never accepts caller-selected native paths',()=>{
 const submission={...engineSubmissionFixture(),codebases:[spec]},request={action:'workspace_prepare',request_id:'prepare',submission,workspace_id:submission.session_id,developer_instructions:'custom',input_files:[],lease_ms:120000};
 expect(engineWireRequestSchema.parse(request)).toEqual(request);
 expect(()=>engineWireRequestSchema.parse({...request,cwd:'/anywhere'})).toThrow();
 for(const key of ['submission','workspace_id','lease_ms']){const missing={...request} as any;delete missing[key];expect(()=>engineWireRequestSchema.parse(missing)).toThrow();}
 const response={action:'workspace_prepare',request_id:'prepare',session_id:submission.session_id,submission_id:submission.submission_id,run_id:submission.run_id,authorization_revision:submission.binding.authorization_revision,codebases:[{codebase_id:spec.id,base_commit:'a'.repeat(40),branch:'luoshu/feature/run-app',checkout_path:'/state/runs/run/targets/app'}]};
 expect(engineWireResponseSchema.parse(response)).toEqual(response);
});
test('native source grants reject duplicates, empty sets and traversal before transport',()=>{
 expect(engineSubmissionSchema.parse({...engineSubmissionFixture(),codebases:[spec]}).codebases).toEqual([spec]);
 for(const codebases of [[],[spec,spec],[{...spec,root_path:'../secret'}],[{...spec,source:{kind:'git',repository_url:'ext::sh -c command'}}]])expect(()=>engineSubmissionSchema.parse({...engineSubmissionFixture(),codebases})).toThrow();
 expect(()=>engineSubmissionSchema.parse({...engineSubmissionFixture(),codebases:[{...spec,cwd:'/forged'}]})).toThrow();
});
test('native Codebase subdirectory cannot expose Git metadata as an authorized checkout root',()=>{
 for(const root_path of ['.git','.git/objects','src/.git'])expect(()=>engineSubmissionSchema.parse({...engineSubmissionFixture(),codebases:[{...spec,root_path}]})).toThrow();
});
test('pre-submit cancellation carries immutable submission identity and never accepts a native turn ID',()=>{
 const submission={...engineSubmissionFixture(),codebases:[spec]},request={action:'workspace_cancel',request_id:'cancel',submission};
 expect(engineWireRequestSchema.parse(request)).toEqual(request);
 expect(()=>engineWireRequestSchema.parse({...request,turn_id:'native-turn'})).toThrow();
 expect(engineWireResponseSchema.parse({action:'workspace_cancel',request_id:'cancel',session_id:submission.session_id,run_id:submission.run_id,submission_id:submission.submission_id,authorization_revision:submission.binding.authorization_revision,session_state:'missing',native:null})).toMatchObject({action:'workspace_cancel'});
});
test('read-only preparation inspection requires full identity and distinguishes cancelling from cancelled',()=>{
 const submission={...engineSubmissionFixture(),codebases:[spec]},request={action:'workspace_inspect',request_id:'inspect',submission};
 expect(engineWireRequestSchema.parse(request)).toEqual(request);
 for(const state of ['missing','open','submitted','cancelling','cancelled'])expect(engineWireResponseSchema.parse({action:'workspace_inspect',request_id:'inspect',session_id:submission.session_id,run_id:submission.run_id,submission_id:submission.submission_id,authorization_revision:submission.binding.authorization_revision,state,session_state:'idle',native:null})).toMatchObject({state});
 expect(()=>engineWireRequestSchema.parse({...request,turn_id:'forged'})).toThrow();
});
test('preparation renewal requires a bounded positive authorization lease and full immutable submission',()=>{
 const request={action:'workspace_renew',request_id:'renew',submission:{...engineSubmissionFixture(),codebases:[spec]},lease_ms:120000};
 expect(engineWireRequestSchema.parse(request)).toEqual(request);
 for(const lease_ms of [undefined,null,0,-1,120001,Infinity])expect(()=>engineWireRequestSchema.parse({...request,lease_ms})).toThrow();
});
