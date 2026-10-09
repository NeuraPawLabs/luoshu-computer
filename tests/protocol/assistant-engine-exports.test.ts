import {expect, test} from 'vitest';
import * as protocol from '../../src/protocol/index.js';

test.each([
  'agentEngineConfigSchema', 'deviceEngineReportSchema',
  'engineBindingSchema', 'engineSubmissionSchema', 'nativeSessionRefSchema',
  'engineEventSourceSchema', 'engineEventPayloadSchema', 'engineTurnEventSchema',
  'engineTaskOperationSchema',
])('public protocol exposes %s', name => {
  const exports = protocol as unknown as Record<string, unknown>;
  expect(exports[name]).toEqual(expect.objectContaining({parse: expect.any(Function)}));
});
