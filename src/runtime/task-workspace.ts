import type Database from 'better-sqlite3';
import {z} from 'zod';
import {CodexAppServerPool} from '../engines/codex-pool.js';
import type {CodexAppServerClient} from '../engines/codex-rpc.js';
import {nativePermissions} from '../engines/native-permissions.js';
import {redact} from '../shared/security.js';
import type {CodexResult} from './codex.js';

export interface TaskWorkspaceInput {
 stateDir:string;db?:Database.Database;executionId:string;cwd:string;read:string[];write:string[];
 prompt:string;signal:AbortSignal;executable?:string;onProgress?:(text:string)=>void;onSession?:(id:string)=>void;
 rpcFactory?:(id:string)=>CodexAppServerClient;
}
const terminal=z.object({threadId:z.string(),turn:z.object({id:z.string(),status:z.enum(['completed','failed','interrupted'])})});
const threadResult=z.object({thread:z.object({id:z.string(),turns:z.array(z.object({id:z.string(),status:z.string(),items:z.array(z.record(z.string(),z.unknown())).default([])}))})});

/** A local, reversible task envelope. It never uses the device's full-access
 * setting, credential helper, inherited tools or native permission escalation. */
export async function runTaskWorkspace(input:TaskWorkspaceInput):Promise<CodexResult>{
 input.signal.throwIfAborted();
 let submitStarted=false,threadId:string|undefined,turnId:string|undefined;
 let resolveEnd!:(value:z.infer<typeof terminal>)=>void,rejectEnd!:(error:unknown)=>void;
 const ended=new Promise<z.infer<typeof terminal>>((resolve,reject)=>{resolveEnd=resolve;rejectEnd=reject;});
 void ended.catch(()=>{});
 const early=new Map<string,z.infer<typeof terminal>>();
 const abort=()=>rejectEnd(Error('Task execution cancelled'));
 const notification=(method:string,params:unknown)=>{
   if(method==='turn/completed'){
    const parsed=terminal.safeParse(params);if(!parsed.success)return;
    const value=parsed.data;
    if(value.threadId===threadId&&value.turn.id===turnId)resolveEnd(value);
    else if(early.size<16)early.set(value.threadId+':'+value.turn.id,value);
   }
 };
 const pool=new CodexAppServerPool({stateDir:input.stateDir,db:input.db,executable:input.executable,rpcFactory:input.rpcFactory,
  onClosed:()=>rejectEnd(Error('Task runtime disconnected; outcome requires reconciliation'))});
 input.signal.addEventListener('abort',abort,{once:true});
 try{
  const current=()=>input.signal.throwIfAborted();
  const client=pool.client('task:'+input.executionId);
  client.onNotification=notification;
  await client.initialize({clientInfo:{name:'luoshu-task-workspace',version:'1'},capabilities:{experimentalApi:true}});current();
  const runtime=await client.runtimeExecutable();current();
  const permissions=nativePermissions({session:input.executionId,cwd:input.cwd,runtime,read:input.read,write:input.write});
  await client.assertPermissionProfileAvailable(input.cwd,permissions.id);current();
  const config=await client.taskThreadConfig(input.cwd);current();
  const thread=await client.startThread({cwd:input.cwd,permissionScope:permissions,serviceName:'luoshu-task',
   config,
   developerInstructions:'Complete only the supplied task using the supplied files and Codebases. Network access and extra tools are disabled. Do not publish, deploy, send messages, access credentials or expand permissions. Report any missing scope to the user.'});
  current();threadId=thread.id;input.onSession?.(threadId);
  // A lost acknowledgement is fenced even if the process is subsequently
  // terminated. This execution ID must never start a second native turn.
  submitStarted=true;
  const turn=await client.startTurn({threadId,input:[{type:'text',text:input.prompt}],permissions:permissions.id,runtimeWorkspaceRoots:permissions.runtimeWorkspaceRoots});
  turnId=turn.id;current();
  const saved=early.get(threadId+':'+turnId);if(saved)resolveEnd(saved);
  const outcome=await ended;current();
  if(outcome.turn.status==='interrupted')throw Error('Task execution stopped');
  const result=threadResult.parse(await client.readThread({threadId,includeTurns:true}));current();
  const final=result.thread.id===threadId?result.thread.turns.find(item=>item.id===turnId):undefined;
  if(!final||final.status!==outcome.turn.status)throw Error('Task terminal receipt identity differs from native execution');
  const summary=redact(final.items.filter(item=>item.type==='agentMessage'&&typeof item.text==='string').map(item=>item.text).join('\n\n')).slice(0,16_000);
  const checks=final.items.flatMap(item=>item.type==='commandExecution'&&typeof item.command==='string'&&Number.isInteger(item.exitCode)?[{command:redact(item.command).slice(0,2000),exit_code:item.exitCode as number,output:''}]:[]).slice(0,50);
  if(summary)input.onProgress?.(summary);
  return{exitCode:outcome.turn.status==='completed'&&summary.trim()?0:1,summary:summary||'Task execution did not return a final report',checks,events:[],argv:[],sessionId:threadId};
 }catch(error){
  if(input.signal.aborted)return{exitCode:130,summary:'Task execution cancelled',checks:[],events:[],argv:[],sessionId:threadId};
  throw Object.assign(error instanceof Error?error:Error(String(error)),submitStarted?{executionUnknown:true}:{executionStopped:true});
 }finally{
  input.signal.removeEventListener('abort',abort);
  // NativeUnitRegistry and the RPC client's systemd supervisor independently
  // confirm process exit, including background children, before releasing work.
  try{await pool.close();}catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{executionUnknown:true});}
 }
}
