import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {expect,test} from 'vitest';
import {fetchComputerRelease} from '../src/computer/releases.js';
import {validateWorkerConfig} from '../src/environment.js';

function fixture(){
 const keys=generateKeyPairSync('ed25519'),archive=Buffer.from('GitHub signed archive');
 const manifest=Buffer.from(JSON.stringify({version:'0.2.0',protocol_version:8,releases:{'linux-x64':{path:'/computer/releases/0.2.0/linux-x64.tar.gz',size:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}}}));
 const config={worker_id:'worker_1',name:'desk',capacity:1,url:'https://core.test',release_repository:'NeuraPawLabs/luoshu-computer',release_public_key:keys.publicKey.export({format:'pem',type:'spki'}).toString()};
 const base='https://github.com/NeuraPawLabs/luoshu-computer/releases/download/v0.2.0/',requests:string[]=[],bodies=new Map<string,Uint8Array>([[base+'manifest.json',manifest],[base+'manifest.sig',sign(null,manifest,keys.privateKey)],[base+'luoshu-computer-0.2.0-linux-x64.tar.gz',archive]]);
 const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);requests.push(url);expect(init?.redirect).toBe('manual');if(url==='https://api.github.com/repos/NeuraPawLabs/luoshu-computer/releases/latest')return Response.json({tag_name:'v0.2.0',draft:false,prerelease:false});const body=bodies.get(url);return body?new Response(body):new Response(null,{status:404});};
 return{keys,archive,manifest,config,base,requests,bodies,fetchImpl};
}
test('signed GitHub updates use the latest formal release and verify its bytes without contacting Core',async()=>{
 const f=fixture();expect(validateWorkerConfig(f.config)).toEqual(f.config);const r=await fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl});expect(await r.download()).toEqual(new Uint8Array(f.archive));expect(f.requests).toEqual(['https://api.github.com/repos/NeuraPawLabs/luoshu-computer/releases/latest',f.base+'manifest.json',f.base+'manifest.sig',f.base+'luoshu-computer-0.2.0-linux-x64.tar.gz']);
});
test('signed GitHub updates reject modified manifests before fetching an archive',async()=>{
 const f=fixture();f.bodies.set(f.base+'manifest.json',Buffer.from(f.manifest.toString().replace('0.2.0','0.3.0')));await expect(fetchComputerRelease(f.config,{fetchImpl:f.fetchImpl})).rejects.toThrow(/signature/i);expect(f.requests.some(u=>u.endsWith('.tar.gz'))).toBe(false);
});
test('GitHub assets accept the official CDN redirect and still check archive size and digest',async()=>{
 const f=fixture(),fetchImpl:typeof fetch=async(input,init)=>String(input)===f.base+'manifest.json'?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/github-production-release-asset/file?token=public'}}):String(input).startsWith('https://release-assets.githubusercontent.com/')?new Response(f.manifest):f.fetchImpl(input,init);
 const r=await fetchComputerRelease(f.config,{fetchImpl});expect(await r.download()).toEqual(new Uint8Array(f.archive));
});
test.each(['http://release-assets.githubusercontent.com/a','https://attacker.test/a','https://github.com/elsewhere/a','https://user:pass@release-assets.githubusercontent.com/a'])('GitHub updates reject unsafe redirect %s',async location=>{
 const f=fixture();const fetchImpl:typeof fetch=async(input,init)=>String(input)===f.base+'manifest.json'?new Response(null,{status:302,headers:{location}}):f.fetchImpl(input,init);await expect(fetchComputerRelease(f.config,{fetchImpl})).rejects.toThrow(/redirect|HTTPS/i);
});
test.each(['../repo','owner/repo?token=abc','owner/repo/extra','https://github.com/owner/repo'])('rejects invalid repository %s before network access',async release_repository=>{
 const f=fixture(),config={...f.config,release_repository};expect(()=>validateWorkerConfig(config)).toThrow();await expect(fetchComputerRelease(config,{fetchImpl:f.fetchImpl})).rejects.toThrow();expect(f.requests).toEqual([]);
});
test('GitHub source requires a pinned key and cannot also select a static feed',()=>{
 const f=fixture(),{release_public_key:_,...noKey}=f.config;expect(()=>validateWorkerConfig(noKey)).toThrow();expect(()=>validateWorkerConfig({...f.config,release_url:'https://downloads.test/computer'})).toThrow();
});
test.each([{tag_name:'v0.2.0',draft:false,prerelease:true},{tag_name:'v0.2.0',draft:true,prerelease:false},{tag_name:'../../bad',draft:false,prerelease:false}])('rejects invalid or preview GitHub release %j',async info=>{
 const f=fixture();await expect(fetchComputerRelease(f.config,{fetchImpl:async()=>Response.json(info)})).rejects.toThrow(/release|tag/i);
});
