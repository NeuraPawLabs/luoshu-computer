import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,type FileHandle} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {knowledgeSourceRefSchema,knowledgeSourceSchema,knowledgeReadResultSchema,type KnowledgeSource,type KnowledgeReadResult} from '@luoshu/protocol';
import type {PreparedNativeCodebases} from './native-codebases.js';

type SourceRef=Pick<KnowledgeSource,'codebase_id'|'path'>;
interface Options {codebaseIds:readonly string[];current:()=>void;prepared:()=>Promise<PreparedNativeCodebases>}
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const descriptor=(handle:FileHandle)=>`/proc/self/fd/${handle.fd}`;
const sameIdentity=(left:BigIntStats,right:BigIntStats)=>left.dev===right.dev&&left.ino===right.ino;
const sameFile=(left:BigIntStats,right:BigIntStats)=>sameIdentity(left,right)&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs&&left.mode===right.mode&&right.nlink===1n;
const contained=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));};
const validCommit=(value:string)=>/^[a-f0-9]{40,64}$/u.test(value);

/** Semantic constraints shared with Core. Source references never grant scope. */
export function assertKnowledgeKind(value:{kind:'analysis'|'reference'|'business';scope:{kind:'codebase'|'project';id:string};sources:SourceRef[];body:string}):void {
 if(value.kind==='business'&&value.scope.kind!=='project')throw Error('Business knowledge belongs to a Project');
 if(value.kind==='reference'&&(value.body!==''||!value.sources.length))throw Error('Reference knowledge requires sources and an empty body');
 if(value.kind==='analysis'&&!value.sources.length)throw Error('Analysis knowledge requires sources');
 if(value.scope.kind==='codebase'&&(!value.sources.length||value.sources.some(source=>source.codebase_id!==value.scope.id)))throw Error('Codebase knowledge requires sources from its own Codebase');
 if(new Set(value.sources.map(source=>`${source.codebase_id}:${source.path}`)).size!==value.sources.length)throw Error('Duplicate knowledge source path');
}

/** Read only the selected files, pinning every directory from / to the leaf.
 * O_NOFOLLOW on the leaf alone cannot fence a swapped checkout ancestor. */
