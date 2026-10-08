import {z} from 'zod';
import {PROTOCOL_VERSION} from './wire-base.js';

export const MAX_COMPUTER_RELEASE_BYTES = 500 * 1024 * 1024;
const archivePath = z.string().max(500).refine(path =>
  /^\/[A-Za-z0-9._/-]+\.tar\.gz$/.test(path) &&
  path.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
  'Unsafe Computer archive path');
export const computerReleaseManifestSchema = z.object({
  version: z.string().regex(/^\d[A-Za-z0-9.+_-]{0,119}$/),
  protocol_version: z.literal(PROTOCOL_VERSION),
  releases: z.record(z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/),z.object({
    path: archivePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(MAX_COMPUTER_RELEASE_BYTES),
  }).strict()).refine(releases => Object.keys(releases).length > 0 && Object.keys(releases).length <= 16),
}).strict();
export type ComputerReleaseManifest = z.infer<typeof computerReleaseManifestSchema>;
