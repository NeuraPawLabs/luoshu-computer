import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {parseNativeTaskTool,type EngineTaskOperation,type EngineTaskResult} from '@luoshu/protocol';
import type {CodexRpcServerRequest} from './codex-rpc.js';
const paramsSchema=z.object({threadId:z.string(),turnId:z.string(),callId:z.string().min(1).max(200),tool:z.string(),namespace:z.null().optional(),arguments:z.unknown()}).strict();
const nativeResult=(result:EngineTaskResult)=>({success:result.success,contentItems:[{type:'inputText' as const,text:JSON.stringify(result.success?result.receipt:{error:result.error})}]});
type Reply=ReturnType<typeof nativeResult>;
interface Call {operation:EngineTaskOperation;promise:Promise<Reply>;resolve:(reply:Reply)=>void;result?:EngineTaskResult}

/** Only task metadata; authority is attached by Worker, never supplied by the model. */
export class CodexTaskTools {
 private readonly calls=new Map<string,Call>();
 private closed=false;
 constructor(private thread:string,private turn:string,private authorized:()=>boolean,private emit:(id:string,operation:EngineTaskOperation)=>void){}
 async handle(request:CodexRpcServerRequest):Promise<Reply>{
  try{
   if(this.closed||!this.authorized())throw Error('Native task tool authority expired');
   const params=paramsSchema.parse(request.params);if(params.threadId!==this.thread||params.turnId!==this.turn)throw Error('Native task tool turn mismatch');
   const operation=parseNativeTaskTool(params.tool,params.arguments),prior=this.calls.get(params.callId);
   if(prior){if(!isDeepStrictEqual(prior.operation,operation))throw Error('Native task call conflicts with prior operation');return prior.promise;}
   let resolve!:(value:Reply)=>void;const promise=new Promise<Reply>(r=>resolve=r);this.calls.set(params.callId,{operation,promise,resolve});
   try{this.emit(params.callId,operation);}catch{this.respond(params.callId,{success:false,error:'Task transport unavailable'});}
   return promise;
  }catch{return nativeResult({success:false,error:'Task operation is invalid or no longer authorized'});}
 }
 respond(id:string,result:EngineTaskResult):void{
  if(this.closed||!this.authorized())throw Error('Native task tool authority expired');
  const call=this.calls.get(id);if(!call)throw Error('Native task call not found');
  if(call.result){if(!isDeepStrictEqual(call.result,result))throw Error('Native task receipt conflict');return;}
  call.result=result;call.resolve(nativeResult(result));
 }
 close():void{this.closed=true;for(const call of this.calls.values())if(!call.result)call.resolve(nativeResult({success:false,error:'Task result unknown; reconcile execution'}));this.calls.clear();}
}
