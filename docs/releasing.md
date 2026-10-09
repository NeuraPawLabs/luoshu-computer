# Release procedure

Computer versions are independent of Core. The first public version is **0.1.0**, wire protocol **8**, packaged for Linux x64 with systemd 254+ and cgroup v2.

## One-time signing configuration

The repository's GitHub Actions Secret is named **LUOSHU_RELEASE_SIGNING_KEY**. It contains the complete PEM Ed25519 private key. Its public counterpart is committed as `release-public-key.pem` and embedded in `scripts/templates/install-github-computer.sh`. CI rejects a missing Secret or a key that does not match this pinned public key; it never falls back to an unsigned formal release.

For this repository the initial key was generated outside the checkout:

- Private key: `~/.config/luoshu-computer-release/private.pem` (mode 600).
- Public copy: `~/.config/luoshu-computer-release/public.pem`.

Keep an encrypted backup of the private key outside GitHub. It is not included in any source archive, release asset or Git commit. To restore the Secret from the local private file after signing in to GitHub CLI:

```sh
gh secret set LUOSHU_RELEASE_SIGNING_KEY --repo NeuraPawLabs/luoshu-computer < ~/.config/luoshu-computer-release/private.pem
```

No TLS certificate or manually created GitHub token is required. Actions uses its automatically supplied repository token to publish the Release. End users do not configure a signing key or GitHub account.

## Publish a version

1. Update root `package.json`, `src/cli/version.ts`, `package-lock.json` and `docs/compatibility.md` together when changing versions.
2. Run `npm ci`, `npm run build`, `npm run lint`, `npm test`, `npm run package` and `npm run test:package`.
3. Commit the reviewed code on `main`. Tag that exact commit, then push main and the tag:

   ```sh
   git push origin main
   git tag v0.1.0
   git push origin v0.1.0
   ```

   Use the current version for later releases. If an unpublished local tag already exists, verify it points at the release commit before pushing. Never reassign a published tag or replace an existing Release's assets.
4. The **Computer signed release** workflow checks the tag's commit belongs to main, initializes and verifies the Ubuntu 24.04 systemd user runtime, runs verification, reads the signing Secret only during release preparation, writes the temporary private file outside the source checkout, and deletes it afterwards. Child build processes do not inherit the signing Secret.
5. The workflow uploads the source archive, Linux x64 binary, `manifest.json`, `manifest.sig`, installer, `SHA256SUMS` and release metadata. Signed stable releases become GitHub's latest release. Existing tags can also be released from Actions → Computer signed release → Run workflow on main.

The release tool binds source and binary to the clean tagged Git snapshot and refuses to replace existing releases. The initial version's unpublished tag may be corrected locally before the first push.

## Installation and updates

```sh
curl -fsSL https://raw.githubusercontent.com/NeuraPawLabs/luoshu-computer/main/scripts/templates/install-github-computer.sh | sh
luoshu-computer setup --server https://console.example --code '<pairing-code>' --name 'My computer'
luoshu-computer update
```

The installer needs Linux x64, curl, OpenSSL with Ed25519 support, Python 3, tar and flock. It verifies the exact manifest bytes with the embedded public key **before downloading the archive**. It then checks protocol, platform, tag, digest, size and archive paths before activating the installed version. Verification failure preserves the old version and device identity.

The verified repository and public key are saved in local `release-source.json`; setup copies them into local device configuration without sending them to Core. CLI and daemon updates use GitHub's latest formal release and repeat signature and archive checks. Downloads accept only HTTPS redirects to official GitHub release-asset domains. Unsigned releases are rejected, and active work defers updates.

Custom static HTTPS feeds remain supported via `setup --release-url URL --release-key /trusted/public.pem`. A public key downloaded beside a release does not establish trust; the local pinned key is authoritative. Key rotation requires an explicit local change to that trust setting, rather than a manifest instructing clients to trust a different key.

## Local release preparation

`npm run release:prepare` remains available for explicitly unsigned development bundles, which are prereleases and are not accepted by the signed GitHub installer. For local signed preparation, read the existing private file directly into the helper's environment without printing it:

```sh
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
execFileSync(process.execPath, ['scripts/prepare-signed-computer-release.mjs'], {
  env: {...process.env, LUOSHU_RELEASE_SIGNING_KEY: readFileSync(join(homedir(), '.config/luoshu-computer-release/private.pem'), 'utf8')},
  stdio: 'inherit',
});
JS
```

Output is `dist/release-bundle/`; this command does not push, publish or alter running services.
