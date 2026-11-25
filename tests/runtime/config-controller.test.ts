import {mkdtemp, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {saveWorkerConfig,loadWorkerConfig,updateWorkerConfig} from '../../src/runtime/environment.js';
import {WorkerConfigController} from '../../src/runtime/config-controller.js';
import type {DeviceMutableConfiguration} from '../../src/protocol/index.js';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'worker-config-controller-')),bin=join(root,'bin'),code=join(root,'code'),maintenance=join(root,'maintenance');
 await Promise.all([mkdir(bin),mkdir(code),mkdir(maintenance)]);const codex=join(bin,'codex');await writeFile(codex,'#!/bin/sh\nexit 0\n',{mode:0o700});
 await saveWorkerConfig(root,{worker_id:'worker_1',url:'https://example.test',name:'desk',capacity:1,agent_paths:{codex},development_roots:[code],maintenance_roots:[maintenance],codex_sandbox:'workspace-write'});
 return{root,bin,code,maintenance,codex};
}
const custom=(f:Awaited<ReturnType<typeof fixture>>,over:Partial<DeviceMutableConfiguration>={}):DeviceMutableConfiguration=>({name:'desk',capacity:1,agent_paths:{codex:f.codex},development_policy:{mode:'custom',roots:[f.code]},maintenance_roots:[f.maintenance],codex_sandbox:'workspace-write',...over});

