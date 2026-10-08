import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { WorkerState } from '../src/state.js';

test('worker state deduplicates starts and persists unacked events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luoshu-state-'));
  const state = new WorkerState(join(dir, 'worker.db'));
  expect(state.recordStart('attempt_1', 1, { hello: 'world' })).toBe(true);
  expect(state.recordStart('attempt_1', 1, { hello: 'world' })).toBe(false);
  expect(state.setDeadline('attempt_1',1,Date.now()+1000)).toBe(true);
  expect(state.setDeadline('attempt_1',2,Date.now()+1000)).toBe(false);
  state.appendEvent({ type: 'event', attempt_id: 'attempt_1', lease_epoch: 1, sequence: 1, event: { type: 'started' } });
  state.close();
  const reopened = new WorkerState(join(dir, 'worker.db'));
  expect(reopened.activeAttemptIds()).toEqual(['attempt_1']);
  expect(reopened.unackedEvents()).toHaveLength(1);
  reopened.ack('attempt_1', 1); expect(reopened.unackedEvents()).toHaveLength(0);
  reopened.close();
});
test('live progress never enters the durable worker outbox', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'luoshu-state-live-')); const state = new WorkerState(join(dir, 'worker.db'));
 state.recordStart('attempt_1', 1, {});
 state.appendEvent({type:'event',attempt_id:'attempt_1',lease_epoch:1,sequence:1,event:{type:'progress',text:'secret command output'}});
 expect(state.unackedEvents()).toEqual([]);
 expect(state.nextSequence('attempt_1')).toBe(1);
 state.close();
});

test('recovering interrupted executions never replays them and preserves event order',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-recover-'));const state=new WorkerState(join(dir,'db'));state.recordStart('execution_1',1,{});state.appendEvent({type:'event',attempt_id:'execution_1',lease_epoch:1,sequence:1,event:{type:'started'}});expect(state.recoverInterrupted()).toEqual([{attemptId:'execution_1',leaseEpoch:1}]);expect(state.status('execution_1')).toBe('unknown');expect(state.recordStart('execution_1',1,{})).toBe(false);expect(state.nextSequence('execution_1')).toBe(2);state.close();});
