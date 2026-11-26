# Device protocol

Core and Computer both require device protocol **v10**. Computer **0.2.0** packages v10; the older **0.1.1** release packages v8. Install the matching Computer package when upgrading Core, then reconnect the device. The signed manifest declares the protocol version. Installers and automatic updates only accept the current protocol, so upgrades across protocol versions use the [matching signed installer](releasing.md#installation-and-updates). Packaged releases target Linux x64 with systemd 254+ user services and cgroup v2; the build uses Node.js 22.17.1.

The Computer wire schemas in `src/protocol` and Core's device wire schemas in `packages/protocol/src` must agree. Device identity (`device_id`), connection generation, conversation, native Agent session, native thread, and execution workspace have separate identities. Device reports describe observed services; Core grants execution authority.

Native sessions require `role: "main"` or `role: "subagent"`, and every submission requires `output_schema`. Computer passes it to Codex as `turn/start.outputSchema`. Both roles have the same native execution path and use the device's configured permissions, tools, and authorized Codebases. Readiness requires the current `assistant_engine` service and Codex readiness checks.

A pre-reservation capacity refusal uses `DEVICE_AGENT_CAPACITY_UNAVAILABLE`. An interrupted turn must be checked against its original receipt before Core can confirm a result. Task execution, development and maintenance remain separate services. Agent tools such as Codex and OpenCode are installed by the device owner.

Run the protocol and runtime suites in both repositories before releasing a wire change. Runtime archives and launchers use `app/dist/main.js`.
