#!/bin/sh
set -eu
umask 077

REPOSITORY="${LUOSHU_COMPUTER_REPOSITORY:-NeuraPawLabs/luoshu-computer}"
ROOT="${HOME}/.local/share/luoshu-computer"
BIN_DIR="${HOME}/.local/bin"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'Computer supports Linux x64' >&2; exit 1; }
for program in curl openssl python3 tar flock; do
  command -v "$program" >/dev/null 2>&1 || { echo "$program is required to install Computer" >&2; exit 1; }
done
python3 - "$REPOSITORY" <<'PY'
import re,sys
if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+',sys.argv[1]) or sys.argv[1].split('/')[1] in ('.','..'):
    sys.exit('Invalid Computer repository')
PY
mkdir -p "$ROOT/versions" "$BIN_DIR"
exec 9>"${ROOT}/update.lock"
flock --exclusive --timeout 5 9 || { echo 'Another Computer installation/update is in progress' >&2; exit 1; }
work=$(mktemp -d "${ROOT}/github-install.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM
fetch() {
  fetch_url=$1; fetch_output=$2; fetch_limit=$3; fetch_redirects=0
  while :; do
    : > "$work/headers"
    curl -fsS --proto '=https' --tlsv1.2 --retry 3 --max-time 120 --max-filesize "$fetch_limit" -D "$work/headers" "$fetch_url" -o "$fetch_output"
    fetch_location=$(awk 'tolower($1)=="location:" {sub(/^[^:]*:[[:space:]]*/, "");sub(/\r$/, ""); location=$0} END {print location}' "$work/headers")
    [ -n "$fetch_location" ] || return 0
    fetch_redirects=$((fetch_redirects + 1))
    [ "$fetch_redirects" -le 5 ] || { echo 'Too many GitHub download redirects' >&2; exit 1; }
    fetch_url=$(python3 - "$fetch_url" "$fetch_location" <<'PY'
import sys,urllib.parse
source=urllib.parse.urlparse(sys.argv[1]);target=urllib.parse.urlparse(urllib.parse.urljoin(sys.argv[1],sys.argv[2]))
if source.hostname=='api.github.com' or target.scheme!='https' or target.username or target.password or target.port or target.fragment or target.hostname not in ('release-assets.githubusercontent.com','objects.githubusercontent.com'):
    sys.exit('Unsafe GitHub download redirect')
print(target.geturl())
PY
    )
  done
}

if [ -n "${LUOSHU_RELEASE_KEY:-}" ]; then
  cp "$LUOSHU_RELEASE_KEY" "$work/public.pem"
else
  cat > "$work/public.pem" <<'PUBLIC_KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVXQcv6oBBV4m8VL8jTWbh7P+4vm34F9p1O/+kNd9vZ8=
-----END PUBLIC KEY-----
PUBLIC_KEY
fi
if [ -n "${LUOSHU_RELEASE_TAG:-}" ]; then
  tag=$LUOSHU_RELEASE_TAG
else
  fetch "https://api.github.com/repos/${REPOSITORY}/releases/latest" "$work/latest.json" 1048576
  tag=$(python3 - "$work/latest.json" <<'PY'
import json,sys
release=json.load(open(sys.argv[1]))
if release.get('draft') is not False or release.get('prerelease') is not False:
    sys.exit('No formal Computer release is available')
print(release['tag_name'])
PY
  )
fi
python3 - "$tag" <<'PY'
import re,sys
if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+',sys.argv[1]):
    sys.exit('Invalid Computer release tag')
PY
version=${tag#v}
base="https://github.com/${REPOSITORY}/releases/download/${tag}"
fetch "${base}/manifest.json" "$work/manifest.json" 1048576
fetch "${base}/manifest.sig" "$work/manifest.sig" 64
openssl pkeyutl -verify -pubin -inkey "$work/public.pem" -rawin -in "$work/manifest.json" -sigfile "$work/manifest.sig" >/dev/null 2>&1 || { echo 'Computer release signature verification failed' >&2; exit 1; }
python3 - "$work/manifest.json" "$version" > "$work/archive-info" <<'PY'
import json,re,sys
manifest=json.load(open(sys.argv[1]));version=sys.argv[2]
if set(manifest)!= {'version','protocol_version','releases'} or manifest['version']!=version or type(manifest['protocol_version']) is not int or manifest['protocol_version']!=8:
    sys.exit('Computer release version or protocol mismatch')
release=manifest['releases'].get('linux-x64',{})
if set(release)!= {'path','size','sha256'} or release['path']!=f'/computer/releases/{version}/linux-x64.tar.gz' or type(release['size']) is not int or not 0<release['size']<=524288000 or not re.fullmatch(r'[a-f0-9]{64}',str(release['sha256'])):
    sys.exit('Invalid Computer archive metadata')
print(release['size'],release['sha256'])
PY
read -r size sha < "$work/archive-info"
fetch "${base}/luoshu-computer-${version}-linux-x64.tar.gz" "$work/archive.tar.gz" "$size"
python3 - "$work/archive.tar.gz" "$size" "$sha" <<'PY'
import hashlib,pathlib,sys,tarfile
path=sys.argv[1]
if pathlib.Path(path).stat().st_size!=int(sys.argv[2]) or hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()!=sys.argv[3]:
    sys.exit('Computer archive digest or size mismatch')
with tarfile.open(path,'r:gz') as archive:
    total=0;count=0
    for entry in archive:
        count+=1;total+=entry.size
        if count>100000 or total>2147483648 or entry.name.startswith('/') or '..' in entry.name.split('/') or '\\' in entry.name or not (entry.isdir() or entry.isreg()) or entry.issparse():
            sys.exit('Unsafe Computer archive')
PY
stage="$work/build"
mkdir "$stage"
tar --no-same-owner -xzf "$work/archive.tar.gz" -C "$stage"
printf '{"version":"%s","sha256":"%s"}\n' "$version" "$sha" > "$stage/.luoshu-release.json"
version_dir=$(mktemp -d "${ROOT}/versions/${version}-XXXXXX")
mv -T "$stage" "$version_dir"
python3 - "$work/public.pem" "$REPOSITORY" > "$work/release-source.json" <<'PY'
import json,sys
print(json.dumps({'repository':sys.argv[2],'public_key':open(sys.argv[1]).read()}))
PY
mv "$work/release-source.json" "${ROOT}/release-source.json"
cat > "$work/launcher" <<'LAUNCHER'
#!/bin/sh
set -eu
ROOT="${HOME}/.local/share/luoshu-computer"
rollback="${ROOT}/rollback-version"
attempted="${ROOT}/update-attempted"
if [ "${1:-}" = daemon ]; then
  if [ -f "$rollback" ] && [ -f "$attempted" ]; then
    previous=$(cat "$rollback")
    [ -d "$previous" ] && ln -sfn "$previous" "${ROOT}/current"
    rm -f "$rollback" "$attempted"
  elif [ -f "$rollback" ]; then
    : > "$attempted"
  fi
fi
entry="${ROOT}/current/app/dist/main.js"
[ -f "$entry" ] || entry="${ROOT}/current/app/apps/worker/dist/computer-main.js"
exec "${ROOT}/current/runtime/node" "$entry" "$@"
LAUNCHER
chmod 0755 "$work/launcher"
mv "$work/launcher" "${BIN_DIR}/luoshu-computer"
ln -s "$version_dir" "$work/current"
mv -Tf "$work/current" "${ROOT}/current"
echo "洛书设备端 ${version} 已安装并通过发行签名验证。请运行："
echo "  luoshu-computer setup --server 'https://你的洛书地址' --code '<注册码>' --name '我的设备'"
