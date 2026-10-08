import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,verify} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PROTOCOL_VERSION} from '@luoshu/protocol';

test('signing authenticates the existing validated manifest and never copies the private key',()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-signing-'));
 try{
  const release=join(root,'release'),bytes=Buffer.from('archive');
  mkdirSync(join(release,'releases','0.1.6'),{recursive:true});
  writeFileSync(join(release,'install.sh'),'#!/bin/sh\n');writeFileSync(join(release,'releases','0.1.6','linux-x64.tar.gz'),bytes);
  const manifest=Buffer.from(JSON.stringify({version:'0.1.6',protocol_version:PROTOCOL_VERSION,releases:{'linux-x64':{path:'/computer/releases/0.1.6/linux-x64.tar.gz',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}})+'\n');
  writeFileSync(join(release,'manifest.json'),manifest);
  const keys=generateKeyPairSync('ed25519');const key=join(root,'private.pem');writeFileSync(key,keys.privateKey.export({format:'pem',type:'pkcs8'}));
  execFileSync(process.execPath,['scripts/sign-computer-release.mjs','--release',release,'--key',key],{stdio:'pipe'});
  const signature=readFileSync(join(release,'manifest.sig'));assert.equal(signature.length,64);assert.equal(verify(null,manifest,keys.publicKey,signature),true);
  assert.deepEqual(readFileSync(join(release,'manifest.json')),manifest);assert.equal(existsSync(join(release,'private.pem')),false);
  writeFileSync(join(release,'private.pem'),readFileSync(key));
  assert.throws(()=>execFileSync(process.execPath,['scripts/sign-computer-release.mjs','--release',release,'--key',join(release,'private.pem')],{stdio:'pipe'}));
  const alias=join(root,'key-alias.pem');symlinkSync(join(release,'private.pem'),alias);
  assert.throws(()=>execFileSync(process.execPath,['scripts/sign-computer-release.mjs','--release',release,'--key',alias],{stdio:'pipe'}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
