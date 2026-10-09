import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {saveWorkerConfig,loadWorkerConfig} from '../../src/runtime/environment.js';
import {updateWorkerConfig} from '../../src/runtime/environment.js';
import {WorkerConfigController} from '../../src/runtime/config-controller.js';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'worker-config-controller-')),bin=join(root,'bin'),code=join(root,'code'),maintenance=join(root,'maintenance');
 await Promise.all([mkdir(bin),mkdir(code),mkdir(maintenance)]);const codex=join(bin,'codex');await writeFile(codex,'#!/bin/sh\nexit 0\n',{mode:0o700});
 await saveWorkerConfig(root,{worker_id:'worker_1',url:'https://example.test',name:'desk',capacity:1,agent_paths:{codex},development_roots:[code],maintenance_roots:[maintenance],codex_sandbox:'workspace-write'});
 return{root,bin,code,maintenance,codex};
}
test('applies a complete mutable config atomically and preserves immutable Worker identity',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root),revision='11111111-1111-4111-8111-111111111111';
 try{
  const result=await controller.apply({request_id:'config_1',revision,expected_revision:(await controller.state()).revision,config:{name:'dedicated',capacity:4,agent_paths:{codex:f.codex},development_roots:[f.code],maintenance_roots:[f.maintenance],codex_sandbox:'danger-full-access'}});
  expect(result.status).toBe('applied');expect(result.config.name).toBe('dedicated');expect((await loadWorkerConfig(f.root)).worker_id).toBe('worker_1');expect((await loadWorkerConfig(f.root)).worker_config_revision).toBe(revision);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('rejects an invalid mutable config and keeps the last applied config',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root),revision='22222222-2222-4222-8222-222222222222';
 try{
  const result=await controller.apply({request_id:'config_2',revision,expected_revision:(await controller.state()).revision,config:{name:'bad',capacity:2,agent_paths:{codex:join(f.bin,'missing')},development_roots:[f.code],maintenance_roots:[f.maintenance],codex_sandbox:'workspace-write'}});
  expect(result.status).toBe('failed');expect(result.error).toMatch(/not available|ENOENT/);expect((await loadWorkerConfig(f.root)).name).toBe('desk');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('replaying an applied revision is idempotent',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root),revision='33333333-3333-4333-8333-333333333333',seen:string[]=[];controller.onApplied(config=>{seen.push(config.name);});
 try{
  const config={name:'new',capacity:2,agent_paths:{codex:f.codex},development_roots:[f.code],maintenance_roots:[f.maintenance],codex_sandbox:'workspace-write' as const};
  const expected_revision=(await controller.state()).revision;
  expect((await controller.apply({request_id:'config_3',revision,config,expected_revision})).status).toBe('applied');expect((await controller.apply({request_id:'config_3-retry',revision,config,expected_revision})).status).toBe('applied');expect(seen).toEqual(['desk','new']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('clearing custom roots restores home and clearing agent paths removes old overrides',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root);try{
  const before=await controller.state(),config={...before.config,development_roots:null,agent_paths:{}};
  const result=await controller.apply({request_id:'clear',revision:crypto.randomUUID(),expected_revision:before.revision,config});
  expect(result).toMatchObject({status:'applied',config:{development_roots:null,agent_paths:{}}});
  expect((await loadWorkerConfig(f.root)).development_roots).toBeUndefined();
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('stale remote updates and conflicting revision replays cannot overwrite local edits',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root);try{
  const before=await controller.state(),revision=crypto.randomUUID();
  await updateWorkerConfig(f.root,current=>({...current,name:'local edit'}));
  expect(await controller.apply({request_id:'stale',revision,expected_revision:before.revision,config:before.config})).toMatchObject({status:'failed',config:{name:'local edit'}});
  const latest=await controller.state(),request={request_id:'current',revision,expected_revision:latest.revision,config:{...latest.config,name:'remote'}};
  expect((await controller.apply(request)).status).toBe('applied');
  expect((await controller.apply({...request,config:{...request.config,name:'conflicting replay'}})).status).toBe('failed');
  expect((await controller.state()).config.name).toBe('remote');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('directory paths cannot be configured as Agent executables',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root);try{const before=await controller.state();
  expect((await controller.apply({request_id:'directory',revision:crypto.randomUUID(),expected_revision:before.revision,config:{...before.config,agent_paths:{codex:f.bin}}})).status).toBe('failed');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a failed config commit does not notify runtimes or alter the previous configuration',async()=>{
 const f=await fixture(),controller=new WorkerConfigController(f.root),{rename,readFile}=await import('node:fs/promises');let notifications=0;
 controller.onApplied(()=>{notifications++;});try{const state=await controller.state(),before=await readFile(join(f.root,'config.json'),'utf8');notifications=0;
  await rename(join(f.root,'config.json'),join(f.root,'backup'));await mkdir(join(f.root,'config.json'));
  await expect(controller.apply({request_id:'disk-failure',revision:crypto.randomUUID(),expected_revision:state.revision,config:{...state.config,name:'must not apply'}})).rejects.toThrow();
  expect(notifications).toBe(0);expect(await readFile(join(f.root,'backup'),'utf8')).toBe(before);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('remote mutable updates preserve the locally pinned release feed and key',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const f=await fixture();
 const release_public_key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
 try{
  await updateWorkerConfig(f.root,current=>({...current,release_url:'https://downloads.test/computer',release_public_key}));
  const controller=new WorkerConfigController(f.root),before=await controller.state();
  expect(before.config).not.toHaveProperty('release_url');expect(before.config).not.toHaveProperty('release_public_key');
  const result=await controller.apply({request_id:'release-preserve',revision:crypto.randomUUID(),expected_revision:before.revision,config:{...before.config,name:'remote'}});
  expect(result.status).toBe('applied');expect(await loadWorkerConfig(f.root)).toMatchObject({name:'remote',release_url:'https://downloads.test/computer',release_public_key});
  const next=await controller.state();
  const attack=await controller.apply({request_id:'release-overwrite',revision:crypto.randomUUID(),expected_revision:next.revision,config:{...next.config,release_url:'https://attacker.test'} as any});
  expect(attack.status).toBe('failed');expect((await loadWorkerConfig(f.root)).release_url).toBe('https://downloads.test/computer');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
