import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,link,rm} from 'node:fs/promises';
import {statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import type {KnowledgeReadResult,KnowledgeSource} from '@luoshu/protocol';
import type {PreparedNativeCodebases} from '../src/agent-engines/native-codebases.js';

const codebase='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
const base='a'.repeat(40),head='b'.repeat(40),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-knowledge-source-')),checkout=join(root,'checkout');
 await mkdir(join(checkout,'.git','refs','heads'),{recursive:true});await mkdir(join(checkout,'src'));
 await writeFile(join(checkout,'src','main.ts'),'export const value = 1;\n');await writeFile(join(checkout,'.git','HEAD'),'ref: refs/heads/main\n');await writeFile(join(checkout,'.git','refs','heads','main'),head+'\n');
 const prepared={assignments:[{id:codebase,root_path:'.',base_commit:base}],workspace:{path:root,targets:root,references:root,codebases:[{id:codebase,alias:'app',access_mode:'read',repository_path:checkout,checkout_path:checkout,base_commit:base,branch:null,read_isolation:'enforced'}]},read:[checkout],write:[]} as PreparedNativeCodebases;
 return {root,checkout,prepared,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function resolver(prepared:()=>Promise<PreparedNativeCodebases>,current:()=>void=()=>{},ids=[codebase]){
 const implementation=await import('../src/agent-engines/native-knowledge-sources.js').catch(()=>null);
 expect(implementation,'Worker source evidence resolver exists').not.toBeNull();
 return new implementation!.NativeKnowledgeSources({codebaseIds:ids,prepared,current});
}
const readResult=(sources:KnowledgeSource[],kind:'analysis'|'reference'|'business'='analysis',body='Current code facts'):KnowledgeReadResult=>({entry:{id:'entry',revision:1,scope:{kind:kind==='business'?'project':'codebase',id:codebase},title:'Entry',summary:'Summary',kind,sources},body});

test('source enrichment derives actual checkout HEAD and content without changing a read-only repository',async()=>{
 const f=await fixture();try{
  await chmod(join(f.checkout,'src','main.ts'),0o444);await chmod(join(f.checkout,'src'),0o555);
  const before=await readFile(join(f.checkout,'src','main.ts')),sources=await (await resolver(async()=>f.prepared)).enrich([{codebase_id:codebase,path:'src/main.ts'}]);
  expect(sources).toEqual([{codebase_id:codebase,path:'src/main.ts',commit_sha:head,content_sha256:sha(before.toString())}]);
  expect(await readFile(join(f.checkout,'src','main.ts'))).toEqual(before);
  expect(await readFile(join(f.checkout,'.git','refs','heads','main'),'utf8')).toBe(head+'\n');
 }finally{await chmod(join(f.checkout,'src'),0o755);await f.cleanup();}
});

test('source verification accepts identical content at a different commit and rejects changed or missing files',async()=>{
 const f=await fixture();try{
  const evidence=await resolver(async()=>f.prepared),sources=await evidence.enrich([{codebase_id:codebase,path:'src/main.ts'}]);
  await writeFile(join(f.checkout,'.git','refs','heads','main'),'c'.repeat(40)+'\n');
  await expect(evidence.verify(readResult(sources))).resolves.toBeUndefined();
  await writeFile(join(f.checkout,'src','main.ts'),'changed');await expect(evidence.verify(readResult(sources))).rejects.toThrow(/stale|content|changed/i);
  await rm(join(f.checkout,'src','main.ts'));await expect(evidence.verify(readResult(sources))).rejects.toThrow();
 }finally{await f.cleanup();}
});

test('source refs reject unauthorized Codebases and normalized path violations',async()=>{
 const f=await fixture();try{
  const evidence=await resolver(async()=>f.prepared);
  await expect(evidence.enrich([{codebase_id:foreign,path:'src/main.ts'}])).rejects.toThrow(/scope|authorized|Codebase/i);
  for(const path of ['/etc/passwd','../outside','src/../main.ts','src\\main.ts','.git/HEAD','src//main.ts','./src/main.ts','src/\u0000main.ts','C:/main.ts'])await expect(evidence.enrich([{codebase_id:codebase,path}])).rejects.toThrow();
  const forged={...f.prepared,workspace:{...f.prepared.workspace,codebases:[{...f.prepared.workspace.codebases[0],id:foreign}]}};
  await expect((await resolver(async()=>forged)).enrich([{codebase_id:codebase,path:'src/main.ts'}])).rejects.toThrow();
 }finally{await f.cleanup();}
});

test('source reads reject links, nonregular files, hard links and linked checkout ancestors',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,'outside'),'outside');await symlink(join(f.root,'outside'),join(f.checkout,'linked'));await symlink(f.root,join(f.checkout,'linked-dir'));
  await link(join(f.checkout,'src','main.ts'),join(f.checkout,'hard'));await mkdir(join(f.checkout,'directory'));
  const evidence=await resolver(async()=>f.prepared);
  for(const path of ['linked','linked-dir/outside','hard','src/main.ts','directory'])await expect(evidence.enrich([{codebase_id:codebase,path}])).rejects.toThrow();
  await symlink(f.checkout,join(f.root,'alias'));const alias={...f.prepared,workspace:{...f.prepared.workspace,codebases:[{...f.prepared.workspace.codebases[0],checkout_path:join(f.root,'alias'),repository_path:join(f.root,'alias')}]}};
  await expect((await resolver(async()=>alias)).enrich([{codebase_id:codebase,path:'src/main.ts'}])).rejects.toThrow();
 }finally{await f.cleanup();}
});

