import {z} from 'zod';
import {isAbsolute,normalize} from 'node:path';
import {assertReturnedProfile,nativeWritableRoots,type NativePermissions} from './native-permissions.js';
const absolute=z.string().refine(value=>isAbsolute(value)&&normalize(value)===value);
export const nativeApprovalPolicy=Object.freeze({granular:Object.freeze({sandbox_approval:false,rules:false,mcp_elicitations:false,request_permissions:false,skill_approval:false})});
export const nativeApprovalPolicySchema=z.object({granular:z.object({sandbox_approval:z.literal(false),rules:z.literal(false),mcp_elicitations:z.literal(false),request_permissions:z.literal(false),skill_approval:z.literal(false)}).strict()}).strict();
const policySchema=z.object({cwd:absolute,model:z.string().min(1),modelProvider:z.string().min(1),reasoningEffort:z.string().min(1).nullable().default(null),
 approvalPolicy:nativeApprovalPolicySchema,approvalsReviewer:z.literal('user'),
 sandbox:z.union([
  z.object({type:z.literal('workspaceWrite'),writableRoots:z.array(absolute),networkAccess:z.literal(false),excludeSlashTmp:z.literal(true),excludeTmpdirEnvVar:z.literal(true)}).strict(),
  z.object({type:z.literal('dangerFullAccess'),writableRoots:z.array(absolute).default([]),networkAccess:z.literal(true).default(true),excludeSlashTmp:z.boolean().default(false),excludeTmpdirEnvVar:z.boolean().default(false)}).strict(),
 ]),
});
export type NativePolicy=z.infer<typeof policySchema>&{permissions:NativePermissions};
export function validateNativePolicy(value:unknown,cwd:string,permissions:NativePermissions):NativePolicy{
 if(permissions.cwd!==cwd)throw Error('Native permission cwd differs from session');
 assertReturnedProfile(value,permissions);
 const policy=policySchema.parse(value);
 const roots=new Set(nativeWritableRoots(permissions));
 if(policy.cwd!==cwd)throw Error('Native effective workspace policy differs from authorized scope');
 if(policy.sandbox.type==='workspaceWrite'&&policy.sandbox.writableRoots.some(root=>!roots.has(root)))throw Error('Native effective workspace policy differs from authorized scope');
 if(permissions.config.network.enabled!== (policy.sandbox.networkAccess===true))throw Error('Native effective network policy differs from authorized scope');
 return{...policy,permissions};
}
