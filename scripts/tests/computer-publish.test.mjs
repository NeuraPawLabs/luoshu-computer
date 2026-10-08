import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-publish-')),bundle=join(root,'bundle'),bin=join(root,'bin'),log=join(root,'calls.jsonl');mkdirSync(bundle);mkdirSync(bin);
 const bytes=Buffer.from('verified payload'),artifact='luoshu-computer-0.1.6-linux-x64.tar.gz',sha256=createHash('sha256').update(bytes).digest('hex');
 const names=[artifact,'luoshu-computer-source-0.1.6.tar.gz','manifest.json','install.sh'];
 const manifest={version:'0.1.6',tag:'v0.1.6',commit:'a'.repeat(40),protocol_version:8,prerelease:true,signature:'none',artifacts:names.map(name=>({name,size:bytes.length,sha256}))};
 for(const name of names)writeFileSync(join(bundle,name),bytes);
 writeFileSync(join(bundle,'SHA256SUMS'),names.map(name=>`${sha256}  ${name}\n`).join(''));writeFileSync(join(bundle,'release-notes.md'),'Unsigned Computer prerelease\n');writeFileSync(join(bundle,'release.json'),JSON.stringify(manifest));
 writeFileSync(join(bin,'gh'),`#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_GH_LOG,JSON.stringify(args)+'\\n');if(args[0]==='api')console.log(JSON.stringify(args[1].includes('/git/ref/')?{object:{type:'commit',sha:process.env.TEST_TAG_SHA||'a'.repeat(40)}}:{full_name:'NeuraPawLabs/luoshu-computer',private:false,permissions:{push:true}}));else if(args[0]==='release'&&args[1]==='view')process.exit(1);\n`,{mode:0o755});
 return{root,bundle,artifact,log,env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_GH_LOG:log,GH_REPO:'NeuraPawLabs/luoshu-computer'}};
}
test('publisher creates an unsigned prerelease using only validated explicit artifacts',()=>{
 const f=fixture();try{
  execFileSync(process.execPath,['scripts/publish-computer-release.mjs','--bundle',f.bundle],{env:f.env,stdio:'pipe'});
  const calls=readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse),create=calls.find(args=>args[0]==='release'&&args[1]==='create');
  assert.ok(create);assert.ok(create.includes('--prerelease'));assert.ok(create.includes('--verify-tag'));assert.ok(create.includes('--latest=false'));
  assert.ok(create.includes(join(f.bundle,f.artifact)));assert.ok(create.includes(join(f.bundle,'release.json')));assert.ok(create.includes(join(f.bundle,'SHA256SUMS')));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('publisher refuses a remote tag pointing to different source',()=>{
 const f=fixture();try{
  assert.throws(()=>execFileSync(process.execPath,['scripts/publish-computer-release.mjs','--bundle',f.bundle],{env:{...f.env,TEST_TAG_SHA:'b'.repeat(40)},stdio:'pipe'}),/tag|commit/i);
  assert.equal(readFileSync(f.log,'utf8').includes('"create"'),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
for(const mutation of ['digest','traversal','unsigned-latest','extra-file'])test(`publisher refuses ${mutation} before any GitHub call`,()=>{
 const f=fixture();try{
  const path=join(f.bundle,'release.json'),data=JSON.parse(readFileSync(path,'utf8'));
  if(mutation==='digest')writeFileSync(join(f.bundle,f.artifact),'tampered');
  if(mutation==='traversal')data.artifacts[0].name='../outside';
  if(mutation==='unsigned-latest')data.prerelease=false;
  if(mutation==='extra-file')writeFileSync(join(f.bundle,'private.pem'),'DO NOT UPLOAD');
  writeFileSync(path,JSON.stringify(data));
  assert.throws(()=>execFileSync(process.execPath,['scripts/publish-computer-release.mjs','--bundle',f.bundle],{env:f.env,stdio:'pipe'}));
  try{assert.equal(readFileSync(f.log,'utf8'),'');}catch(error){assert.equal(error.code,'ENOENT');}
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
