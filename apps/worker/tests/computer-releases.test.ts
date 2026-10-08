import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {expect, test} from 'vitest';
import {PROTOCOL_VERSION} from '@luoshu/protocol';
import {fetchComputerRelease} from '../src/computer/releases.js';
import {validateWorkerConfig} from '../src/environment.js';

function fixture(change: Record<string, unknown> = {}) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({type:'spki',format:'pem'}).toString();
  const archive = Buffer.from('a verified release archive');
  const manifest = {version:'0.2.0', protocol_version:PROTOCOL_VERSION, releases:{'linux-x64':{
    path:'/computer/releases/0.2.0/linux-x64.tar.gz', sha256:createHash('sha256').update(archive).digest('hex'), size:archive.length,
  }}, ...change};
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2)+'\n');
  const bodies = new Map<string, Uint8Array>([
    ['https://downloads.test/computer/manifest.json', bytes],
    ['https://downloads.test/computer/manifest.sig', sign(null,bytes,keys.privateKey)],
    ['https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz', archive],
  ]);
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    expect(init?.redirect).toBe('error');
    const url=String(input); requests.push(url);
    const body=bodies.get(url);
    return body ? new Response(Buffer.from(body)) : new Response('missing',{status:404});
  };
  const config={worker_id:'worker_1',url:'https://core.test',name:'desk',capacity:1,release_url:'https://downloads.test/computer',release_public_key:publicKey};
  return {keys,archive,manifest,bytes,bodies,requests,fetchImpl,config};
}

test('verifies exact signed manifest bytes and returns a checked archive download',async()=>{
  const f=fixture(), release=await fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl});
  expect(release.manifest).toEqual(f.manifest);
  expect(f.requests).toEqual(['https://downloads.test/computer/manifest.json','https://downloads.test/computer/manifest.sig']);
  expect(await release.download()).toEqual(new Uint8Array(f.archive));
});

test('rejects altered manifest bytes even when JSON contents are identical',async()=>{
  const f=fixture();f.bodies.set('https://downloads.test/computer/manifest.json',Buffer.from(JSON.stringify(f.manifest)));
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/signature/i);
});

test('rejects a manifest signed by another key',async()=>{
  const f=fixture();f.config.release_public_key=fixture().config.release_public_key;
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/signature/i);
});

test('rejects signatures with the wrong raw byte length',async()=>{
  const f=fixture();f.bodies.set('https://downloads.test/computer/manifest.sig',Buffer.alloc(63));
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/signature/i);
});

test('rejects incompatible protocols before downloading the archive',async()=>{
  const f=fixture({protocol_version:PROTOCOL_VERSION+1});
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/protocol/i);
  expect(f.requests).not.toContain('https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz');
});

test('rejects unsupported release platforms',async()=>{
  const f=fixture({releases:{'darwin-arm64':{path:'/computer/release.tar.gz',sha256:'a'.repeat(64),size:1}}});
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/Linux x64|platform/i);
});

test.each(['https://other.test/computer/release.tar.gz','//other.test/computer/release.tar.gz','/elsewhere/release.tar.gz',
  '/computer-other/release.tar.gz','../release.tar.gz','/computer/releases/../release.tar.gz',
  '/computer/%2e%2e/release.tar.gz','/computer/releases%2f..%2fescape.tar.gz','/computer/release.tar.gz?secret=1',
  '/computer/release.tar.gz#fragment','/computer/release.tar.gz?','/computer/release.tar.gz#','/computer/release\\escape.tar.gz',
])('rejects unsafe archive path %s before archive download',async path=>{
  const original=fixture();const f=fixture({releases:{'linux-x64':{...original.manifest.releases['linux-x64'],path}}});
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/path|URL|origin/i);
  expect(f.requests).toHaveLength(2);
});

test.each(['manifest.json','manifest.sig','releases/0.2.0/linux-x64.tar.gz'])('rejects redirects of %s',async path=>{
  const f=fixture(),fetchImpl:typeof fetch=async(input,init)=>String(input).endsWith('/'+path)
    ? new Response(null,{status:302,headers:{location:'https://other.test/file'}}):f.fetchImpl(input,init);
  await expect((async()=>{const r=await fetchComputerRelease(f.config,{fetchImpl});await r.download();})()).rejects.toThrow(/redirect|302/i);
});

test('rejects an already followed redirect response',async()=>{
  const f=fixture();const response=new Response(f.bytes);Object.defineProperty(response,'redirected',{value:true});
  await expect(fetchComputerRelease(f.config,{fetchImpl:async()=>response})).rejects.toThrow(/redirect/i);
});

