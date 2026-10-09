import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {redact} from '../shared/security.js';
import type {EngineEventPayload,EngineInteractionOutcome} from '../protocol/index.js';
import type {CodexRpcServerRequest} from './codex-rpc.js';

const approvalResponse=z.object({kind:z.literal('approval'),decision:z.enum(['allow_once','deny','cancel'])}).strict();
const inputResponse=z.object({kind:z.literal('input'),answers:z.record(z.string(),z.array(z.string()))}).strict();
const scope=z.object({threadId:z.string(),turnId:z.string(),itemId:z.string()});
const questions=z.array(z.object({id:z.string().min(1),question:z.string().min(1),header:z.string().optional(),isOther:z.boolean().optional(),isSecret:z.boolean().optional(),options:z.array(z.object({label:z.string(),description:z.string().optional()})).nullable().optional()}));
const userInput=z.object({isBlocking:z.boolean(),questions});
const messageQuestions=z.object({id:z.string().min(1),type:z.literal('agentMessage'),questions:z.array(z.object({title:z.string().min(1),options:z.array(z.string()).nullable()})).min(1)});
export interface CodexTurnSteerParams {threadId:string;expectedTurnId:string;input:Array<{type:'text';text:string}>}
export type CodexQuestionSteering=(params:CodexTurnSteerParams)=>Promise<{turnId:string}>;
type Decision='allow_once'|'deny'|'cancel';
interface Pending {nativeId?:number|string;kind:'approval'|'input';event:Extract<EngineEventPayload,{kind:'waiting_input'|'waiting_approval'}>;decisions:Decision[];questionIds:string[];questionIdMap:Map<string,string>;state:'unanswered'|'responded'|'unknown';resolve?:(v:unknown)=>void;reject?:(e:unknown)=>void}
const nativeKey=(id:number|string)=>typeof id+':'+id;

/** Pending requests live only on this exact native connection/turn. Core must
 * separately persist user-facing approval state and authenticate respondents. */
