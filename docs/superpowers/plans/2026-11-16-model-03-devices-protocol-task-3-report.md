# Task 3 report — Computer service reports and unified configuration

Implemented protocol v9 Computer configuration and observation handling.

- `WorkerClient` authenticates and reports typed `DeviceObservation` values, with generation fencing on auth, reconnect, refresh, and configuration replies.
- Environment reporting now emits platform/software/Agent facts and actual typed service descriptions. Hidden `tools.luoshu.*`, `development`, and `maintenance_git` report markers were removed.
- Development, maintenance, task execution, and assistant engine adapters expose `DeviceServiceReport`; an explicitly disabled development policy keeps the development service ready while path access fails.
- `WorkerConfigController` applies `DeviceMutableConfiguration` and returns `DeviceConfigurationState`; local config files are written only after validation and runtime application, with failed/blocked responses retaining the previous applied value.
- Removed the old worker configuration network message handlers and old roots/Codex settings network writes. Existing local CLI configuration fields remain supported as on-disk storage and are translated to the explicit home/custom/disabled policy.
- Pairing now uses `/api/devices/join` and the v9 device identity/authentication fields.

Validation:

- `npx vitest run tests/runtime/config-controller.test.ts tests/runtime/worker-environment.test.ts --maxWorkers=1` — 11 tests passed.
- Manual disabled-policy check with a temporary root and real `DevelopmentService` — roots report empty, list is rejected outside an allowed root, and `describe()` reports development ready.
- `npm run build -- --pretty false` reaches only the deferred Task 1 engine/session/knowledge diagnostics; no diagnostics remain in the Task 3 Computer files.
- Existing pre-Task 3 suites that still send removed v8 WorkerReport/configuration or roots-update messages require the protocol-v9 test migration and are not used as a compatibility contract.
