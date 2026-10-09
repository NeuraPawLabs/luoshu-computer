import type Database from 'better-sqlite3';
import {isAbsolute,normalize} from 'node:path';
import {engineBindingSchema,engineSubmissionSchema,nativeCommandReceiptSchema,type NativeCommandReceipt,type EngineBinding,type EngineSubmission,type EngineEventPayload} from '../protocol/index.js';
import type {NativePolicy} from './codex-policy.js';
import {isDeepStrictEqual} from 'node:util';
import {nativeCheckReceiptSchema,type NativeCheckReceipt} from '../protocol/index.js';

export type CodexBinding=Omit<EngineBinding,'engine'>&{engine:Extract<EngineBinding['engine'],{kind:'device'}>};
export type SubmissionStatus='prepared'|'starting'|'running'|'stopping'|'unknown'|'completed'|'failed'|'cancelled';
export interface SessionRow {session_key:string;binding_json:string;developer_instructions:string;policy_json:string|null;thread_id:string|null;session_tree_id:string|null;cwd:string;native_status:'idle'|'creating'|'unknown'|'closed';created_at:number;updated_at:number}
export interface SubmissionRow {submission_id:string;session_key:string;input_sha256:string;thread_id:string|null;turn_id:string|null;status:SubmissionStatus;created_at:number;updated_at:number}
export interface NativeTurnResult {status:'completed'|'failed'|'cancelled';replies:Extract<EngineEventPayload,{kind:'reply.final'}>[];reason:string|null}
const busy=()=>Object.assign(Error('Codex session has an active or unresolved native turn'),{code:'CODEX_SESSION_BUSY'});
const terminal=new Set<SubmissionStatus>(['completed','failed','cancelled']);

