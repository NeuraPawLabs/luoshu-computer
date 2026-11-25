import {expect, test} from 'vitest';
import {engineBindingSchema, engineSubmissionSchema, nativeSessionRefSchema} from '../../src/protocol/assistant-engine-session.js';
import {engineBindingFixture, engineSubmissionFixture} from './fixtures/assistant-engine.js';

test('a normal run has a session and no Task', () => {
  const value = engineSubmissionSchema.parse(engineSubmissionFixture());
  expect(value.task_id).toBeNull();
  expect(value.run_id).toBe('run_1');
});

test('native submissions have one Run identity and reject an extra batch identity', () => {
  const input=engineSubmissionFixture();
  expect(engineSubmissionSchema.safeParse({...input,batch_id:'batch_1'}).success).toBe(false);
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
  expect(nativeSessionRefSchema.parse({native_thread_id: 'thread_child', session_tree_id: 'thread_root'})).toEqual({
    native_thread_id: 'thread_child', session_tree_id: 'thread_root',
  });
  expect(nativeSessionRefSchema.safeParse({native_thread_id: '', session_tree_id: null}).success).toBe(false);
});

test('bindings reject missing revisions and credential fields', () => {
  const binding = engineBindingFixture();
  expect(engineBindingSchema.safeParse({...binding, authorization_revision: 0}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...binding, credentials: {token: 'secret'}}).success).toBe(false);
});

test('topic bindings freeze a positive context generation and keep the base binding intact', () => {
  const base = engineBindingFixture();
  expect(engineBindingSchema.parse(base)).toEqual(base);
  const topic = {...base, topic_thread_id: 'topic_1', context_generation: 1};
  expect(engineBindingSchema.parse(topic)).toEqual(topic);
  expect(engineBindingSchema.safeParse({...base, topic_thread_id: 'topic_1'}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...base, context_generation: 1}).success).toBe(false);
  expect(engineBindingSchema.safeParse({...topic, context_generation: 0}).success).toBe(false);
});




test('the device protocol accepts only network roles with structured output',()=>{
 const fixture=engineSubmissionFixture();
 const input={...fixture,binding:{...fixture.binding,role:'main'},output_schema:{type:'object'}};
 expect(engineSubmissionSchema.safeParse(input).success).toBe(true);
 for(const role of [undefined,'core','worker'])expect(engineSubmissionSchema.safeParse({...input,binding:{...input.binding,role}}).success).toBe(false);
 expect(engineSubmissionSchema.safeParse({...input,output_schema:undefined}).success).toBe(false);
});
