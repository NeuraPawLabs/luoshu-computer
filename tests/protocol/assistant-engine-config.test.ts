import {expect, test} from 'vitest';
import {
  agentEngineConfigSchema,
  deviceEngineReportSchema,
  requiredDeviceEngineFeatures,
} from '../../src/protocol/assistant-engine.js';

const builtin = {
  kind: 'builtin',
  model_connection_id: '11111111-1111-4111-8111-111111111111',
  model_id: 'example-model',
  reasoning_effort: 'medium',
  thinking_budget_tokens: null,
};
const device = {kind: 'device', worker_id: 'worker_1', agent: 'codex', adapter_version: 1};

test('a device engine does not need a Core model connection', () => {
  expect(agentEngineConfigSchema.parse(device)).toEqual(device);
  expect(agentEngineConfigSchema.parse(builtin)).toEqual(builtin);
});

test.each([
  {...device, model_id: 'unexpected'},
  {...builtin, worker_id: 'worker_1'},
  {...device, api_key: 'secret'},
  {...device, oauth_token: 'secret'},
  {...device, agent: 'opencode'},
  {...device, adapter_version: 2},
  {...builtin, reasoning_effort: 'auto'},
  {...builtin, model_connection_id: ''},
])('rejects mixed, credential-bearing or unsupported configuration %#', value => {
  expect(agentEngineConfigSchema.safeParse(value).success).toBe(false);
});

test('ready requires a tested adapter and all mandatory direct-conversation features', () => {
  const ready = {
    agent: 'codex', agent_version: 'fixture-version', adapter_version: 1,
    status: 'ready', reason: null, features: [...requiredDeviceEngineFeatures],
  };
  expect(deviceEngineReportSchema.safeParse(ready).success).toBe(true);
  for (const feature of requiredDeviceEngineFeatures) {
    expect(deviceEngineReportSchema.safeParse({
      ...ready, features: ready.features.filter(value => value !== feature),
    }).success).toBe(false);
  }
  expect(deviceEngineReportSchema.safeParse({...ready, agent: 'opencode'}).success).toBe(false);
  expect(deviceEngineReportSchema.safeParse({...ready, features: [...ready.features, ready.features[0]]}).success).toBe(false);
});

test('unsupported engines report why without claiming they can run direct conversations', () => {
  expect(deviceEngineReportSchema.parse({
    agent: 'opencode', agent_version: 'fixture-version', adapter_version: null,
    status: 'unavailable', reason: 'adapter_missing', features: [],
  }).reason).toBe('adapter_missing');
});
