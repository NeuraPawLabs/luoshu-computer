import {nativeCommandReceiptSchema,type NativeCommandReceipt} from '../protocol/index.js';
import {redact} from '../shared/security.js';

/** Only authoritative native completion fields. Never retain raw item/output. */
export function nativeCommandReceipt(thread:string,turn:string,raw:unknown):NativeCommandReceipt|null{
 if(!raw||typeof raw!=='object')return null;
 const item=raw as Record<string,unknown>;
 if(item.type!=='commandExecution'||!['completed','failed','declined'].includes(String(item.status)))return null;
 return nativeCommandReceiptSchema.parse({thread_id:thread,turn_id:turn,item_id:item.id,command:typeof item.command==='string'?redact(item.command):null,cwd:typeof item.cwd==='string'?redact(item.cwd):null,status:item.status,exit_code:typeof item.exitCode==='number'?item.exitCode:null,duration_ms:typeof item.durationMs==='number'?item.durationMs:null});
}
