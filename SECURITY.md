# Security

Computer runs on a user's machine and may execute explicitly authorized Agent and Git operations. Its installation directory alone is not an operating-system sandbox. Permissions, process lifecycle and Codebase path checks are part of its security boundary.

For suspected vulnerabilities, use this repository's **Security → Report a vulnerability** if private vulnerability reporting is enabled. If unavailable, contact a maintainer through the organization's publicly provided contact channel; do not put secrets or exploitable private-device details in a public issue. No private reporting mailbox is assumed by this source tree.

Include affected version, operating system, protocol version, reproducible steps and impact, using synthetic data where possible. Never send device identity private keys, model credentials or a release signing key.

Independent automatic update feeds require a locally pinned Ed25519 public key, exact manifest bytes, compatible protocol, validated archive paths, size bounds and SHA-256. Static feeds reject redirects; GitHub downloads permit only HTTPS redirects to official GitHub asset domains. An unsigned GitHub prerelease is for manual inspection/download, not a trusted automatic update feed. A signature authenticates the manifest and its referenced archive; the installer itself is code obtained from the selected trusted source.

Only Linux x64 is currently packaged. Released versions and compatibility are documented in [compatibility](docs/compatibility.md); no support or security-maintenance promise for arbitrary historical versions is implied.
