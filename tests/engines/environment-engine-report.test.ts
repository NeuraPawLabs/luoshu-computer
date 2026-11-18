import {expect,test} from 'vitest';
import {buildEnvironmentReport} from '../../src/runtime/environment.js';
import type {DeviceServiceReport} from '../../src/protocol/index.js';

const assistantFeatures: DeviceServiceReport['features'] = ['session_resume','turn_status','turn_interrupt','interaction_response','structured_events','attachments','task_operations','delivery','core_agent_runtime'];
const assistantService = (status: DeviceServiceReport['status'], reason: string | null = null): DeviceServiceReport => ({
 id:'assistant-codex', type:'assistant_engine', version:'1', agent_id:'codex', status, reason,
 features: assistantFeatures,
});

test('detected Codex without an available audit remains unavailable',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,agentPaths:{codex:'/fixture/codex'},services:[assistantService('unavailable','permissions_unavailable')],probe:async tool=>tool==='codex'?'codex 0.154.0':undefined});
 expect(report.agents).toContainEqual(expect.objectContaining({id:'codex',detected:true,version:'0.154.0'}));expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'unavailable'});
});
test('detected current Codex is ready when the approved systemd supervisor is available',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},services:[assistantService('ready')],probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.agents).toContainEqual(expect.objectContaining({id:'codex',detected:true,version:'0.160.0'}));expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'ready',features:expect.arrayContaining(['delivery','task_operations','core_agent_runtime'])});
});
test('verified Codex patch release is ready when the approved systemd supervisor is available',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},services:[assistantService('ready')],probe:async tool=>tool==='codex'?'codex 0.160.1':undefined});
 expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'ready'});
});
test('arbitrary valid Codex versions are evaluated by runtime audit, not a version list',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',agentPaths:{codex:'/fixture/codex'},services:[assistantService('ready')],probe:async tool=>tool==='codex'?'codex 0.161.0':undefined});
 expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'ready'});
});
test('current Codex is not ready before effective capability audit',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,agentPaths:{codex:'/fixture/codex'},services:[assistantService('unavailable','permissions_unavailable')],probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.services).toContainEqual(expect.objectContaining({type:'assistant_engine',agent_id:'codex',status:'unavailable',reason:'permissions_unavailable'}));
});
test('native audit login failure remains distinguishable from permission failure',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'login_required',agentPaths:{codex:'/fixture/codex'},services:[assistantService('unavailable','login_required')],probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'unavailable'});
});
test('current Codex reports supervisor unavailable when the approved Linux supervisor cannot start',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>false,agentPaths:{codex:'/fixture/codex'},services:[assistantService('unavailable','supervisor_unavailable')],probe:async tool=>tool==='codex'?'codex 0.160.0':undefined});
 expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({agent_id:'codex',status:'unavailable'});
});
test.each(['0.161.0','1.0.0','unknown'])('version text does not decide runtime readiness: %s',async version=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,supervisorAvailable:async()=>true,nativeAudit:async()=> 'ready',services:[assistantService('ready')],probe:async tool=>tool==='codex'?`codex ${version}`:undefined});
 expect(report.agents).toContainEqual(expect.objectContaining({id:'codex',detected:true,version:version==='unknown'?'codex unknown':version}));expect(report.services.find(s=>s.type==='assistant_engine')).toMatchObject({status:'ready'});
});
test('detected Codex report includes the supplied assistant service',async()=>{
 const report=await buildEnvironmentReport({name:'fixture',capacity:1,probe:async tool=>tool==='codex'?'codex 0.161.0':undefined,services:[assistantService('ready')]});
 expect(report.agents.find(a=>a.id==='codex')?.detected).toBe(true);expect(report.services.find(s=>s.type==='assistant_engine')).toBeDefined();
});
