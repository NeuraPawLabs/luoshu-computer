// Stop only at actual filesystem boundaries in the production publisher.
// No production test hook or manufactured ownership journal.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const options=JSON.parse(process.argv[2]!);
let held=false;
async function pause(stage:string){if(stage!==options.stage||held)return;held=true;process.send!({stage});await new Promise(()=>setInterval(()=>{},1000));}
const originalOpen=fs.open.bind(fs),originalLink=fs.link.bind(fs),originalRename=fs.rename.bind(fs),originalUnlink=fs.unlink.bind(fs);
fs.open=(async(...args:Parameters<typeof fs.open>)=>{
 const staging=String(args[0]).includes('/.luoshu-index-')&&(Number(args[1])&constants.O_CREAT)!==0;
 if(staging)await pause('reserved');
 const handle=await originalOpen(...args);
 if(staging){
  const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();await pause('staged');};
  const write=handle.write.bind(handle);handle.write=(async(...values:any[])=>{if(options.stage==='partial')values[2]=Math.min(values[2],8);const result=await (write as any)(...values);await pause('partial');return result;}) as typeof handle.write;
 }
 return handle;
}) as typeof fs.open;
fs.link=async(...args:Parameters<typeof fs.link>)=>{if(String(args[1]).endsWith('/index.lock'))await pause('before_link');await originalLink(...args);if(String(args[1]).endsWith('/index.lock'))await pause('linked');};
fs.rename=async(...args:Parameters<typeof fs.rename>)=>{if(String(args[0]).endsWith('/index.lock'))await pause('before_publish');await originalRename(...args);if(String(args[0]).endsWith('/index.lock'))await pause('published');};
fs.unlink=async(...args:Parameters<typeof fs.unlink>)=>{await originalUnlink(...args);if(String(args[0]).endsWith('/index.lock'))await pause('recovered_lock_removed');if(String(args[0]).includes('/.luoshu-index-'))await pause('anchor_removed');};
syncBuiltinESMExports();
const {default:Database}=await import('better-sqlite3');
const {NativeCodebases}=await import('../../src/engines/native-codebases.js');
const db=new Database(options.db);
try{await new NativeCodebases(db,{stateDir:options.state,allowedRoots:()=>[options.source]}).collect(options.input,true);throw Error('Expected crash boundary was not reached');}finally{db.close();}
