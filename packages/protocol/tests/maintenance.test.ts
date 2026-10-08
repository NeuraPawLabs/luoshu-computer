import {expect, test} from 'vitest';
import {maintenanceRequestSchema, maintenanceResponseSchema, serverMessageSchema, workerMessageSchema} from '../src/index.js';

const request = {
  type: 'maintenance_request' as const,
  request_id: 'request_1', attempt_id: 'attempt_1', lease_epoch: 1, operation: 'repair' as const,
  repository: '/srv/luoshu', base_sha: 'a'.repeat(40), branch: 'luoshu/repair/incident_1/attempt_1',
  agent: 'codex' as const, instruction: 'Fix the reported timeout.', allowed_paths: ['apps/core/src/**'],
  checks: [{name: 'unit', executable: 'npm', args: ['exec', 'vitest', 'run'], timeout_seconds: 300}], timeout_seconds: 1800,
};

test('exports a strict maintenance request with an immutable base and repair branch', () => {
  expect(maintenanceRequestSchema.parse(request)).toEqual(request);
  expect(serverMessageSchema.parse(request)).toEqual(request);
  for (const invalid of [
    {...request, branch: 'main'},
    {...request, base_sha: 'bad'},
    {...request, repository: 'relative/repo'},
    {...request, allowed_paths: ['../outside']},
    {...request, checks: [{...request.checks[0], executable: 'npm test; rm'}]},
    {...request, checks: [{...request.checks[0], args: ['test', '&&', 'rm']}]},
    {...request, command: 'sh -c npm test'},
  ]) expect(maintenanceRequestSchema.safeParse(invalid).success).toBe(false);
});

test('correlates bounded success and error responses to the attempt lease', () => {
  const success = {type: 'maintenance_response' as const, request_id: request.request_id, attempt_id: request.attempt_id, lease_epoch: 1,
    result: {status: 'patch_ready' as const, summary: 'fixed', base_sha: request.base_sha, commit_sha: 'b'.repeat(40), branch: request.branch,
      changed_paths: ['apps/core/src/runtime.ts'], checks: [{name: 'unit', command: 'npm exec vitest run', exit_code: 0, output: ''}]}};
  expect(maintenanceResponseSchema.parse(success)).toEqual(success);
  expect(workerMessageSchema.parse(success)).toEqual(success);
  expect(maintenanceResponseSchema.safeParse({...success, attempt_id: '../bad'}).success).toBe(false);
  expect(maintenanceResponseSchema.safeParse({...success, result: {...success.result, changed_paths: ['../secret']}}).success).toBe(false);
  const error = {type: 'maintenance_response' as const, request_id: request.request_id, attempt_id: request.attempt_id, lease_epoch: 1, error: 'Worker stopped', execution_unknown: true};
  expect(maintenanceResponseSchema.parse(error)).toEqual(error);
});

test('allows a verifier branch while keeping it outside repair and default branches', () => {
  const verify = {...request, operation: 'verify' as const, branch: 'luoshu/verify/incident_1/verification_1'};
  expect(maintenanceRequestSchema.parse(verify)).toEqual(verify);
  expect(maintenanceRequestSchema.safeParse({...verify, branch: 'main'}).success).toBe(false);
});
