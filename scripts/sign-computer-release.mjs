import {readFileSync,writeFileSync,renameSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createPrivateKey,sign,randomUUID} from 'node:crypto';
import {validateComputerRelease} from './computer-release.mjs';

const args=process.argv.slice(2),options={};
for(let index=0;index<args.length;index+=2){
 const name=args[index];
 if(!['--release','--key'].includes(name)||!args[index+1]||Object.hasOwn(options,name))throw Error('Usage: sign-computer-release.mjs --release DIR --key FILE');
 options[name]=args[index+1];
}
if(!options['--release']||!options['--key'])throw Error('Usage: sign-computer-release.mjs --release DIR --key FILE');
const root=realpathSync(resolve(options['--release'])),keyFile=realpathSync(resolve(options['--key']));
if(keyFile===root||keyFile.startsWith(root+sep))throw Error('Keep the private signing key outside the public release directory');
const mirror=validateComputerRelease(root);
const key=createPrivateKey(readFileSync(keyFile));
if(key.asymmetricKeyType!=='ed25519')throw Error('Computer signing key must use Ed25519');
const bytes=mirror.files.find(file=>file.path==='manifest.json').bytes;
const temporary=join(root,`.manifest.sig-${randomUUID()}`);
try{writeFileSync(temporary,sign(null,bytes,key),{mode:0o644,flag:'wx'});renameSync(temporary,join(root,'manifest.sig'));}
finally{rmSync(temporary,{force:true});}
console.log(join(root,'manifest.sig'));
