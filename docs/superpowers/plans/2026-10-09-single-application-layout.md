# Single Application Layout Implementation Plan

**Goal:** Make luoshu-computer a normal independent Node application with one package, source tree and release pipeline.

**Architecture:** Root src/main.ts starts the Computer CLI; src/runtime retains the low-level Worker CLI and transport/execution implementation. CLI, engines, development, maintenance, protocol and shared helpers live in explicit source modules. Build emits dist/lib; binary archives contain app/dist/main.js with production dependencies. The protocol snapshot remains wire v8 and its initial provenance is historical metadata under docs/provenance.

**Constraints:** Linux x64, Node 22+, systemd 254+, cgroup v2, MIT, Ed25519 signing. Preserve device state, wire messages, CLI setup arguments and the public scripts/templates/install-github-computer.sh URL. Root main is authorized by the user; no push or Release publication is part of this change.

## Tasks

- [x] Add an archive regression that runs the root-installed CLI without workspace dependencies, and legacy-to-flat launcher recovery tests. Verify the expected failures before migration.
- [x] Move Worker code to src/{cli,runtime,engines,development,maintenance}, protocol to src/protocol, helpers to src/shared; move tests to matching tests directories. Rewrite imports by resolving old paths against the relocation map, rather than guessing relative depth.
- [x] Merge all manifests/dependencies into root package.json (name luoshu-computer), remove workspaces/references, emit dist/lib, rebuild lockfile with npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund.
- [x] Rewrite package-runtime.mjs for one root package and production dependency graph. Package app/dist/main.js, validate each current-source module, remove deleted compiled outputs from archives. Update all launchers with a legacy-entry fallback so rollback can start pre-migration builds.
- [x] Remove duplicate repository templates and package-computer-source.mjs; move source-export.json to docs/provenance/source-import.json. Update exact tagged-source release whitelist and its fixtures to the root layout, keeping path/key/Git snapshot protections.
- [x] Update workflows/docs/package tests; run npm ci, npm run build, npm run lint, npm test, npm run package, npm run test:package.
- [x] Review diff and imports, validate the extracted binary launcher, and commit the application layout.
- [x] Prepare a signed release against an unpublished local tag and smoke-install with the real pinned key; record the result. No remote tag rewrites.

**Behavioral evidence:** Package test extracts and invokes the flat CLI with bundled Node. Launcher tests execute rollback fixtures in both layouts. Existing 1031 runtime/protocol tests and signing/install corruption tests must remain passing. Source archive tests must still prove exact tagged bytes and rejection of private files/keys, symlinks, modified worktrees, mismatched tags and keys.

**Validation before commit:** fresh npm ci, clean build and lint; 106 Vitest files / 1032 tests; 43 packaging/signing/installer tests; extracted bundled launcher works outside the checkout; wire v8 source and public key unchanged.

**Release smoke:** Signed v0.1.0 manifest and all artifact digests verified using the existing pinned public key; the real GitHub installer consumed the local signed assets and its installed flat CLI ran successfully. Archive packaging retains only a generated historical entry forwarder for old updater launchers, with no duplicate runtime or workspace package.
