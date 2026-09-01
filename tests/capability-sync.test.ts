import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ActionRegistry, ActionRegistryError, classifyObservedToolType } from '../src/server/action-registry.js';
import { AdapterStore, validateAdapter } from '../src/server/adapter-store.js';
import { compareCapabilities, mergeModeCatalog, mergeModelCatalog } from '../src/server/capability-diff.js';
import { extractCapabilities } from '../src/server/capability-extractor.js';
import { normalizeId, normalizeLabel } from '../src/server/capability-normalize.js';
import { validateSelector, validateSelectorMap } from '../src/server/selector-validation.js';
import { CapabilityCircuitBreaker } from '../src/server/capability-circuit-breaker.js';
import { operationFingerprint } from '../src/server/relay.js';
import { mergePassiveCapabilityObservation } from '../src/server/passive-capability-probe.js';
import type { CapabilitySummary } from '../src/server/types.js';

function adapter(id: string) {
  return {
    id,
    cursorVersionRange: '*',
    endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    domSignature: 'target-a:1',
    capabilityKinds: ['mode'] as const,
    strategies: { modeDropdown: [{ id: 'mode-1', kind: 'dropdown', selector: '.composer-unified-dropdown[data-mode]', scope: 'composer', operationClass: 'interactive_read' as const }] },
    evidence: [{ source: 'test', summary: 'direct live observation', confidence: 1 }],
  };
}

describe('capability normalization and extraction', () => {
  it('normalizes whitespace and unstable React ids', () => {
    assert.equal(normalizeLabel('  GPT-5\n High  '), 'GPT-5 High');
    assert.equal(normalizeId('_r_12_', 'GPT-5 High'), 'label::GPT-5 High');
  });

  it('extracts a mode label from semantic data without model text', () => {
    const result = extractCapabilities({
      modes: [{ id: 'agent', label: 'Agent', current: true, source: 'data_attribute', confidence: 1, selectable: true }],
      models: { items: [{ id: 'gpt-5', label: 'GPT-5', selected: true, scope: 'composer', idStability: 'stable', source: 'aria', confidence: .9, selectable: true }], completeness: 'complete' },
      tools: [],
    });
    assert.equal(result.modes[0].label, 'Agent');
    assert.equal(result.models.items[0].id, 'gpt-5');
  });
});

