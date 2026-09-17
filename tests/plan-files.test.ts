import { describe, it, before, after, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import {
  MAX_PLAN_FILE_BYTES,
  fileWorkspacePlansRoot,
  planFileFromFileUri,
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

  it('rejects non-markdown files and alternate traversal syntax', () => {
    for (const label of ['secret.txt', '../safe.plan.md', 'sub/../safe.plan.md', '..\\safe.plan.md', 'C:\\safe.plan.md']) {
      assert.equal(resolvePlanFilePath(label, root), null);
    }
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

  it('binds the full file bytes to a version and observation time', () => {
    const before = Date.now();
    const result = readPlanFileResult('safe_plan_abc123.plan.md', plansRoot);
    assert.ok(result.ok);
    assert.equal(result.version, createHash('sha256').update(PLAN_MD).digest('hex'));
    assert.ok(result.observedAt >= before && result.observedAt <= Date.now());
    assert.equal(result.updatedAt, fs.statSync(join(plansRoot, 'safe_plan_abc123.plan.md')).mtimeMs);
    const changed = PLAN_MD.replace('Safe Plan Body', 'Next Plan Body');
    writeFileSync(join(plansRoot, 'version-change.plan.md'), changed);
    const next = readPlanFileResult('version-change.plan.md', plansRoot);
    assert.ok(next.ok);
    assert.notEqual(next.version, result.version);
  });

  it('rejects a same-size change observed during the read without returning content', () => {
    const original = fs.fstatSync;
    let calls = 0;
    const stub = mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = original(...args);
      calls += 1;
      if (calls === 2) Object.defineProperty(stat, 'mtimeMs', { value: Number(stat.mtimeMs) + 1 });
      return stat;
    });
    syncBuiltinESMExports();
    try {
      const result = readPlanFileResult('safe_plan_abc123.plan.md', plansRoot);
      assert.deepEqual(result, { ok: false, error: 'read_failed' });
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('rejects invalid UTF-8 instead of marking replacement text complete', () => {
    writeFileSync(join(plansRoot, 'invalid-encoding.plan.md'), Buffer.from([0xc3, 0x28]));
    assert.deepEqual(readPlanFileResult('invalid-encoding.plan.md', plansRoot), { ok: false, error: 'read_failed' });
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

const FILE_WORKSPACE = {
  id: '265d56b2c491736926ee6e06eeffd5de',
  uri: { scheme: 'file', authority: '', path: '/Users/yaogj/works/ccspace/cursorremote' },
};

describe('fileWorkspacePlansRoot', () => {
  it('accepts the observed local file workspace and points at its .cursor/plans', () => {
    assert.equal(
      fileWorkspacePlansRoot(FILE_WORKSPACE),
      '/Users/yaogj/works/ccspace/cursorremote/.cursor/plans',
    );
  });

  it('rejects remote scheme, authority, missing identity, and multi-root workspaces', () => {
    assert.equal(fileWorkspacePlansRoot(null), null);
    assert.equal(fileWorkspacePlansRoot({ uri: FILE_WORKSPACE.uri }), null);
    assert.equal(fileWorkspacePlansRoot({ id: '', uri: FILE_WORKSPACE.uri }), null);
    assert.equal(fileWorkspacePlansRoot({
      ...FILE_WORKSPACE,
      uri: { ...FILE_WORKSPACE.uri, scheme: 'vscode-remote' },
    }), null);
    assert.equal(fileWorkspacePlansRoot({
      ...FILE_WORKSPACE,
      uri: { ...FILE_WORKSPACE.uri, authority: 'ssh-remote+host' },
    }), null);
    assert.equal(fileWorkspacePlansRoot({ ...FILE_WORKSPACE, folders: [{}, {}] }), null);
    assert.equal(fileWorkspacePlansRoot({ ...FILE_WORKSPACE, folderCount: 2 }), null);
  });

  it('rejects relative, encoded, backslash, and traversal workspace paths', () => {
    const badPaths = [
      'Users/yaogj/works/ccspace/cursorremote',
      '/Users/yaogj/works/ccspace/cursorremote/',
      '/Users/yaogj/works/ccspace/cursorremote\\plans',
      '/Users/yaogj/works/%2e%2e/ccspace/cursorremote',
      '/Users/yaogj/works/ccspace/../secret',
      '/Users/yaogj/works/ccspace/cursorremote/./proj',
    ];
    for (const path of badPaths) {
      assert.equal(fileWorkspacePlansRoot({ ...FILE_WORKSPACE, uri: { ...FILE_WORKSPACE.uri, path } }), null, path);
    }
  });
});

describe('planFileFromFileUri', () => {
  const homeName = 'safe_plan_abc123.plan.md';
  const homeUri = `file://${resolve(homedir(), '.cursor', 'plans', homeName)}`;

  it('accepts a home-plans file URI and returns only the basename', () => {
    assert.deepEqual(planFileFromFileUri(homeUri), { fileName: homeName });
  });

  it('accepts a verified workspace plans file URI and returns that root', () => {
    const name = 'safe_plan_abc123.plan.md';
    const uri = `file://${FILE_WORKSPACE.uri.path}/.cursor/plans/${name}`;
    assert.deepEqual(planFileFromFileUri(uri, FILE_WORKSPACE), {
      fileName: name,
      plansRoot: `${FILE_WORKSPACE.uri.path}/.cursor/plans`,
    });
  });

  it('rejects traversal, non-file URIs, and paths outside the plans roots', () => {
    const cases = [
      'file:///etc/passwd.plan.md',
      `file://${resolve(homedir(), '.cursor', 'plans', '..', 'secret.plan.md')}`,
      `file://${resolve(homedir(), '.cursor', 'plans')}/../secret.plan.md`,
      `file://${resolve(homedir(), '.cursor', 'plans')}/sub/${homeName}`,
      'file://localhost/Users/yaogj/.cursor/plans/safe_plan_abc123.plan.md',
      'https://example.com/safe_plan_abc123.plan.md',
      '/Users/yaogj/.cursor/plans/safe_plan_abc123.plan.md',
    ];
    for (const uri of cases) {
      assert.equal(planFileFromFileUri(uri), null, uri);
    }
  });
});

describe('readPlanFileResult with a file-workspace plans root', () => {
  it('reads a plan inside that root and refuses a path outside it', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'plan-workspace-'));
    try {
      const workspacePath = join(fixtureRoot, 'cursorremote');
      const plansRoot = join(workspacePath, '.cursor', 'plans');
      mkdirSync(plansRoot, { recursive: true });
      writeFileSync(join(plansRoot, 'safe_plan_abc123.plan.md'), PLAN_MD);
      const secretPath = join(fixtureRoot, 'secret.md');
      writeFileSync(secretPath, SECRET);
      const identity = {
        id: '265d56b2c491736926ee6e06eeffd5de',
        uri: { scheme: 'file', authority: '', path: workspacePath },
      };
      const resolvedRoot = fileWorkspacePlansRoot(identity);
      assert.equal(resolvedRoot, plansRoot);
      const result = readPlanFileResult('safe_plan_abc123.plan.md', resolvedRoot as string);
      assert.ok(result.ok);
      if (result.ok) assert.equal(result.data.body, '# Safe Plan Body');
      assert.equal(readPlanFile('../secret.md', resolvedRoot as string), null);
      assert.equal(readPlanFile(secretPath, resolvedRoot as string), null);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});