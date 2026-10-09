import Database from 'better-sqlite3';
import type { WorkerEvent } from '../protocol/index.js';

export type LocalExecutionStatus = 'running'|'stopping'|'finished'|'unknown';

export class WorkerState {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_executions(attempt_id TEXT PRIMARY KEY, lease_epoch INTEGER NOT NULL, assignment_json TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, deadline INTEGER);
      CREATE TABLE IF NOT EXISTS worker_outbox(attempt_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(attempt_id,sequence));`);
  }
  recordStart(attemptId: string, leaseEpoch: number, assignment: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO worker_executions VALUES(?,?,?,'running',?,NULL)").run(attemptId, leaseEpoch, JSON.stringify(assignment), Date.now()).changes === 1;
  }
  setDeadline(attemptId: string, leaseEpoch:number, deadline: number): boolean { return this.db.prepare("UPDATE worker_executions SET deadline=? WHERE attempt_id=? AND lease_epoch=? AND status='running'").run(deadline, attemptId,leaseEpoch).changes===1; }
  finish(attemptId: string, status: LocalExecutionStatus): void { this.db.prepare('UPDATE worker_executions SET status=? WHERE attempt_id=?').run(status, attemptId); }
  reconcile(attemptId:string,leaseEpoch:number):boolean {return this.db.prepare("UPDATE worker_executions SET status='finished' WHERE attempt_id=? AND lease_epoch=? AND status='unknown'").run(attemptId,leaseEpoch).changes===1;}
  status(attemptId: string): LocalExecutionStatus | undefined { return (this.db.prepare('SELECT status FROM worker_executions WHERE attempt_id=?').get(attemptId) as {status:LocalExecutionStatus}|undefined)?.status; }
  activeAttemptIds(): string[] { return (this.db.prepare("SELECT attempt_id FROM worker_executions WHERE status IN ('running','stopping','unknown') ORDER BY started_at").all() as {attempt_id:string}[]).map(row=>row.attempt_id); }
  appendEvent(event: WorkerEvent): void { if(event.event.type==='progress')return; this.db.prepare('INSERT OR IGNORE INTO worker_outbox VALUES(?,?,?,0)').run(event.attempt_id,event.sequence,JSON.stringify(event)); }
  unackedEvents(): WorkerEvent[] { return (this.db.prepare('SELECT event_json FROM worker_outbox WHERE acked=0 ORDER BY rowid').all() as {event_json:string}[]).map(row=>JSON.parse(row.event_json) as WorkerEvent); }
  unackedEventsFor(attemptId:string):WorkerEvent[]{return (this.db.prepare('SELECT event_json FROM worker_outbox WHERE acked=0 AND attempt_id=? ORDER BY sequence').all(attemptId) as {event_json:string}[]).map(row=>JSON.parse(row.event_json) as WorkerEvent);}
  ack(attemptId:string, sequence:number):void { this.db.prepare('UPDATE worker_outbox SET acked=1 WHERE attempt_id=? AND sequence<=?').run(attemptId,sequence); }
  nextSequence(attemptId:string):number { return ((this.db.prepare('SELECT MAX(sequence) n FROM worker_outbox WHERE attempt_id=?').get(attemptId) as {n:number|null}).n ?? 0)+1; }
  recoverInterrupted(): {attemptId:string;leaseEpoch:number}[] {
    return this.db.transaction(()=>{
      const hasCheckpoints=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_checkpoints'").get());
      if(hasCheckpoints)this.db.prepare("UPDATE worker_executions SET status='finished' WHERE status IN ('running','stopping') AND EXISTS (SELECT 1 FROM worker_checkpoints c WHERE c.execution_id=worker_executions.attempt_id AND c.evidence_json IS NOT NULL AND json_extract(c.evidence_json,'$.outcome') IN ('succeeded','failed','cancelled') AND json_extract(c.evidence_json,'$.exit_code') IS NOT NULL)").run();
      const rows=this.db.prepare("SELECT attempt_id,lease_epoch FROM worker_executions WHERE status IN ('running','stopping')").all() as {attempt_id:string;lease_epoch:number}[];
      this.db.prepare("UPDATE worker_executions SET status='unknown' WHERE status IN ('running','stopping')").run();
      return rows.map(row=>({attemptId:row.attempt_id,leaseEpoch:row.lease_epoch}));
    })();
  }
  close():void { this.db.close(); }
}
