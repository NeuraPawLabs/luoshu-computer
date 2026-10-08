import {cpSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export function copyComputerNodeRuntime(staging){
 if(process.platform!=='linux'||process.arch!=='x64')throw Error('Computer release packaging supports only Linux x64; do not relabel host-native binaries');
 const prefix=resolve(dirname(process.execPath),'..');
 const license=process.env.LUOSHU_NODE_LICENSE_FILE??[
  join(prefix,'LICENSE'),join(prefix,'n','versions','node',process.versions.node,'LICENSE'),
 ].find(path=>existsSync(path));
 if(!license||!existsSync(license))throw Error('Node distribution LICENSE unavailable; set LUOSHU_NODE_LICENSE_FILE to its LICENSE');
 if(!readFileSync(license,'utf8').includes('Node.js'))throw Error('Expected the Node.js distribution LICENSE');
 mkdirSync(join(staging,'runtime'),{recursive:true});
 cpSync(process.execPath,join(staging,'runtime/node'));cpSync(license,join(staging,'runtime/LICENSE'));
}
