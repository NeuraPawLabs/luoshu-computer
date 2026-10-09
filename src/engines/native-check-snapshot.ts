import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readdir,type FileHandle} from 'node:fs/promises';
import {withOutputRoot} from '../runtime/files.js';
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
/** Hash actual authorized worktree bytes, not HEAD; Git bookkeeping is not
 * deliverable content. No raw bytes or file contents leave this routine. */
export async function fingerprintNativeTree(path:string,assertCurrent:()=>void=()=>{}):Promise<string>{
 const hash=createHash('sha256');
 const visit=async(dir:FileHandle,prefix:string)=>{
  assertCurrent();const before=await dir.stat(),entries=(await readdir('/proc/self/fd/'+dir.fd,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries){
   assertCurrent();if(!prefix&&entry.name==='.git')continue;
   const name=prefix+entry.name,child='/proc/self/fd/'+dir.fd+'/'+entry.name;
   if(entry.isSymbolicLink())throw Error('Native check symbolic links are forbidden');
   if(entry.isDirectory()){
    hash.update(JSON.stringify(['directory',name]));const handle=await open(child,directoryFlags);try{await visit(handle,name+'/');}finally{await handle.close();}
   }else{
    const handle=await open(child,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
     const first=await handle.stat();if(!first.isFile()||first.nlink!==1)throw Error('Native check requires regular files without links');
     const bytes=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;
     for(;;){assertCurrent();const {bytesRead}=await handle.read(buffer,0,buffer.length,size);if(!bytesRead)break;size+=bytesRead;bytes.update(buffer.subarray(0,bytesRead));}
     const last=await handle.stat();if(size!==first.size||last.size!==first.size||last.mtimeMs!==first.mtimeMs||last.ctimeMs!==first.ctimeMs||last.nlink!==1)throw Error('Native check file changed during snapshot');
     hash.update(JSON.stringify(['file',name,first.mode&0o111,size,bytes.digest('hex')]));
    }finally{await handle.close();}
   }
  }
  const after=await dir.stat();assertCurrent();if(before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Native check directory changed during snapshot');
 };
 await withOutputRoot(path,root=>visit(root,''));return hash.digest('hex');
}
