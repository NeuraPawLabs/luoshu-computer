import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {engineTitleResultSchema,parseNativeTitleTool,type EngineTitleUpdate,type EngineTitleResult} from '../protocol/index.js';
import type {CodexRpcServerRequest} from './codex-rpc.js';

const nativeId=z.string().min(1).max(200);
const paramsSchema=z.object({threadId:nativeId,turnId:nativeId,callId:nativeId,tool:z.string(),namespace:z.null().optional(),arguments:z.unknown()}).strict();
const nativeResult=(result:EngineTitleResult)=>({success:result.success,contentItems:[{type:'inputText' as const,text:JSON.stringify(result.success?{updated:result.updated,title:result.title,version:result.version}:{error:result.error})}]});
type Reply=ReturnType<typeof nativeResult>;
interface Call {update:EngineTitleUpdate;promise:Promise<Reply>;resolve:(reply:Reply)=>void;result?:EngineTitleResult}

/** Conversation metadata only; the current Worker turn supplies all authority. */
export class CodexTitleTools {
 private readonly calls=new Map<string,Call>();
 private closed=false;
 constructor(private readonly thread:string,private readonly turn:string,private readonly authorized:()=>boolean,private readonly emit:(id:string,update:EngineTitleUpdate)=>void|Promise<void>){}
 async handle(request:CodexRpcServerRequest):Promise<Reply>{
  try{
   if(this.closed||!this.authorized())throw Error('Native title tool authority expired');
   if(request.method!=='item/tool/call')throw Error('Native title tool method mismatch');
   const params=paramsSchema.parse(request.params);
   if(params.threadId!==this.thread||params.turnId!==this.turn)throw Error('Native title tool turn mismatch');
   const update=parseNativeTitleTool(params.tool,params.arguments),prior=this.calls.get(params.callId);
   if(prior){if(!isDeepStrictEqual(prior.update,update))throw Error('Native title call conflicts with prior update');return prior.promise;}
   let resolve!:(value:Reply)=>void;const promise=new Promise<Reply>(r=>resolve=r),call:Call={update,promise,resolve};
   this.calls.set(params.callId,call);
   const transportFailed=()=>{
    if(this.closed||this.calls.get(params.callId)!==call||call.result)return;
    call.result={success:false,error:'Title result unknown; transport unavailable; reconcile conversation metadata'};
    call.resolve(nativeResult(call.result));
   };
   try{void Promise.resolve(this.emit(params.callId,update)).catch(transportFailed);}catch{transportFailed();}
   return promise;
  }catch{return nativeResult({success:false,error:'Title update is invalid or no longer authorized'});}
 }
 respond(id:string,result:EngineTitleResult):void{
  if(this.closed||!this.authorized())throw Error('Native title tool authority expired');
  const call=this.calls.get(id);if(!call)throw Error('Native title call not found');
  const receipt=engineTitleResultSchema.parse(result);
  if(call.result){if(!isDeepStrictEqual(call.result,receipt))throw Error('Native title receipt conflict');return;}
  call.result=receipt;call.resolve(nativeResult(receipt));
 }
 close():void{
  this.closed=true;
  for(const call of this.calls.values())if(!call.result)call.resolve(nativeResult({success:false,error:'Title result unknown; reconcile conversation metadata'}));
  this.calls.clear();
 }
}
