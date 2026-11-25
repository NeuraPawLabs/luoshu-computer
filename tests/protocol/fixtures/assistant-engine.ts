export function engineBindingFixture() {
  return {
    session_id: 'conversation_1', agent_id: 'agent_1', actor_id: 'alice',
    agent_revision: 1, authorization_revision: 1,
    role: 'main' as const, engine: {kind: 'device', device_id: 'worker_1', agent: 'codex', adapter_version: 1},
  };
}

export function engineSubmissionFixture() {
  return {
    submission_id: 'submission_1', run_id: 'run_1',
    engine_session_id: 'session_1', binding: engineBindingFixture(),
    input_message_ids: ['message_1'], context_message_ids: [],
    input_sha256: 'a'.repeat(64), task_id: null, task_revision: null,output_schema:{type:'object'},
  };
}

export function engineSourceFixture() {
  return {
    session_id: 'conversation_1', agent_id: 'agent_1', actor_id: 'alice',
    engine_session_id: 'session_1', run_id: 'run_1', submission_id: 'submission_1',
    authorization_revision: 1, device_id: 'worker_1', connection_generation: 1,
    native: {native_thread_id: 'thread_1', turn_id: 'turn_1', item_id: 'item_1'},
  };
}
