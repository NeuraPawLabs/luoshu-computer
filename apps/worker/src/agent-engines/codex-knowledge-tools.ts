import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {engineKnowledgeResultSchema,parseNativeKnowledgeTool,type EngineKnowledgeOperation,type EngineKnowledgeResult,type KnowledgeReadResult,type KnowledgeSource} from '@luoshu/protocol';
import type {CodexRpcServerRequest} from './codex-rpc.js';
import {assertKnowledgeKind} from './native-knowledge-sources.js';

const nativeId=z.string().min(1).max(200);
const paramsSchema=z.object({threadId:nativeId,turnId:nativeId,callId:nativeId,tool:z.string(),namespace:z.null().optional(),arguments:z.unknown()}).strict();
const nativeResult=(result:EngineKnowledgeResult)=>({success:result.success,contentItems:[{type:'inputText' as const,text:JSON.stringify(result.success?result.value:{error:result.error})}]});
type Reply=ReturnType<typeof nativeResult>;
type Operation=ReturnType<typeof parseNativeKnowledgeTool>;
interface Evidence {enrich:(refs:Pick<KnowledgeSource,'codebase_id'|'path'>[])=>Promise<KnowledgeSource[]>;verify:(value:KnowledgeReadResult)=>Promise<void>}
interface Call {operation:Operation;promise:Promise<Reply>;resolve:(reply:Reply)=>void;result?:EngineKnowledgeResult;receipt?:EngineKnowledgeResult;response?:Promise<void>;sent:boolean}
const failure=(error:string):EngineKnowledgeResult=>({success:false,error});

/** Scoped metadata only: all authority is supplied by the current native turn. */
export class CodexKnowledgeTools {
 private readonly calls=new Map<string,Call>();
 private closed=false;
 private releaseClosed!:()=>void;
 private readonly closedSignal=new Promise<void>(resolve=>{this.releaseClosed=resolve;});
 constructor(private readonly thread:string,private readonly turn:string,private readonly authorized:()=>boolean,private readonly emit:(id:string,operation:EngineKnowledgeOperation)=>void|Promise<void>,private readonly evidence:Evidence){}
 private current():void {if(this.closed||!this.authorized())throw Error('Native knowledge tool authority expired');}
 private async evidenceWork<T>(work:()=>Promise<T>):Promise<T>{
  this.current();const result=await Promise.race([work().then(value=>({value})),this.closedSignal.then(()=>null)]);
  this.current();if(result===null)throw Error('Native knowledge tool is closed');return result.value;
 }
 private settle(call:Call,result:EngineKnowledgeResult):void {if(call.result)return;call.result=result;call.resolve(nativeResult(result));}
 async handle(request:CodexRpcServerRequest):Promise<Reply>{
  try{
   this.current();if(request.method!=='item/tool/call')throw Error('Native knowledge tool method mismatch');
   const params=paramsSchema.parse(request.params);if(params.threadId!==this.thread||params.turnId!==this.turn)throw Error('Native knowledge tool turn mismatch');
   const operation=parseNativeKnowledgeTool(params.tool,params.arguments);if(operation.action==='propose')assertKnowledgeKind(operation.proposal);
   const prior=this.calls.get(params.callId);if(prior){if(!isDeepStrictEqual(prior.operation,operation))throw Error('Native knowledge call conflicts with prior operation');return prior.promise;}
   let resolve!:(value:Reply)=>void;const promise=new Promise<Reply>(r=>resolve=r),call:Call={operation,promise,resolve,sent:false};this.calls.set(params.callId,call);
   void this.dispatch(params.callId,call);return promise;
  }catch{return nativeResult(failure('Knowledge operation is invalid or no longer authorized'));}
 }
 private async dispatch(id:string,call:Call):Promise<void>{
  try{
   let operation:EngineKnowledgeOperation;
   if(call.operation.action==='propose'){
    const proposal=call.operation.proposal;operation={action:'propose',proposal:{...proposal,sources:await this.evidenceWork(()=>this.evidence.enrich(proposal.sources))}};
   }else operation=call.operation;
   this.current();if(this.calls.get(id)!==call||call.result)return;
   call.sent=true;
   const transportFailed=()=>{if(!this.closed&&this.calls.get(id)===call&&!call.result&&!call.receipt)this.settle(call,failure('Knowledge result unknown; transport unavailable; reconcile knowledge metadata'));};
   try{void Promise.resolve(this.emit(id,operation)).catch(transportFailed);}catch{transportFailed();}
  }catch{if(!this.closed&&this.calls.get(id)===call)this.settle(call,failure('Knowledge source is unavailable or no longer authorized; inspect the current Run checkout'));}
 }
 async respond(id:string,raw:EngineKnowledgeResult):Promise<void>{
  this.current();const call=this.calls.get(id);if(!call)throw Error('Native knowledge call not found');
  const receipt=engineKnowledgeResultSchema.parse(raw);if(!call.sent)throw Error('Native knowledge call has not been emitted');
  if(call.receipt){if(!isDeepStrictEqual(call.receipt,receipt))throw Error('Native knowledge receipt conflict');await call.response;this.current();return;}
  if(call.result){if(!isDeepStrictEqual(call.result,receipt))throw Error('Native knowledge receipt conflict');return;}
  if(receipt.success){
   const value=receipt.value;
   if(call.operation.action==='list'&&!('snapshot_id'in value)||call.operation.action==='propose'&&!('status'in value)||call.operation.action==='read'&&(!('body'in value)||value.entry.id!==call.operation.entry_id||value.entry.revision!==call.operation.revision))throw Error('Native knowledge result shape or operation identity mismatch');
  }
  call.receipt=receipt;
  const work=this.confirm(call,receipt);call.response=work;
  try{await work;}catch(error){if(call.receipt===receipt&&!call.result){call.receipt=undefined;call.response=undefined;}throw error;}
 }
 private async confirm(call:Call,receipt:EngineKnowledgeResult):Promise<void>{
  let result=receipt;
  if(receipt.success&&call.operation.action==='read'&&'body'in receipt.value){
   const value=receipt.value;try{await this.evidenceWork(()=>this.evidence.verify(value));}
   catch{this.current();result=failure('Knowledge source is stale, missing or outside the current Run scope; inspect current checkout files before relying on facts');}
  }
  this.current();this.settle(call,result);
 }
 close():void {
  if(this.closed)return;this.closed=true;this.releaseClosed();
  for(const call of this.calls.values())this.settle(call,failure('Knowledge result unknown; reconcile knowledge metadata'));
  this.calls.clear();
 }
}
