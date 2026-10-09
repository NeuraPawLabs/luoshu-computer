import {expect,test} from 'vitest';
import {validateNativePolicy} from '../../src/engines/codex-policy.js';
import {nativePermissions} from '../../src/engines/native-permissions.js';
const permissions=nativePermissions({session:'test',cwd:'/fixture/workspace',runtime:'/opt/codex',read:[],write:[]});
const provenance={activePermissionProfile:{id:permissions.id,extends:null},runtimeWorkspaceRoots:['/fixture/workspace']};
const approvalPolicy={granular:{sandbox_approval:false,rules:false,mcp_elicitations:false,request_permissions:false,skill_approval:false}};
const policy={cwd:'/fixture/workspace',model:'fixture-model',modelProvider:'fixture-provider',reasoningEffort:'low',approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
test('native effective policy projects only necessary configuration and never auth data',()=>{
 const safe=validateNativePolicy({...policy,...provenance,auth:{secret:'DO_NOT_PERSIST'},thread:{id:'thread',text:'PRIVATE_HISTORY'}},policy.cwd,permissions);
 expect(safe).toEqual({...policy,permissions});expect(JSON.stringify(safe)).not.toContain('PRIVATE');expect(JSON.stringify(safe)).not.toContain('PERSIST');
});
test.each([
 {sandbox:{...policy.sandbox,type:'dangerFullAccess'}},
 {sandbox:{...policy.sandbox,writableRoots:['/home/alice']}},
 {sandbox:{...policy.sandbox,networkAccess:true}},
 {sandbox:{...policy.sandbox,excludeSlashTmp:false}},
 {sandbox:{...policy.sandbox,excludeTmpdirEnvVar:false}},
 {approvalPolicy:'never'}, {approvalPolicy:'on-request'},
 ...Object.keys(approvalPolicy.granular).map(key=>({approvalPolicy:{granular:{...approvalPolicy.granular,[key]:!approvalPolicy.granular[key as keyof typeof approvalPolicy.granular]}}})),
 {approvalsReviewer:'auto_review'}, {cwd:'/other'}, {model:''}, {modelProvider:''}, {sandbox:undefined},
])('native policy rejects unapproved relaxation or missing metadata: %j',change=>{
 expect(()=>validateNativePolicy({...policy,...provenance,...change},policy.cwd,permissions)).toThrow();
});
