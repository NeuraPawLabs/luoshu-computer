import type Database from 'better-sqlite3';

/** Read existing journals only; updating must not create/migrate native state. */
export function computerUpdateBlockers(db:Database.Database):string[] {
 const queries=[
    ['worker_executions',"SELECT attempt_id AS id FROM worker_executions WHERE status IN ('running','stopping','unknown') ORDER BY attempt_id",'attempt'],
    ['codex_native_submissions',"SELECT submission_id AS id FROM codex_native_submissions WHERE status IN ('prepared','starting','running','stopping','unknown') ORDER BY submission_id",'native'],
    ['assistant_native_run_files',"SELECT run_id AS id FROM assistant_native_run_files WHERE delivery_json IS NULL AND state!='cancelled' ORDER BY run_id",'delivery'],
    ['codex_native_sessions',"SELECT session_key AS id FROM codex_native_sessions WHERE native_status IN ('creating','unknown') ORDER BY session_key",'session'],
    ['native_systemd_units','SELECT unit_name AS id FROM native_systemd_units ORDER BY unit_name','unit'],
  ] as const;
 const blockers:string[]=[];
 for(const [table,query,kind] of queries){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
  if(kind==='delivery'){
   const safe=new Set<string>();
   const hasSubmissions=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_native_submissions'").get());
   const hasResults=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_native_turn_results'").get());
   if(hasSubmissions&&hasResults){
    const rows=db.prepare(`SELECT f.run_id AS id FROM assistant_native_run_files f
      JOIN codex_native_submissions s ON s.submission_id=f.submission_id
      JOIN codex_native_turn_results r ON r.submission_id=f.submission_id
      WHERE f.delivery_json IS NULL AND f.state!='cancelled' AND s.status='completed' AND r.result_json IS NOT NULL`).all() as {id:string}[];
    for(const row of rows)safe.add(row.id);
   }
   const rows=db.prepare(query).all() as {id:string}[];blockers.push(...rows.filter(row=>!safe.has(row.id)).map(row=>`${kind}:${row.id}`));
  }else blockers.push(...(db.prepare(query).all() as {id:string}[]).map(row=>`${kind}:${row.id}`));
 }
 return blockers;
}