test('scoped checkout sources use assignment pin without following Git metadata outside its checkout',async()=>{
 const f=await fixture();try{
  const scoped={...f.prepared,assignments:[{...f.prepared.assignments[0],root_path:'src'}],workspace:{...f.prepared.workspace,codebases:[{...f.prepared.workspace.codebases[0],checkout_path:join(f.checkout,'src')}]} ,read:[join(f.checkout,'src')]};
  const sources=await (await resolver(async()=>scoped)).enrich([{codebase_id:codebase,path:'main.ts'}]);
  expect(sources).toEqual([{codebase_id:codebase,path:'main.ts',commit_sha:base,content_sha256:sha('export const value = 1;\n')}]);
 }finally{await f.cleanup();}
});

test.each(['HEAD','metadata'] as const)('whole checkout source enrichment rejects missing Git %s instead of recording an assignment pin',async missing=>{
 const f=await fixture();try{
  if(missing==='HEAD')await rm(join(f.checkout,'.git','HEAD'));else await rm(join(f.checkout,'.git'),{recursive:true});
  await expect((await resolver(async()=>f.prepared)).enrich([{codebase_id:codebase,path:'src/main.ts'}])).rejects.toThrow();
 }finally{await f.cleanup();}
});

test('source enrichment rejects files changed during descriptor reads',async()=>{
 const f=await fixture();try{
  const file=join(f.checkout,'src','main.ts');await writeFile(file,'x'.repeat(200000));const before=statSync(file,{bigint:true}).atimeNs;let changed=false;
  const evidence=await resolver(async()=>f.prepared,()=>{if(!changed&&statSync(file,{bigint:true}).atimeNs!==before){changed=true;writeFileSync(file,'y'.repeat(200000));}});
  await expect(evidence.enrich([{codebase_id:codebase,path:'src/main.ts'}])).rejects.toThrow(/changed|identity/i);
  expect(changed).toBe(true);
 }finally{await f.cleanup();}
});

test('source enrichment rechecks live authority after delayed resource lookup',async()=>{
 const f=await fixture();try{
  let release!:(value:PreparedNativeCodebases)=>void,authorized=true;
  const prepared=new Promise<PreparedNativeCodebases>(resolve=>release=resolve),evidence=await resolver(()=>prepared,()=>{if(!authorized)throw Error('authority revoked');});
  const pending=evidence.enrich([{codebase_id:codebase,path:'src/main.ts'}]);authorized=false;release(f.prepared);
  await expect(pending).rejects.toThrow(/authority/i);
 }finally{await f.cleanup();}
});

test('business notes without sources do not require a Codebase and reference reads preserve source pointers',async()=>{
 const empty=await resolver(async()=>{throw Error('no Codebase');},()=>{},[]);
 await expect(empty.verify(readResult([],'business'))).resolves.toBeUndefined();await expect(empty.enrich([])).resolves.toEqual([]);
 const f=await fixture();try{
  const evidence=await resolver(async()=>f.prepared),sources=await evidence.enrich([{codebase_id:codebase,path:'src/main.ts'}]),result=readResult(sources,'reference','');
  await evidence.verify(result);expect(result.body).toBe('');expect(result.entry.sources).toEqual(sources);
 }finally{await f.cleanup();}
});
