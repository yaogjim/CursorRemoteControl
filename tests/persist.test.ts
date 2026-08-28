import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileAtomic, writeJsonAtomic } from '../src/server/persist.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persist-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories', () => {
    const filePath = join(dir, 'nested', 'deep', 'file.txt');
    writeFileAtomic(filePath, 'hello\n');
    assert.equal(readFileSync(filePath, 'utf-8'), 'hello\n');
  });

  it('replaces an existing file and leaves no tmp siblings', () => {
    const filePath = join(dir, 'state.json');
    writeFileSync(filePath, 'old');
    writeFileAtomic(filePath, '{"ok":true}\n');
    assert.equal(readFileSync(filePath, 'utf-8'), '{"ok":true}\n');
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('writeJsonAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persist-json-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON with a trailing newline and round-trips', () => {
    const filePath = join(dir, 'out.json');
    writeJsonAtomic(filePath, { a: 1, b: [true] });
    const raw = readFileSync(filePath, 'utf-8');
    assert.equal(raw.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(raw), { a: 1, b: [true] });
  });

  it('pretty-prints when space is provided', () => {
    const filePath = join(dir, 'pretty.json');
    writeJsonAtomic(filePath, { token: 'x' }, 2);
    const raw = readFileSync(filePath, 'utf-8');
    assert.equal(raw, '{\n  "token": "x"\n}\n');
  });

  it('overwrites remain valid JSON (no torn file)', () => {
    const filePath = join(dir, 'scratch.json');
    for (let i = 0; i < 20; i++) {
      writeJsonAtomic(filePath, { i, pad: 'x'.repeat(200) });
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { i: number };
      assert.equal(parsed.i, i);
    }
    assert.equal(existsSync(filePath), true);
  });
});