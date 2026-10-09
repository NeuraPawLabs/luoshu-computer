import {expect, test} from 'vitest';
import {engineTurnEventSchema} from '../../src/protocol/assistant-engine-events.js';
import {engineSourceFixture} from './fixtures/assistant-engine.js';

const envelope = () => ({source: engineSourceFixture(), sequence: 1});

test('command failure remains an item result, not an invented turn failure', () => {
  const value = engineTurnEventSchema.parse({
    ...envelope(), event: {kind: 'tool.finished', item_id: 'item_1', status: 'failed', exit_code: 127},
  });
  expect(value.event.kind).toBe('tool.finished');
});

test('final answers are not constrained to the old Worker summary length', () => {
  const text = '完整答复。'.repeat(20000);
  const value = engineTurnEventSchema.parse({
    ...envelope(), event: {kind: 'reply.final', item_id: 'item_1', text, citations: [], artifact_ids: []},
  });
  if (value.event.kind !== 'reply.final') throw new Error('Unexpected event kind');
  expect(value.event.text).toBe(text);
});

test('events require complete origin and matched worker identity fields', () => {
  const event = {kind: 'progress', text: '正在核对来源'};
  expect(engineTurnEventSchema.safeParse({...envelope(), source: {...engineSourceFixture(), worker_generation: null}, event}).success).toBe(false);
  expect(engineTurnEventSchema.safeParse({...envelope(), source: {...engineSourceFixture(), run_id: ''}, event}).success).toBe(false);
  expect(engineTurnEventSchema.safeParse({...envelope(), sequence: 0, event}).success).toBe(false);
});

test('raw reasoning and surprise fields cannot enter the public event contract', () => {
  expect(engineTurnEventSchema.safeParse({...envelope(), event: {kind: 'reasoning.raw', text: 'private'}}).success).toBe(false);
  expect(engineTurnEventSchema.safeParse({...envelope(), event: {kind: 'progress', text: 'safe', raw_reasoning: 'private'}}).success).toBe(false);
});

test('approval state carries a request identity and explicit allowed choices', () => {
  const value = {
    ...envelope(), event: {kind: 'waiting_approval', request_id: 'request_1', item_id: 'item_1',
      summary: '允许此项操作？', decisions: ['allow_once', 'deny', 'cancel'], expires_at: null},
  };
  expect(engineTurnEventSchema.safeParse(value).success).toBe(true);
  expect(engineTurnEventSchema.safeParse({...value, event: {...value.event, decisions: ['allow_once', 'allow_once']}}).success).toBe(false);
});

test('citations reject executable URL schemes', () => {
  expect(engineTurnEventSchema.safeParse({...envelope(), event: {
    kind: 'reply.final', item_id: 'item_1', text: 'answer',
    citations: [{url: 'javascript:alert(1)', title: 'unsafe'}], artifact_ids: [],
  }}).success).toBe(false);
});

test.each(['not-a-url', '', 'https://', 'http://[invalid'])('malformed citation %j is a validation result, not an exception', url => {
  const value = {...envelope(), event: {
    kind: 'reply.final', item_id: 'item_1', text: 'answer',
    citations: [{url, title: 'invalid'}], artifact_ids: [],
  }};
  expect(() => engineTurnEventSchema.safeParse(value)).not.toThrow();
  expect(engineTurnEventSchema.safeParse(value).success).toBe(false);
});

test.each([
  {kind: 'reply.delta', item_id: 'item_1', text: 'partial'},
  {kind: 'reply.final', item_id: 'item_1', text: 'answer', citations: [{url: 'https://example.com/report', title: 'Report'}], artifact_ids: ['artifact_1']},
  {kind: 'progress', text: '正在整理'},
  {kind: 'progress.delta', item_id: 'item_1', text: '正在'},
  {kind: 'progress.final', item_id: 'item_1', text: '正在整理'},
  {kind: 'reasoning.summary', item_id: 'item_1', mode: 'replace', text: '公开摘要'},
  {kind: 'tool.started', item_id: 'item_1', name: 'search', command: null},
  {kind: 'tool.output', item_id: 'item_1', text: 'result'},
  {kind: 'tool.finished', item_id: 'item_1', status: 'completed', exit_code: 0},
  {kind: 'waiting_input', request_id: 'request_1', is_blocking: false, questions: [{id: 'q1', text: '选择目录', options: [], header: '目录', option_descriptions: [], is_other: true}], expires_at: null},
  {kind: 'waiting_approval', request_id: 'request_1', item_id: 'item_1', summary: '允许操作？', decisions: ['deny', 'cancel'], expires_at: null},
  {kind: 'interaction.resolved', request_id: 'request_1', resolution: 'answered'},
  {kind: 'turn.status', state: 'unknown', reason: '连接中断，执行状态待核对'},
  {kind: 'delivery.ready', delivery_id: 'delivery_1', manifest_sha256: 'a'.repeat(64)},
])('accepts the public $kind payload without adding extra fields', event => {
  const input = {...envelope(), event};
  expect(engineTurnEventSchema.parse(input)).toEqual(input);
  expect(engineTurnEventSchema.safeParse({...input, event: {...event, unknown: true}}).success).toBe(false);
});

test('platform lifecycle events can exist before a native turn is assigned', () => {
  expect(engineTurnEventSchema.parse({
    ...envelope(), source: {...engineSourceFixture(), worker_id: null, worker_generation: null, native: null},
    event: {kind: 'turn.status', state: 'queued', reason: null},
  }).source.native).toBeNull();
});

test.each([
  {kind: 'progress.delta', text: '片段'},
  {kind: 'progress.final', text: '完整进度'},
  {kind: 'reasoning.summary', item_id: 'item_1', text: '摘要'},
  {kind: 'waiting_input', request_id: 'request_1', questions: [{id: 'q1', text: '继续？', options: []}], expires_at: null},
  {kind: 'interaction.resolved', request_id: 'request_1'},
])('required native conversation fields have no legacy defaults: $kind', event => {
  expect(engineTurnEventSchema.safeParse({...envelope(), event}).success).toBe(false);
});

test.each(['append', 'replace'])('public summaries explicitly describe %s updates', mode => {
  const event = {kind: 'reasoning.summary', item_id: 'item_1', text: '公开摘要', mode};
  expect(engineTurnEventSchema.parse({...envelope(), event}).event).toEqual(event);
});

test('native cleanup is distinct from an accepted answer', () => {
  const event = {kind: 'interaction.resolved', request_id: 'request_1', resolution: 'dismissed'};
  expect(engineTurnEventSchema.parse({...envelope(), event}).event).toEqual(event);
  expect(engineTurnEventSchema.safeParse({...envelope(), event: {...event, resolution: 'unknown'}}).success).toBe(false);
});
