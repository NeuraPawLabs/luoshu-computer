#!/bin/sh
set -eu

REPOSITORY="${LUOSHU_COMPUTER_REPOSITORY:-NeuraPawLabs/luoshu-computer}"
API_BASE="https://api.github.com/repos/${REPOSITORY}"
ROOT="${HOME}/.local/share/luoshu-computer"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$ROOT/versions" "$BIN_DIR"
work=$(mktemp -d "${ROOT}/github-install.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1" -o "$2"; }

case "$REPOSITORY" in
  */*) : ;;
  *) echo 'Invalid Computer repository' >&2; exit 1 ;;
esac
if [ -n "${LUOSHU_RELEASE_TAG:-}" ]; then
  tag=$LUOSHU_RELEASE_TAG
else
  releases="$work/releases.json"
  fetch "${API_BASE}/releases?per_page=20" "$releases"
  tag=$(sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9A-Za-z.-]*\)".*/\1/p' "$releases" | head -n 1)
fi
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) : ;;
  *) echo 'No public Computer release tag was found' >&2; exit 1 ;;
esac
version=${tag#v}
case "$version" in *[!A-Za-z0-9.+_-]*|.*|-*) echo 'Invalid Computer version' >&2; exit 1;; esac
base="https://github.com/${REPOSITORY}/releases/download/${tag}"
for name in release.json SHA256SUMS manifest.json install.sh "luoshu-computer-${version}-linux-x64.tar.gz"; do
  fetch "${base}/${name}" "${work}/${name}"
done
if grep -q 'manifest.sig' "${work}/SHA256SUMS"; then
  fetch "${base}/manifest.sig" "${work}/manifest.sig"
fi
if grep -q "luoshu-computer-source-${version}.tar.gz" "${work}/SHA256SUMS"; then
  fetch "${base}/luoshu-computer-source-${version}.tar.gz" "${work}/luoshu-computer-source-${version}.tar.gz"
fi
(
  cd "$work"
  sha256sum -c SHA256SUMS
)
release_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9A-Za-z.+_-]*\)".*/\1/p' "${work}/release.json" | head -n 1)
[ "$release_version" = "$version" ] || { echo 'Computer release metadata does not match its tag' >&2; exit 1; }
manifest_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9A-Za-z.+_-]*\)".*/\1/p' "${work}/manifest.json" | head -n 1)
[ "$manifest_version" = "$version" ] || { echo 'Computer manifest does not match its tag' >&2; exit 1; }

version_dir="${ROOT}/versions/${version}"
rm -rf "$version_dir"
mkdir -p "$version_dir"
tar -xzf "${work}/luoshu-computer-${version}-linux-x64.tar.gz" -C "$version_dir"
printf '{"version":"%s","repository":"%s","tag":"%s"}\n' "$version" "$REPOSITORY" "$tag" > "$version_dir/.luoshu-release.json"
ln -sfn "$version_dir" "${ROOT}/current"
cat > "${BIN_DIR}/luoshu-computer" <<'LAUNCHER'
#!/bin/sh
set -eu
ROOT="${HOME}/.local/share/luoshu-computer"
exec "${ROOT}/current/runtime/node" "${ROOT}/current/app/apps/worker/dist/computer-main.js" "$@"
LAUNCHER
chmod 0755 "${BIN_DIR}/luoshu-computer"
echo "洛书设备端 ${version} 已安装。请运行："
echo "  luoshu-computer setup --server 'https://你的洛书地址' --code '<注册码>'"
