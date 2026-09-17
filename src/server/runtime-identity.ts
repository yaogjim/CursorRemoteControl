import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_NAME = 'cursor-remote';
const PACKAGE_RELATIVE_CANDIDATES = ['../../package.json', '../package.json', '../../../package.json'] as const;

export type BuildFingerprintScope = 'bundle' | 'unavailable';

export interface BuildFingerprint {
  digest: string | null;
  scope: BuildFingerprintScope;
}

export interface RuntimeIdentity {
  version: string;
  instanceId: string;
  startedAt: string;
  build: BuildFingerprint;
}

let cached: RuntimeIdentity | undefined;

export function readPackageVersion(fromMetaUrl: string): string {
  for (const rel of PACKAGE_RELATIVE_CANDIDATES) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, fromMetaUrl), 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

export function describeBuildFingerprint(fromMetaUrl: string): BuildFingerprint {
  let filePath: string;
  try {
    filePath = fileURLToPath(fromMetaUrl);
  } catch {
    return { digest: null, scope: 'unavailable' };
  }
  if (basename(filePath) !== 'bundle.mjs') {
    return { digest: null, scope: 'unavailable' };
  }
  try {
    const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return { digest, scope: 'bundle' };
  } catch {
    return { digest: null, scope: 'unavailable' };
  }
}

export function getRuntimeIdentity(): RuntimeIdentity {
  if (!cached) {
    cached = {
      version: readPackageVersion(import.meta.url),
      instanceId: randomBytes(16).toString('hex'),
      startedAt: new Date().toISOString(),
      build: describeBuildFingerprint(import.meta.url),
    };
  }
  return cached;
}