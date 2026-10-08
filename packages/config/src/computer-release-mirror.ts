import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {computerReleaseManifestSchema,MAX_COMPUTER_RELEASE_BYTES,type ComputerReleaseManifest} from '@luoshu/protocol';

export interface ComputerMirrorFile {path:string;bytes:Buffer;mode:number}
export interface ComputerReleaseMirror {manifest:ComputerReleaseManifest;files:ComputerMirrorFile[]}

function readMirrorFile(root:string,path:string,limit:number):Buffer {
 let current=root;
 for(const segment of path.split('/')){
  if(!segment||segment==='.'||segment==='..')throw Error('Unsafe Computer mirror path');
  current=join(current,segment);
  if(lstatSync(current).isSymbolicLink())throw Error('Computer mirror must not contain symlinks');
 }
 const fd=openSync(current,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw Error('Invalid Computer mirror file');
  const bytes=readFileSync(fd);
  if(bytes.length>limit||bytes.length!==stat.size)throw Error('Computer mirror changed while reading');
  return bytes;
 }finally{closeSync(fd);}
}

/** Take verified snapshots of only the public distribution files, never arbitrary directory contents. */
export function loadComputerReleaseMirror(directory:string):ComputerReleaseMirror {
 const root=resolve(directory),stat=lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid Computer mirror directory');
 const manifestBytes=readMirrorFile(root,'manifest.json',256*1024);
 const manifest=computerReleaseManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
 if(!manifest.releases['linux-x64'])throw Error('Computer mirror has no Linux x64 release');
 const files:ComputerMirrorFile[]=[{path:'manifest.json',bytes:manifestBytes,mode:0o644},
  {path:'install.sh',bytes:readMirrorFile(root,'install.sh',64*1024),mode:0o755}];
 let total=0;
 const paths=new Set<string>();
 for(const release of Object.values(manifest.releases)){
  if(!release.path.startsWith('/computer/'))throw Error('Computer mirror archive must use /computer/ paths');
  const path=release.path.slice('/computer/'.length);
  if(paths.has(path))throw Error('Duplicate Computer mirror archive path');
  paths.add(path);
  const bytes=readMirrorFile(root,path,release.size);
  total+=bytes.length;
  if(total>MAX_COMPUTER_RELEASE_BYTES||bytes.length!==release.size||createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw Error('Computer mirror archive size or SHA-256 mismatch');
  files.push({path,bytes,mode:0o644});
 }
 try{
  const signature=readMirrorFile(root,'manifest.sig',64);
  if(signature.length!==64)throw Error('Invalid Computer mirror signature');
  files.push({path:'manifest.sig',bytes:signature,mode:0o644});
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return{manifest,files};
}
