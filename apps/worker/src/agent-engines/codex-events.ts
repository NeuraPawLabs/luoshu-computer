import {redact} from '@luoshu/config/security';
import type {EngineEventPayload} from '@luoshu/protocol';

type Item=Record<string,unknown>&{id:string;type:string};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
/** Per-native-turn ephemeral projection. Never persist this map or raw params. */
export class CodexTurnProjection {
 private terminal=false;
 private readonly items=new Map<string,Item>();
 private readonly finalText=new Map<string,string>();
 private readonly progressText=new Map<string,string>();
 private readonly summaries=new Map<string,string>();
 private lastReply:Extract<EngineEventPayload,{kind:'reply.final'}>|null=null;
 private readonly tools=new Set<string>();
 private readonly completedTools=new Set<string>();
 constructor(readonly threadId:string,readonly turnId:string){}
 finalReply():Extract<EngineEventPayload,{kind:'reply.final'}>|null{return this.lastReply?structuredClone(this.lastReply):null;}
 consume(method:string,raw:unknown):EngineEventPayload[]{
  const params=object(raw);if(!params||this.terminal||params.threadId!==this.threadId)return[];
  if(method==='turn/completed'){
   const turn=object(params.turn);if(turn?.id!==this.turnId||!['completed','failed','interrupted'].includes(String(turn.status)))return[];
   const result:EngineEventPayload[]=[];
   for(const item of Array.isArray(turn.items)?turn.items:[])result.push(...this.item(item,true,true));
   if(turn.status==='completed'&&!this.finalText.size){
    const candidate=[...this.items.values()].filter(i=>i.type==='agentMessage'&&i.phase===null&&typeof i.text==='string').at(-1);
    if(candidate)result.push(...this.reply(candidate));
   }
   this.terminal=true;
   result.push({kind:'turn.status',state:turn.status==='completed'?'completed':turn.status==='interrupted'?'cancelled':'failed',reason:typeof object(turn.error)?.message==='string'?redact(object(turn.error)!.message as string):null});return result;
  }
  if(params.turnId!==this.turnId)return[];
  if(method==='item/started'||method==='item/completed')return this.item(params.item,method==='item/completed');
  if(typeof params.itemId!=='string'||typeof params.delta!=='string')return[];
  const text=redact(params.delta),item_id=params.itemId;
  if(method==='item/agentMessage/delta'){
   const item=this.items.get(item_id);if(!item||item.type!=='agentMessage'||this.finalText.has(item_id)||this.progressText.has(item_id))return[];
   if(item.phase==='commentary')return[{kind:'progress.delta',item_id,text}];
   if(item.phase==='final_answer')return[{kind:'reply.delta',item_id,text}];
  }
  if(method==='item/commandExecution/outputDelta'&&this.tools.has(item_id)&&!this.completedTools.has(item_id))return[{kind:'tool.output',item_id,text}];
  if(method==='item/reasoning/summaryTextDelta'&&!this.summaries.has(item_id))return[{kind:'reasoning.summary',item_id,mode:'append',text}];
  return[];
 }
 private reply(item:Item,authoritativeOrder=false):EngineEventPayload[]{
  if(typeof item.text!=='string')return[];const text=redact(item.text);
  if(this.finalText.get(item.id)===text&&!authoritativeOrder)return[];
  this.lastReply={kind:'reply.final',item_id:item.id,text,citations:[],artifact_ids:[]};
  if(this.finalText.get(item.id)===text)return[];this.finalText.set(item.id,text);
  return[structuredClone(this.lastReply)];
 }
 private item(raw:unknown,complete:boolean,terminalSnapshot=false):EngineEventPayload[]{
  const value=object(raw);if(!value||typeof value.id!=='string'||typeof value.type!=='string')return[];
  const item=value as Item;
  if(item.type==='agentMessage'){
   // Completion snapshots provide authoritative native ordering, including
   // nullable-phase candidates already observed on the live connection.
   if(terminalSnapshot)this.items.delete(item.id);
   this.items.set(item.id,{id:item.id,type:item.type,phase:item.phase,text:typeof item.text==='string'?redact(item.text):null});
   if(!complete)return[];
   if(item.phase==='commentary'&&typeof item.text==='string'){
    const text=redact(item.text);if(this.progressText.get(item.id)===text)return[];this.progressText.set(item.id,text);
    return[{kind:'progress.final',item_id:item.id,text}];
   }
   return item.phase==='final_answer'?this.reply(item,terminalSnapshot):[];
  }
  if(item.type==='reasoning'){
   // Never place raw reasoning content in any projection map.
   if(!complete||!Array.isArray(item.summary))return[];
   const text=redact(item.summary.filter((s):s is string=>typeof s==='string').join('\n'));
   if(this.summaries.get(item.id)===text)return[];this.summaries.set(item.id,text);
   return[{kind:'reasoning.summary',item_id:item.id,mode:'replace',text}];
  }
  if(!['commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall'].includes(item.type))return[];
  if(!complete){if(this.tools.has(item.id))return[];this.tools.add(item.id);return[{kind:'tool.started',item_id:item.id,name:item.type,command:typeof item.command==='string'?redact(item.command):null}];}
  if(this.completedTools.has(item.id))return[];this.completedTools.add(item.id);
  return[{kind:'tool.finished',item_id:item.id,status:item.status==='failed'?'failed':item.status==='declined'?'declined':'completed',exit_code:typeof item.exitCode==='number'&&Number.isInteger(item.exitCode)?item.exitCode:null}];
 }
}
