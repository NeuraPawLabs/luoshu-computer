import {access,open,realpath,readFile,stat} from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import {delimiter,dirname,isAbsolute,join,resolve} from 'node:path';
import {createRequire} from 'node:module';

export interface NativeExecutableSnapshot {path:string;identity:string}
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
/** Installation identity, not a content signature or proof of exec-time inode.
 * Uses only the executable and official launcher metadata, never credentials. */
export async function snapshotNativeExecutable(requested?:string,searchPath?:string):Promise<NativeExecutableSnapshot>{
 const path=await resolveNativeExecutable(requested,searchPath),handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat({bigint:true});
  if(!before.isFile()||(before.mode&0o111n)===0n)throw Error('Native executable must be an executable regular file');
  const bytes=Buffer.alloc(4),read=await handle.read(bytes,0,4,0);
  if(read.bytesRead!==4||!bytes.equals(Buffer.from([0x7f,0x45,0x4c,0x46])))throw Error('Native executable is not native');
  const expected=identity(before),after=await handle.stat({bigint:true});
  if(identity(after)!==expected||await resolveNativeExecutable(requested,searchPath)!==path||identity(await stat(path,{bigint:true}))!==expected)throw Error('Native executable changed during inspection');
  return{path,identity:expected};
 }finally{await handle.close();}
}

async function native(path:string):Promise<boolean>{
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{if(!(await handle.stat()).isFile())throw Error('Native executable must be a regular file');const bytes=Buffer.alloc(4);const read=await handle.read(bytes,0,4,0);return read.bytesRead===4&&bytes.equals(Buffer.from([0x7f,0x45,0x4c,0x46]));}finally{await handle.close();}
}

/** Resolve a Linux native binary or official npm launcher without executing
 * wrapper scripts or reading device configuration/authentication files. */
export async function resolveNativeExecutable(requested='codex',searchPath=process.env.PATH??''):Promise<string>{
 if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))throw Error('Native direct engine requires verified Linux runtime');
 let found:string|undefined;
 for(const candidate of isAbsolute(requested)?[requested]:requested.includes('/')?[]:searchPath.split(delimiter).filter(isAbsolute).map(root=>join(root,requested))){
  try{await access(candidate,constants.X_OK);found=await realpath(candidate);break;}catch{/* Find an executable, not an arbitrary shell expression. */}
 }
 if(!found)throw Error('Codex executable is unavailable');
 if(await native(found))return found;
 const root=dirname(dirname(found)),metadata=join(root,'package.json');
 let manifest:{name?:string;version?:string;bin?:{codex?:string}};
 try{if((await stat(metadata)).size>65536)throw Error();manifest=JSON.parse(await readFile(metadata,'utf8'));}catch{throw Error('Unsupported native Codex wrapper');}
 if(manifest.name!=='@openai/codex'||manifest.bin?.codex!=='bin/codex.js'||resolve(root,manifest.bin.codex)!==found)throw Error('Unsupported native Codex wrapper');
 const triple=process.arch==='x64'?'x86_64-unknown-linux-musl':'aarch64-unknown-linux-musl';
 let vendor=join(root,'vendor');
 try{const packagePath=createRequire(metadata).resolve(`@openai/codex-linux-${process.arch}/package.json`);vendor=join(dirname(packagePath),'vendor');}catch{/* Official bundled distribution uses its own vendor directory. */}
 const binary=await realpath(join(vendor,triple,'bin','codex'));await access(binary,constants.X_OK);
 if(!await native(binary))throw Error('Codex platform executable is not native');return binary;
}
