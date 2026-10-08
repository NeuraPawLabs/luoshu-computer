export function engineBindingFixture() {
  return {
    conversation_id: 'conversation_1', agent_id: 'agent_1', actor_id: 'alice',
    agent_revision: 1, authorization_revision: 1,
    engine: {kind: 'device', worker_id: 'worker_1', agent: 'codex', adapter_version: 1},
  };
}

export function engineSubmissionFixture() {
  return {
    submission_id: 'submission_1', batch_id: 'batch_1', run_id: 'run_1',
    session_id: 'session_1', binding: engineBindingFixture(),
    input_message_ids: ['message_1'], context_message_ids: [],
    input_sha256: 'a'.repeat(64), task_id: null, task_revision: null,
  };
}

export function engineSourceFixture() {
  return {
    conversation_id: 'conversation_1', agent_id: 'agent_1', actor_id: 'alice',
    session_id: 'session_1', run_id: 'run_1', submission_id: 'submission_1',
    authorization_revision: 1, worker_id: 'worker_1', worker_generation: 1,
    native: {thread_id: 'thread_1', turn_id: 'turn_1', item_id: 'item_1'},
  };
}
