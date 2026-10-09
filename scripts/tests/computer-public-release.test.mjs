import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const project=resolve(import.meta.dirname,'../..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const mit='MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction.\n';
function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),'computer-public-release-')),root=join(parent,'source');
 mkdirSync(root);t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const put=(path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
 for(const name of ['prepare-computer-release.mjs','computer-release.mjs']){
  const source=join(project,'scripts',name);if(existsSync(source)){mkdirSync(join(root,'scripts'),{recursive:true});cpSync(source,join(root,'scripts',name));}
 }
 symlinkSync(join(project,'node_modules'),join(root,'node_modules'),'dir');
 put('.gitignore','node_modules\ndist/\n');put('LICENSE',mit);
 put('package.json',JSON.stringify({name:'luoshu-computer-source',version:'0.1.6',license:'MIT',type:'module',scripts:{build:'node scripts/package-runtime.mjs',package:'node scripts/package-computer.mjs'}}));
 put('apps/worker/package.json',JSON.stringify({version:'0.1.6',license:'MIT'}));
 put('apps/worker/src/example.ts','export const publicValue = 42;\n');
 put('scripts/templates/install-github-computer.sh','#!/bin/sh\necho verified-github-bootstrap\n');
 put('source-export.json',JSON.stringify({format:'luoshu-computer-source-v1',upstream:{commit:'a'.repeat(40)}})+'\n');
 const archive=Buffer.from('built:export const publicValue = 42;\n');put('dist/computer/releases/0.1.6/linux-x64.tar.gz',archive);
 const manifest=Buffer.from(JSON.stringify({version:'0.1.6',protocol_version:8,releases:{'linux-x64':{path:'/computer/releases/0.1.6/linux-x64.tar.gz',sha256:digest(archive),size:archive.length}}},null,2)+'\n');
 put('dist/computer/manifest.json',manifest);put('dist/computer/install.sh','#!/bin/sh\necho install\n');
 put('scripts/package-runtime.mjs',`import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
mkdirSync('dist',{recursive:true});writeFileSync('dist/current-build.txt','built:'+readFileSync('apps/worker/src/example.ts','utf8'));
`);
 put('scripts/package-computer.mjs',`import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const archive=readFileSync('dist/current-build.txt');mkdirSync('dist/computer/releases/0.1.6',{recursive:true});
writeFileSync('dist/computer/releases/0.1.6/linux-x64.tar.gz',archive);
writeFileSync('dist/computer/manifest.json',JSON.stringify({version:'0.1.6',protocol_version:8,releases:{'linux-x64':{path:'/computer/releases/0.1.6/linux-x64.tar.gz',sha256:createHash('sha256').update(archive).digest('hex'),size:archive.length}}},null,2)+'\\n');
writeFileSync('dist/computer/install.sh','#!/bin/sh\\necho install\\n');
`);

 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','--quiet','--initial-branch=main');git('config','user.name','Release fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','--quiet','-m','Public source');git('tag','v0.1.6');
 const output=join(root,'dist/release-bundle');
 const run=(...args)=>spawnSync(process.execPath,[join(root,'scripts/prepare-computer-release.mjs'),...args],{cwd:root,encoding:'utf8'});
 return{parent,root,output,put,git,run,archive,manifest};
}
function success(result){assert.equal(result.status,0,result.stderr||result.stdout);}
function failure(result,pattern){assert.notEqual(result.status,0);assert.match(result.stderr,pattern);}

test('unsigned release snapshots exactly tracked public source and checksums original artifact bytes',t=>{
 const f=fixture(t);success(f.run());
 const release=JSON.parse(readFileSync(join(f.output,'release.json')));
 assert.equal(release.version,'0.1.6');assert.equal(release.tag,'v0.1.6');assert.equal(release.commit,f.git('rev-parse','HEAD'));assert.equal(release.protocol_version,8);assert.equal(release.prerelease,true);assert.equal(release.signature,'none');
 assert.deepEqual(readFileSync(join(f.output,'manifest.json')),f.manifest);assert.deepEqual(readFileSync(join(f.output,'luoshu-computer-0.1.6-linux-x64.tar.gz')),f.archive);
 assert.equal(existsSync(join(f.output,'manifest.sig')),false);
 assert.equal(readFileSync(join(f.output,'install.sh'),'utf8'),'#!/bin/sh\necho verified-github-bootstrap\n');
 const archive=join(f.output,'luoshu-computer-source-0.1.6.tar.gz');
 const unpack=join(f.parent,'unpacked');mkdirSync(unpack);execFileSync('tar',['-xzf',archive,'-C',unpack]);
 const prefix='luoshu-computer-0.1.6/';
 const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n').filter(path=>!path.endsWith('/')).map(path=>path.slice(prefix.length)).sort();
 assert.deepEqual(entries,f.git('ls-files').split('\n').sort());
 for(const path of entries)assert.deepEqual(readFileSync(join(unpack,prefix,path)),execFileSync('git',['show',`HEAD:${path}`],{cwd:f.root}));
 const sums=readFileSync(join(f.output,'SHA256SUMS'),'utf8');
 for(const artifact of release.artifacts){const bytes=readFileSync(join(f.output,artifact.name));assert.equal(bytes.length,artifact.size);assert.equal(digest(bytes),artifact.sha256);assert.ok(sums.includes(`${artifact.sha256}  ${artifact.name}\n`));}
 assert.equal(release.artifacts.some(artifact=>artifact.name==='manifest.sig'),false);
});