async function readSource<T>(root:string,parts:string[],current:()=>void,read:(file:FileHandle,checked:<V>(work:()=>Promise<V>)=>Promise<V>)=>Promise<T>):Promise<T>{
 if(!isAbsolute(root)||resolve(root)!==root||/[\\\u0000-\u001f\u007f-\u009f]/u.test(root))throw Error('Knowledge checkout path is invalid');
 const handles:FileHandle[]=[],links:{parent:FileHandle;name:string;child:FileHandle}[]=[];
 const checked=async<V>(work:()=>Promise<V>):Promise<V>=>{current();const value=await work();current();return value;};
 const acquire=async(path:string,flags:number):Promise<FileHandle>=>{current();const handle=await open(path,flags);handles.push(handle);current();return handle;};
 try{
  let parent=await acquire('/',directoryFlags);
  for(const name of [...root.split(sep).filter(Boolean),...parts.slice(0,-1)]){
   const child=await acquire(`${descriptor(parent)}/${name}`,directoryFlags);links.push({parent,name,child});parent=child;
  }
  const path=`${descriptor(parent)}/${parts.at(-1)!}`,file=await acquire(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await checked(()=>file.stat({bigint:true}));if(!before.isFile()||before.nlink!==1n)throw Error('Knowledge source must be a regular file without hard links');
  const value=await read(file,checked);
  const after=await checked(()=>file.stat({bigint:true})),named=await checked(()=>lstat(path,{bigint:true}));
  if(!sameFile(before,after)||!sameFile(after,named)||!named.isFile()||named.isSymbolicLink())throw Error('Knowledge source file changed during read');
  for(const link of links){
   const [actual,pinned]=await checked(()=>Promise.all([lstat(`${descriptor(link.parent)}/${link.name}`,{bigint:true}),link.child.stat({bigint:true})]));
   if(!actual.isDirectory()||actual.isSymbolicLink()||!sameIdentity(actual,pinned))throw Error('Knowledge checkout directory identity changed during read');
  }
  current();return value;
 }finally{for(const handle of handles.reverse())await handle.close();}
}

async function contentHash(root:string,path:string,current:()=>void):Promise<string>{
 return readSource(root,path.split('/'),current,async(file,checked)=>{
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let position=0;
  for(;;){const {bytesRead}=await checked(()=>file.read(buffer,0,buffer.length,position));if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  return hash.digest('hex');
 });
}
async function metadata(root:string,path:string,current:()=>void):Promise<string>{
 return readSource(root,path.split('/'),current,(file,checked)=>checked(()=>file.readFile('utf8')));
}

/** Whole checkouts have their own Git directory. Scoped checkouts use the
 * assignment pin so resolving evidence never follows parent repository paths. */
async function commit(root:string,base:string,scoped:boolean,current:()=>void):Promise<string>{
 if(!validCommit(base))throw Error('Knowledge Codebase commit pin is invalid');
 if(scoped)return base;
 const head=(await metadata(root,'.git/HEAD',current)).trim();
 if(validCommit(head))return head;
 const ref=head.startsWith('ref: ')?head.slice(5):'';
 if(!/^refs\/[A-Za-z0-9_./-]+$/u.test(ref)||ref.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git'))throw Error('Knowledge checkout HEAD is invalid');
 let value:string;
 try{value=(await metadata(root,`.git/${ref}`,current)).trim();}
 catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  const packed=await metadata(root,'.git/packed-refs',current);value=packed.split('\n').find(line=>line.split(' ')[1]===ref)?.split(' ')[0]??'';
 }
 if(!validCommit(value))throw Error('Knowledge checkout commit is invalid');return value;
}

/** Evidence comes only from current prepared Run checkouts and pinned IDs. */
export class NativeKnowledgeSources {
 constructor(private readonly options:Options){}
 private async resources(refs:SourceRef[]):Promise<PreparedNativeCodebases|undefined>{
  this.options.current();for(const ref of refs){knowledgeSourceRefSchema.parse(ref);if(!this.options.codebaseIds.includes(ref.codebase_id))throw Error('Knowledge source Codebase is outside authorized Run scope');}
  if(!refs.length)return undefined;
  const resources=await this.options.prepared();this.options.current();return resources;
 }
 private checkout(resources:PreparedNativeCodebases,id:string){
  this.options.current();const matches=resources.workspace.codebases.filter(cb=>cb.id===id),assignments=resources.assignments.filter(cb=>cb.id===id);
  if(matches.length!==1||assignments.length!==1)throw Error('Knowledge source Codebase preparation identity mismatch');
  const cb=matches[0]!,assignment=assignments[0]!;
  if(!contained(resources.workspace.path,cb.repository_path)||!contained(cb.repository_path,cb.checkout_path)||resolve(cb.repository_path,assignment.root_path)!==cb.checkout_path||cb.base_commit!==assignment.base_commit||!(cb.access_mode==='read'?resources.read:resources.write).includes(cb.checkout_path))throw Error('Knowledge source checkout differs from authorized Codebase preparation');
  return {cb,assignment};
 }
 async enrich(refs:SourceRef[]):Promise<KnowledgeSource[]>{
  const resources=await this.resources(refs);this.options.current();const sources:KnowledgeSource[]=[];
  for(const ref of refs){
   const {cb,assignment}=this.checkout(resources!,ref.codebase_id),commit_sha=await commit(cb.checkout_path,assignment.base_commit,assignment.root_path!=='.',this.options.current);this.options.current();
   const content_sha256=await contentHash(cb.checkout_path,ref.path,this.options.current);this.options.current();sources.push(knowledgeSourceSchema.parse({...ref,commit_sha,content_sha256}));
  }
  this.options.current();return sources;
 }
 async verify(raw:KnowledgeReadResult):Promise<void>{
  const value=knowledgeReadResultSchema.parse(raw);assertKnowledgeKind({...value.entry,body:value.body});
  const refs=value.entry.sources.map(({codebase_id,path})=>({codebase_id,path})),resources=await this.resources(refs);this.options.current();
  for(const source of value.entry.sources){
   const {cb}=this.checkout(resources!,source.codebase_id),actual=await contentHash(cb.checkout_path,source.path,this.options.current);this.options.current();
   if(actual!==source.content_sha256)throw Error('Knowledge source content is stale; inspect the current checkout files');
  }
  this.options.current();
 }
}
