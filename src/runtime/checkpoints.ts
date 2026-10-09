import type Database from 'better-sqlite3';
import {agentEvidenceSchema,assignmentSchema,idSchema,type AgentEvidence,type Assignment,type CodebaseExecutionResult} from '../protocol/index.js';
import {hashAssignment} from '../protocol/recovery-hash.js';
import {redact} from '../shared/security.js';
export interface WorkerCheckpoint {
 execution_id:string;assignment_sha256:string;version:number;
 stage:'started'|'agent_finished'|'collecting'|'delivery_ready'|'delivery_failed';
 evidence:AgentEvidence|null;session_id:string|null;source_snapshot_sha256:string|null;
 current_delivery_id:string|null;error_code:string|null;updated_at:number;
}
type Row=Omit<WorkerCheckpoint,'evidence'>&{evidence_json:string|null};
export class CheckpointStore{
 constructor(readonly db:Database.Database,readonly now=Date.now){db.exec(`
 CREATE TABLE IF NOT EXISTS worker_checkpoints(execution_id TEXT PRIMARY KEY,assignment_sha256 TEXT NOT NULL,version INTEGER NOT NULL,stage TEXT NOT NULL,evidence_json TEXT,source_snapshot_sha256 TEXT,current_delivery_id TEXT,error_code TEXT,updated_at INTEGER NOT NULL,FOREIGN KEY(execution_id) REFERENCES worker_executions(attempt_id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS worker_delivery_packages(delivery_id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,purpose TEXT NOT NULL,manifest_json TEXT NOT NULL,evidence_json TEXT,package_sha256 TEXT NOT NULL,relative_package_path TEXT NOT NULL,imported_at INTEGER,created_at INTEGER NOT NULL,FOREIGN KEY(execution_id) REFERENCES worker_executions(attempt_id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS worker_recovery_operations(operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,execution_id TEXT NOT NULL,action TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,delivery_id TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(execution_id) REFERENCES worker_executions(attempt_id) ON DELETE CASCADE);
 `);
 const columns=db.prepare('PRAGMA table_info(worker_checkpoints)').all() as {name:string}[];
 if(!columns.some(c=>c.name==='session_id'))db.exec('ALTER TABLE worker_checkpoints ADD COLUMN session_id TEXT');
 }

 begin(raw:Assignment):WorkerCheckpoint{
  return this.db.transaction(()=>{
   const assignment=assignmentSchema.parse(raw);
   const start=this.db.prepare('SELECT assignment_json FROM worker_executions WHERE attempt_id=?').get(assignment.attempt_id) as {assignment_json:string}|undefined;
   if(!start)throw new Error('Execution is not registered');
   const hash=hashAssignment(assignment);
   if(hashAssignment(assignmentSchema.parse(JSON.parse(start.assignment_json)))!==hash)throw new Error('Checkpoint assignment conflict');
   const prior=this.read(assignment.attempt_id);
   if(prior){if(prior.assignment_sha256!==hash)throw new Error('Checkpoint assignment conflict');return prior;}
   this.db.prepare("INSERT INTO worker_checkpoints(execution_id,assignment_sha256,version,stage,updated_at) VALUES(?,?,1,'started',?)").run(assignment.attempt_id,hash,this.now());
   return this.read(assignment.attempt_id)!;
  })();
 }
 read(executionId:string):WorkerCheckpoint|null{
  idSchema.parse(executionId);
  const row=this.db.prepare('SELECT * FROM worker_checkpoints WHERE execution_id=?').get(executionId) as Row|undefined;
  if(!row)return null;
  const {evidence_json,...value}=row;
  return {...value,evidence:evidence_json?agentEvidenceSchema.parse(JSON.parse(evidence_json)):null};
 }
 agentFinished(executionId:string,evidence:AgentEvidence):WorkerCheckpoint{
  return this.db.transaction(()=>{
   const current=this.read(executionId);if(!current)throw new Error('Checkpoint has not started');
   const clean=agentEvidenceSchema.parse({...evidence,session_id:evidence.session_id??current.session_id,
    summary:redact(evidence.summary),checks:evidence.checks.map(({command,exit_code})=>({command:redact(command),exit_code}))});
   if(current.evidence){if(JSON.stringify(current.evidence)!==JSON.stringify(clean))throw new Error('Checkpoint evidence conflict');return current;}
   this.db.prepare("UPDATE worker_checkpoints SET version=version+1,stage='agent_finished',evidence_json=?,session_id=?,error_code=NULL,updated_at=? WHERE execution_id=?").run(JSON.stringify(clean),clean.session_id,this.now(),executionId);
   return this.read(executionId)!;
  })();
 }
 recordSession(executionId:string,sessionId:string):void{
  const current=this.read(executionId);if(!current)throw new Error('Checkpoint has not started');
  if(!sessionId||sessionId.length>200)throw new Error('Invalid Agent session ID');
  if(current.session_id===sessionId)return;
  if(current.session_id||current.evidence)throw new Error('Checkpoint session conflict');
  this.db.prepare('UPDATE worker_checkpoints SET session_id=?,version=version+1,updated_at=? WHERE execution_id=?').run(sessionId,this.now(),executionId);
 }
 collectionFailed(executionId:string,errorCode:string):void{
  if(!this.read(executionId))throw new Error('Checkpoint has not started');
  this.db.prepare("UPDATE worker_checkpoints SET version=version+1,stage='delivery_failed',error_code=?,updated_at=? WHERE execution_id=?").run(errorCode,this.now(),executionId);
 }
 bindCollectedEvidence(executionId:string,sourceHash:string,codebases:CodebaseExecutionResult[]):AgentEvidence{
  const current=this.read(executionId);
  if(!current?.evidence||current.stage!=='agent_finished'||current.error_code||current.evidence.output_snapshot_sha256)
   throw new Error('Evidence cannot be rebound');
  const next=agentEvidenceSchema.parse({...current.evidence,output_snapshot_sha256:sourceHash,codebases});
  this.db.prepare('UPDATE worker_checkpoints SET evidence_json=?,source_snapshot_sha256=?,version=version+1,updated_at=? WHERE execution_id=?')
   .run(JSON.stringify(next),sourceHash,this.now(),executionId);
  return next;
 }
 recordCodebases(executionId:string,codebases:CodebaseExecutionResult[]):void{
  const current=this.read(executionId);
  if(!current?.evidence||current.current_delivery_id||current.evidence.output_snapshot_sha256)throw Error('Codebase evidence cannot be rebound');
  const next=agentEvidenceSchema.parse({...current.evidence,codebases});
  if(current.evidence.codebases.length&&JSON.stringify(current.evidence.codebases)!==JSON.stringify(codebases))throw Error('Codebase evidence conflict');
  this.db.prepare('UPDATE worker_checkpoints SET evidence_json=?,version=version+1,updated_at=? WHERE execution_id=?').run(JSON.stringify(next),this.now(),executionId);
 }
 markDeliveryReady(executionId:string,deliveryId:string,sourceHash:string|null):void{
  if(!this.read(executionId))throw new Error('Checkpoint has not started');
  this.db.prepare("UPDATE worker_checkpoints SET version=version+1,stage='delivery_ready',current_delivery_id=?,source_snapshot_sha256=?,error_code=NULL,updated_at=? WHERE execution_id=?").run(deliveryId,sourceHash,this.now(),executionId);
 }
}
