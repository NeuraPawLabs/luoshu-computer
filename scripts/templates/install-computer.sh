#!/bin/sh
set -eu

BASE_URL="__LUOSHU_BASE_URL__"
ROOT="${HOME}/.local/share/luoshu-computer"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$ROOT/versions" "$BIN_DIR"
manifest=$(mktemp "${ROOT}/manifest.XXXXXX")
archive=$(mktemp "${ROOT}/archive.XXXXXX")
signature=$(mktemp "${ROOT}/signature.XXXXXX")
cleanup() { rm -f "$manifest" "$archive" "$signature"; }
trap cleanup EXIT INT TERM
fetch() { curl -fsSL --proto '=https,http' --tlsv1.2 "$1" -o "$2"; }
fetch "${BASE_URL}/computer/manifest.json" "$manifest"
if [ -n "${LUOSHU_RELEASE_KEY:-}" ]; then
  command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to verify the Computer release signature' >&2; exit 1; }
  fetch "${BASE_URL}/computer/manifest.sig" "$signature"
  openssl pkeyutl -verify -pubin -inkey "$LUOSHU_RELEASE_KEY" -rawin -in "$manifest" -sigfile "$signature" >/dev/null || { echo 'Computer release signature verification failed' >&2; exit 1; }
fi
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")
sha=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")
path=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")
[ -n "$version" ] && [ -n "$sha" ] && [ -n "$path" ]
case "$version" in *[!A-Za-z0-9.+_-]*|.*|-*) echo 'Invalid Computer version' >&2; exit 1;; esac
[ "${#sha}" -eq 64 ] || exit 1
case "$sha" in *[!a-f0-9]*) echo 'Invalid Computer digest' >&2; exit 1;; esac
fetch "${BASE_URL}${path}" "$archive"
actual=$(sha256sum "$archive" | awk '{print $1}')
[ "$actual" = "$sha" ] || { echo '洛书设备端下载校验失败' >&2; exit 1; }
version_dir="${ROOT}/versions/${version}"
rm -rf "$version_dir"
mkdir -p "$version_dir"
tar -xzf "$archive" -C "$version_dir"
printf '{"version":"%s","sha256":"%s"}\n' "$version" "$sha" > "$version_dir/.luoshu-release.json"
ln -sfn "$version_dir" "${ROOT}/current"
cat > "${BIN_DIR}/luoshu-computer" <<'LAUNCHER'
#!/bin/sh
set -eu
ROOT="${HOME}/.local/share/luoshu-computer"
rollback="${ROOT}/rollback-version"
attempted="${ROOT}/update-attempted"
if [ "${1:-}" = 'daemon' ]; then
  if [ -f "$rollback" ] && [ -f "$attempted" ]; then
    previous=$(cat "$rollback")
    [ -d "$previous" ] && ln -sfn "$previous" "${ROOT}/current"
    rm -f "$rollback" "$attempted"
  elif [ -f "$rollback" ]; then
    : > "$attempted"
  fi
fi
exec "${ROOT}/current/runtime/node" "${ROOT}/current/app/apps/worker/dist/computer-main.js" "$@"
LAUNCHER
chmod 0755 "${BIN_DIR}/luoshu-computer"
echo "洛书设备端 ${version} 已安装。请运行："
echo "  luoshu-computer setup --server '${BASE_URL}' --code '<注册码>' --name '<设备名称>'"