test('release rejects tracked edits and relevant untracked source without creating output',t=>{
 const f=fixture(t);f.put('apps/worker/src/example.ts','changed');failure(f.run(),/clean|dirty/i);assert.equal(existsSync(f.output),false);
 f.git('checkout','--','apps/worker/src/example.ts');f.put('apps/worker/src/new.ts','untracked');failure(f.run(),/clean|dirty/i);assert.equal(existsSync(f.output),false);
});
test('release requires the exact version tag to point at HEAD',t=>{
 const f=fixture(t);f.put('apps/worker/src/example.ts','new revision');f.git('add','.');f.git('commit','--quiet','-m','Later commit');failure(f.run(),/tag|HEAD/i);assert.equal(existsSync(f.output),false);
});
test('release rejects mismatched root version and corrupt freshly packaged archives',t=>{
 const f=fixture(t);f.put('package.json',JSON.stringify({name:'luoshu-computer-source',version:'0.1.5',license:'MIT',type:'module'}));f.git('add','.');f.git('commit','--quiet','-m','Mismatch');f.git('tag','-f','v0.1.6');failure(f.run(),/version/i);
 f.git('checkout','HEAD~1','--','package.json');f.git('add','.');f.git('commit','--quiet','-m','Restore');f.git('tag','-f','v0.1.6');f.put('scripts/package-computer.mjs',readFileSync(join(f.root,'scripts/package-computer.mjs'),'utf8')+"\nwriteFileSync('dist/computer/releases/0.1.6/linux-x64.tar.gz','bad archive');\n");f.git('add','.');f.git('commit','--quiet','-m','Broken packaging');f.git('tag','-f','v0.1.6');failure(f.run(),/size|SHA-256|changed/i);
});
test('unsigned rerun drops stale signatures from both mirror and prior signed output',t=>{
 const f=fixture(t),keys=generateKeyPairSync('ed25519'),key=join(f.parent,'private.pem');writeFileSync(key,keys.privateKey.export({format:'pem',type:'pkcs8'}));
 success(f.run('--key',key));const signed=JSON.parse(readFileSync(join(f.output,'release.json')));assert.equal(signed.signature,'ed25519');assert.equal(signed.prerelease,false);assert.ok(signed.artifacts.some(artifact=>artifact.name==='manifest.sig'));assert.equal(existsSync(join(f.output,'private.pem')),false);assert.equal(verify(null,f.manifest,keys.publicKey,readFileSync(join(f.output,'manifest.sig'))),true);
 f.put('dist/computer/manifest.sig',Buffer.alloc(64,1));success(f.run());assert.equal(existsSync(join(f.output,'manifest.sig')),false);assert.equal(JSON.parse(readFileSync(join(f.output,'release.json'))).signature,'none');assert.doesNotMatch(readFileSync(join(f.output,'SHA256SUMS'),'utf8'),/manifest.sig/);
});
test('release refuses source, Git and unrelated nonempty output directories without mutation',t=>{
 const f=fixture(t);for(const output of [f.root,join(f.root,'apps/worker/release'),join(f.root,'packages/release'),join(f.root,'.git/release')])failure(f.run('--output',output),/output|unsafe|Git/i);
 const unrelated=join(f.parent,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep.txt'),'keep');failure(f.run('--output',unrelated),/output|replace|directory/i);assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'keep');
 const repository=join(f.parent,'repository');mkdirSync(repository);mkdirSync(join(repository,'.git'));failure(f.run('--output',repository),/Git|output/i);assert.ok(existsSync(join(repository,'.git')));
});
test('release refuses signing keys in repository or public output and non-Ed25519 keys',t=>{
 const f=fixture(t),keys=generateKeyPairSync('ed25519'),pem=keys.privateKey.export({format:'pem',type:'pkcs8'});f.put('dist/private.pem',pem);failure(f.run('--key',join(f.root,'dist/private.pem')),/private|outside|external/i);
 const key=join(f.parent,'private.pem');writeFileSync(key,generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}));failure(f.run('--key',key),/Ed25519/i);assert.equal(existsSync(f.output),false);
 const output=join(f.parent,'output');mkdirSync(output);writeFileSync(join(output,'private.pem'),pem);failure(f.run('--output',output,'--key',join(output,'private.pem')),/private|outside|external|output/i);assert.equal(readFileSync(join(output,'private.pem'),'utf8'),pem);
});
test('release refuses private source and missing MIT license before archiving',t=>{
 const f=fixture(t);f.put('apps/core/src/private.ts','private');f.git('add','.');f.git('commit','--quiet','-m','Private');f.git('tag','-f','v0.1.6');failure(f.run(),/source|public|Core|whitelist/i);assert.equal(existsSync(f.output),false);
 f.git('rm','-r','apps/core');f.put('apps/worker/src/secret.ts','-----BEGIN PRIVATE KEY-----\nsecret');f.git('add','.');f.git('commit','--quiet','-m','Private key');f.git('tag','-f','v0.1.6');failure(f.run(),/private|key/i);
 f.git('rm','apps/worker/src/secret.ts');f.put('LICENSE','All rights reserved');f.git('add','.');f.git('commit','--quiet','-m','Wrong license');f.git('tag','-f','v0.1.6');failure(f.run(),/MIT|LICENSE/i);
});

