import {createPrivateKey,createPublicKey} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const secret=process.env.LUOSHU_RELEASE_SIGNING_KEY;
delete process.env.LUOSHU_RELEASE_SIGNING_KEY;
if(!secret?.trim())throw Error('Configure the LUOSHU_RELEASE_SIGNING_KEY GitHub Actions Secret before releasing');
let key;
try{key=createPrivateKey(secret);}catch{throw Error('LUOSHU_RELEASE_SIGNING_KEY must be a PEM Ed25519 private key');}
if(key.asymmetricKeyType!=='ed25519')throw Error('Computer signing key must use Ed25519');
const pinned=createPublicKey(readFileSync(join(root,'release-public-key.pem')));
if(!createPublicKey(key).export({format:'der',type:'spki'}).equals(pinned.export({format:'der',type:'spki'})))throw Error('Signing Secret does not match the pinned release public key');
const installerKey=readFileSync(join(root,'scripts/templates/install-github-computer.sh'),'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
if(!installerKey||!createPublicKey(installerKey[0]).export({format:'der',type:'spki'}).equals(pinned.export({format:'der',type:'spki'})))throw Error('Installer public key does not match the signing public key');
const temporary=mkdtempSync(join(tmpdir(),'luoshu-release-signing-'));
try{
 const path=join(temporary,'private.pem');writeFileSync(path,key.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
 execFileSync(process.execPath,[join(root,'scripts/prepare-computer-release.mjs'),'--key',path],{cwd:root,stdio:'inherit',timeout:300_000});
}finally{rmSync(temporary,{recursive:true,force:true});}
