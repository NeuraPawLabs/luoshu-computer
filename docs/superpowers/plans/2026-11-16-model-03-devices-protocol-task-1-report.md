# Task 1 protocol v9 implementation report

Implemented strict v9 device protocol contracts in `packages/protocol`: DeviceObservation, DeviceAgentReport, DeviceServiceReport, DeviceMutableConfiguration, DeviceConfigurationState, explicit configuration request/read/state/response messages, and DevelopmentPolicy. Observation is strict and excludes device control fields. Duplicate IDs/features, ready/unavailable reason invariants, typed known service features, and bounded unknown diagnostics are enforced. Auth/challenge/welcome/report now carry device identity and connection generation; report revision is peer supplied and received timestamps remain server owned.

Protocol semantic fields were renamed coherently: session_set knowledge scope, business session_id, native engine_session_id, execution_workspace_id, native_thread_id, and device_id/connection_generation provenance. The retired WorkerReport/reportSchema/Worker DTO aliases and old worker configuration write wire are removed. Both independent protocol copies use the same JSON vectors and tests.

Validation:
- Core protocol `npx vitest run packages/protocol/tests --maxWorkers=1`: 19 files, 159 tests passed.
- Core protocol `npx tsc -b packages/protocol --pretty false`: passed.
- Core `git diff --check`: passed.
- Computer protocol `npx vitest run tests/protocol --maxWorkers=1`: 19 files, 159 tests passed.
- Computer full `npm run build`: expected failures in pre-Task2/3 runtime callers (old worker/report DTO, old config write messages, old session/workspace/native field names). Exact output is available from the build invocation; protocol source itself compiles as mirrored with Core.

Remaining caller migration is intentionally deferred to Tasks 2/3. No Console, device DB, scheduler, or apps checkout files were modified.
