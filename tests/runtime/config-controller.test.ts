import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
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

test('explicit disabled policy applies while preserving local files and reports blocked runtime application',async()=>{const f=await fixture(),controller=new WorkerConfigController(f.root);try{const before=await controller.state();controller.onApplied(()=>{throw Object.assign(new Error('active development session blocks the change'),{configurationBlocked:true});});const disabled=custom(f,{development_policy:{mode:'disabled',roots:[]}}),result=await controller.apply({request_id:'blocked',desired_revision:'55555555-5555-4555-8555-555555555555',expected_revision:before.desired_revision,config:disabled});expect(result.status).toBe('blocked');expect(result.applied).toEqual(before.applied);expect((await loadWorkerConfig(f.root)).development_roots).toEqual([f.code]);}finally{await rm(f.root,{recursive:true,force:true});}});
