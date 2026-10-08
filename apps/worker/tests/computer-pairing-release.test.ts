import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {pairWorker} from '../src/client.js';
import {loadWorkerConfig} from '../src/environment.js';

test('pairing persists the local release source without sending it to Core or trusting Core replacements',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'release-pairing-'));try{
  const releasePublicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
  await pairWorker({stateDir,url:'https://core.test',name:'desk',code:'single-use',capacity:1,releaseUrl:'https://downloads.test/computer',releasePublicKey,
   codexPath:'/missing/codex',opencodePath:'/missing/opencode',fetchImpl:async(_input,init)=>{
    const payload=JSON.parse(String(init?.body));expect(payload).not.toHaveProperty('release_url');expect(JSON.stringify(payload)).not.toContain(releasePublicKey);
    return Response.json({worker_id:'worker_1',status:'pending',release_url:'https://attacker.test',release_public_key:'untrusted'});
   }});
  expect(await loadWorkerConfig(stateDir)).toMatchObject({release_url:'https://downloads.test/computer',release_public_key:releasePublicKey});
 }finally{await rm(stateDir,{recursive:true,force:true});}
});

test('pairing rejects invalid local release configuration before creating identity or contacting Core',async()=>{
 const root=await mkdtemp(join(tmpdir(),'release-pairing-invalid-')),stateDir=join(root,'absent');let requested=false;try{
  await expect(pairWorker({stateDir,url:'https://core.test',name:'desk',code:'single-use',capacity:1,releaseUrl:'https://downloads.test/computer',fetchImpl:async()=>{requested=true;throw Error('must not request');}})).rejects.toThrow(/together|key/i);
  expect(requested).toBe(false);const {access}=await import('node:fs/promises');await expect(access(stateDir)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
