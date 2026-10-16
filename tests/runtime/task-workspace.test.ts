import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {expect,test} from 'vitest';
import {CodexAppServerClient,type CodexRpcProcess} from '../../src/engines/codex-rpc.js';
import {nativeApprovalPolicy} from '../../src/engines/codex-policy.js';
import {assignmentSchema} from '../../src/protocol/index.js';
import {runTaskWorkspace} from '../../src/runtime/task-workspace.js';

class Peer extends EventEmitter implements CodexRpcProcess {
 readonly stdout=new PassThrough();readonly stderr=new PassThrough();readonly sent:any[]=[];
 readonly stdin=new Writable({write:(chunk,_encoding,done)=>{const request=JSON.parse(String(chunk));this.sent.push(request);done();queueMicrotask(()=>this.answer(request));},final:done=>{done();queueMicrotask(()=>this.emit('close',0));}});
 closed=false; mode:'complete'|'lost'|'broaden'|'wait'='complete';
 kill(){this.closed=true;queueMicrotask(()=>this.emit('close',0));return true;}
 line(value:unknown){this.stdout.write(JSON.stringify(value)+'\n');}
 answer(r:any){
  if(r.id===undefined)return;
  let result:unknown={};
  if(r.method==='initialize')result={userAgent:'fixture/0.160.0'};
  if(r.method==='config/read')result={config:{permissions:{},mcp_servers:{'local.tools':{enabled:true,token:'PRIVATE'}},shell_environment_policy:{set:{SERVICE_TOKEN:'PRIVATE'}}}};
  if(r.method==='thread/start'){
   const permissions=r.params.config['permissions.'+r.params.permissions];
   result={thread:{id:'thread'},cwd:r.params.cwd,model:'fixture',modelProvider:'fixture',approvalPolicy:nativeApprovalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:this.mode==='broaden',excludeSlashTmp:true,excludeTmpdirEnvVar:true},activePermissionProfile:{id:r.params.permissions,extends:null},runtimeWorkspaceRoots:[r.params.cwd]};
   expect(permissions.filesystem['/state/input']).toBe('read');
  }
  if(r.method==='turn/start'){
   if(this.mode==='lost'){this.emit('close',1);return;}
   result={turn:{id:'turn'}};
  }
  if(r.method==='thread/read')result={thread:{id:'thread',turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',text:'修复和测试已完成'},{type:'commandExecution',command:'npm test',exitCode:0}]}]}};
  this.line({id:r.id,result});
  if(r.method==='turn/start'&&this.mode!=='wait')this.line({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
}
const base={stateDir:'/state',executionId:'execution',cwd:'/state/scratch',read:['/state/input','/state/references/lib'],write:['/state/output','/state/targets/app'],prompt:'修复并运行测试',signal:new AbortController().signal};
function fixture(mode:Peer['mode']='complete'){
 const peer=new Peer();peer.mode=mode;
 const client=new CodexAppServerClient({spawn:()=>peer,executable:process.execPath});
 return{peer,client,input:{...base,rpcFactory:()=>client}};
}

test('task scope is optional for legacy assignments and cannot be used by an unsupported agent',()=>{
 const assignment={attempt_id:'execution',lease_epoch:1,agent:'codex',instruction:'read',input_files:[],timeout_seconds:30};
 expect(assignmentSchema.parse(assignment)).not.toHaveProperty('permission_scope');
 expect(assignmentSchema.parse({...assignment,permission_scope:'task_workspace'})).toHaveProperty('permission_scope','task_workspace');
 expect(()=>assignmentSchema.parse({...assignment,permission_scope:'task_workspace',agent:'opencode'})).toThrow();
});

test('task execution uses exact read/write roots, disables extra channels, and retains readable results',async()=>{
 const f=fixture();const result=await runTaskWorkspace(f.input);
 expect(result).toMatchObject({exitCode:0,summary:'修复和测试已完成',checks:[{command:'npm test',exit_code:0}]});
 const params=f.peer.sent.find(r=>r.method==='thread/start').params,profile=params.config['permissions.'+params.permissions];
 expect(profile).toMatchObject({network:{enabled:false},filesystem:{'/state/scratch':'write','/state/input':'read','/state/references/lib':'read','/state/output':'write','/state/targets/app':'write'}});
 expect(profile.filesystem).not.toHaveProperty(':root');
 expect(params.config).toMatchObject({'features.shell_tool':true,'features.unified_exec':true,'features.apps':false,'features.hooks':false,'features.plugins':false,'features.multi_agent':false,
  'shell_environment_policy.inherit':'none','shell_environment_policy.set':{SERVICE_TOKEN:''},'shell_environment_policy.exclude':['*'],mcp_servers:{'local.tools':{enabled:false,required:false}}});
 expect(JSON.stringify(params)).not.toContain('PRIVATE');expect(f.client.hasExited).toBe(true);
});

test('a broader effective native policy is rejected before a model turn starts',async()=>{
 const f=fixture('broaden');await expect(runTaskWorkspace(f.input)).rejects.toThrow();
 expect(f.peer.sent.some(r=>r.method==='turn/start')).toBe(false);expect(f.client.hasExited).toBe(true);
});

test('lost submit acknowledgement never submits twice and stays unknown',async()=>{
 const f=fixture('lost');await expect(runTaskWorkspace(f.input)).rejects.toMatchObject({executionUnknown:true});
 expect(f.peer.sent.filter(r=>r.method==='turn/start')).toHaveLength(1);expect(f.client.hasExited).toBe(true);
});

test('cancellation waits for supervised process exit and does not produce a successful result',async()=>{
 const f=fixture('wait'),controller=new AbortController();
 const pending=runTaskWorkspace({...f.input,signal:controller.signal});
 const cancelled=expect(pending).resolves.toMatchObject({exitCode:130});
 await expect.poll(()=>f.peer.sent.some(r=>r.method==='turn/start')).toBe(true);controller.abort('cancelled');await cancelled;
 expect(f.client.hasExited).toBe(true);expect(f.peer.sent.filter(r=>r.method==='turn/start')).toHaveLength(1);
});