describe('selector and action boundaries', () => {
  it('rejects unsafe selectors and duplicate selector strategies', () => {
    assert.equal(validateSelector('javascript:alert(1)').ok, false);
    assert.equal(validateSelector('\\6aavascript:alert(1)').ok, false);
    assert.equal(validateSelector('div\\31').ok, false);
    assert.equal(validateSelectorMap({ modeDropdown: ['.a', '.a'] }).ok, false);
  });

  it('binds actions to type, generation, and one-shot consumption', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const action = registry.register({ windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve' });
    assert.throws(() => registry.reserve(action.actionId, { actionType: 'reject' }), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_scope_changed');
    const reserved = registry.reserve(action.actionId, { actionType: 'approve', targetGeneration: 3 });
    assert.equal(reserved.targetId, 'target-a');
    registry.release(action.actionId);
    const consumed = registry.consume(action.actionId, { actionType: 'approve', targetGeneration: 3 });
    assert.equal(consumed.consumed, true);
    assert.throws(() => registry.consume(action.actionId), /action_consumed/);
  });

  it('does not refresh an observed action when its label or composer binding changes', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const base = { windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve' };
    const first = registry.registerObserved(base);
    const changedLabel = registry.registerObserved({ ...base, expectedLabel: 'Approve All' });
    const changedComposer = registry.registerObserved({ ...base, composerId: 'composer-b' });

    assert.notEqual(changedLabel.actionId, first.actionId);
    assert.notEqual(changedComposer.actionId, first.actionId);
    assert.equal(registry.size, 3);
  });

  it('expires actions and enforces the configured registry bound', async () => {
    const expiring = new ActionRegistry({ ttlMs: 1 });
    const input = { windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve' };
    const action = expiring.register(input);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.throws(() => expiring.reserve(action.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_expired');

    const bounded = new ActionRegistry({ ttlMs: 10_000, maxActions: 2 });
    const first = bounded.register({ ...input, toolCallId: 'tool-1' });
    bounded.register({ ...input, toolCallId: 'tool-2' });
    bounded.register({ ...input, toolCallId: 'tool-3' });
    assert.equal(bounded.size, 2);
    assert.throws(() => bounded.reserve(first.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_not_found');
  });

  it('never evicts a reserved action when pruning to the max bound', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000, maxActions: 2 });
    const input = { windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve' };
    const first = registry.register({ ...input, toolCallId: 'tool-1' });
    registry.reserve(first.actionId);
    registry.register({ ...input, toolCallId: 'tool-2' });
    registry.register({ ...input, toolCallId: 'tool-3' });
    assert.throws(() => registry.reserve(first.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_consumed');
    const publicFirst = registry.public(first.actionId);
    assert.ok(publicFirst);
    assert.equal(publicFirst?.executable, true);
  });

  it('enforces per-target capacity without evicting other target actions', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000, maxActions: 10, maxActionsPerTarget: 2 });
    const base = {
      windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a',
      adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve',
    };
    const oldest = registry.register({ ...base, toolCallId: 'target-a-1' });
    registry.register({ ...base, toolCallId: 'target-a-2' });
    registry.register({ ...base, toolCallId: 'target-b-1', windowId: 'window-b', targetId: 'target-b' });
    registry.register({ ...base, toolCallId: 'target-a-3' });

    assert.equal(registry.size, 3);
    assert.throws(
      () => registry.reserve(oldest.actionId),
      (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_not_found',
    );
  });

  it('keeps approve_all, allow, run, build, continue, and questionnaire options distinct', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const base = {
      windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a',
      toolCallId: 'tool-a', adapterId: 'builtin', expectedLabel: 'Go', selectorStrategyId: 's1', selectorPath: 'button.go',
    };
    const types = ['approve', 'approve_all', 'allow', 'run', 'build', 'continue', 'questionnaire_option'] as const;
    const registered = types.map((actionType) => registry.register({ ...base, actionType, expectedLabel: actionType }));
    const kinds = registered.map((action) => action.kind);
    assert.deepEqual(kinds, [...types]);
    assert.equal(new Set(registered.map((action) => action.actionId)).size, types.length);
    const approve = registered[0];
    const approveAll = registered[1];
    assert.throws(
      () => registry.reserve(approve.actionId, { actionType: 'approve_all' }),
      (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_scope_changed',
    );
    assert.throws(
      () => registry.reserve(approveAll.actionId, { actionType: 'approve' }),
      (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_scope_changed',
    );
    assert.equal(registry.reserve(approveAll.actionId, { actionType: 'approve_all' }).actionType, 'approve_all');
  });

  it('marks unknown action kinds non-executable without collapsing known types', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const base = {
      windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a',
      toolCallId: 'tool-a', adapterId: 'builtin', expectedLabel: 'View', selectorStrategyId: 's1', selectorPath: 'button.view',
    };
    const unknown = registry.register({ ...base, actionType: 'generic_observe' });
    const run = registry.register({ ...base, actionType: 'run', expectedLabel: 'Run', selectorPath: 'button.run' });
    assert.equal(unknown.executable, false);
    assert.equal(unknown.kind, 'generic_observe');
    assert.equal(run.executable, true);
    assert.equal(run.kind, 'run');
  });

  it('keeps unknown Tool labels display-only while recognizing explicit Tool families', () => {
    assert.equal(classifyObservedToolType({ type: 'run_command' }), 'shell');
    assert.equal(classifyObservedToolType({ type: 'tool', action: 'Edit' }), 'edit');
    assert.equal(classifyObservedToolType({ type: 'tool', action: 'Write file' }), 'edit');
    assert.equal(classifyObservedToolType({ type: 'tool', action: 'Fetch URL' }), 'fetch');
    assert.equal(classifyObservedToolType({ type: 'tool', action: 'Unexpected custom action' }), null);
    assert.equal(classifyObservedToolType({ type: 'tool', action: '' }), null);
  });

  it('invalidates by target, generation, and adapter without touching unrelated actions', () => {
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const base = {
      windowId: 'window-a', targetId: 'target-a', targetGeneration: 3, composerId: 'composer-a',
      adapterId: 'builtin', actionType: 'approve', expectedLabel: 'Approve', selectorStrategyId: 's1', selectorPath: 'button.approve',
    };
    const keep = registry.register({ ...base, toolCallId: 'keep', targetId: 'target-b', targetGeneration: 9, adapterId: 'other' });
    const byTarget = registry.register({ ...base, toolCallId: 'target' });
    const byGeneration = registry.register({ ...base, toolCallId: 'gen', targetGeneration: 2 });
    const byAdapter = registry.register({ ...base, toolCallId: 'adapter', adapterId: 'old-adapter', targetId: 'target-c' });

    assert.equal(registry.invalidateGeneration('target-a', 3), 1);
    assert.throws(() => registry.reserve(byGeneration.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_not_found');
    assert.equal(registry.invalidateTarget('target-a'), 1);
    assert.throws(() => registry.reserve(byTarget.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_not_found');
    assert.equal(registry.invalidateAdapter('old-adapter'), 1);
    assert.throws(() => registry.reserve(byAdapter.actionId), (error: unknown) => error instanceof ActionRegistryError && error.code === 'action_not_found');
    assert.equal(registry.reserve(keep.actionId).actionId, keep.actionId);
  });
});

describe('adapter lifecycle isolation', () => {
  it('keeps activated adapters active across observational re-discovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursorremote-adapter-'));
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-a'));
    assert.equal(pending.status, 'pending_confirmation');
    const applied = await store.apply(pending.id, { capabilityKind: 'mode', cursorVersionRange: '*', endpointFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa', domSignature: 'target-a:1' });
    assert.equal(applied.status, 'active');
    const observedAgain = await store.savePending(adapter('adapter-a'));
    assert.equal(observedAgain.status, 'active');
    const disk = JSON.parse(await readFile(join(dir, 'adapters.json'), 'utf8')) as { adapters: Array<{ status: string }> };
    assert.equal(disk.adapters[0].status, 'active');
  });

  it('requires a matching capability kind and validates strategy scope', () => {
    const bad = { ...adapter('bad'), strategies: { modeDropdown: [{ id: 'mode-1', kind: 'dropdown', selector: '.a', scope: 'unknown', operationClass: 'interactive_read' as const }] } };
    assert.equal(validateAdapter(bad as never).ok, false);
  });
});

describe('passive capability projection', () => {
  it('preserves a complete menu inventory while refreshing current selections', () => {
    const previous = {
      modes: [
        { id: 'agent', label: 'Agent', current: true },
        { id: 'plan', label: 'Plan', current: false },
      ],
      models: {
        items: [
          { id: 'label::A', label: 'A', selected: true },
          { id: 'label::B', label: 'B', selected: false },
        ],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
    } as CapabilitySummary;
    const observed = {
      composerReady: true,
      modes: [{ id: 'plan', label: 'Plan', current: true, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true }],
      models: { items: [{ id: 'label::B', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: .9, selectable: true }], completeness: 'unknown', filterActive: false, observedAt: 2 },
      tools: [],
      observedAt: 2,
    } as Parameters<typeof mergePassiveCapabilityObservation>[1];

    const merged = mergePassiveCapabilityObservation(previous, observed);

    assert.equal(merged.completeness, 'complete');
    assert.deepEqual(merged.modes.map(mode => [mode.id, mode.current]), [['agent', false], ['plan', true]]);
    assert.deepEqual(merged.models.items.map(model => [model.id, model.selected]), [['label::A', false], ['label::B', true]]);
  });

  it('does not replace an equal-length complete catalog with a current-only observation', () => {
    const previous = {
      modes: [
        { id: 'agent', label: 'Agent', current: true, source: 'menu' },
        { id: 'plan', label: 'Plan', current: false, source: 'menu' },
      ],
      models: {
        items: [
          { id: 'label::A', label: 'A', selected: true },
          { id: 'label::B', label: 'B', selected: false },
        ],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
    } as CapabilitySummary;
    const observed = {
      composerReady: true,
      modes: [
        { id: 'agent', label: 'Agent', current: false, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true },
        { id: 'plan', label: 'Plan', current: true, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true },
      ],
      models: {
        items: [
          { id: 'label::B', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: .9, selectable: true },
          { id: 'label::A', label: 'A', selected: false, scope: 'composer', idStability: 'label', source: 'aria', confidence: .9, selectable: true },
        ],
        completeness: 'unknown',
        filterActive: false,
        observedAt: 2,
      },
      tools: [],
      observedAt: 2,
    } as Parameters<typeof mergePassiveCapabilityObservation>[1];

    const merged = mergePassiveCapabilityObservation(previous, observed);
    assert.equal(merged.completeness, 'complete');
    assert.equal(merged.modes.length, 2);
    assert.equal(merged.models.items.length, 2);
    assert.deepEqual(merged.modes.map(mode => [mode.id, mode.current]), [['agent', false], ['plan', true]]);
  });
});

describe('diff completeness and circuit breaker', () => {
  it('does not report removals from a partial model menu', () => {
    const previous = { models: { items: [{ id: 'a' }], completeness: 'complete' as const } };
    const observed = { models: { items: [], completeness: 'partial' as const } };
    const diff = compareCapabilities(previous, observed, previous);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.canReportRemoval, false);
  });

  it('does not report removals from an unknown model menu', () => {
    const previous = { models: { items: [{ id: 'a' }, { id: 'b' }], completeness: 'complete' as const } };
    const observed = { models: { items: [{ id: 'a' }], completeness: 'unknown' as const } };
    const diff = compareCapabilities(previous, observed, previous);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.canReportRemoval, false);
  });

  it('keeps partial completeness when a later passive observation is unknown', () => {
    const previous = {
      items: [
        { id: 'a', label: 'A', selected: true, scope: 'composer' as const, idStability: 'stable' as const, source: 'menu' as const, confidence: 1, selectable: true, observedAt: 1 },
        { id: 'b', label: 'B', selected: false, scope: 'composer' as const, idStability: 'stable' as const, source: 'menu' as const, confidence: 1, selectable: true, observedAt: 1 },
      ],
      completeness: 'partial' as const,
      filterActive: false,
      observedAt: 1,
    };
    const merged = mergeModelCatalog(previous, {
      items: [{ id: 'b', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: 1, selectable: true, observedAt: 2 }],
      completeness: 'unknown',
      filterActive: false,
      observedAt: 2,
    });
    assert.equal(merged.completeness, 'partial');
    assert.deepEqual(merged.items.map((item) => [item.id, item.selected]), [['a', false], ['b', true]]);
  });

  it('keeps a complete model catalog unless a complete unfiltered snapshot replaces it', () => {
    const previous = {
      items: [
        { id: 'a', label: 'A', selected: true, scope: 'composer' as const, idStability: 'stable' as const, source: 'menu' as const, confidence: 1, selectable: true, observedAt: 1 },
        { id: 'b', label: 'B', selected: false, scope: 'composer' as const, idStability: 'stable' as const, source: 'menu' as const, confidence: 1, selectable: true, observedAt: 1 },
      ],
      completeness: 'complete' as const,
      filterActive: false,
      observedAt: 1,
    };
    const unknown = mergeModelCatalog(previous, {
      items: [{ id: 'b', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: 1, selectable: true, observedAt: 2 }],
      completeness: 'unknown',
      filterActive: false,
      observedAt: 2,
    });
    assert.equal(unknown.completeness, 'complete');
    assert.deepEqual(unknown.items.map((item) => item.id), ['a', 'b']);

    const replaced = mergeModelCatalog(previous, {
      items: [{ id: 'c', label: 'C', selected: true, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 3 }],
      completeness: 'complete',
      filterActive: false,
      observedAt: 3,
    });
    assert.deepEqual(replaced.items.map((item) => item.id), ['c']);
  });

  it('does not let a one-item fallback shrink a menu-sourced mode catalog', () => {
    const previous = [
      { id: 'agent', label: 'Agent', current: true, source: 'menu' as const, confidence: 1, scope: 'composer' as const, selectable: true, observedAt: 1 },
      { id: 'plan', label: 'Plan', current: false, source: 'menu' as const, confidence: 1, scope: 'composer' as const, selectable: true, observedAt: 1 },
    ];
    const merged = mergeModeCatalog(previous, [
      { id: 'plan', label: 'Plan', current: true, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true, observedAt: 2 },
    ]);
    assert.deepEqual(merged.map((mode) => [mode.id, mode.current]), [['agent', false], ['plan', true]]);
  });

  it('opens after the configured failure ratio and resets on success', () => {
    const breaker = new CapabilityCircuitBreaker({ minSamples: 3, failureRatio: .66 });
    const key = { cursorBuild: '3.17', domSignature: 'dom-a', capabilityKind: 'model', adapterId: 'builtin' };
    breaker.record(key, false, 1); breaker.record(key, false, 2); breaker.record(key, false, 3);
    assert.equal(breaker.isOpen(key, 3), true);
    breaker.record(key, true, 4);
    assert.equal(breaker.isOpen(key, 4), false);
  });
});

describe('HTTP operation replay fingerprint', () => {
  it('ignores only operation id while preserving request identity', () => {
    assert.equal(operationFingerprint('POST', '/api/adapters/a/apply', { operationId: 'one', x: 1 }), operationFingerprint('POST', '/api/adapters/a/apply', { operationId: 'two', x: 1 }));
    assert.notEqual(operationFingerprint('POST', '/api/adapters/a/apply', { operationId: 'one', x: 1 }), operationFingerprint('POST', '/api/adapters/a/apply', { operationId: 'one', x: 2 }));
  });
});