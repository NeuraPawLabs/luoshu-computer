import {mkdtemp,mkdir,writeFile,symlink,rm,rename,unlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {resolveNativeExecutable} from '../../src/engines/native-executable.js';
import {CodexAppServerClient} from '../../src/engines/codex-rpc.js';
const elf=Buffer.from([0x7f,0x45,0x4c,0x46]);
test('native ELF resolution uses canonical exact file path and rejects arbitrary scripts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-executable-'));try{
  const binary=join(root,'native'),alias=join(root,'codex');await writeFile(binary,elf,{mode:0o700});await symlink(binary,alias);
  expect(await resolveNativeExecutable(alias)).toBe(binary);
  expect(await resolveNativeExecutable('codex',root)).toBe(binary);
  const script=join(root,'script');await writeFile(script,'#!/bin/sh\nexit 0\n',{mode:0o700});
  await expect(resolveNativeExecutable(script)).rejects.toThrow(/native|wrapper/);
  await expect(resolveNativeExecutable(root)).rejects.toThrow(/file|executable/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('official npm launcher resolves the platform package without executing its JavaScript',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-native-launcher-'));try{
  const packageRoot=join(root,'node_modules','@openai','codex'),platformRoot=join(packageRoot,'node_modules','@openai',`codex-linux-${process.arch}`),triple=process.arch==='x64'?'x86_64-unknown-linux-musl':'aarch64-unknown-linux-musl';
  await mkdir(join(packageRoot,'bin'),{recursive:true});await mkdir(join(platformRoot,'vendor',triple,'bin'),{recursive:true});
  const launcher=join(packageRoot,'bin','codex.js'),binary=join(platformRoot,'vendor',triple,'bin','codex');
  await writeFile(launcher,'#!/usr/bin/env node\nthrow Error("must not execute launcher");\n',{mode:0o700});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@openai/codex',version:'9.9.9',bin:{codex:'bin/codex.js'}}));
  await writeFile(join(platformRoot,'package.json'),JSON.stringify({name:'@openai/codex',version:`9.9.9-linux-${process.arch}`}));await writeFile(binary,elf,{mode:0o700});
  expect(await resolveNativeExecutable(launcher)).toBe(binary);
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'other',version:'9.9.9',bin:{codex:'bin/codex.js'}}));
  await expect(resolveNativeExecutable(launcher)).rejects.toThrow(/wrapper/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test.each(['replace','overwrite','retarget','remove','permissions'] as const)('client rejects executable %s instead of trusting cached path',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'native-runtime-drift-')),binary=join(root,'native'),alias=join(root,'codex'),other=join(root,'replacement');
 const client=new CodexAppServerClient({executable:alias});
 try{
  await writeFile(binary,Buffer.concat([elf,Buffer.from('one')]),{mode:0o700});await symlink(binary,alias);
  expect(await client.runtimeExecutable()).toBe(binary);expect(await client.runtimeExecutable()).toBe(binary);
  if(mode==='replace'){await writeFile(other,Buffer.concat([elf,Buffer.from('one')]),{mode:0o700});await rename(other,binary);}
  if(mode==='overwrite')await writeFile(binary,Buffer.concat([elf,Buffer.from('two')]));
  if(mode==='retarget'){await writeFile(other,elf,{mode:0o700});await unlink(alias);await symlink(other,alias);}
  if(mode==='remove')await unlink(binary);
  if(mode==='permissions')await chmod(binary,0o600);
  await expect(client.runtimeExecutable()).rejects.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
  expect(client.isClosed).toBe(false); // A disk update must not kill accepted work.
  if(mode==='remove')await writeFile(binary,elf,{mode:0o700});
  if(mode==='permissions')await chmod(binary,0o700);
  if(mode==='retarget'){await unlink(alias);await symlink(binary,alias);}
  await expect(client.runtimeExecutable()).rejects.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
  const fresh=new CodexAppServerClient({executable:alias});try{expect(await fresh.runtimeExecutable()).toBe(binary);}finally{await fresh.close();}
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
test('an initially missing executable is unavailable, not a change to an existing installation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-runtime-absent-')),client=new CodexAppServerClient({executable:join(root,'missing')});
 try{
  await expect(client.runtimeExecutable()).rejects.toThrow('Codex executable is unavailable');
  await expect(client.runtimeExecutable()).rejects.not.toMatchObject({code:'CODEX_RUNTIME_CHANGED'});
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
test('runtime resolution respects configured PATH and coalesces initial pinning',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-runtime-path-')),name='fixture-codex-'+Date.now(),binary=join(root,name);
 const client=new CodexAppServerClient({executable:name,env:{PATH:root}});
 try{
  await writeFile(binary,elf,{mode:0o700});
  expect(await Promise.all([client.runtimeExecutable(),client.runtimeExecutable()])).toEqual([binary,binary]);
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
