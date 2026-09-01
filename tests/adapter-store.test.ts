import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AdapterStore, ADAPTER_STORE_MAX, validateAdapter } from '../src/server/adapter-store.js';

function adapter(id: string, overrides: { domSignature?: string; cursorVersionRange?: string; capabilityKinds?: Array<'mode' | 'model' | 'tool'> } = {}) {
  return {
    id,
    cursorVersionRange: overrides.cursorVersionRange ?? '*',
    endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    domSignature: overrides.domSignature ?? 'target-a:1',
    capabilityKinds: overrides.capabilityKinds ?? (['mode'] as const),
    strategies: { modeDropdown: [{ id: 'mode-1', kind: 'dropdown', selector: '.composer-unified-dropdown[data-mode]', scope: 'composer', operationClass: 'interactive_read' as const }] },
    evidence: [{ source: 'test', summary: 'direct live observation', confidence: 1 }],
  };
}

describe('AdapterStore rollback isolation', () => {
  it('restores only the prior binding for the same version+signature+kind tuple', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-rollback-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const first = await store.savePending(adapter('adapter-a'));
    await store.apply(first.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' });
    const second = await store.savePending(adapter('adapter-b'));
    await store.apply(second.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' });
    const other = await store.savePending(adapter('adapter-other', { domSignature: 'target-b:9' }));
    await store.apply(other.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-b:9' });

    await store.rollback({ capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' }, 'adapter-b');
    const state = store.getState();
    assert.deepEqual(
      state.activeBindings.map((b) => [b.domSignature, b.adapterId]),
      [['target-b:9', 'adapter-other'], ['target-a:1', 'adapter-a']],
    );
    assert.equal(state.adapters.find((a) => a.id === 'adapter-b')?.status, 'rolled_back');
    assert.equal(state.adapters.find((a) => a.id === 'adapter-a')?.status, 'active');
  });

  it('does not attach a different-kind or different-signature adapter on rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-rollback-kind-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const mode = await store.savePending(adapter('mode-a'));
    await store.apply(mode.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' });
    const other = await store.savePending(adapter('adapter-other', { capabilityKinds: ['model'], domSignature: 'target-a:1' }));
    await store.apply(other.id, { capabilityKind: 'model', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' });
    await store.rollback({ capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' }, 'mode-a');
    const state = store.getState();
    assert.equal(state.activeBindings.find((b) => b.capabilityKind === 'mode'), undefined);
    assert.equal(state.activeBindings.find((b) => b.capabilityKind === 'model')?.adapterId, 'adapter-other');
  });
});

describe('AdapterStore persistence', () => {
  it('restores from filePath.bak.N when the primary is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-backup-'));
    const filePath = join(dir, 'custom-store.json');
    const store = new AdapterStore(filePath);
    await store.savePending(adapter('keep-me'));
    await store.savePending(adapter('newer'));
    await writeFile(filePath, '{not json', 'utf8');

    const restored = new AdapterStore(filePath);
    const listed = await restored.list();
    assert.ok(listed.some((a) => a.id === 'keep-me' || a.id === 'newer'), 'restored adapters from backup');
    const primary = await readFile(filePath, 'utf8');
    assert.match(primary, /keep-me|newer/);
    const bak = await readFile(`${filePath}.bak.1`, 'utf8');
    assert.match(bak, /keep-me|newer/);
  });

  it('drops invalid adapter records on load and keeps valid ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-validate-'));
    const filePath = join(dir, 'adapters.json');
    const valid = {
      ...adapter('good'),
      status: 'pending_confirmation',
      createdAt: 1,
      verifiedAt: null,
    };
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      activeBindings: [{ cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1', capabilityKind: 'mode', adapterId: 'missing' }],
      adapters: [valid, { id: '', status: 'active', cursorVersionRange: '*', domSignature: 'x', capabilityKinds: ['mode'], strategies: {}, evidence: [], createdAt: 1, verifiedAt: null }],
      history: [],
    }), 'utf8');
    const store = new AdapterStore(filePath);
    const data = await store.load();
    assert.equal(data.adapters.length, 1);
    assert.equal(data.adapters[0].id, 'good');
    assert.equal(data.activeBindings.length, 0);
  });

  it('loads the legacy store envelope without schemaVersion or previousBindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-legacy-'));
    const filePath = join(dir, 'adapters.json');
    const legacy = {
      ...adapter('legacy-pending'),
      endpointFingerprint: undefined,
      status: 'pending_confirmation',
      createdAt: 1,
      verifiedAt: null,
    };
    await writeFile(filePath, JSON.stringify({ revision: 10, activeBindings: [], adapters: [legacy], history: [] }), 'utf8');
    const store = new AdapterStore(filePath);
    const data = await store.load();
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.revision, 10);
    assert.equal(data.previousBindings.length, 0);
    assert.equal(data.adapters[0]?.id, 'legacy-pending');
  });

  it('never evicts active or bound adapters when over capacity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-cap-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const bound = await store.savePending(adapter('bound-active', { domSignature: 'target-keep:1' }));
    await store.apply(bound.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-keep:1' });
    for (let i = 0; i < ADAPTER_STORE_MAX + 5; i++) {
      await store.savePending(adapter(`pending-${i}`, { domSignature: `target-x:${i}` }));
    }
    const state = store.getState();
    assert.ok(state.adapters.some((a) => a.id === 'bound-active' && a.status === 'active'));
    assert.equal(state.activeBindings[0]?.adapterId, 'bound-active');
    assert.ok(state.adapters.length <= ADAPTER_STORE_MAX + 1);
  });

  it('serializes concurrent commits without dropping records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-lock-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    await Promise.all([
      store.savePending(adapter('one', { domSignature: 't:1' })),
      store.savePending(adapter('two', { domSignature: 't:2' })),
      store.savePending(adapter('three', { domSignature: 't:3' })),
    ]);
    const listed = await store.list();
    assert.deepEqual(listed.map((a) => a.id).sort(), ['one', 'three', 'two']);
  });
});

describe('validateAdapter', () => {
  it('rejects a strategy whose selector uses CSS escapes', () => {
    const bad = {
      ...adapter('escaped'),
      strategies: { modeDropdown: [{ id: 'mode-1', kind: 'dropdown', selector: '\\6aavascript:alert(1)', scope: 'composer', operationClass: 'interactive_read' as const }] },
    };
    assert.equal(validateAdapter(bad as never).ok, false);
  });
});