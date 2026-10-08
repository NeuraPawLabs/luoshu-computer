# Release procedure

The first independent version is 0.1.6 with protocol 8. Unsigned releases are explicitly marked **prerelease** and never advertised as automatic-update sources.

1. Update `apps/worker/package.json`, `apps/worker/src/computer/version.ts`, the independent root package version, lockfile and compatibility documentation together. Run `npm ci`, `npm run build`, `npm run lint`, `npm test`, `npm run package` and `npm run test:package`.
2. Commit reviewed sources on `main` and tag the clean commit `v<package-version>`, such as `v0.1.6`. Never reassign an already published tag or replace bytes under its immutable archive path.
3. Run `npm run release:prepare`. The tool checks the tag, clean Git worktree and exact tracked bytes, license and version, then forces a new build/package to bind the binary to those sources. It validates the resulting manifest/archive and creates a tracked-source snapshot, release files, `SHA256SUMS`, `release.json` and human release notes under `dist/release-bundle/`.
4. If an existing Ed25519 release key is available, use `npm run release:prepare -- --key /secure/path/private.pem`. Keep the key outside the source tree and output directory. Store/distribute its public key through a separately trusted channel. Do not generate or upload private keys through CI or a GitHub Release.
5. Upload only the explicit artifact list in `release.json`; retain exact commit, protocol, digests and whether the manifest is signed. Use GitHub's prerelease flag for unsigned content. The manual workflow prepares and publishes only unsigned prereleases with the repository token; it never handles a release signing secret.

GitHub Release attachments use redirects. They are suitable for manual download and inspection, not for the Worker's redirect-free automatic update feed. To provide automatic updates, serve the unmodified `manifest.json`, matching `manifest.sig`, `install.sh` and the original `releases/<version>/linux-x64.tar.gz` paths at a stable HTTPS `/computer/` directory. Alternately mount a verified release mirror into Core. Do not change the manifest's paths after signing.

The initial installer still has to come from a trusted source. The optional `LUOSHU_RELEASE_KEY` verifies the downloaded manifest during installation; `--release-url` and `--release-key` pin subsequent updates locally. A checksum alone is an integrity check and not publisher authentication.
