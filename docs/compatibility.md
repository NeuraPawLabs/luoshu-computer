# Compatibility

| Computer | Wire protocol | Packaged platform | Build runtime |
| --- | --- | --- | --- |
| 0.1.1 (current source) | 9 | Linux x64, systemd 254+ user services, cgroup v2 | Node.js 22.17.1 |

The independent public version sequence starts at 0.1.0. The earlier 0.1.6 repository import was release preparation; it had no published version tag or Release when the starting version was corrected. Monorepo device versions belong to a separate preparation sequence.

Computer version and protocol version are separate. Core and Computer currently require the same exact wire version. A package version bump does not establish backward compatibility; automatic updates reject a manifest with a different protocol before downloading the archive.

Codex/OpenCode are user-installed tools with their own accounts. The runtime detects and audits capabilities before advertising them; this repository does not bundle or license those programs. A successfully installed Computer does not imply an authenticated Agent or an available model.

The Core database and scheduler remain in the parent repository; this independent repository runs the device-local and protocol suites. Protocol or execution-contract changes must also pass the corresponding Core integration tests before both systems are released.

## Current source alignment

The current source implements device protocol **9** and must be released together with a matching Core build. Package version 0.1.1 alone does not establish which protocol an older binary implements; use the signed release manifest and source revision.

`src/protocol` matches Core `packages/protocol/src`. Device identity (`device_id`), current transport (`connection_generation`), business Session (`session_id`), native engine session (`engine_session_id`), native thread (`native_thread_id`) and prepared execution workspace (`execution_workspace_id`) are distinct. Device observations report platform, software, agents and typed services; Core owns activation, names and Agent grants. Configuration has explicit desired/applied revisions. No protocol-8 downgrade or old WorkerReport aliases are provided.

Both Core decisions and Worker submissions belong to `run_id`; `batch_id` remains internal to Core intake and is rejected on the wire. Core-role sessions expose no native Worker tools. Matching version numbers alone do not prove independently copied schemas agree: run both protocol suites and the joint integration gates before release.

## Device-backed Core Agent capability

Core requires a ready `assistant_engine` service with the supported version and required features, including `core_agent_runtime`. Detection of Codex alone is insufficient; Core also checks activation, current transport, Agent grant and capacity. Restarting an older v8 binary cannot provide v9 support.

Core bindings use `role: "core"` and require a per-submission `output_schema`; missing roles keep the existing Worker behavior. The device forwards the schema as native `turn/start.outputSchema`. Core sessions use a host-owned read-only permission profile with no runtime workspace roots or command network access, even when the device's Worker mode is full access. They receive no native dynamic tools, attachments, Codebase grants or Worker run-file instructions. Inherited native tools, MCP servers, apps, plugins, hooks, `notify` commands and local project instructions are disabled for the Core thread without changing the user's on-disk configuration. Tool proposals in the structured answer are executed and authorized by Core.

A completed Core result acknowledges late `renew` requests without reopening execution, so completion before the submit acknowledgement or during a heartbeat does not prevent result collection. A pre-reservation capacity refusal uses `DEVICE_CORE_CAPACITY_UNAVAILABLE` with `retryable: true`; this is the only error that proves no turn started and allows Core to queue the same round again. Lost responses and failures after reservation retain the unknown-execution fence. Installation updates validate the target protocol and retain rollback data.

Readiness advertising still relies on the existing native login/permission audit. A dedicated startup probe for structured output and Core tool isolation remains a follow-up; a report is not proof that an arbitrary Codex version or host sandbox supports the contract. The opt-in check below uses a temporary Codex home and a local fake Responses server, with no user credentials or paid model calls:

```sh
LUOSHU_CODEX_NATIVE_TEST_BINARY="$(command -v codex)" npx vitest run tests/engines/core-agent-native.test.ts
```

The check verifies the actual native model request has `tools: []`, strict structured output, and read-only/no-network permissions, including inherited required MCP servers, Code Mode, token/context/time/executor features and previously registered Worker tools. It also verifies inherited `notify` commands do not run. The current compatibility verification uses Codex 0.162.1.

Joint validation from the Core checkout, after building this Computer checkout:

```sh
LUOSHU_COMPUTER_DIR=/absolute/path/to/luoshu-computer npx vitest run apps/core/tests/device-core-computer-integration.test.ts
```

The parent repository is `NeuraPawLabs/luoshu`; the initial exact import commit and content hashes are in `provenance/source-import.json`. After independent development, synchronize by reviewing changes against the parent compatibility snapshot. Do not delete or replace a user's running database or identity to make a version appear compatible.

The independent application uses one root package and `src/protocol` as its wire contract boundary. Runtime archives use `app/dist/main.js`. A generated historical entry forwards old updater launchers to this flat entry; it contains no second implementation or workspace dependency. New launchers also retain a fallback for legacy builds during rollback. Device identity and state paths are unchanged.
