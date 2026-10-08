# Luoshu Computer

MIT-licensed local execution client for Luoshu. This source tree contains the device runtime, shared wire protocol and common utilities. It contains no Core or Console implementation. Dependencies retain their own licenses.

The supported release target is Linux x64 with systemd user services. Node.js 22+ and npm are required to build. Codex/OpenCode are separately installed and authenticated by the user; they are not bundled here.

The public repository is intended as `NeuraPawLabs/luoshu-computer`. Initial source provenance is recorded in `source-export.json`; the history imported here contains only the approved MIT source subset. See [Contributing](CONTRIBUTING.md), [Compatibility](COMPATIBILITY.md), [Security](SECURITY.md) and [Release procedure](RELEASE.md).

## Build and verify

```sh
npm ci
npm run build
npm test
npm run package
npm run test:package
```

The self-contained release is written to `dist/computer/`. Packaging bundles the current Node binary and native modules and therefore must run on Linux x64. The Node distribution LICENSE must be present in its installation prefix; an explicit path can be provided through `LUOSHU_NODE_LICENSE_FILE`.

Two Core↔Worker integration tests remain in the main repository and are listed in `source-export.json`. The exported tests cover local runtime and protocol behavior; running them does not claim to validate a production Core or real model quality.

## Signed independent updates

Build an immutable release, then sign its original manifest bytes with an existing Ed25519 private key:

```sh
npm run sign -- --release dist/computer --key /secure/path/release-private.pem
```

The private key must be outside the release directory and never published. Serve `manifest.json`, `manifest.sig`, `install.sh` and `releases/` at a stable HTTPS directory such as `https://downloads.example/computer`. The public key is obtained and checked separately; the feed cannot replace its own trust key. Dynamic redirect download endpoints are unsupported.

Install and pair with the independently verified public key:

```sh
curl -fsS --proto '=https' https://downloads.example/computer/install.sh -o install-computer.sh
# Inspect the installer obtained from the trusted release source before running it.
LUOSHU_BASE_URL=https://downloads.example LUOSHU_RELEASE_KEY=/trusted/path/release-public.pem sh install-computer.sh
luoshu-computer setup --server https://console.example --code '<pairing-code>' --name 'My computer' --release-url https://downloads.example/computer --release-key /trusted/path/release-public.pem
luoshu-computer status
luoshu-computer doctor
```

The initial installer still comes from the HTTPS source you chose; signature verification authenticates the manifest and archive, not arbitrary installer code. Local release settings are not sent to Core or editable through its control plane. Existing clients without an independent source continue using their configured Core's `/computer/` mirror with SHA-256 integrity checks.

CLI and daemon updates reject incompatible protocol versions and invalid signatures, archive paths, byte sizes or digests. Active work defers updates; existing atomic activation and rollback remain in place. Publishing a new manifest requires rebuilding and signing; do not replace archive bytes under an existing version.

## Manual prerelease downloads

On a clean version-tagged checkout, `npm run release:prepare` creates the exact source snapshot, Linux x64 binary, original manifest/installer, metadata and checksums in `dist/release-bundle/`. Without an explicitly supplied external Ed25519 key it produces an unsigned **prerelease**. Verify the release commit and SHA256SUMS before installing. GitHub attachment URLs redirect and are not automatic update feed URLs.