test('applies unified mutable config atomically and preserves immutable device identity',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root),revision='11111111-1111-4111-8111-111111111111';
 try{const before=await controller.state();const result=await controller.apply({request_id:'config_1',desired_revision:revision,expected_revision:before.desired_revision,config:custom(f,{name:'dedicated',capacity:4,codex_sandbox:'danger-full-access'})});
  expect(result).toMatchObject({status:'applied',desired:{name:'dedicated'},applied:{name:'dedicated'},desired_revision:revision});expect((await loadWorkerConfig(f.root)).worker_id).toBe('worker_1');expect((await loadWorkerConfig(f.root)).worker_config_revision).toBe(revision);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('rejects invalid Agent path and keeps last applied state',async()=>{const f=await fixture(),controller=new WorkerConfigController(f.root);try{const before=await controller.state();const result=await controller.apply({request_id:'config_2',desired_revision:'22222222-2222-4222-8222-222222222222',expected_revision:before.desired_revision,config:custom(f,{agent_paths:{codex:join(f.bin,'missing')}})});expect(result.status).toBe('failed');expect(result.applied).toEqual(before.applied);expect((await loadWorkerConfig(f.root)).name).toBe('desk');}finally{await rm(f.root,{recursive:true,force:true});}});

test('replaying an applied revision is idempotent and local edits fence remote writes',async()=>{const f=await fixture(),controller=new WorkerConfigController(f.root),seen:string[]=[];controller.onApplied(config=>{seen.push(config.name);});try{const before=await controller.state(),revision='33333333-3333-4333-8333-333333333333',config=custom(f,{name:'new'});expect((await controller.apply({request_id:'config_3',desired_revision:revision,expected_revision:before.desired_revision,config})).status).toBe('applied');expect((await controller.apply({request_id:'config_3-retry',desired_revision:revision,expected_revision:revision,config})).status).toBe('applied');expect(seen).toEqual(['desk','new']);await updateWorkerConfig(f.root,current=>({...current,name:'local edit'}));const stale=await controller.apply({request_id:'stale',desired_revision:'44444444-4444-4444-8444-444444444444',expected_revision:revision,config});expect(stale.status).toBe('failed');expect(stale.applied?.name).toBe('local edit');}finally{await rm(f.root,{recursive:true,force:true});}});

test('explicit disabled policy applies while preserving local files and reports blocked runtime application',async()=>{const f=await fixture(),controller=new WorkerConfigController(f.root);try{const before=await controller.state();controller.onApplied(config=>{if(config.development_policy.mode==='disabled')throw Object.assign(new Error('active development session blocks the change'),{configurationBlocked:true});});const disabled=custom(f,{development_policy:{mode:'disabled',roots:[]}}),result=await controller.apply({request_id:'blocked',desired_revision:'55555555-5555-4555-8555-555555555555',expected_revision:before.desired_revision,config:disabled});expect(result.status).toBe('blocked');expect(result.applied).toEqual(before.applied);expect((await loadWorkerConfig(f.root)).development_roots).toEqual([f.code]);}finally{await rm(f.root,{recursive:true,force:true});}});

test('a later listener failure reconciles earlier runtime listeners to the saved applied config',async()=>{const f=await fixture(),controller=new WorkerConfigController(f.root);let runtimeName='';controller.onApplied(config=>{runtimeName=config.name;});controller.onApplied(config=>{if(config.name==='after')throw Object.assign(new Error('runtime rejected the change'),{configurationBlocked:true});});try{const before=await controller.state(),config=custom(f,{name:'after'}),result=await controller.apply({request_id:'partial-listener-failure',desired_revision:'66666666-6666-4666-8666-666666666666',expected_revision:before.desired_revision,config});expect(result.status).toBe('blocked');expect(result.applied?.name).toBe('desk');expect((await loadWorkerConfig(f.root)).name).toBe('desk');expect(runtimeName).toBe('desk');}finally{await rm(f.root,{recursive:true,force:true});}});

test('a failed runtime rollback clears the claimed applied state and still restores later listeners',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root);let rejectRollback=false,runtimeName='';
 controller.onApplied(config=>{if(rejectRollback&&config.name==='desk')throw Error('runtime rollback refused');});
 controller.onApplied(config=>{runtimeName=config.name;});
 controller.onApplied(config=>{if(config.name==='after'){rejectRollback=true;throw Error('runtime change refused');}});
 try{
  const before=await controller.state(),result=await controller.apply({request_id:'rollback-failure',desired_revision:'77777777-7777-4777-8777-777777777777',expected_revision:before.desired_revision,config:custom(f,{name:'after'})});
  expect(result).toMatchObject({status:'failed',applied:null,applied_revision:null,desired:{name:'after'}});
  expect(result.error).toContain('runtime change refused');expect(result.error).toContain('runtime rollback refused');
  expect(runtimeName).toBe('desk');expect((await loadWorkerConfig(f.root)).name).toBe('desk');
  expect(JSON.parse(await readFile(join(f.root,'configuration-state.json'),'utf8'))).toEqual(result);
  await expect(controller.state()).rejects.toThrow('runtime rollback refused');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a failed local config rollback reports failure without claiming a complete applied config',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root);let runtimeName='';
 controller.onApplied(config=>{runtimeName=config.name;});
 controller.onApplied(async config=>{if(config.name==='after'){await rename(join(f.root,'config.json'),join(f.root,'config-before-rollback.json'));await mkdir(join(f.root,'config.json'));throw Error('runtime change refused');}});
 try{
  const before=await controller.state(),result=await controller.apply({request_id:'file-rollback-failure',desired_revision:'88888888-8888-4888-8888-888888888888',expected_revision:before.desired_revision,config:custom(f,{name:'after'})});
  expect(result).toMatchObject({status:'failed',applied:null,applied_revision:null,desired:{name:'after'}});
  expect(result.error).toContain('runtime change refused');expect(result.error).toContain('Configuration rollback failed');
  expect(runtimeName).toBe('desk');expect(JSON.parse(await readFile(join(f.root,'configuration-state.json'),'utf8'))).toEqual(result);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('client service descriptors are explicit adapter output only',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {WorkerClient}=await import('../../src/runtime/client.js');const {deviceObservationSchema}=await import('../../src/protocol/index.js');
 const root=await mkdtemp(join(tmpdir(),'service-describe-'));const client=new WorkerClient({stateDir:root,config:{worker_id:'device_1',url:'https://example.test',name:'device',capacity:1},onAssistantEngineRequest:async()=>{throw Error('unused')}});
 try { const services=(client as any).describeServices();expect(services).toEqual([]);const descriptor={id:'maintenance',type:'maintenance',version:'1',agent_id:'codex',status:'ready',reason:null,features:['git']};const concrete=new WorkerClient({stateDir:root,config:{worker_id:'device_1',url:'https://example.test',name:'device',capacity:1},serviceReports:()=>[descriptor]});try {const reported=(concrete as any).describeServices();expect(reported).toEqual([descriptor]);expect(()=>deviceObservationSchema.parse({protocol_version:10,report_revision:1,platform:{os:'linux',arch:'x64',computer_version:'test'},software:[],agents:[],services:reported,git_credentials:[]})).not.toThrow();} finally {concrete.stop();}} finally {client.stop();await rm(root,{recursive:true,force:true});}
});
