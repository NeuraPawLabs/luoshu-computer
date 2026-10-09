import {expect,test} from 'vitest';
import {buildEnvironmentReport} from '../../src/runtime/environment.js';
test('detected Codex without an available audit remains unavailable',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.154.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'unavailable',reason:'permissions_unavailable'}));
});
test('detected current Codex is ready when the approved systemd supervisor is available',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'ready',adapter_version:1,reason:null,features:expect.arrayContaining(['delivery','task_operations'])}));
});
test('verified Codex patch release is ready when the approved systemd supervisor is available',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.160.1':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'ready',adapter_version:1,reason:null}));
});
test('arbitrary valid Codex versions are evaluated by runtime audit, not a version list',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.161.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'ready',adapter_version:1,reason:null}));
});
test('current Codex is not ready before effective capability audit',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'unavailable',reason:'permissions_unavailable'}));
});
test('native audit login failure remains distinguishable from permission failure',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'login_required',agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'unavailable',reason:'login_required'}));
});
test('current Codex reports supervisor unavailable when the approved Linux supervisor cannot start',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>false,agentPaths:{codex:'/fixture/codex'},probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.assistant_engines).toContainEqual(expect.objectContaining({agent:'codex',status:'unavailable',reason:'supervisor_unavailable'}));
});
test.each(['0.161.0','1.0.0','unknown'])('version text does not decide runtime readiness: %s',async version=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',probe:async tool=>tool==='codex'?`codex ${version}`:undefined});
 expect(report.assistant_engines).toMatchObject([{status:'ready',reason:null}]);
});
test('detected Codex starts runtime audit without a version preflight gate',async()=>{
 let audits=0,preflights=0;
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,probe:async tool=>tool==='codex'?'codex 0.161.0':undefined,supervisorAvailable:async()=>{preflights++;return true;},nativeAudit:async()=>{audits++;return'ready';}});
 expect(report.assistant_engines?.[0].reason).toBeNull();expect(audits).toBe(1);expect(preflights).toBe(1);
});
