import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AdapterStore } from '../src/server/adapter-store.js';
import { RuntimeSelectorProvider, endpointFingerprint } from '../src/server/runtime-selector-provider.js';
import type { EndpointIdentity, SelectorConfig } from '../src/server/types.js';

const ENDPOINT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BUILD = 'Cursor/3.17.21';
const DOM = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function selectors(): SelectorConfig {
  return {
    chatContainer: { strategies: ['.chat'] },
    approveButton: { strategies: ['.approve'], textMatch: ['Approve'] },
    rejectButton: { strategies: ['.reject'], textMatch: ['Reject'] },
    chatInput: { strategies: ['.input'] },
    agentStatus: { strategies: ['.status'] },
    modeDropdown: { strategies: ['.mode-builtin'] },
    modelDropdown: { strategies: ['.model-builtin'] },
  };
}

function candidate() {
  return {
    id: 'mode-live',
    cursorVersionRange: BUILD,
    endpointFingerprint: ENDPOINT,
    domSignature: DOM,
    capabilityKinds: ['mode'] as const,
    strategies: {
      modeDropdown: [{ id: 'mode-observed', kind: 'observed', selector: '.mode-adapter', scope: 'composer', operationClass: 'interactive_read' as const }],
    },
    evidence: [{ source: 'test', summary: 'unique visible mode trigger', confidence: 1 }],
  };
}

describe('RuntimeSelectorProvider exact context', () => {
  it('uses an active adapter only for an exact endpoint, build, DOM, and kind binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-selectors-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(candidate());
    await store.apply(pending.id, {
      capabilityKind: 'mode', cursorVersionRange: BUILD, endpointFingerprint: ENDPOINT, domSignature: DOM,
    });
    const provider = new RuntimeSelectorProvider(selectors(), store.getState());

    provider.setActiveContext({ endpointFingerprint:ENDPOINT, cursorBuild:BUILD, domSignature:DOM, targetId:'target-a', targetGeneration:1, observedAt:1 });
    assert.deepEqual(provider.selectors.modeDropdown.strategies, ['.mode-adapter']);
    assert.equal(provider.getUsage().mode.adapterId, pending.id);
    assert.deepEqual(provider.selectors.modelDropdown.strategies, ['.model-builtin']);

    provider.setActiveContext({ endpointFingerprint:ENDPOINT, cursorBuild:'Cursor/3.18.0', domSignature:DOM, targetId:'target-a', targetGeneration:2, observedAt:2 });
    assert.deepEqual(provider.selectors.modeDropdown.strategies, ['.mode-builtin']);
    assert.equal(provider.getUsage().mode.source, 'builtin');

    provider.setActiveContext({ endpointFingerprint:'cccccccccccccccccccccccc', cursorBuild:BUILD, domSignature:DOM, targetId:'target-b', targetGeneration:1, observedAt:3 });
    assert.deepEqual(provider.selectors.modeDropdown.strategies, ['.mode-builtin']);

    provider.setActiveContext({ endpointFingerprint:ENDPOINT, cursorBuild:BUILD, domSignature:'dddddddddddddddddddddddd', targetId:'target-c', targetGeneration:1, observedAt:4 });
    assert.deepEqual(provider.selectors.modeDropdown.strategies, ['.mode-builtin']);
  });

  it('restores the immutable builtin selector snapshot after rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-selectors-rollback-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(candidate());
    const binding = { capabilityKind:'mode' as const, cursorVersionRange:BUILD, endpointFingerprint:ENDPOINT, domSignature:DOM };
    await store.apply(pending.id, binding);
    const provider = new RuntimeSelectorProvider(selectors(), store.getState());
    provider.setActiveContext({ endpointFingerprint:ENDPOINT, cursorBuild:BUILD, domSignature:DOM, targetId:'target-a', targetGeneration:1, observedAt:1 });
    assert.equal(provider.selectors.modeDropdown.strategies[0], '.mode-adapter');

    await store.rollback(binding, pending.id);
    provider.updateStore(store.getState());
    assert.equal(provider.selectors.modeDropdown.strategies[0], '.mode-builtin');
    assert.equal(provider.getUsage().mode.adapterId, '');
  });

  it('derives endpoint identity from verified Cursor product and protocol only', () => {
    const cursor: EndpointIdentity = {
      verified:true,
      browserFamily:'cursor',
      product:BUILD,
      protocolVersion:'1.3',
      diagnosticCode:'identity_ok',
      diagnosticMessage:'ok',
    };
    assert.match(endpointFingerprint(cursor), /^[a-f0-9]{24}$/);
    assert.equal(endpointFingerprint({ ...cursor, verified:false }), '');
    assert.notEqual(endpointFingerprint(cursor), endpointFingerprint({ ...cursor, product:'Cursor/3.18.0' }));
  });
});