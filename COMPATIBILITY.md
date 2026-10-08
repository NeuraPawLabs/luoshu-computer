# Compatibility

| Computer | Wire protocol | Packaged platform | Build runtime |
| --- | --- | --- | --- |
| 0.1.0 | 8 | Linux x64, systemd user services | Node.js 22.17.1 |

The independent public version sequence starts at 0.1.0. The earlier 0.1.6 repository import was release preparation; it had no published version tag or Release when the starting version was corrected. Monorepo device versions belong to a separate preparation sequence.

Computer version and protocol version are separate. Core and Computer currently require the same exact wire version. A package version bump does not establish backward compatibility; automatic updates reject a manifest with a different protocol before downloading the archive.

Codex/OpenCode are user-installed tools with their own accounts. The runtime detects and audits capabilities before advertising them; this repository does not bundle or license those programs. A successfully installed Computer does not imply an authenticated Agent or an available model.

The Core database and scheduler remain in the parent repository; this independent repository runs the device-local and protocol suites. Protocol or execution-contract changes must also pass the corresponding Core integration tests before both systems are released.

The parent repository is `NeuraPawLabs/luoshu`; the initial exact import commit and content hashes are in `source-export.json`. After independent development, synchronize by reviewing changes against the parent compatibility snapshot. Do not delete or replace a user's running database or identity to make a version appear compatible.
