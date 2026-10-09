import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'github-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const home=join(root,'home'),assets=join(root,'assets'),bin=join(root,'bin');for(const dir of [home,assets,bin])mkdirSync(dir);
 const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'installed.txt'),'signed computer');
 const archive=join(assets,'luoshu-computer-0.1.0-linux-x64.tar.gz');execFileSync('tar',['-czf',archive,'-C',source,'.']);const bytes=readFileSync(archive);
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString(),keyPath=join(root,'public.pem');writeFileSync(keyPath,publicKey);
 const manifest=Buffer.from(JSON.stringify({version:'0.1.0',protocol_version:8,releases:{'linux-x64':{path:'/computer/releases/0.1.0/linux-x64.tar.gz',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}},null,2)+'\n');
 writeFileSync(join(assets,'manifest.json'),manifest);writeFileSync(join(assets,'manifest.sig'),sign(null,manifest,keys.privateKey));
 writeFileSync(join(assets,'release.json'),JSON.stringify({version:'0.1.0'},null,2));writeFileSync(join(assets,'install.sh'),'unused');
 const sums=()=>writeFileSync(join(assets,'SHA256SUMS'),['manifest.json','manifest.sig','install.sh','luoshu-computer-0.1.0-linux-x64.tar.gz'].map(name=>createHash('sha256').update(readFileSync(join(assets,name))).digest('hex')+'  '+name+'\n').join(''));sums();
 writeFileSync(join(bin,'curl'),`#!/usr/bin/env node\nconst fs=require('fs'),path=require('path'),args=process.argv.slice(2),url=args.find(a=>a.startsWith('https://'));fs.appendFileSync(process.env.INSTALL_REQUESTS,url+'\\n');const name=url.includes('/releases/latest')?'latest.json':path.basename(url);const file=path.join(process.env.INSTALL_ASSETS,name);if(!fs.existsSync(file))process.exit(22);fs.copyFileSync(file,args[args.indexOf('-o')+1]);\n`,{mode:0o755});
 writeFileSync(join(assets,'latest.json'),JSON.stringify({tag_name:'v0.1.0',draft:false,prerelease:false}));
 const log=join(root,'requests'),run=()=>spawnSync('sh',[resolve('scripts/templates/install-github-computer.sh')],{env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH,LUOSHU_RELEASE_TAG:'v0.1.0',LUOSHU_RELEASE_KEY:keyPath,INSTALL_ASSETS:assets,INSTALL_REQUESTS:log},encoding:'utf8'});
 return{root,home,assets,keys,manifest,publicKey,keyPath,sums,run,log,current:join(home,'.local/share/luoshu-computer/current')};
}

test('GitHub bootstrap installs a signed archive and pins the verified source for subsequent updates',t=>{
 const f=fixture(t),r=f.run();assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(f.current,'installed.txt'),'utf8'),'signed computer');
 assert.deepEqual(JSON.parse(readFileSync(join(f.home,'.local/share/luoshu-computer/release-source.json'),'utf8')),{repository:'NeuraPawLabs/luoshu-computer',public_key:f.publicKey});
 const receipt=JSON.parse(readFileSync(join(f.current,'.luoshu-release.json')));assert.equal(receipt.sha256,createHash('sha256').update(readFileSync(join(f.assets,'luoshu-computer-0.1.0-linux-x64.tar.gz'))).digest('hex'));
});
for(const mutation of ['signature','manifest','wrong-key','missing-signature','protocol','archive'])test(`GitHub bootstrap rejects ${mutation} before activating a version`,t=>{
 const f=fixture(t);
 if(mutation==='signature')writeFileSync(join(f.assets,'manifest.sig'),Buffer.alloc(64));
 if(mutation==='manifest')writeFileSync(join(f.assets,'manifest.json'),f.manifest.toString().replace('0.1.0','0.2.0'));
 if(mutation==='wrong-key')writeFileSync(f.keyPath,generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}));
 if(mutation==='missing-signature')rmSync(join(f.assets,'manifest.sig'));
 if(mutation==='protocol'){const m=Buffer.from(f.manifest.toString().replace('"protocol_version": 8','"protocol_version": 7'));writeFileSync(join(f.assets,'manifest.json'),m);writeFileSync(join(f.assets,'manifest.sig'),sign(null,m,f.keys.privateKey));}
 if(mutation==='archive')writeFileSync(join(f.assets,'luoshu-computer-0.1.0-linux-x64.tar.gz'),'tampered');
 if(mutation!=='missing-signature')f.sums();
 const result=f.run();assert.notEqual(result.status,0,`accepted ${mutation}: ${result.stdout}`);assert.equal(existsSync(f.current),false);
 if(mutation!=='archive')assert.equal(readFileSync(f.log,'utf8').includes('linux-x64.tar.gz'),false,'archive must not download before manifest validation');
});

test('GitHub bootstrap preserves the installed version and device identity when verification fails',t=>{
 const f=fixture(t);assert.equal(f.run().status,0);const state=join(f.home,'.local/share/luoshu-computer/state');mkdirSync(state);writeFileSync(join(state,'identity.json'),'existing identity');
 writeFileSync(join(f.assets,'manifest.sig'),Buffer.alloc(64));f.sums();assert.notEqual(f.run().status,0);
 assert.equal(readFileSync(join(f.current,'installed.txt'),'utf8'),'signed computer');assert.equal(readFileSync(join(state,'identity.json'),'utf8'),'existing identity');
});