export class CodexInteractions {
 private readonly pending=new Map<string,Pending>();
 private readonly nativeIds=new Map<string,string>();
 private readonly seenNativeIds=new Set<string>();
 private readonly seenMessages=new Set<string>();
 private readonly receipts:EngineInteractionOutcome[]=[];
 private closed=false;
 constructor(private readonly threadId:string,private readonly turnId:string,private readonly emit:(event:EngineEventPayload)=>void,private readonly authorized:()=>boolean=()=>true,private readonly steer?:CodexQuestionSteering){}
 async handle(request:CodexRpcServerRequest):Promise<unknown>{
  this.assertAuthorized();const params=scope.parse(request.params);
  if(params.threadId!==this.threadId||params.turnId!==this.turnId)throw Error('Foreign Codex interaction');
  if(this.seenNativeIds.has(nativeKey(request.id)))throw Error('Duplicate Codex interaction');
  let id=randomUUID(),event:EngineEventPayload,kind:Pending['kind'],decisions:Decision[]=[],questionIds:string[]=[],questionIdMap=new Map<string,string>();
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method)){
   kind='approval';const value=request.params as Record<string,unknown>;
   // The selected native policy rejects sandbox escalation. Do not turn an
   // explicit expansion or alternate environment into an ordinary confirmation.
   if(['additionalPermissions','networkApprovalContext','grantRoot','environmentId'].some(key=>value[key]!=null))throw Error('Native approval cannot expand authorized scope');
   if(value.availableDecisions!=null&&!Array.isArray(value.availableDecisions))throw Error('Invalid native approval decisions');
   const available=Array.isArray(value.availableDecisions)?value.availableDecisions:null;
   decisions=(['allow_once','deny','cancel'] as const).filter(d=>!available||available.includes({allow_once:'accept',deny:'decline',cancel:'cancel'}[d]));
   if(!decisions.length)throw Error('No supported one-time Codex approval decisions');
   const summary=typeof value.command==='string'?value.command:typeof value.reason==='string'?value.reason:'Codex requests a file change';
   event={kind:'waiting_approval',request_id:id,item_id:params.itemId,summary:redact(summary)||'Codex approval',decisions,expires_at:null};
  }else if(request.method==='item/tool/requestUserInput'){
   kind='input';const input=userInput.parse(request.params),values=input.questions;
   if(!values.length||values.some(q=>q.isSecret)||new Set(values.map(q=>q.id)).size!==values.length)throw Error('Unsupported or invalid Codex input questions');
   const nativeQuestionIds=new Set(values.map(q=>q.id));let alias:string|undefined;
   if(nativeQuestionIds.has('__proto__')){
    alias='question:'+createHash('sha256').update(JSON.stringify([id,'__proto__'])).digest('hex');
    while(nativeQuestionIds.has(alias)){id=randomUUID();alias='question:'+createHash('sha256').update(JSON.stringify([id,'__proto__'])).digest('hex');}
   }
   // Alias poison JSON keys only at the wire boundary; private Map keys retain
   // their exact native identity for the original JSON-RPC response.
   questionIdMap=new Map(values.map(q=>[q.id==='__proto__'?alias!:q.id,q.id]));questionIds=[...questionIdMap.keys()];
   // Offered labels are native control values and must round-trip verbatim.
   event={kind:'waiting_input',request_id:id,is_blocking:input.isBlocking,questions:values.map((q,index)=>({id:questionIds[index]!,text:redact(q.question),options:(q.options??[]).map(o=>o.label),...(q.header!==undefined?{header:redact(q.header)}:{}),...(q.isOther!==undefined?{is_other:q.isOther}:{}),...(q.options?.some(o=>o.description!==undefined)?{option_descriptions:q.options.map(o=>redact(o.description??''))}:{})})),expires_at:null};
  }else throw Object.assign(Error('Unsupported Codex server request'),{code:-32601});
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{nativeId:request.id,kind,event:event as Pending['event'],decisions,questionIds,questionIdMap,state:'unanswered',resolve,reject});this.nativeIds.set(nativeKey(request.id),id);this.seenNativeIds.add(nativeKey(request.id));
   try{this.emit(event);}catch(error){this.delete(id);reject(error);}
  });
 }
 observeMessageQuestions(raw:unknown):void{
  if(this.closed||!this.authorized())return;
  const parsed=messageQuestions.safeParse(raw);if(!parsed.success||this.seenMessages.has(parsed.data.id))return;
  const item=parsed.data,id='message-question:'+createHash('sha256').update(JSON.stringify([this.threadId,this.turnId,item.id])).digest('hex');
  const values=item.questions.map((q,index)=>{
   const candidate=item.id+':'+index;
   return{id:candidate.length<=200?candidate:id+':'+index,text:redact(q.title),options:[...(q.options??[])]};
  });
  const event:Extract<EngineEventPayload,{kind:'waiting_input'}>={kind:'waiting_input',request_id:id,is_blocking:false,questions:values,expires_at:null};
  this.seenMessages.add(item.id);
  this.pending.set(id,{kind:'input',event,decisions:[],questionIds:values.map(q=>q.id),questionIdMap:new Map(values.map(q=>[q.id,q.id])),state:'unanswered'});
  try{this.emit(event);}catch(error){this.pending.delete(id);throw error;}
 }
 respond(id:string,raw:unknown):void|Promise<void>{
  this.assertAuthorized();const pending=this.pending.get(id);if(!pending)throw Error('Codex interaction is expired or already resolved');
  if(pending.state!=='unanswered')throw Error('Codex interaction response is pending, unknown or already resolved');
  let result:unknown;
  if(pending.kind==='approval'){
   const response=approvalResponse.parse(raw);if(!pending.decisions.includes(response.decision))throw Error('Approval decision was not offered');
   result={decision:{allow_once:'accept',deny:'decline',cancel:'cancel'}[response.decision]};
  }else{
   const response=inputResponse.parse(raw),ids=Object.keys(response.answers);
   if(ids.length!==pending.questionIds.length||ids.some(key=>!pending.questionIds.includes(key)))throw Error('Input answer IDs differ from requested questions');
   result={answers:Object.fromEntries(ids.map(key=>[pending.questionIdMap.get(key)!,{answers:response.answers[key]}]))};
   if(pending.nativeId===undefined){
    if(!this.steer)throw Error('Native exact-turn steering is unavailable');
    const event=pending.event;if(event.kind!=='waiting_input')throw Error('Invalid message-question interaction');
    const input=[{type:'text' as const,text:JSON.stringify({assistant_question_answers:event.questions.map(q=>({id:q.id,question:q.text,answers:response.answers[q.id]}))})}];
    pending.state='responded';return this.steerResponse(id,pending,input);
   }
  }
  pending.state='responded';pending.resolve!(result);
 }
 private async steerResponse(id:string,pending:Pending,input:CodexTurnSteerParams['input']):Promise<void>{
  try{
   const result=await this.steer!({threadId:this.threadId,expectedTurnId:this.turnId,input});
   this.assertAuthorized();if(this.pending.get(id)!==pending)throw Error('Codex interaction turn closed during steering');
   if(result.turnId!==this.turnId)throw Object.assign(Error('Codex steering acknowledgement turn identity mismatch'),{code:'CODEX_RPC_PROTOCOL_ERROR'});
   this.delete(id);this.receipt(id,'answered');
  }catch(error){if(this.pending.get(id)===pending)pending.state='unknown';throw error;}
 }
 resolved(nativeId:number|string):void{
  const id=this.nativeIds.get(nativeKey(nativeId));if(!id)return;const pending=this.pending.get(id)!;
  this.delete(id);if(pending.state==='unanswered')pending.reject?.(Error('Codex request was resolved natively'));
  this.receipt(id,pending.state==='responded'?'answered':'dismissed');
 }
 close():void{this.closed=true;for(const pending of this.pending.values())pending.reject?.(Error('Codex interaction authority revoked or turn closed'));this.pending.clear();this.nativeIds.clear();}
 snapshot():Pending['event'][] {if(this.closed||!this.authorized())return[];return [...this.pending.values()].filter(p=>p.state==='unanswered').map(p=>structuredClone(p.event));}
 outcomes():EngineInteractionOutcome[]{return structuredClone(this.receipts);}
 private receipt(request_id:string,resolution:EngineInteractionOutcome['resolution']){this.receipts.push({request_id,resolution});this.emit({kind:'interaction.resolved',request_id,resolution});}
 private delete(id:string){const pending=this.pending.get(id);if(pending?.nativeId!==undefined)this.nativeIds.delete(nativeKey(pending.nativeId));this.pending.delete(id);}
 private assertAuthorized(){if(this.closed||!this.authorized())throw Error('Codex interaction is no longer authorized');}
}