/** Local authority/journal only. Never stores raw native output or credentials. */
export class CodexSessionStore {
 constructor(private readonly db:Database.Database){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_native_sessions'").get()&&['binding_json','developer_instructions','policy_json'].some(name=>!(db.prepare('PRAGMA table_info(codex_native_sessions)').all() as {name:string}[]).some(c=>c.name===name)))throw Error('CODEX_SESSION_SCHEMA_UNSUPPORTED: prepare a current development database; no automatic migration');
  db.exec(`CREATE TABLE IF NOT EXISTS codex_native_sessions(
   session_key TEXT PRIMARY KEY,binding_json TEXT NOT NULL,thread_id TEXT UNIQUE,session_tree_id TEXT,cwd TEXT NOT NULL,
   native_status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,developer_instructions TEXT NOT NULL,policy_json TEXT);
   CREATE TABLE IF NOT EXISTS codex_native_submissions(
   submission_id TEXT PRIMARY KEY,session_key TEXT NOT NULL REFERENCES codex_native_sessions(session_key) ON DELETE CASCADE,
   input_sha256 TEXT NOT NULL,thread_id TEXT,turn_id TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS codex_one_unresolved_submission ON codex_native_submissions(session_key)
    WHERE status IN ('prepared','starting','running','stopping','unknown');
   CREATE UNIQUE INDEX IF NOT EXISTS codex_turn_identity ON codex_native_submissions(thread_id,turn_id) WHERE turn_id IS NOT NULL;
   CREATE TABLE IF NOT EXISTS codex_native_turn_results(submission_id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL REFERENCES codex_native_sessions(session_key),submission_json TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,result_json TEXT);
   CREATE TABLE IF NOT EXISTS codex_cancelled_preparations(submission_id TEXT PRIMARY KEY,submission_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_preparation_leases(submission_id TEXT PRIMARY KEY REFERENCES codex_native_turn_results(submission_id),deadline INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_native_submission_policies(submission_id TEXT PRIMARY KEY REFERENCES codex_native_submissions(submission_id),thread_id TEXT NOT NULL,policy_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_native_command_receipts(submission_id TEXT NOT NULL REFERENCES codex_native_submissions(submission_id),item_id TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(submission_id,item_id));
   CREATE TABLE IF NOT EXISTS codex_native_check_receipts(submission_id TEXT NOT NULL REFERENCES codex_native_submissions(submission_id),check_id TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(submission_id,check_id));
   CREATE TABLE IF NOT EXISTS codex_closed_bindings(session_key TEXT PRIMARY KEY,binding_json TEXT NOT NULL,closed_at INTEGER);
   CREATE TABLE IF NOT EXISTS codex_session_unsubscriptions(session_key TEXT PRIMARY KEY REFERENCES codex_closed_bindings(session_key),binding_json TEXT NOT NULL,thread_id TEXT,completed_at INTEGER NOT NULL);`);
 }
 session(key:string):SessionRow|undefined{return this.db.prepare('SELECT * FROM codex_native_sessions WHERE session_key=?').get(key) as SessionRow|undefined;}
 binding(key:string):CodexBinding{const row=this.session(key);if(!row)throw Error('Codex session binding not found');return JSON.parse(row.binding_json);}
 ensure(binding:CodexBinding,key:string,cwd:string,instructions?:string):SessionRow{
  this.assertSessionOpen(key);
  if(!isAbsolute(cwd)||normalize(cwd)!==cwd)throw Error('Codex workspace must be an absolute normalized path');
  const parsed=engineBindingSchema.parse(binding);if(parsed.engine.kind!=='device')throw Error('Codex requires a device binding');
  const json=JSON.stringify(parsed),current=this.session(key),now=Date.now();
  if(current){if(current.binding_json!==json||current.cwd!==cwd||instructions!==undefined&&current.developer_instructions!==instructions)throw Error('Codex session binding revision, instructions or workspace changed');if(current.native_status==='closed')throw Error('Codex session binding is closed');return current;}
  this.db.prepare("INSERT INTO codex_native_sessions VALUES(?,?,NULL,NULL,?,'idle',?,?,?,NULL)").run(key,json,cwd,now,now,instructions??'');return this.session(key)!;
 }
 closedBinding(key:string):{binding_json:string;closed_at:number|null}|undefined{return this.db.prepare('SELECT binding_json,closed_at FROM codex_closed_bindings WHERE session_key=?').get(key) as {binding_json:string;closed_at:number|null}|undefined;}
 assertSessionOpen(key:string):void{if(this.closedBinding(key))throw Error('Codex session binding is revoked or closed');}
 revokeSession(key:string,binding:CodexBinding):void{
  const json=JSON.stringify(engineBindingSchema.parse(binding));
  this.db.transaction(()=>{
   const session=this.session(key),prior=this.closedBinding(key);
   if(session&&session.binding_json!==json||prior&&prior.binding_json!==json)throw Error('Codex session close binding mismatch');
   this.db.prepare('INSERT OR IGNORE INTO codex_closed_bindings VALUES(?,?,NULL)').run(key,json);
  })();
 }
 unsubscribed(key:string):boolean{
  const receipt=this.db.prepare('SELECT binding_json,thread_id FROM codex_session_unsubscriptions WHERE session_key=?').get(key) as {binding_json:string;thread_id:string|null}|undefined;
  if(!receipt)return false;
  const revoked=this.closedBinding(key),session=this.session(key);
  if(!revoked||revoked.binding_json!==receipt.binding_json||session&&session.binding_json!==receipt.binding_json||receipt.thread_id!==(session?.thread_id??null))throw Error('Native unsubscribe receipt binding or thread changed');
  return true;
 }
 finishSessionUnsubscribe(key:string,threadId:string|null):void{
  this.db.transaction(()=>{
   const revoked=this.closedBinding(key),session=this.session(key);
   if(!revoked||this.active(key)||session&&session.binding_json!==revoked.binding_json||threadId!==(session?.thread_id??null)||session&&!threadId&&session.native_status!=='idle')throw Error('Native unsubscribe binding or thread remains unresolved');
   if(this.unsubscribed(key))return;
   this.db.prepare('INSERT INTO codex_session_unsubscriptions VALUES(?,?,?,?)').run(key,revoked.binding_json,threadId,Date.now());
  })();
 }
 finishSessionClose(key:string,finalizeResources:()=>void=()=>{}):void{
  this.db.transaction(()=>{
   if(!this.closedBinding(key)||this.active(key))throw Error('Codex session has active or unresolved work');
   if(!this.unsubscribed(key))throw Error('Native unsubscribe phase is not confirmed');
   if(this.closedBinding(key)!.closed_at!==null)return;
   // Resource owners share this transaction. A failure must retain both their
   // recovery data and ours; filesystem removal is idempotent on retry.
   finalizeResources();
   for(const table of ['codex_native_command_receipts','codex_native_check_receipts','codex_native_submission_policies']){
    this.db.prepare(`DELETE FROM ${table} WHERE submission_id IN (SELECT submission_id FROM codex_native_submissions WHERE session_key=?)`).run(key);
   }
   this.db.prepare('DELETE FROM codex_preparation_leases WHERE submission_id IN (SELECT submission_id FROM codex_native_turn_results WHERE session_key=?)').run(key);
   this.db.prepare('DELETE FROM codex_native_submissions WHERE session_key=?').run(key);
   this.db.prepare('DELETE FROM codex_native_turn_results WHERE session_key=?').run(key);
   this.db.prepare("DELETE FROM codex_cancelled_preparations WHERE json_extract(submission_json,'$.session_id')=?").run(key);
   this.db.prepare("UPDATE codex_native_sessions SET native_status='closed',developer_instructions='',policy_json=NULL,updated_at=? WHERE session_key=?").run(Date.now(),key);
   this.db.prepare('UPDATE codex_closed_bindings SET closed_at=? WHERE session_key=?').run(Date.now(),key);
  })();
 }
 submission(id:string):SubmissionRow|undefined{return this.db.prepare('SELECT * FROM codex_native_submissions WHERE submission_id=?').get(id) as SubmissionRow|undefined;}
 active(key:string):SubmissionRow|undefined{return this.db.prepare("SELECT * FROM codex_native_submissions WHERE session_key=? AND status IN ('prepared','starting','running','stopping','unknown')").get(key) as SubmissionRow|undefined;}
 activeCount():number{return(this.db.prepare("SELECT COUNT(*) AS n FROM codex_native_submissions WHERE status IN ('prepared','starting','running','stopping','unknown')").get() as {n:number}).n;}
 canUnload(ignoreRevoked=false):boolean{
  if(this.activeCount())return false;
  return !this.db.prepare(`SELECT 1 FROM codex_native_sessions s WHERE s.native_status!='closed' AND
   (?=0 OR NOT EXISTS(SELECT 1 FROM codex_closed_bindings b WHERE b.session_key=s.session_key)) AND
   (s.native_status!='idle' OR NOT EXISTS(SELECT 1 FROM codex_native_submissions p WHERE p.session_key=s.session_key AND p.turn_id IS NOT NULL AND p.status IN ('completed','failed','cancelled'))) LIMIT 1`).get(ignoreRevoked?1:0);
 }
 reserve(binding:CodexBinding,key:string,cwd:string,id:string,digest:string):{row:SubmissionRow;created:boolean}{
  return this.db.transaction(()=>{
   this.assertPreparationAllowed(id);
   const session=this.ensure(binding,key,cwd),prior=this.submission(id);
   if(prior){if(prior.session_key!==key||prior.input_sha256!==digest)throw Error('Codex submission conflict');return{row:prior,created:false};}
   if(this.active(key)||session.native_status!=='idle')throw busy();
   const now=Date.now();this.db.prepare("INSERT INTO codex_native_submissions VALUES(?,?,?,?,NULL,'prepared',?,?)").run(id,key,digest,session.thread_id,now,now);
   return{row:this.submission(id)!,created:true};
  })();
 }
 beginThread(key:string,submissionId?:string):SessionRow{
  this.assertSessionOpen(key);
  return this.db.transaction(()=>{
   const session=this.session(key);if(!session||session.native_status!=='idle')throw busy();
   const active=this.active(key);if(active&&active.submission_id!==submissionId)throw busy();
   this.db.prepare("UPDATE codex_native_sessions SET native_status='creating',updated_at=? WHERE session_key=?").run(Date.now(),key);return session;
  })();
 }
 attachThread(key:string,threadId:string,treeId:string|null):void{
  const current=this.session(key);if(!threadId||!current||current.native_status!=='creating'||current.thread_id&&current.thread_id!==threadId)throw Error('Codex native thread identity conflict');
  this.db.prepare("UPDATE codex_native_sessions SET thread_id=?,session_tree_id=?,native_status='idle',updated_at=? WHERE session_key=?").run(threadId,treeId??current.session_tree_id,Date.now(),key);
 }
 attachConfiguredThread(key:string,threadId:string,treeId:string|null,policy:NativePolicy,replaceScopeFrom?:NativePolicy):void{
  this.db.transaction(()=>{
   const session=this.session(key);if(!session)throw Error('Native session missing');
   if(session.policy_json){
    const prior=JSON.parse(session.policy_json) as NativePolicy;
    // A Worker sandbox-mode change intentionally replaces permissions and the
    // returned sandbox shape. Model/provider/approval metadata remains pinned.
    const fixed=(p:NativePolicy)=>{const {permissions:_,sandbox:__,...other}=p;return other;};
    if(replaceScopeFrom? !isDeepStrictEqual(prior,replaceScopeFrom)||!isDeepStrictEqual(fixed(prior),fixed(policy))||prior.permissions.runtime!==policy.permissions.runtime:!isDeepStrictEqual(prior,policy))throw Error('Native model or policy configuration changed');
   }
   this.attachThread(key,threadId,treeId);
   this.db.prepare('UPDATE codex_native_sessions SET policy_json=? WHERE session_key=?').run(JSON.stringify(policy),key);
  })();
 }
 unknownThread(key:string):void{this.db.prepare("UPDATE codex_native_sessions SET native_status='unknown',updated_at=? WHERE session_key=? AND native_status='creating'").run(Date.now(),key);}
 start(id:string,threadId:string):void{
  const row=this.submission(id);if(!row||row.status!=='prepared'||this.session(row.session_key)?.thread_id!==threadId)throw Error('Codex submission cannot start');
  this.db.transaction(()=>{
   const policy=this.session(row.session_key)?.policy_json;if(!policy)throw Error('Native execution policy is not pinned');
   this.db.prepare('INSERT INTO codex_native_submission_policies VALUES(?,?,?)').run(id,threadId,policy);
   this.db.prepare("UPDATE codex_native_submissions SET thread_id=?,status='starting',updated_at=? WHERE submission_id=?").run(threadId,Date.now(),id);
  })();
 }
 submissionPolicy(id:string):{thread_id:string;policy:NativePolicy}|null{
  const row=this.db.prepare('SELECT thread_id,policy_json FROM codex_native_submission_policies WHERE submission_id=?').get(id) as {thread_id:string;policy_json:string}|undefined;
  return row?{thread_id:row.thread_id,policy:JSON.parse(row.policy_json)}:null;
 }
 acknowledge(id:string,threadId:string,turnId:string):void{
  const row=this.submission(id);if(!row||row.status!=='starting'||row.thread_id!==threadId||!turnId)throw Error('Codex turn acknowledgement mismatch');
  this.db.prepare("UPDATE codex_native_submissions SET turn_id=?,status='running',updated_at=? WHERE submission_id=?").run(turnId,Date.now(),id);
 }
 lateAcknowledge(id:string,threadId:string,turnId:string):void{
  const row=this.submission(id);if(!row||row.thread_id!==threadId||!turnId)throw Error('Codex late turn identity mismatch');
  this.db.prepare("UPDATE codex_native_submissions SET turn_id=?,status='unknown',updated_at=? WHERE submission_id=? AND status IN ('starting','unknown')").run(turnId,Date.now(),id);
 }
 unknown(id:string):void{this.db.prepare("UPDATE codex_native_submissions SET status='unknown',updated_at=? WHERE submission_id=? AND status IN ('prepared','starting','running','stopping')").run(Date.now(),id);}
 settle(key:string,threadId:string,turnId:string,status:'completed'|'failed'|'cancelled'):void{
  const row=this.db.prepare('SELECT * FROM codex_native_submissions WHERE session_key=? AND thread_id=? AND turn_id=?').get(key,threadId,turnId) as SubmissionRow|undefined;
  if(!row||!terminal.has(status))throw Error('Codex terminal native identity mismatch');
  if(terminal.has(row.status)){if(row.status!==status)throw Error('Codex terminal result conflicts');return;}
  this.db.prepare('UPDATE codex_native_submissions SET status=?,updated_at=? WHERE submission_id=?').run(status,Date.now(),row.submission_id);
 }
 stopping(key:string,turnId:string):SubmissionRow{
  const row=this.active(key);if(!row||row.turn_id!==turnId||!row.thread_id)throw Error('Codex active turn identity mismatch');
  this.db.prepare("UPDATE codex_native_submissions SET status='stopping',updated_at=? WHERE submission_id=?").run(Date.now(),row.submission_id);return row;
 }
 registerSubmission(raw:EngineSubmission):void{
  this.assertSessionOpen(raw.session_id);
  this.assertPreparationAllowed(raw.submission_id);
  const value=engineSubmissionSchema.parse(raw),s=this.session(value.session_id);
  if(!s||s.binding_json!==JSON.stringify(value.binding))throw Error('Codex event submission binding mismatch');
  const json=JSON.stringify(value),prior=this.db.prepare('SELECT submission_json FROM codex_native_turn_results WHERE submission_id=?').get(value.submission_id) as {submission_json:string}|undefined;
  if(prior){if(prior.submission_json!==json)throw Error('Codex submission metadata conflict');return;}
  this.db.prepare('INSERT INTO codex_native_turn_results(submission_id,session_key,submission_json) VALUES(?,?,?)').run(value.submission_id,value.session_id,json);
 }
 metadata(key:string,id:string):EngineSubmission{
  const row=this.db.prepare('SELECT submission_json FROM codex_native_turn_results WHERE session_key=? AND submission_id=?').get(key,id) as {submission_json:string}|undefined;
  if(!row)throw Error('Codex submission metadata missing');return engineSubmissionSchema.parse(JSON.parse(row.submission_json));
 }
 assertPreparationAllowed(id:string):void{
  if(this.db.prepare('SELECT 1 FROM codex_cancelled_preparations WHERE submission_id=?').get(id))throw Error('Native preparation was cancelled');
 }
 preparationDeadline(id:string):number|null{return(this.db.prepare('SELECT deadline FROM codex_preparation_leases WHERE submission_id=?').get(id) as {deadline:number}|undefined)?.deadline??null;}
 renewPreparation(s:EngineSubmission,duration:number):number{
  if(this.preparationState(s)!=='open')throw Error('Native preparation cancelled or already submitted');
  const prior=this.preparationDeadline(s.submission_id);if(prior!==null&&Date.now()>=prior)throw Error('Native preparation lease expired');
  const deadline=Date.now()+duration;this.db.prepare('INSERT INTO codex_preparation_leases VALUES(?,?) ON CONFLICT(submission_id) DO UPDATE SET deadline=excluded.deadline').run(s.submission_id,deadline);return deadline;
 }
 preparationState(raw:EngineSubmission):'missing'|'open'|'submitted'|'cancelling'{
  const s=engineSubmissionSchema.parse(raw),json=JSON.stringify(s),session=this.session(s.session_id);
  if(session&&session.binding_json!==JSON.stringify(s.binding))throw Error('Native inspection binding conflict');
  const metadata=this.db.prepare('SELECT submission_json FROM codex_native_turn_results WHERE submission_id=?').get(s.submission_id) as {submission_json:string}|undefined;
  const cancelled=this.db.prepare('SELECT submission_json FROM codex_cancelled_preparations WHERE submission_id=?').get(s.submission_id) as {submission_json:string}|undefined;
  if(metadata&&metadata.submission_json!==json||cancelled&&cancelled.submission_json!==json)throw Error('Native preparation inspection identity conflict');
  const row=this.submission(s.submission_id);
  if(row){if(!metadata||row.session_key!==s.session_id||row.input_sha256!==s.input_sha256)throw Error('Native submission inspection identity conflict');return'submitted';}
  return cancelled?'cancelling':metadata?'open':'missing';
 }
 cancelPreparation(raw:EngineSubmission):void{
  const s=engineSubmissionSchema.parse(raw),json=JSON.stringify(s);
  this.db.transaction(()=>{
   if(this.closedBinding(s.session_id)?.closed_at!=null)throw Error('Codex session binding is closed');
   if(this.submission(s.submission_id))throw Error('Native submission may have started; preparation cancellation is forbidden');
   const session=this.session(s.session_id);
   if(session&&session.binding_json!==JSON.stringify(s.binding))throw Error('Native cancellation binding conflict');
   const metadata=this.db.prepare('SELECT submission_json FROM codex_native_turn_results WHERE submission_id=?').get(s.submission_id) as {submission_json:string}|undefined;
   const prior=this.db.prepare('SELECT submission_json FROM codex_cancelled_preparations WHERE submission_id=?').get(s.submission_id) as {submission_json:string}|undefined;
   if(metadata&&metadata.submission_json!==json||prior&&prior.submission_json!==json)throw Error('Native cancellation submission conflict');
   if(!prior)this.db.prepare('INSERT INTO codex_cancelled_preparations VALUES(?,?)').run(s.submission_id,json);
  })();
 }
 nextEvent(id:string):number{
  const r=this.db.prepare('UPDATE codex_native_turn_results SET sequence=sequence+1 WHERE submission_id=? RETURNING sequence').get(id) as {sequence:number}|undefined;
  if(!r)throw Error('Codex event binding missing');return r.sequence;
 }
 eventSequence(id:string):number{const row=this.db.prepare('SELECT sequence FROM codex_native_turn_results WHERE submission_id=?').get(id) as {sequence:number}|undefined;if(!row)throw Error('Codex event binding missing');return row.sequence;}
 result(key:string,id:string):NativeTurnResult|null{
  const row=this.db.prepare('SELECT result_json FROM codex_native_turn_results WHERE session_key=? AND submission_id=?').get(key,id) as {result_json:string|null}|undefined;
  return row?.result_json?JSON.parse(row.result_json):null;
 }
 recordCommand(key:string,id:string,raw:NativeCommandReceipt):void{
  const receipt=nativeCommandReceiptSchema.parse(raw),row=this.submission(id);
  if(!row||row.session_key!==key||row.thread_id!==receipt.thread_id||row.turn_id!==receipt.turn_id)throw Error('Native command receipt identity mismatch');
  const json=JSON.stringify(receipt),prior=this.db.prepare('SELECT receipt_json FROM codex_native_command_receipts WHERE submission_id=? AND item_id=?').get(id,receipt.item_id) as {receipt_json:string}|undefined;
  if(prior){if(prior.receipt_json!==json)throw Error('Conflicting native command receipt');return;}
  if(terminal.has(row.status))throw Error('Native terminal commands are already sealed');
  this.db.prepare('INSERT INTO codex_native_command_receipts VALUES(?,?,?)').run(id,receipt.item_id,json);
 }
 commandReceipts(key:string,id:string):NativeCommandReceipt[]{
  if(this.submission(id)?.session_key!==key)throw Error('Native command collection identity mismatch');
  return(this.db.prepare('SELECT receipt_json FROM codex_native_command_receipts WHERE submission_id=? ORDER BY item_id').all(id) as {receipt_json:string}[]).map(r=>nativeCommandReceiptSchema.parse(JSON.parse(r.receipt_json)));
 }
 recordCheck(key:string,id:string,raw:NativeCheckReceipt):void{
  const receipt=nativeCheckReceiptSchema.parse(raw),row=this.submission(id);
  if(row?.session_key!==key||row.status!=='running'||row.thread_id!==receipt.thread_id||row.turn_id!==receipt.turn_id)throw Error('Native check identity mismatch');
  const prior=this.db.prepare('SELECT receipt_json FROM codex_native_check_receipts WHERE submission_id=? AND check_id=?').get(id,receipt.check_id) as {receipt_json:string}|undefined,json=JSON.stringify(receipt);
  if(prior){if(prior.receipt_json!==json)throw Error('Native check receipt conflict');return;}
  this.db.prepare('INSERT INTO codex_native_check_receipts VALUES(?,?,?)').run(id,receipt.check_id,json);
 }
 checkReceipts(key:string,id:string):NativeCheckReceipt[]{
  if(this.submission(id)?.session_key!==key)throw Error('Native check collection identity mismatch');
  return(this.db.prepare('SELECT receipt_json FROM codex_native_check_receipts WHERE submission_id=? ORDER BY rowid').all(id) as {receipt_json:string}[]).map(r=>nativeCheckReceiptSchema.parse(JSON.parse(r.receipt_json)));
 }
 finishResult(key:string,id:string,result:NativeTurnResult,commands:NativeCommandReceipt[]=[]):void{
  this.db.transaction(()=>{
   const row=this.submission(id);if(!row?.thread_id||!row.turn_id||row.session_key!==key)throw Error('Codex result identity mismatch');
   const previous=this.result(key,id);if(previous){if(JSON.stringify(previous)!==JSON.stringify(result))throw Error('Conflicting Codex final result');return;}
   for(const command of commands)this.recordCommand(key,id,command);
   if(!this.db.prepare('UPDATE codex_native_turn_results SET result_json=? WHERE submission_id=? AND session_key=?').run(JSON.stringify(result),id,key).changes)throw Error('Codex result binding missing');
   this.settle(key,row.thread_id,row.turn_id,result.status);
  })();
 }
}
