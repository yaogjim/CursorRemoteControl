import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  MAX_PLAN_FILE_BYTES,
  readPlanFile,
  readPlanFileResult,
  resolvePlanFilePath,
} from '../src/server/plan-files.js';

const PLAN_MD = `---
name: Safe Plan
todos:
  - id: t1
    content: Do the thing
    status: pending
---

# Safe Plan Body
`;

const SECRET = 'SECRET_SHOULD_NOT_LEAK';

describe('resolvePlanFilePath', () => {
  const root = '/tmp/cursor-plans-root';

  it('resolves a legitimate plan filename inside the root', () => {
    const path = resolvePlanFilePath('safe_plan_abc123.plan.md', root);
    assert.equal(path, resolve(root, 'safe_plan_abc123.plan.md'));
  });

  it('resolves unicode plan filenames', () => {
    const label = '中文计划_deadbeef.plan.md';
    const path = resolvePlanFilePath(label, root);
    assert.equal(path, resolve(root, label));
  });

  it('rejects parent-directory traversal', () => {
    assert.equal(resolvePlanFilePath('../secret.md', root), null);
    assert.equal(resolvePlanFilePath('foo/../../secret.md', root), null);
    assert.equal(resolvePlanFilePath('..', root), null);
    assert.equal(resolvePlanFilePath('.', root), null);
  });

  it('rejects absolute paths', () => {
    assert.equal(resolvePlanFilePath('/etc/passwd', root), null);
    assert.equal(resolvePlanFilePath('/tmp/cursor-plans-root/../secret.md', root), null);
  });

  it('rejects empty and NUL-containing labels', () => {
    assert.equal(resolvePlanFilePath('', root), null);
    assert.equal(resolvePlanFilePath('safe.plan.md\0../secret.md', root), null);
  });
});

describe('readPlanFile', () => {
  let fixtureRoot: string;
  let plansRoot: string;
  let secretPath: string;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'plan-files-'));
    plansRoot = join(fixtureRoot, 'plans');
    mkdirSync(plansRoot);
    writeFileSync(join(plansRoot, 'safe_plan_abc123.plan.md'), PLAN_MD);
    writeFileSync(join(plansRoot, '中文计划_deadbeef.plan.md'), PLAN_MD);
    writeFileSync(join(plansRoot, 'too-large.plan.md'), Buffer.alloc(MAX_PLAN_FILE_BYTES + 1, 65));
    mkdirSync(join(plansRoot, 'directory.plan.md'));
    secretPath = join(fixtureRoot, 'secret.md');
    writeFileSync(secretPath, SECRET);
    symlinkSync(secretPath, join(plansRoot, 'outside-link.plan.md'));
    symlinkSync(join(plansRoot, 'safe_plan_abc123.plan.md'), join(plansRoot, 'inside-link.plan.md'));
  });

  after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('reads a legitimate plan file', () => {
    const data = readPlanFile('safe_plan_abc123.plan.md', plansRoot);
    assert.ok(data);
    assert.equal(data.body, '# Safe Plan Body');
    assert.equal(data.todos.length, 1);
    assert.equal(data.todos[0].text, 'Do the thing');
    assert.equal(data.todos[0].status, 'pending');
  });

  it('reads a unicode plan filename', () => {
    const data = readPlanFile('中文计划_deadbeef.plan.md', plansRoot);
    assert.ok(data);
    assert.equal(data.body, '# Safe Plan Body');
  });

  it('returns null for missing plans without throwing', () => {
    assert.equal(readPlanFile('does-not-exist.plan.md', plansRoot), null);
  });

  it('does not read files outside the plans directory', () => {
    assert.equal(readPlanFile('../secret.md', plansRoot), null);
    assert.equal(readPlanFile('foo/../../secret.md', plansRoot), null);
    assert.equal(readPlanFile(secretPath, plansRoot), null);
    assert.equal(readPlanFile(resolve(plansRoot, '..', 'secret.md'), plansRoot), null);
  });

  it('rejects symlinks even when their directory entry and target are inside plans', () => {
    const outside = readPlanFileResult('outside-link.plan.md', plansRoot);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.error, 'invalid_path');
    assert.equal(readPlanFile('outside-link.plan.md', plansRoot), null);

    const inside = readPlanFileResult('inside-link.plan.md', plansRoot);
    assert.equal(inside.ok, false);
    if (!inside.ok) assert.equal(inside.error, 'invalid_path');
    assert.equal(readPlanFile('inside-link.plan.md', plansRoot), null);
  });

  it('rejects non-regular and oversized plan files', () => {
    const directory = readPlanFileResult('directory.plan.md', plansRoot);
    assert.equal(directory.ok, false);
    if (!directory.ok) assert.equal(directory.error, 'not_regular_file');

    const large = readPlanFileResult('too-large.plan.md', plansRoot);
    assert.equal(large.ok, false);
    if (!large.ok) assert.equal(large.error, 'too_large');
  });
});