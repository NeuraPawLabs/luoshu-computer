import {createHash, createPublicKey, verify} from 'node:crypto';
import {computerReleaseManifestSchema, type ComputerReleaseManifest} from '@luoshu/protocol';
import type {WorkerConfig} from '../environment.js';

export type {ComputerReleaseManifest} from '@luoshu/protocol';

type ReleaseSource = {release_url?: unknown; release_public_key?: unknown};

// Check the original spelling before URL normalization can erase traversal.
function assertSafePath(path: string): void {
  if (/[\\\s\u0000-\u001f\u007f?#]/.test(path)) throw new Error('Invalid Computer release path');
  for (const segment of path.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('Invalid Computer release path encoding'); }
    if (decoded === '.' || decoded === '..' || /[\\/\s\u0000-\u001f\u007f?#%]/.test(decoded)) throw new Error('Unsafe Computer release path');
  }
}

function directoryUrl(value: string): URL {
  if (value !== value.trim() || /[\\\u0000-\u001f\u007f?#]/.test(value)) throw new Error('Invalid Computer release URL');
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Computer release URL requires HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid Computer release URL credentials, query or fragment');
  // Extract from the original URL rather than its already normalized pathname.
  const originalPath = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/.*)?$/i.exec(value)?.[1];
  if (originalPath === undefined && !/^[a-z][a-z\d+.-]*:\/\/[^/]+$/i.test(value)) throw new Error('Invalid Computer release URL');
  assertSafePath(originalPath ?? '/');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

/** Local trust settings never come from a manifest or the Core control plane. */
export function validateComputerReleaseSource(config: ReleaseSource): void {
  const hasUrl = config.release_url !== undefined, hasKey = config.release_public_key !== undefined;
  if (hasUrl !== hasKey) throw new Error('Computer release URL and public key must be specified together');
  if (!hasUrl) return;
  if (typeof config.release_url !== 'string' || !config.release_url) throw new Error('Invalid Computer release URL');
  directoryUrl(config.release_url);
  if (typeof config.release_public_key !== 'string' || !config.release_public_key.trim().startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Computer release key must be an Ed25519 public key in PEM format');
  const key = createPublicKey(config.release_public_key);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Computer release public key must use Ed25519');
}

function archiveUrl(path: string, feed: URL, legacyCoreBase?: string): URL {
  // Legacy Core paths are appended to its configured base, including proxy prefixes.
  const url = legacyCoreBase === undefined ? new URL(path, feed) : new URL(`${legacyCoreBase}${path}`);
  assertSafePath(url.pathname);
  if (url.origin !== feed.origin || !url.pathname.startsWith(feed.pathname) || url.pathname === feed.pathname || url.username || url.password || url.search || url.hash) {
    throw new Error('Computer release archive path is outside the selected feed');
  }
  return url;
}

async function fetchBytes(url: URL, fetchImpl: typeof fetch, maxBytes: number, label: string): Promise<Uint8Array> {
  const response = await fetchImpl(url.href, {redirect:'error'});
  if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url.href) throw new Error('Computer release redirects are forbidden');
  if (!response.ok) throw new Error(`Unable to fetch Computer release (${response.status})`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error(`Computer release ${label} size exceeds the allowed byte count`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Load a signed independent feed, or the legacy unsigned Core mirror. */
export async function fetchComputerRelease(config: WorkerConfig, options: {fetchImpl?: typeof fetch} = {}): Promise<{manifest: ComputerReleaseManifest; download: () => Promise<Uint8Array>}> {
  validateComputerReleaseSource(config);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Computer releases support only the Linux x64 platform');
  const feed = directoryUrl(config.release_url ?? `${config.url.replace(/\/$/, '')}/computer`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestBytes = await fetchBytes(new URL('manifest.json', feed), fetchImpl, 1024 * 1024, 'manifest');
  if (config.release_public_key !== undefined) {
    const signature = await fetchBytes(new URL('manifest.sig', feed), fetchImpl, 64, 'signature');
    if (signature.byteLength !== 64 || !verify(null, manifestBytes, createPublicKey(config.release_public_key), signature)) throw new Error('Computer release manifest signature is invalid');
  }
  const manifest = computerReleaseManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(manifestBytes)));
  const release = manifest.releases['linux-x64'];
  if (!release) throw new Error('No Linux x64 Computer release is available');
  const url = archiveUrl(release.path, feed, config.release_url === undefined ? config.url.replace(/\/$/, '') : undefined);
  const {size, sha256} = release;
  return {manifest, download: async () => {
    const bytes = await fetchBytes(url, fetchImpl, size, 'archive');
    if (bytes.byteLength !== size) throw new Error('Computer release size mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Computer release SHA-256 mismatch');
    return bytes;
  }};
}
