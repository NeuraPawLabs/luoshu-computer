# Luoshu Computer

MIT-licensed local execution client for [Luoshu](https://github.com/NeuraPawLabs/luoshu). Device runtime, wire protocol and local tests live in this independent repository; Core and Console are maintained separately. Dependencies retain their own licenses.

The supported target is Linux x64 with systemd user services. Codex/OpenCode are installed and authenticated separately by each user.

## Install from GitHub

```sh
curl -fsSL https://raw.githubusercontent.com/NeuraPawLabs/luoshu-computer/main/scripts/templates/install-github-computer.sh | sh
luoshu-computer setup --server https://console.example --code '<pairing-code>' --name 'My computer'
luoshu-computer status
luoshu-computer doctor
```

Get a pairing code from your Luoshu instance and approve the device after registration. The installer needs curl, OpenSSL with Ed25519 support, Python 3, tar and flock; Node.js is bundled in the release. No GitHub login or user-managed signing key is needed.

The installer uses the repository's latest signed formal GitHub Release. It verifies the manifest against its embedded public key before downloading the archive, then checks the protocol, platform, digest, size and extraction paths. `LUOSHU_RELEASE_TAG=v0.1.0` selects a particular release. An absent or invalid signature stops installation and preserves existing state.

```sh
luoshu-computer update
```

Setup remembers the installer-verified GitHub repository and signing key locally. CLI and daemon updates verify signed GitHub Releases with this pinned key and accept only official GitHub asset redirects. Active work defers updates; activation and startup rollback are atomic. Source/key settings are not sent to Core or editable from its control plane.

For a trusted custom repository, set `LUOSHU_COMPUTER_REPOSITORY=owner/repository` and `LUOSHU_RELEASE_KEY=/trusted/public.pem` during installation. Static signed feeds are also supported with `setup --release-url https://downloads.example/computer --release-key /trusted/public.pem`. The manifest cannot replace the pinned trust key.

## Build and verify

Node.js 22+ and npm are required to build:

```sh
npm ci
npm run build
npm run lint
npm test
npm run package
npm run test:package
```

The self-contained Linux x64 output is `dist/computer/`. Packaging includes the current Node binary, native modules and licenses, and must run on Linux x64. Set `LUOSHU_NODE_LICENSE_FILE` if the Node distribution's LICENSE cannot be found automatically.

Local/protocol tests do not claim to validate production Core or real model quality. Protocol changes must pass tests in both repositories before release. Initial source provenance is recorded in `source-export.json`.

## Signed releases

GitHub Actions automatically builds and signs a version tag using the **LUOSHU_RELEASE_SIGNING_KEY** repository Secret, then publishes a formal Release. The Secret must match the public key in `release-public-key.pem` and the installer. Missing/mismatched keys stop publication; private keys are never committed or uploaded as release assets. See [Release procedure](RELEASE.md) for one-time configuration, backup and tag commands.

Explicit local unsigned development bundles can still be prepared with `npm run release:prepare`; they are prereleases and cannot be installed through the signed GitHub installer.

See [Contributing](CONTRIBUTING.md), [Compatibility](COMPATIBILITY.md) and [Security](SECURITY.md).
