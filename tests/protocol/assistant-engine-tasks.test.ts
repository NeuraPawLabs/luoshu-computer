import {expect, test} from 'vitest';
import {engineTaskOperationSchema} from '../../src/protocol/assistant-engine-tasks.js';

test('create represents explicit business intent, not a Worker call', () => {
  expect(engineTaskOperationSchema.parse({action: 'create', title: '调查公开资料', goal: '整理结论与来源'})).toEqual({
    action: 'create', title: '调查公开资料', goal: '整理结论与来源',
  });
});

test('existing task mutations always include an expected revision', () => {
  expect(engineTaskOperationSchema.safeParse({action: 'attach', task_id: 'task_1', expected_revision: 3}).success).toBe(true);
  expect(engineTaskOperationSchema.safeParse({action: 'attach', task_id: 'task_1'}).success).toBe(false);
  expect(engineTaskOperationSchema.safeParse({action: 'revise', task_id: 'task_1', expected_revision: 3, instruction: '追加来源日期'}).success).toBe(true);
});

test.each([
  {action: 'create', title: 'x', goal: 'y', actor_id: 'another-user'},
  {action: 'create', title: 'x', goal: 'y', run_id: 'another-run'},
  {action: 'shell', command: 'pwd'},
  {action: 'create', title: 'x', goal: 'y', url: 'https://example.test'},
  {action: 'report', task_id: 'task_1', expected_revision: 1, status: 'accepted', summary: 'done'},
])('rejects authority, execution and acceptance injection %#', value => {
  expect(engineTaskOperationSchema.safeParse(value).success).toBe(false);
});

test('an agent can report delivery without accepting the Task for the user', () => {
  expect(engineTaskOperationSchema.parse({
    action: 'report', task_id: 'task_1', expected_revision: 3,
    status: 'delivered', summary: '结果已就绪',
  }).action).toBe('report');
});
