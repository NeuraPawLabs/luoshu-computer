# Compatibility

| Computer | Wire protocol | Packaged platform | Build runtime |
| --- | --- | --- | --- |
| 0.1.6 | 8 | Linux x64, systemd user services | Node.js 22.17.1 |

Computer version and protocol version are separate. Core and Computer currently require the same exact wire version. A package version bump does not establish backward compatibility; automatic updates reject a manifest with a different protocol before downloading the archive.

Codex/OpenCode are user-installed tools with their own accounts. The runtime detects and audits capabilities before advertising them; this repository does not bundle or license those programs. A successfully installed Computer does not imply an authenticated Agent or an available model.

Two tests use Core's database/scheduler and stay in the original repository: `apps/worker/tests/assistant-engine-runtime.test.ts` and `apps/worker/tests/native-capacity-integration.test.ts`. This independent repository runs the local/protocol suites. Protocol or execution-contract changes must also pass the corresponding Core integration tests before both systems are released.

The parent repository is `NeuraPawLabs/luoshu`; the initial exact import commit and content hashes are in `source-export.json`. After independent development, synchronize by reviewing changes against the parent compatibility snapshot. Do not delete or replace a user's running database or identity to make a version appear compatible.
