import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),'ci-signing-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));const root=join(parent,'repo'),temporary=join(parent,'temp');mkdirSync(root);mkdirSync(temporary);mkdirSync(join(root,'scripts'));
 const script=resolve('scripts/prepare-signed-computer-release.mjs');if(existsSync(script))cpSync(script,join(root,'scripts/prepare-signed-computer-release.mjs'));
 const keys=generateKeyPairSync('ed25519'),pem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();writeFileSync(join(root,'release-public-key.pem'),keys.publicKey.export({format:'pem',type:'spki'}));mkdirSync(join(root,'scripts/templates'));writeFileSync(join(root,'scripts/templates/install-github-computer.sh'),keys.publicKey.export({format:'pem',type:'spki'}));
 writeFileSync(join(root,'scripts/prepare-computer-release.mjs'),`import {readFileSync,writeFileSync,statSync} from 'node:fs';import {createPrivateKey,sign} from 'node:crypto';const keyPath=process.argv[process.argv.indexOf('--key')+1];if(process.env.LUOSHU_RELEASE_SIGNING_KEY)throw Error('secret leaked to build environment');if(keyPath.startsWith(process.cwd()+'/'))throw Error('key was written in repository');if((statSync(keyPath).mode&0o777)!==0o600)throw Error('private key mode');writeFileSync('manifest.sig',sign(null,Buffer.from('verified manifest'),createPrivateKey(readFileSync(keyPath))));`);
 const run=(secret=pem)=>spawnSync(process.execPath,[join(root,'scripts/prepare-signed-computer-release.mjs')],{cwd:root,encoding:'utf8',env:{...process.env,TMPDIR:temporary,LUOSHU_RELEASE_SIGNING_KEY:secret}});
 return{root,temporary,keys,pem,run};
}
test('CI signing uses its Secret outside the source tree and cleans temporary private material',t=>{
 const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(verify(null,Buffer.from('verified manifest'),f.keys.publicKey,readFileSync(join(f.root,'manifest.sig'))),true);assert.deepEqual(readdirSync(f.temporary),[]);assert.equal((result.stdout+result.stderr).includes(f.pem),false);
});
test('CI signing rejects a missing Secret instead of publishing an unsigned fallback',t=>{
 const f=fixture(t),r=f.run('');assert.notEqual(r.status,0);assert.match(r.stderr,/LUOSHU_RELEASE_SIGNING_KEY/);assert.equal(existsSync(join(f.root,'manifest.sig')),false);assert.deepEqual(readdirSync(f.temporary),[]);
});
test('CI signing rejects a Secret that does not match the pinned public key',t=>{
 const f=fixture(t),wrong=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString(),r=f.run(wrong);assert.notEqual(r.status,0);assert.match(r.stderr,/match|public key/i);assert.equal(existsSync(join(f.root,'manifest.sig')),false);assert.equal(r.stderr.includes(wrong),false);assert.deepEqual(readdirSync(f.temporary),[]);
});

test('CI signing refuses to publish when the installer still pins a different key',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'scripts/templates/install-github-computer.sh'),generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}));const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/installer|public key/i);assert.equal(existsSync(join(f.root,'manifest.sig')),false);assert.deepEqual(readdirSync(f.temporary),[]);
});

test('CI signing cleans its temporary key even when release preparation fails',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'scripts/prepare-computer-release.mjs'),"throw Error('Build failed');");const r=f.run();assert.notEqual(r.status,0);assert.deepEqual(readdirSync(f.temporary),[]);assert.equal(r.stderr.includes(f.pem),false);
});
