import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {nativeCheckReceiptSchema,nativeCheckTargetsSchema,sameCheckTargets,type NativeCheckTarget,type NativeCheckReceipt,type NativeCommandReceipt} from '@luoshu/protocol';
import {redact} from '@luoshu/config/security';
interface Options {thread:string;turn:string;assertCurrent:()=>void;snapshot:()=>Promise<NativeCheckTarget[]>;quiescent:()=>Promise<void>;commands:()=>NativeCommandReceipt[];save:(r:NativeCheckReceipt)=>void}
interface Window {id:string;purpose:string;before:NativeCheckTarget[];commands:Set<string>;invalid:boolean}
const passive=new Set(['agentMessage','reasoning','userMessage','plan']);
export class NativeCheckWindow {
 private active=new Map<string,string>();private seen=new Set<string>();private revision=0;private window?:Window;private closed=false;private capturing=false;
 private calls=new Map<string,{input:unknown;result:Promise<any>}>();
 constructor(private options:Options){}
 private authorized(){if(this.closed)throw Error('Native check window is closed');this.options.assertCurrent();}
 observe(method:string,raw:unknown):void{
  if(this.closed||!raw||typeof raw!=='object')return;const p=raw as any;
  if(p.threadId!==this.options.thread||p.turnId!==this.options.turn||!['item/started','item/completed'].includes(method)||!p.item||typeof p.item.id!=='string')return;
  const item=p.item;if(passive.has(item.type)||item.type==='dynamicToolCall'&&['luoshu_check_begin','luoshu_check_end'].includes(item.tool))return;
  this.revision++;
  if(method==='item/started'){
   if(this.window&&(this.active.size||this.seen.has(item.id)||item.type!=='commandExecution'||this.capturing))this.window.invalid=true;
   if(!this.active.has(item.id)){this.active.set(item.id,item.type);if(this.window&&item.type==='commandExecution'&&!this.seen.has(item.id))this.window.commands.add(item.id);}
   this.seen.add(item.id);
  }else{
   if(this.window&&(!this.active.has(item.id)||item.type!=='commandExecution'||this.capturing))this.window.invalid=true;
   this.active.delete(item.id);this.seen.add(item.id);
  }
 }
 private call<T>(id:string,input:unknown,operation:()=>Promise<T>):Promise<T>{
  this.authorized();const old=this.calls.get(id);if(old){if(!isDeepStrictEqual(input,old.input))throw Error('Native check call conflict');return old.result;}
  const result=operation();this.calls.set(id,{input,result});return result;
 }
 async begin(callId:string,purpose:string):Promise<{check_id:string}>{return this.call(callId,{begin:purpose},async()=>{
  this.authorized();if(this.window||this.capturing||this.active.size)throw Error('Native check has active or pending tools');
  this.capturing=true;const revision=this.revision;
  try{
   await this.options.quiescent();const before=nativeCheckTargetsSchema.parse(await this.options.snapshot());this.authorized();
   if(revision!==this.revision||this.active.size)throw Error('Native tools changed during check snapshot');
   const id=randomUUID();this.window={id,purpose:redact(purpose),before,commands:new Set(),invalid:false};return{check_id:id};
  }finally{this.capturing=false;}
 });}
 async end(callId:string,checkId:string):Promise<NativeCheckReceipt>{return this.call(callId,{end:checkId},async()=>{
  this.authorized();const w=this.window;if(!w||w.id!==checkId||this.capturing||this.active.size)throw Error('Native check identity or pending tool mismatch');
  this.capturing=true;const revision=this.revision;
  try{
   await this.options.quiescent();const after=nativeCheckTargetsSchema.parse(await this.options.snapshot());this.authorized();
   const receipts=this.options.commands().filter(c=>w.commands.has(c.item_id)),complete=receipts.length===w.commands.size&&receipts.every(c=>c.thread_id===this.options.thread&&c.turn_id===this.options.turn&&c.command!==null&&c.cwd!==null&&c.exit_code!==null);
   const invalid=w.invalid||this.revision!==revision||this.active.size>0||!w.commands.size||!complete||!sameCheckTargets(w.before,after);
   const status=invalid?'invalidated':receipts.every(c=>c.status==='completed'&&c.exit_code===0)?'passed':'failed';
   const receipt=nativeCheckReceiptSchema.parse({check_id:w.id,thread_id:this.options.thread,turn_id:this.options.turn,purpose:w.purpose,command_ids:[...w.commands],before:w.before,after,status});
   this.options.save(receipt);this.window=undefined;return receipt;
  }finally{this.capturing=false;}
 });}
 close(){this.closed=true;this.window=undefined;}
}
