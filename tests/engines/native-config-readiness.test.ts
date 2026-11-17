import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {CodexAppServerClient} from '../../src/engines/codex-rpc.js';
import {CodexAppServerPool} from '../../src/engines/codex-pool.js';
import {CodexSessionService,CodexSessionStore} from '../../src/engines/codex-session.js';

async function fixture(config:Record<string,unknown>,options:{directories?:boolean;customSkill?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-config-')),home=join(root,'codex'),cwd=join(root,'workspace');
 await mkdir(home);await mkdir(cwd);
 if(options.directories)for(const directory of ['rules','hooks','plugins','apps']){
  await mkdir(join(home,directory));await writeFile(join(home,directory,'fixture'),'native installation');
 }
 const db=new Database(':memory:'),sent:any[]=[];
 class Process extends EventEmitter {
  stdout=new PassThrough();stderr=new PassThrough();
  stdin=new Writable({write:(chunk,_encoding,done)=>{
   const request=JSON.parse(chunk.toString());sent.push(request);done();
   if(!Object.hasOwn(request,'id'))return;
   queueMicrotask(()=>{
    let result:unknown;
    if(request.method==='initialize')result={userAgent:'fixture/0.160.0',codexHome:home};
    else if(request.method==='account/read')result={requiresOpenaiAuth:false,account:null};
    else if(request.method==='config/read')result={config,layers:[{name:{type:'user'},version:'1',config}]};
    else if(request.method==='skills/list')result={data:[{cwd:request.params.cwds[0],skills:options.customSkill?[{name:'custom',path:join(home,'skills','custom','SKILL.md'),scope:'user',enabled:true,pluginId:null}]:[],errors:[]}]};
    else if(request.method==='thread/start')result={thread:{id:'native-thread'},cwd:request.params.cwd,model:'fixture',modelProvider:'fixture',approvalPolicy:request.params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true},activePermissionProfile:{id:request.params.permissions,extends:null},runtimeWorkspaceRoots:request.params.runtimeWorkspaceRoots};
    else throw Error('Unexpected diagnostic RPC method: '+request.method);
    this.stdout.write(JSON.stringify({id:request.id,result})+'\n');
   });
  },final:done=>{done();queueMicrotask(()=>this.emit('close',0));}});
  kill(){queueMicrotask(()=>this.emit('close',0));return true;}
 }
 const pool=new CodexAppServerPool({stateDir:root,rpcFactory:()=>new CodexAppServerClient({executable:process.execPath,spawn:()=>new Process()})});
 return {pool,db,cwd,sent,root,close:async()=>{await pool.close();db.close();await rm(root,{recursive:true,force:true});}};
}

const nativeConfigurations=[
 {plugins:{fixture:{enabled:true}}},
 {apps:{fixture:{enabled:true}}},
 {hooks:{PreToolUse:[]}},
 {skills:{config:[{path:'/fixture/SKILL.md',enabled:true}]}},
 {agents:{fixture:{description:'custom'}}},
 {rules:{default:'allow'}},
 {commands:{fixture:{command:'native'}}},
 {experimental_features:{fixture:true}},
 {features:{remote_plugin:true}},
 {approval_policy:'on-request'},
 {approvals_reviewer:'user'},
 {sandbox_mode:'workspace-write'},
 {sandbox_workspace_write:{network_access:true}},
 {permissions:{unrelated:{filesystem:{':root':'read'}}}},
 {default_permissions:'unrelated'},
 {web_search:'live'},
];
test.each(nativeConfigurations)('readiness does not reject inherited native settings: %j',async config=>{
 const f=await fixture(config),original=JSON.stringify(config);
 try{
  await expect(f.pool.audit('worker')).resolves.toBe('ready');
  expect(JSON.stringify(config)).toBe(original);
  expect(f.sent.filter(r=>r.method==='config/read')).toMatchObject([{params:{includeLayers:false}}]);
  expect(f.sent.some(r=>['skills/list','thread/start','turn/start'].includes(r.method))).toBe(false);
 }finally{await f.close();}
});
test.each([{directories:true},{customSkill:true}])('native installed extensions do not block readiness: %j',async options=>{
 const f=await fixture({},options);
 try{await expect(f.pool.audit('worker')).resolves.toBe('ready');expect(f.sent.some(r=>r.method==='skills/list')).toBe(false);}
 finally{await f.close();}
});
test('native session prepares with user configuration without exporting it or starting a turn',async()=>{
 const config={mcp_servers:{fixture:{bearer_token:'FIXTURE_NATIVE_SECRET'}},plugins:{fixture:{enabled:true}},approval_policy:'on-request',sandbox_mode:'workspace-write'},f=await fixture(config,{directories:true,customSkill:true});
 const sessions=new CodexSessionService(new CodexSessionStore(f.db),id=>f.pool.client(id),{workspacePath:async()=>f.cwd});
 try{
  await expect(sessions.prepare({session_key:'session',workspace_id:'workspace',binding:{conversation_id:'room',agent_id:'agent',actor_id:'alice',agent_revision:1,authorization_revision:1,engine:{kind:'device',worker_id:'worker',agent:'codex',adapter_version:1}}})).resolves.toEqual({thread_id:'native-thread',session_tree_id:null});
  const thread=f.sent.find(r=>r.method==='thread/start');expect(thread.params.permissions).toMatch(/^luoshu_/);
  expect(thread.params.config['permissions.'+thread.params.permissions]).toBeDefined();
  expect(f.sent.some(r=>['skills/list','turn/start'].includes(r.method))).toBe(false);
  expect(JSON.stringify(f.sent)).not.toContain('FIXTURE_NATIVE_SECRET');
  expect(JSON.stringify(f.db.prepare('SELECT policy_json FROM codex_native_sessions').all())).not.toContain('FIXTURE_NATIVE_SECRET');
 }finally{await f.close();}
});