test('local Git export attributes cannot omit or rewrite tracked source bytes',t=>{
 const f=fixture(t);mkdirSync(join(f.root,'.git/info'),{recursive:true});writeFileSync(join(f.root,'.git/info/attributes'),'apps/worker/src/example.ts export-ignore\nsource-export.json export-ignore\n');
 success(f.run());const source=join(f.output,'luoshu-computer-source-0.1.6.tar.gz');
 const paths=execFileSync('tar',['-tzf',source],{encoding:'utf8'});
 assert.ok(paths.includes('luoshu-computer-0.1.6/apps/worker/src/example.ts\n'));
 assert.ok(paths.includes('luoshu-computer-0.1.6/source-export.json\n'));
});

test('public test fixtures may mention private-key headers without containing an actual key',t=>{
 const f=fixture(t);f.put('scripts/tests/computer-public-release.test.mjs',"const header = '-----BEGIN PRIVATE KEY-----';\n");f.git('add','.');f.git('commit','--quiet','-m','Public fixture');f.git('tag','-f','v0.1.6');success(f.run());
});
test('source snapshot requires tracked export provenance from a clean upstream commit',t=>{
 const f=fixture(t);f.git('rm','source-export.json');f.git('commit','--quiet','-m','Missing provenance');f.git('tag','-f','v0.1.6');failure(f.run(),/provenance|source-export/i);
 f.put('source-export.json',JSON.stringify({format:'luoshu-computer-source-v1',upstream:{commit:'a'.repeat(40),dirty:true}}));f.git('add','.');f.git('commit','--quiet','-m','Dirty provenance');f.git('tag','-f','v0.1.6');failure(f.run(),/provenance|upstream|clean/i);
});


test('release rebuilds stale same-version binaries from the tagged source',t=>{
 const f=fixture(t),stale=Buffer.from('stale binary from unrelated source');
 f.put('dist/computer/releases/0.1.6/linux-x64.tar.gz',stale);
 f.put('dist/computer/manifest.json',JSON.stringify({version:'0.1.6',protocol_version:8,releases:{'linux-x64':{path:'/computer/releases/0.1.6/linux-x64.tar.gz',sha256:digest(stale),size:stale.length}}}));
 success(f.run());assert.deepEqual(readFileSync(join(f.output,'luoshu-computer-0.1.6-linux-x64.tar.gz')),f.archive);
 const release=JSON.parse(readFileSync(join(f.output,'release.json')));assert.equal(release.artifacts.find(artifact=>artifact.name==='luoshu-computer-0.1.6-linux-x64.tar.gz').sha256,digest(f.archive));
});
test('release aborts failed builds before producing bundle files',t=>{
 const f=fixture(t);f.put('scripts/package-runtime.mjs',"throw Error('fixture build failure');\n");f.git('add','.');f.git('commit','--quiet','-m','Failing build');f.git('tag','-f','v0.1.6');failure(f.run(),/build|fixture/i);assert.equal(existsSync(f.output),false);
});
test('release rejects source changes caused by build scripts',t=>{
 const f=fixture(t);f.put('scripts/package-runtime.mjs',readFileSync(join(f.root,'scripts/package-runtime.mjs'),'utf8')+"\nwriteFileSync('apps/worker/src/example.ts','changed during build');\n");f.git('add','.');f.git('commit','--quiet','-m','Mutating build');f.git('tag','-f','v0.1.6');failure(f.run(),/Git|tree|clean|changed/i);assert.equal(existsSync(f.output),false);
});

test('release rejects source edits hidden from Git status by assume-unchanged',t=>{
 const f=fixture(t);f.git('update-index','--assume-unchanged','apps/worker/src/example.ts');f.put('apps/worker/src/example.ts','hidden source change');assert.equal(f.git('status','--porcelain'),'');failure(f.run(),/source|changed|Git|tree/i);assert.equal(existsSync(f.output),false);
});
