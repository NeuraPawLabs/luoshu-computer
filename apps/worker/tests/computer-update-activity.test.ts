import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {computerUpdateBlockers} from '../src/computer/update-activity.js';

test('update activity checks legacy and native work without creating missing schema',()=>{
 const db=new Database(':memory:');
 try{
  expect(computerUpdateBlockers(db)).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  db.exec("CREATE TABLE worker_executions(attempt_id TEXT,status TEXT); INSERT INTO worker_executions VALUES('legacy','running'),('done','succeeded'); CREATE TABLE codex_native_submissions(submission_id TEXT,status TEXT); INSERT INTO codex_native_submissions VALUES('native','unknown'),('old','completed'); CREATE TABLE assistant_native_run_files(run_id TEXT,state TEXT,delivery_json TEXT); INSERT INTO assistant_native_run_files VALUES('delivery','ready',NULL),('delivered','ready','{}'),('cancelled','cancelled',NULL)");
  expect(computerUpdateBlockers(db)).toEqual(['attempt:legacy','native:native','delivery:delivery']);
 }finally{db.close();}
});

test('native thread creation and unresolved supervisor ownership prevent manual updates',()=>{
 const db=new Database(':memory:');
 try{
  db.exec("CREATE TABLE codex_native_sessions(session_key TEXT,native_status TEXT); INSERT INTO codex_native_sessions VALUES('preparing','creating'),('uncertain','unknown'),('idle','idle'); CREATE TABLE native_systemd_units(unit_name TEXT); INSERT INTO native_systemd_units VALUES('unit-active')");
  expect(computerUpdateBlockers(db)).toEqual(['session:preparing','session:uncertain','unit:unit-active']);
 }finally{db.close();}
});

test('a completed native result with pending delivery does not block a safe Worker update',()=>{
 const db=new Database(':memory:');
 try{
  db.exec("CREATE TABLE assistant_native_run_files(run_id TEXT,state TEXT,delivery_json TEXT,submission_id TEXT); INSERT INTO assistant_native_run_files VALUES('safe','ready',NULL,'submission-safe'),('active','ready',NULL,'submission-active'); CREATE TABLE codex_native_submissions(submission_id TEXT,status TEXT); INSERT INTO codex_native_submissions VALUES('submission-safe','completed'),('submission-active','running'); CREATE TABLE codex_native_turn_results(submission_id TEXT,result_json TEXT); INSERT INTO codex_native_turn_results VALUES('submission-safe','{\\\"status\\\":\\\"completed\\\"}')");
  expect(computerUpdateBlockers(db)).toEqual(['native:submission-active','delivery:active']);
 }finally{db.close();}
});
