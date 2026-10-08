import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink,realpath,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assignmentSchema,idSchema,MAX_WIRE_BYTES,recoveryRequestSchema,recoveryResponseSchema,type AgentEvidence,type Assignment,type DeliveryEnvelope,type DeliveryInspection,type RecoveryCommand,type RecoveryResponse} from '@luoshu/protocol';
import {hashDelivery,hashAssignment,sha256,verifyDelivery} from '@luoshu/protocol/recovery-hash';
import {redact} from '@luoshu/config/security';
import {collectOutputSnapshot,withOutputRoot} from './files.js';
import {collectCodebaseResults,existingCodebaseWorkspace} from './codebase-workspace.js';
import type {WorkerState} from './state.js';
import type {CheckpointStore} from './checkpoints.js';

type ErrorCode='RECOVERY_NOT_FOUND'|'RECOVERY_UNAUTHORIZED'|'RECOVERY_STALE'|'RECOVERY_ACTIVE'|'DELIVERY_MISSING'|'DELIVERY_CORRUPT'|'RECOVERY_EXPIRED'|'RECOVERY_STOPPED'|'RECOVERY_UNAVAILABLE';
const fail=(code:ErrorCode,message:string)=>Object.assign(new Error(message),{code});
export interface WorkerDeliveryOptions {
 state:WorkerState;checkpoints:CheckpointStore;stateDir:string;
 isExecutionActive:(id:string)=>boolean;now?:()=>number;
}
interface PackageRow {delivery_id:string;relative_package_path:string;package_sha256:string}
interface OperationRow {fingerprint:string;status:string;result_json:string|null;expires_at:number}
export class WorkerDeliveryService {
 private readonly active=new Map<string,{purpose:DeliveryEnvelope['purpose'];controller:AbortController;promise:Promise<DeliveryEnvelope>}>();
 private readonly operations=new Map<string,Promise<RecoveryResponse>>();
 private closing=false;
 private now:()=>number;
 constructor(private readonly options:WorkerDeliveryOptions){
  this.now=options.now??Date.now;
  const cols=this.db.prepare('PRAGMA table_info(worker_recovery_operations)').all() as {name:string}[];
  if(!cols.some(x=>x.name==='result_json'))this.db.exec('ALTER TABLE worker_recovery_operations ADD COLUMN result_json TEXT');
  if(!cols.some(x=>x.name==='expires_at'))this.db.exec('ALTER TABLE worker_recovery_operations ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
  this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS worker_recovery_one_active ON worker_recovery_operations(execution_id) WHERE status='running'");
 }
 private get db(){return this.options.state.db;}
 private available(){if(this.closing)throw fail('RECOVERY_UNAVAILABLE','Delivery service is closed');}
 private assignment(id:string):Assignment{
  idSchema.parse(id);
  const row=this.db.prepare('SELECT assignment_json FROM worker_executions WHERE attempt_id=?').get(id) as {assignment_json:string}|undefined;
  if(!row)throw fail('RECOVERY_NOT_FOUND','Execution is not registered');
  return assignmentSchema.parse(JSON.parse(row.assignment_json));
 }
 private stopped(id:string):boolean{
  return !this.options.isExecutionActive(id)&&this.options.state.status(id)==='finished';
 }
 private assertStopped(id:string):void{
  this.assignment(id);
  if(!this.stopped(id))throw fail('RECOVERY_ACTIVE','Execution is active or unknown');
 }
 async inspect(executionId:string):Promise<DeliveryInspection>{
  this.available();this.assignment(executionId);
  const cp=this.options.checkpoints.read(executionId);
  const row=this.db.prepare('SELECT delivery_id,package_sha256 FROM worker_delivery_packages WHERE execution_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(executionId) as PackageRow|undefined;
  let hasWorkspace=false;
  try{const path=resolve(this.options.stateDir,'workspaces',executionId,'outputs');hasWorkspace=(await realpath(path))===path&&(await lstat(path)).isDirectory();}catch{}
  return {execution_id:executionId,checkpoint_version:cp?.version??null,agent_outcome:cp?.evidence?.outcome??'unknown',
   stopped:this.stopped(executionId),delivery_id:row?.delivery_id??null,package_sha256:row?.package_sha256??null,has_workspace:hasWorkspace};
 }
 async collect(executionId:string,purpose:DeliveryEnvelope['purpose'],signal?:AbortSignal,initialCodebases?:AgentEvidence['codebases']):Promise<DeliveryEnvelope>{
  this.available();this.assertStopped(executionId);signal?.throwIfAborted();
  const running=this.active.get(executionId);
  if(running){if(running.purpose!==purpose)throw fail('RECOVERY_ACTIVE','Another delivery purpose is active');return running.promise;}
  const controller=new AbortController();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const promise=this.collectOnce(executionId,purpose,controller.signal,initialCodebases);
  this.active.set(executionId,{purpose,controller,promise});
  try{return await promise;}finally{signal?.removeEventListener('abort',abort);this.active.delete(executionId);}
 }
 private async collectOnce(executionId:string,purpose:DeliveryEnvelope['purpose'],signal:AbortSignal,initialCodebases?:AgentEvidence['codebases']):Promise<DeliveryEnvelope>{
  const assignment=this.assignment(executionId);let cp=this.options.checkpoints.read(executionId);
  if(purpose==='execution_result'&&(!cp?.evidence||cp.evidence.outcome==='unknown'||cp.evidence.exit_code===null))
   throw fail('RECOVERY_UNAVAILABLE','Reliable Agent completion checkpoint is unavailable');
  let envelope:DeliveryEnvelope;
  try{
   if(purpose==='execution_result'&&assignment.codebases.length&&!cp!.evidence!.codebases.length){
    if(!assignment.run_id)throw Error('Codebase Run identity missing');
    const workspace=await existingCodebaseWorkspace(this.options.stateDir,assignment.run_id,assignment.codebases);
    const codebases=await collectCodebaseResults(workspace,assignment.codebases);
    signal.throwIfAborted();this.options.checkpoints.recordCodebases(executionId,codebases);cp=this.options.checkpoints.read(executionId);
   }
   const snapshot=await collectOutputSnapshot(resolve(this.options.stateDir,'workspaces',executionId,'outputs'),signal);
   const files=snapshot.files;
   if(purpose==='recovered_artifacts'&&!files.length)throw fail('DELIVERY_MISSING','No saved output artifacts');
   const evidence=purpose==='execution_result'?
    initialCodebases&&cp!.stage==='agent_finished'&&!cp!.error_code?
      this.options.checkpoints.bindCollectedEvidence(executionId,snapshot.source_sha256,initialCodebases):cp!.evidence
    :null;
   const binding=evidence?.outcome==='succeeded'&&evidence.output_snapshot_sha256===snapshot.source_sha256?'same_snapshot':'unbound';
   const input:Omit<DeliveryEnvelope,'package_sha256'>={
    execution_id:executionId,delivery_id:randomUUID(),assignment_sha256:hashAssignment(assignment),
    checkpoint_version:cp?.version??0,purpose,agent:assignment.agent,evidence,
    manifest:files.map((file,index)=>{const bytes=Buffer.from(file.content_base64,'base64');return {file_key:'file_'+index,name:file.name,mime_type:file.mime_type,size_bytes:bytes.length,sha256:sha256(bytes)};}),
    files,verification_binding:binding,
   };
   envelope=verifyDelivery({...input,package_sha256:hashDelivery(input)});
   await this.writePackage(envelope,signal);
   signal.throwIfAborted();this.assertStopped(executionId);
   this.db.transaction(()=>{
    this.db.prepare('INSERT INTO worker_delivery_packages(delivery_id,execution_id,purpose,manifest_json,evidence_json,package_sha256,relative_package_path,created_at) VALUES(?,?,?,?,?,?,?,?)')
     .run(envelope.delivery_id,executionId,purpose,JSON.stringify(envelope.manifest),evidence?JSON.stringify(evidence):null,envelope.package_sha256,this.relativePath(executionId,envelope.delivery_id),this.now());
    if(cp)this.options.checkpoints.markDeliveryReady(executionId,envelope.delivery_id,snapshot.source_sha256);
   })();
  }catch(error){
   if(cp)this.options.checkpoints.collectionFailed(executionId,signal.aborted?'RECOVERY_STOPPED':'COLLECT_FAILED');
   throw error;
  }
  return envelope;
 }
 private relativePath(executionId:string,deliveryId:string){idSchema.parse(executionId);idSchema.parse(deliveryId);return join('deliveries',executionId,deliveryId+'.json');}
 private async packageDirectory(executionId:string){
  const dir=resolve(this.options.stateDir,'deliveries',executionId);
  await mkdir(dir,{recursive:true,mode:0o700});
  if(await realpath(dir)!==dir)throw fail('DELIVERY_CORRUPT','Delivery directory contains symbolic links');
  return dir;
 }
 private async writePackage(envelope:DeliveryEnvelope,signal:AbortSignal){
  const directory=await this.packageDirectory(envelope.execution_id);
  return withOutputRoot(directory,async root=>{
  const dir='/proc/self/fd/'+root.fd,final=join(dir,envelope.delivery_id+'.json'),temp=join(dir,randomUUID()+'.tmp');
  const handle=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(envelope));await handle.sync();}finally{await handle.close();}
  try{
   signal.throwIfAborted();
   await link(temp,final); // atomic no-overwrite publication
   await unlink(temp);
   await root.sync();
  }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  });
 }
 async resend(executionId:string,deliveryId:string):Promise<DeliveryEnvelope>{
  this.available();this.assertStopped(executionId);
  const expected=this.relativePath(executionId,deliveryId);
  const row=this.db.prepare('SELECT * FROM worker_delivery_packages WHERE execution_id=? AND delivery_id=?').get(executionId,deliveryId) as PackageRow|undefined;
  if(!row)throw fail('DELIVERY_MISSING','Delivery package is missing');
  if(row.relative_package_path!==expected)throw fail('DELIVERY_CORRUPT','Delivery package path mismatch');
  const directory=resolve(this.options.stateDir,'deliveries',executionId);
  return withOutputRoot(directory,async root=>{
  const path=join('/proc/self/fd/'+root.fd,deliveryId+'.json');
  let handle;
  try{
   handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const info=await handle.stat();
   if(!info.isFile()||info.nlink!==1||info.size>MAX_WIRE_BYTES)throw new Error('Invalid package file');
   const bytes=Buffer.alloc(info.size+1);let count=0;
   while(count<bytes.length){const chunk=await handle.read(bytes,count,bytes.length-count,count);if(!chunk.bytesRead)break;count+=chunk.bytesRead;}
   if(count!==info.size)throw new Error('Package changed');
   const envelope=verifyDelivery(JSON.parse(bytes.subarray(0,count).toString('utf8')));
   if(envelope.execution_id!==executionId||envelope.delivery_id!==deliveryId||envelope.package_sha256!==row.package_sha256||envelope.assignment_sha256!==hashAssignment(this.assignment(executionId)))throw new Error('Package identity hash mismatch');
   return envelope;
  }catch(error){throw fail('DELIVERY_CORRUPT','Delivery package is corrupt or unavailable');}
  finally{await handle?.close();}
  });
 }
 async handle(raw:RecoveryCommand):Promise<RecoveryResponse>{
  const command=recoveryRequestSchema.parse(raw);
  const fields={type:'execution_recovery_response' as const,request_id:command.request_id,operation_id:command.operation_id,execution_id:command.execution_id,connection_generation:command.connection_generation};
  const errorResponse=(code:ErrorCode,message:string):RecoveryResponse=>({...fields,error:{code,message:redact(message).slice(0,2000)}});
  let fingerprint:string;
  try{
   this.available();this.assertStopped(command.execution_id);
   if(hashAssignment(this.assignment(command.execution_id))!==command.assignment_sha256)throw fail('RECOVERY_UNAUTHORIZED','Execution assignment mismatch');
   fingerprint=sha256(JSON.stringify(command));
   const prior=this.db.prepare('SELECT * FROM worker_recovery_operations WHERE operation_id=?').get(command.operation_id) as OperationRow|undefined;
   if(prior){
    if(prior.fingerprint!==fingerprint)throw fail('RECOVERY_UNAUTHORIZED','Recovery operation conflict');
    if(prior.expires_at<=this.now())throw fail('RECOVERY_EXPIRED','Recovery authorization expired');
    if(prior.result_json)return recoveryResponseSchema.parse(JSON.parse(prior.result_json));
    const active=this.operations.get(command.operation_id);if(active)return active;
    throw fail('RECOVERY_STALE','Interrupted recovery requires a fresh authorized operation');
   }
   const cp=this.options.checkpoints.read(command.execution_id);
   if(command.expected_checkpoint_version!==null&&command.expected_checkpoint_version!==cp?.version)throw fail('RECOVERY_STALE','Checkpoint version changed');
   this.db.transaction(()=>{
   this.db.prepare("UPDATE worker_recovery_operations SET status='failed',error_code='RECOVERY_EXPIRED' WHERE status='running' AND expires_at<=?").run(this.now());
   if(this.db.prepare("SELECT 1 FROM worker_recovery_operations WHERE execution_id=? AND status='running'").get(command.execution_id))throw fail('RECOVERY_ACTIVE','Another recovery operation is active');
   if((this.db.prepare("SELECT COUNT(*) n FROM worker_recovery_operations WHERE status='running'").get() as {n:number}).n>=2)throw fail('RECOVERY_ACTIVE','Delivery recovery capacity is busy');
   this.db.prepare('INSERT INTO worker_recovery_operations(operation_id,request_id,execution_id,action,fingerprint,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(command.operation_id,command.request_id,command.execution_id,command.action,fingerprint,'running',this.now(),this.now(),this.now()+command.lease_ms);
   })();
  }catch(error){const code=(error as {code?:ErrorCode}).code??'RECOVERY_UNAVAILABLE';return errorResponse(code,error instanceof Error?error.message:'Recovery unavailable');}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort('authorization expired'),command.lease_ms);timer.unref();
  const work=(async():Promise<RecoveryResponse>=>{
   try{
    const delivery=command.action==='inspect_result'?null:command.action==='resend_result'?await this.resend(command.execution_id,command.delivery_id!):await this.collect(command.execution_id,command.action==='recover_artifacts'?'recovered_artifacts':'execution_result',controller.signal);
    controller.signal.throwIfAborted();
    const inspection=await this.inspect(command.execution_id);
    if(delivery){inspection.delivery_id=delivery.delivery_id;inspection.package_sha256=delivery.package_sha256;}
    return recoveryResponseSchema.parse({...fields,inspection,delivery});
   }catch(error){return errorResponse(controller.signal.aborted?'RECOVERY_EXPIRED':(error as {code?:ErrorCode}).code??'RECOVERY_UNAVAILABLE',error instanceof Error?error.message:'Recovery unavailable');}
  })();
  this.operations.set(command.operation_id,work);
  try{
   const result=await work;
   this.db.prepare('UPDATE worker_recovery_operations SET status=?,result_json=?,updated_at=? WHERE operation_id=?').run('error'in result?'failed':'succeeded',JSON.stringify(result),this.now(),command.operation_id);
   return result;
  }finally{clearTimeout(timer);this.operations.delete(command.operation_id);}
 }
 markImported(executionId:string,deliveryId:string,hash:string):void{
  const row=this.db.prepare('SELECT package_sha256 FROM worker_delivery_packages WHERE execution_id=? AND delivery_id=?').get(executionId,deliveryId) as {package_sha256:string}|undefined;
  if(!row||row.package_sha256!==hash)throw fail('DELIVERY_CORRUPT','Imported receipt hash mismatch');
  this.db.prepare('UPDATE worker_delivery_packages SET imported_at=COALESCE(imported_at,?) WHERE delivery_id=?').run(this.now(),deliveryId);
 }
 async close(){this.closing=true;for(const active of this.active.values())active.controller.abort('closed');await Promise.allSettled([...this.active.values()].map(x=>x.promise));await Promise.allSettled(this.operations.values());}
 activeRecoveryIds(){return [...this.active.keys()];}
 async stop(executionId:string){const active=this.active.get(executionId);active?.controller.abort('stopped');await active?.promise.catch(()=>undefined);}
}
