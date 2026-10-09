import {z} from 'zod';
import {codebaseSourceSchema} from './execution.js';

const source=codebaseSourceSchema.refine(s=>{
 if(s.kind==='local')return !/[\\\u0000-\u001f\u007f]/u.test(s.path)&&!s.path.split('/').includes('..');
 try{const url=new URL(s.repository_url);return ['https:','ssh:'].includes(url.protocol)&&Boolean(url.hostname)&&!url.password&&(url.protocol!=='https:'||!url.username);}catch{return /^git@[a-zA-Z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(s.repository_url);}
},'Invalid native Codebase repository source');
const root=z.string().min(1).max(500).refine(p=>p==='.'||!p.startsWith('/')&&!p.endsWith('/')&&!p.split('/').some(c=>!c||c==='.'||c==='..'||c.toLowerCase()==='.git')&&!/[\\\u0000-\u001f\u007f]/u.test(p),'Invalid native Codebase root path');
export const nativeCodebaseSpecSchema=z.object({id:z.string().uuid(),alias:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),access_mode:z.enum(['read','write']),source,root_path:root,default_branch:z.string().min(1).max(200).refine(b=>!b.startsWith('-')&&!/[\u0000-\u0020\u007f]/u.test(b),'Invalid native repository branch')}).strict();
export const nativeCodebaseSpecsSchema=z.array(nativeCodebaseSpecSchema).min(1).max(32).refine(v=>new Set(v.map(s=>s.id)).size===v.length&&new Set(v.map(s=>s.alias)).size===v.length,'Duplicate native Codebase identity');
export type NativeCodebaseSpec=z.infer<typeof nativeCodebaseSpecSchema>;
