import {expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {CodexAppServerClient} from '../../src/engines/codex-rpc.js';
import {nativePermissions} from '../../src/engines/native-permissions.js';

/** Opt-in native compatibility check. The isolated home and local Responses
 * endpoint cannot use a user's credentials or contact a paid model provider. */
test.skipIf(!process.env.LUOSHU_CODEX_NATIVE_TEST_BINARY).each(['token_budget','current_time_reminder','deferred_executor'])('native Core disables inherited %s tools and notify commands',async inheritedFeature=>{
 const executable=process.env.LUOSHU_CODEX_NATIVE_TEST_BINARY!,root=await mkdtemp(join(tmpdir(),'luoshu-core-native-'));
 const codexHome=join(root,'codex'),cwd=join(root,'workspace'),notifyScript=join(root,'notify.cjs'),notifyMarker=join(root,'notify-ran');
 let completed!:()=>void;const terminal=new Promise<void>(resolve=>completed=resolve);
 let requestBody:Record<string,any>|undefined;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  requestBody=JSON.parse(raw);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'response',object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})+'\n\n');
 });
 let client:CodexAppServerClient|undefined;
 try{
  await mkdir(codexHome);await mkdir(cwd);
  await writeFile(notifyScript,`require('node:fs').writeFileSync(${JSON.stringify(notifyMarker)},'notify executed');`);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  await writeFile(join(codexHome,'config.toml'),`model = "fixture"\nmodel_provider = "fixture"\nnotify = ${JSON.stringify([process.execPath,notifyScript])}\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[mcp_servers."local.tools"]\ncommand = "/does-not-exist"\nrequired = true\n[features]\n${inheritedFeature} = true\ngoals = true\nshell_tool = true\ncode_mode_only = true\njs_repl_tools_only = true\nagent_message_board = true\nstandalone_web_search = true\ntool_search = true\nrequest_permissions = true\nsend_message_to_user_async = true\n[tools.experimental_request_user_input]\nenabled = true\n[tools.update_plan]\nenabled = true\n`);
  client=new CodexAppServerClient({spawn:()=>spawn(executable,['app-server','--listen','stdio://'],{cwd,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:codexHome},stdio:['pipe','pipe','pipe']}),requestTimeoutMs:10000,onNotification:method=>{if(method==='turn/completed')completed();}});
  await client.initialize({clientInfo:{name:'luoshu-native-test',version:'1'},capabilities:{experimentalApi:true}});
  const config=await client.coreThreadConfig(cwd),permissionScope=nativePermissions({session:'core-native-test',cwd,runtime:executable,read:[],write:[],mode:'read-only'});
  await client.startThread({cwd,permissionScope,config,model:'fixture',modelProvider:'fixture',dynamicTools:[{type:'function',name:'worker_side_effect',description:'Worker execution tool',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
  const thread=await client.startThread({cwd,permissionScope,config,model:'fixture',modelProvider:'fixture',dynamicTools:[]});
  expect(thread.policy.sandbox).toEqual({type:'readOnly',networkAccess:false});expect(thread.runtimeWorkspaceRoots).toEqual([]);
  const outputSchema={type:'object',properties:{text:{type:'string'},calls:{type:'array',maxItems:0,items:{type:'object'}}},required:['text','calls'],additionalProperties:false};
  await client.startTurn({threadId:thread.id,input:[{type:'text',text:'Return a decision.'}],permissions:permissionScope.id,runtimeWorkspaceRoots:[],outputSchema});
  await expect.poll(()=>Boolean(requestBody),{timeout:10000}).toBe(true);
  await terminal;
  await new Promise(resolve=>setTimeout(resolve,100));
  await expect(access(notifyMarker)).rejects.toMatchObject({code:'ENOENT'});
  expect(requestBody!.tools).toEqual([]);
  expect(requestBody!.text.format).toMatchObject({type:'json_schema',strict:true,schema:outputSchema});
 }finally{
  await client?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
 }
},20000);
