import {expect, test} from 'vitest';
import {engineBindingSchema, engineSubmissionSchema, nativeSessionRefSchema} from '../src/assistant-engine-session.js';
import {engineBindingFixture, engineSubmissionFixture} from './fixtures/assistant-engine.js';

test('a normal run has a session and no Task', () => {
  const value = engineSubmissionSchema.parse(engineSubmissionFixture());
  expect(value.task_id).toBeNull();
  expect(value.run_id).toBe('run_1');
});

test('task id and revision are an inseparable explicit association', () => {
  const input = engineSubmissionFixture();
  expect(engineSubmissionSchema.safeParse({...input, task_id: 'task_1', task_revision: 2}).success).toBe(true);
  expect(engineSubmissionSchema.safeParse({...input, task_id: 'task_1'}).success).toBe(false);
  expect(engineSubmissionSchema.safeParse({...input, task_revision: 2}).success).toBe(false);
});

test('input must not duplicate itself or earlier context', () => {
  const input = engineSubmissionFixture();
  expect(engineSubmissionSchema.safeParse({...input, input_message_ids: []}).success).toBe(false);
  expect(engineSubmissionSchema.safeParse({...input, input_message_ids: ['m', 'm']}).success).toBe(false);
  expect(engineSubmissionSchema.safeParse({...input, context_message_ids: ['message_1']}).success).toBe(false);
  expect(engineSubmissionSchema.safeParse({...input, input_sha256: 'not-a-hash'}).success).toBe(false);
});

test('thread and native session-tree identifiers are separate', () => {
  expect(nativeSessionRefSchema.parse({thread_id: 'thread_child', session_tree_id: 'thread_root'})).toEqual({
    thread_id: 'thread_child', session_tree_id: 'thread_root',
  });
  expect(nativeSessionRefSchema.safeParse({thread_id: '', session_tree_id: null}).success).toBe(false);
});

test('bindings reject missing revisions and credential fields', () => {
  const binding = engineBindingFixture();
  expect(engineBindingSchema.safeParse({...binding, authorization_revision: 0}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...binding, credentials: {token: 'secret'}}).success).toBe(false);
});

test('topic bindings freeze a positive context generation while legacy JSON remains unchanged', () => {
  const legacy = engineBindingFixture();
  expect(JSON.stringify(engineBindingSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  const topic = {...legacy, topic_thread_id: 'topic_1', context_generation: 1};
  expect(engineBindingSchema.parse(topic)).toEqual(topic);
  expect(engineBindingSchema.safeParse({...legacy, topic_thread_id: 'topic_1'}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...legacy, context_generation: 1}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...topic, context_generation: 0}).success).toBe(false);
});
