import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  describeBuildFingerprint,
  getRuntimeIdentity,
  readPackageVersion,
} from '../src/server/runtime-identity.js';

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

describe('runtime identity', () => {
  it('resolves cursor-remote version the same way as the server entry', () => {
    const fromServerModule = new URL('../src/server/runtime-identity.ts', import.meta.url).href;
    assert.equal(readPackageVersion(fromServerModule), packageVersion());
  });

  it('returns unknown when no cursor-remote package.json is reachable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-id-pkg-'));
    try {
      const fake = join(dir, 'runtime-identity.js');
      writeFileSync(fake, '');
      assert.equal(readPackageVersion(pathToFileURL(fake).href), 'unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not invent a digest for unbundled source or dist entry files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-id-src-'));
    try {
      for (const name of ['runtime-identity.ts', 'index.js', 'index.ts']) {
        const filePath = join(dir, name);
        writeFileSync(filePath, 'export {}\n');
        assert.deepEqual(describeBuildFingerprint(pathToFileURL(filePath).href), {
          digest: null,
          scope: 'unavailable',
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes only a real bundle.mjs and labels that scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-id-bundle-'));
    try {
      const contents = 'export const marker = "bundle-fixture";\n';
      const bundlePath = join(dir, 'bundle.mjs');
      writeFileSync(bundlePath, contents);
      const fp = describeBuildFingerprint(pathToFileURL(bundlePath).href);
      assert.equal(fp.scope, 'bundle');
      assert.equal(fp.digest, createHash('sha256').update(contents).digest('hex'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a process-wide identity and omits paths from the public snapshot', () => {
    const a = getRuntimeIdentity();
    const b = getRuntimeIdentity();
    assert.equal(a, b);
    assert.equal(a.version, packageVersion());
    assert.match(a.instanceId, /^[0-9a-f]{32}$/);
    assert.equal(Number.isNaN(Date.parse(a.startedAt)), false);
    assert.deepEqual(a.build, { digest: null, scope: 'unavailable' });
    const raw = JSON.stringify(a);
    assert.doesNotMatch(raw, /file:/);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, /package\.json/);
    assert.doesNotMatch(raw, /WEBAPP_PASSWORD|TELEGRAM_BOT_TOKEN|process\.env/);
  });
});