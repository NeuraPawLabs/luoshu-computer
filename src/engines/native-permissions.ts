import {createHash} from 'node:crypto';
import {isAbsolute,normalize,relative,resolve,sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

const path=z.string().refine(p=>isAbsolute(p)&&normalize(p)===p&&p!=='/'&&!/[\u0000-\u001f\u007f]/u.test(p),'Invalid native permission path');
const scopeSchema=z.object({session:z.string().min(1).max(200),cwd:path,runtime:path,read:z.array(path),write:z.array(path),resourceRoot:path.optional(),mode:z.enum(['workspace-write','danger-full-access']).default('workspace-write')}).strict();
export interface NativePermissions {
 id:string;cwd:string;runtime:string;runtimeWorkspaceRoots:string[];
 config:{filesystem:Record<string,'read'|'write'|Record<string,'read'|'write'>>;network:{enabled:boolean}};
}
const within=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};

/** Intended host scope, not a model path grant or proof of OS enforcement.
 * Callers resolve real paths before construction and verify native provenance. */
export function nativePermissions(raw:z.input<typeof scopeSchema>):NativePermissions{
 const scope=scopeSchema.parse(raw),write=[...new Set([scope.cwd,...scope.write])].sort(),read=[...new Set([scope.runtime,...scope.read])].sort();
 if(scope.mode==='danger-full-access')return{id:'luoshu_'+createHash('sha256').update(JSON.stringify([scope.session,'danger-full-access'])).digest('hex'),cwd:scope.cwd,runtime:scope.runtime,config:{filesystem:{':root':'write'},network:{enabled:true}},runtimeWorkspaceRoots:[scope.cwd]};
 if(write.some(w=>read.some(r=>within(w,r))))throw Error('Native write scope overlaps a read-only root or runtime');
 let filesystem:NativePermissions['config']['filesystem'];
 if(scope.resourceRoot){
  if(within(scope.cwd,scope.resourceRoot)||within(scope.resourceRoot,scope.cwd)||within(scope.resourceRoot,scope.runtime))throw Error('Native resource scope overlaps workspace or runtime');
  const rules:Record<string,'read'|'write'>={};
  for(const [paths,mode] of [[scope.read,'read'],[scope.write,'write']] as const)for(const p of paths){
   const subpath=relative(scope.resourceRoot,p);
   if(!subpath||!within(scope.resourceRoot,p)||subpath.includes('\\')||/[?*\[\]{}]/u.test(subpath))throw Error('Native resource path is outside exact root scope');
   rules[subpath]=mode;
  }
  filesystem={':minimal':'read',[scope.runtime]:'read',[scope.cwd]:'write',':workspace_roots':Object.fromEntries(Object.entries(rules).sort(([a],[b])=>a.localeCompare(b)))};
 }else filesystem=Object.fromEntries([[':minimal','read'],...read.map(r=>[r,'read']),...write.map(w=>[w,'write'])].sort(([a],[b])=>a!.localeCompare(b!))) as Record<string,'read'|'write'>;
 const config={filesystem,network:{enabled:false as const}};
 return{id:'luoshu_'+createHash('sha256').update(JSON.stringify([scope.session,scope.cwd,scope.runtime,config])).digest('hex'),cwd:scope.cwd,runtime:scope.runtime,config,runtimeWorkspaceRoots:scope.resourceRoot?[scope.resourceRoot]:[scope.cwd]};
}

export function nativeWritableRoots(scope:NativePermissions):string[]{
 const roots:string[]=[];
 for(const [path,mode] of Object.entries(scope.config.filesystem)){
  if(mode==='write')roots.push(path);
  else if(path===':workspace_roots'&&typeof mode==='object')for(const root of scope.runtimeWorkspaceRoots)for(const [subpath,access] of Object.entries(mode))if(access==='write')roots.push(resolve(root,subpath));
 }
 return [...new Set(roots)].sort();
}

export function assertReturnedProfile(raw:unknown,expected:NativePermissions):void{
 const value=z.object({activePermissionProfile:z.object({id:z.string(),extends:z.string().nullable().optional()}),runtimeWorkspaceRoots:z.array(path)}).parse(raw);
 if(value.activePermissionProfile.id!==expected.id||value.activePermissionProfile.extends!=null)throw Error('Native permission profile identity differs from host policy');
 if(!isDeepStrictEqual(value.runtimeWorkspaceRoots,expected.runtimeWorkspaceRoots))throw Error('Native workspace roots differ from host policy');
}
