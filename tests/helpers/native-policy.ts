import {nativeApprovalPolicy} from '../../src/engines/codex-policy.js';
/** Complete post-RPC thread fixtures. Preserve deliberately supplied policy. */
export function withNativePolicy<T extends object>(rpc:T):T{
 return new Proxy(rpc,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);
  if(key==='runtimeExecutable'&&value===undefined)return async()=>'/opt/fixture/native-codex';
  if(key==='assertPermissionProfileAvailable'&&value===undefined)return async()=>{};
  if((key==='startThread'||key==='resumeThread')&&typeof value==='function')return async(params:any)=>{
   const result=await value.call(target,params);
   const full=Boolean(params.permissionScope?.config?.network?.enabled),roots=Object.entries(params.permissionScope?.config?.filesystem??{}).filter(([,value])=>value==='write').map(([path])=>path).filter(path=>path!==':root');
   return{activePermissionProfile:{id:params.permissionScope?.id,extends:null},runtimeWorkspaceRoots:params.permissionScope.runtimeWorkspaceRoots,...result,policy:result.policy??{cwd:params.cwd,model:params.model??'fixture-model',modelProvider:params.modelProvider??'fixture-provider',reasoningEffort:params.config?.model_reasoning_effort??'low',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:full?{type:'dangerFullAccess',writableRoots:[],networkAccess:true,excludeSlashTmp:true,excludeTmpdirEnvVar:true}:{type:'workspaceWrite',writableRoots:roots,networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true},permissions:params.permissionScope}};
  };return value;
 }});
}
