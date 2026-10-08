import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
import type {Assignment} from '@luoshu/protocol';
import {WorkerState} from '../src/state.js';
import {CheckpointStore} from '../src/checkpoints.js';

const assignment:Assignment={attempt_id:'execution_1',lease_epoch:1,agent:'codex',instruction:'build',input_files:[],codebases:[],timeout_seconds:null};
test('persists Agent evidence before delivery and survives Worker restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-checkpoint-'));const path=join(root,'worker.db');
 const state=new WorkerState(path);state.recordStart(assignment.attempt_id,1,assignment);
 const checkpoints=new CheckpointStore(state.db);checkpoints.begin(assignment);
 checkpoints.agentFinished(assignment.attempt_id,{outcome:'succeeded',exit_code:0,summary:'done',session_id:'session_1',checks:[{command:'node --check app.js',exit_code:0}],output_snapshot_sha256:null,codebases:[]});
 state.close();
 const reopened=new WorkerState(path);try{const value=new CheckpointStore(reopened.db).read(assignment.attempt_id);expect(value?.evidence?.exit_code).toBe(0);expect(value?.evidence?.session_id).toBe('session_1');expect(reopened.recoverInterrupted()).toEqual([]);}finally{reopened.close();await rm(root,{recursive:true,force:true});}
});

test('checkpoints require a registered matching assignment and persist early session IDs',()=>{
 const state=new WorkerState(':memory:'),store=new CheckpointStore(state.db);
 try{
  expect(()=>store.begin(assignment)).toThrow(/execution|registered/i);
  state.recordStart(assignment.attempt_id,1,assignment);store.begin(assignment);
  store.recordSession(assignment.attempt_id,'session_early');
  expect(store.read(assignment.attempt_id)?.session_id).toBe('session_early');
  expect(()=>store.begin({...assignment,instruction:'different'})).toThrow(/conflict|match/i);
 }finally{state.close();}
});
test('a collection error label without reliable exit evidence does not release unknown execution',()=>{
 const state=new WorkerState(':memory:'),store=new CheckpointStore(state.db);
 try{
  state.recordStart(assignment.attempt_id,1,assignment);store.begin(assignment);
  store.collectionFailed(assignment.attempt_id,'NO_RESULT');
  expect(state.recoverInterrupted()).toEqual([{attemptId:assignment.attempt_id,leaseEpoch:1}]);
  expect(state.status(assignment.attempt_id)).toBe('unknown');
 }finally{state.close();}
});
test('same evidence is idempotent while conflicting evidence is rejected',()=>{
 const state=new WorkerState(':memory:');state.recordStart(assignment.attempt_id,1,assignment);const checkpoints=new CheckpointStore(state.db);checkpoints.begin(assignment);
 const evidence={outcome:'failed' as const,exit_code:1,summary:'failed',session_id:null,checks:[],output_snapshot_sha256:null,codebases:[]};
 expect(checkpoints.agentFinished(assignment.attempt_id,evidence)).toMatchObject({evidence});expect(checkpoints.agentFinished(assignment.attempt_id,evidence)).toMatchObject({evidence});
 expect(()=>checkpoints.agentFinished(assignment.attempt_id,{...evidence,exit_code:2})).toThrow(/conflict/i);state.close();
});
test('checkpoint storage strips raw check output',()=>{
 const state=new WorkerState(':memory:');state.recordStart(assignment.attempt_id,1,assignment);const checkpoints=new CheckpointStore(state.db);checkpoints.begin(assignment);
 checkpoints.agentFinished(assignment.attempt_id,{outcome:'succeeded',exit_code:0,summary:'token=secret',session_id:null,checks:[{command:'check',exit_code:0,output:'private'}],output_snapshot_sha256:null,codebases:[]});
 const raw=JSON.stringify(state.db.prepare('SELECT * FROM worker_checkpoints').all());expect(raw).not.toContain('private');expect(raw).not.toContain('token=secret');state.close();
});
