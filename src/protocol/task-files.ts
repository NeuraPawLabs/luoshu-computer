import {z} from 'zod';
export const MAX_FILE_BYTES=10*1024*1024;
export const MAX_TASK_FILES=4;
export const MAX_WIRE_BYTES=64*1024*1024;
export function fileByteLength(value:string):number{return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);}
export function validBase64(value:string):boolean {
 if(value.length%4!==0||/[^A-Za-z0-9+/=]/.test(value))return false;
 const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
 const body=padding?value.slice(0,-padding):value;
 if(body.includes('='))return false;
 const last='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(body.at(-1)??'');
 return padding===2?last>=0&&last%16===0:padding===1?last>=0&&last%4===0:true;
}
export const taskFileSchema=z.object({
 name:z.string().min(1).max(240).refine(v=>!/^\.|[. ]$|[/\\\u0000-\u001f\u007f-\u009f]/u.test(v),'Invalid filename'),
 mime_type:z.string().max(100).regex(/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/),
 content_base64:z.string().max(Math.ceil(MAX_FILE_BYTES/3)*4).refine(validBase64,'Invalid base64').refine(v=>fileByteLength(v)<=MAX_FILE_BYTES,'File too large')
}).strict();
export type TaskFile=z.infer<typeof taskFileSchema>;
export const taskFilesSchema=z.array(taskFileSchema).max(MAX_TASK_FILES).refine(files=>new Set(files.map(f=>f.name.normalize('NFC').toLowerCase())).size===files.length,'Duplicate filenames');