test('rejects archive byte count mismatch',async()=>{
  const f=fixture();f.bodies.set('https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz',Buffer.from('truncated'));
  const release=await fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl});
  await expect(release.download()).rejects.toThrow(/size|byte/i);
});

test('rejects archive digest mismatch even with the correct byte count',async()=>{
  const f=fixture();f.bodies.set('https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz',Buffer.alloc(f.archive.length));
  const release=await fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl});
  await expect(release.download()).rejects.toThrow(/SHA-256/i);
});

test.each([0,-1,1.5,'20'])('rejects invalid archive size %s',async size=>{
  const f=fixture({releases:{'linux-x64':{path:'release.tar.gz',sha256:'a'.repeat(64),size}}});
  await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/size/i);
});

test('legacy configuration reads the unsigned Core mirror and checks archive size and digest',async()=>{
  const f=fixture();const {release_url:_,release_public_key:__,...config}=f.config;
  const fetchImpl:typeof fetch=async(input,init)=>f.fetchImpl(String(input).replace('https://core.test','https://downloads.test'),init);
  const release=await fetchComputerRelease(config,{fetchImpl});expect(await release.download()).toEqual(new Uint8Array(f.archive));
  expect(f.requests).not.toContain('https://downloads.test/computer/manifest.sig');
});

test('local configuration requires the independent source and key together',()=>{
  const f=fixture();expect(validateWorkerConfig(f.config)).toEqual(f.config);
  const {release_public_key:_,...noKey}=f.config;const {release_url:__,...noUrl}=f.config;
  expect(()=>validateWorkerConfig(noKey)).toThrow(/together|key/i);expect(()=>validateWorkerConfig(noUrl)).toThrow(/together|URL/i);
});

test.each(['http://downloads.test/computer','file:///computer','ftp://localhost/computer','https://user:pass@downloads.test/computer',
  'https://downloads.test/computer?x=1','https://downloads.test/computer#part','https://downloads.test/computer?',
  'https://downloads.test/a/../computer','https://downloads.test/%2e%2e/computer',
])('rejects invalid independent feed URL %s',async release_url=>{
  const f=fixture(),config={...f.config,release_url};
  expect(()=>validateWorkerConfig(config)).toThrow();
  await expect(fetchComputerRelease(config,{fetchImpl:f.fetchImpl})).rejects.toThrow();expect(f.requests).toEqual([]);
});

test.each(['http://127.0.0.1:8080/computer','http://localhost:8080/computer','http://[::1]:8080/computer'])('accepts loopback HTTP feed %s',release_url=>{
  expect(validateWorkerConfig({...fixture().config,release_url}).release_url).toBe(release_url);
});

test('rejects non-Ed25519 public keys',()=>{
  const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
  expect(()=>validateWorkerConfig({...fixture().config,release_public_key:publicKey})).toThrow(/Ed25519/i);
});

test('cancels an oversized archive stream instead of reading the unbounded response',async()=>{
 const f=fixture();let cancelled=false;
 const fetchImpl:typeof fetch=async(input,init)=>String(input).endsWith('.tar.gz') ? new Response(new ReadableStream({
  start(controller){controller.enqueue(new Uint8Array(f.archive.length+1));},cancel(){cancelled=true;},
 })) : f.fetchImpl(input,init);
 const release=await fetchComputerRelease(f.config,{fetchImpl});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await expect(Promise.race([release.download(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('unbounded read')),1000);})])).rejects.toThrow(/size/i);
  expect(cancelled).toBe(true);
 }finally{clearTimeout(timer);}
});

test.each(['https://core.test/luoshu','https://core.test/luoshu/'])('legacy Core base %s preserves its prefix for manifest and archive downloads',async url=>{
 const f=fixture();const {release_url:_,release_public_key:__,...legacy}=f.config;const requests:string[]=[];
 const fetchImpl:typeof fetch=async(input,init)=>{
  expect(init?.redirect).toBe('error');const request=String(input);requests.push(request);
  if(request==='https://core.test/luoshu/computer/manifest.json')return new Response(f.bytes);
  if(request==='https://core.test/luoshu/computer/releases/0.2.0/linux-x64.tar.gz')return new Response(f.archive);
  throw Error(`Unexpected legacy request: ${request}`);
 };
 const release=await fetchComputerRelease({...legacy,url},{fetchImpl});
 expect(await release.download()).toEqual(new Uint8Array(f.archive));
 expect(requests).toEqual(['https://core.test/luoshu/computer/manifest.json','https://core.test/luoshu/computer/releases/0.2.0/linux-x64.tar.gz']);
});
