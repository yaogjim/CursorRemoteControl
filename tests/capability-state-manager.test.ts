import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityStateManager,
  projectModeModel,
  toPublicCapabilityFull,
} from '../src/server/capability-state-manager.js';
import { compareCapabilities } from '../src/server/capability-diff.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CapabilitySummary, CursorState, ModeCapability } from '../src/server/types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mode(id: string, current = false): ModeCapability {
  return {
    id,
    label: id,
    current,
    source: 'data_attribute',
    confidence: 1,
    scope: 'composer',
    selectable: true,
    observedAt: 1,
  };
}

function snapshot(
  targetId: string,
  generation: number,
  revision: number,
  overrides: Partial<CapabilitySummary> = {},
): CapabilitySummary {
  return {
    targetId,
    targetGeneration: generation,
    revision,
    modes: [mode('agent', true)],
    models: {
      items: [{
        id: 'm1',
        label: 'Composer',
        selected: true,
        scope: 'composer',
        idStability: 'stable',
        source: 'aria',
        confidence: 1,
        selectable: true,
        observedAt: 1,
      }],
      completeness: 'partial',
      filterActive: false,
      observedAt: 1,
    },
    tools: [],
    status: {
      state: 'ok',
      confidence: 1,
      completeness: 'partial',
      revision,
      targetGeneration: generation,
    },
    adapterBindings: { mode: '', model: '', tool: '' },
    observedAt: 1,
    ...overrides,
  };
}

describe('CapabilityStateManager revision / generation', () => {
  it('increments revision on observed updates for the same generation', () => {
    const mgr = new CapabilityStateManager();
    mgr.setActiveTarget('t1', 1);
    const first = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('agent', true)],
      state: 'ok',
    });
    const second = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('agent', true), mode('plan')],
      state: 'ok',
    });
    assert.equal(first?.revision, 1);
    assert.equal(second?.revision, 2);
    assert.equal(mgr.getRevision('t1'), 2);
    assert.equal(mgr.getSnapshot('t1')?.modes.length, 2);
  });

  it('discards older revisions in the same generation', () => {
    const mgr = new CapabilityStateManager();
    const applied = mgr.applySnapshot(snapshot('t1', 1, 3));
    assert.equal(applied?.revision, 3);
    assert.equal(mgr.applySnapshot(snapshot('t1', 1, 2)), null);
    assert.equal(mgr.applySnapshot(snapshot('t1', 1, 3)), null);
    assert.equal(mgr.getRevision('t1'), 3);
  });

  it('marks capabilities stale, preserves last-known inventory, and rejects old generations', () => {
    const mgr = new CapabilityStateManager();
    mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('debug', true), mode('plan')],
      models: {
        items: [{
          id: 'm1',
          label: 'Composer',
          selected: true,
          scope: 'composer',
          idStability: 'stable',
          source: 'menu',
          confidence: 1,
          selectable: true,
          observedAt: 1,
        }, {
          id: 'm2',
          label: 'Other',
          selected: false,
          scope: 'composer',
          idStability: 'stable',
          source: 'menu',
          confidence: 1,
          selectable: true,
          observedAt: 1,
        }],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
      state: 'ok',
    });
    const staleEvents: unknown[] = [];
    mgr.on('capabilities:stale', (p) => staleEvents.push(p));
    const nextGen = mgr.bumpTargetGeneration('t1');
    assert.equal(nextGen, 2);
    const snap = mgr.getSnapshot('t1');
    assert.equal(snap?.targetGeneration, 2);
    assert.equal(snap?.revision, 0);
    assert.equal(snap?.status.state, 'stale');
    assert.equal(snap?.models.completeness, 'unknown');
    assert.deepEqual(snap?.modes.map((item) => item.id), ['debug', 'plan']);
    assert.deepEqual(snap?.models.items.map((item) => item.id), ['m1', 'm2']);
    assert.ok(staleEvents.length >= 1);
    assert.equal(mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('agent', true)],
    }), null, 'old generation must not overwrite');
  });

  it('does not shrink a complete catalog from unknown/partial or fallback observations', () => {
    const mgr = new CapabilityStateManager();
    mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [
        { ...mode('agent', true), source: 'menu' },
        { ...mode('plan'), source: 'menu' },
        { ...mode('debug'), source: 'menu' },
      ],
      models: {
        items: [
          { id: 'a', label: 'A', selected: true, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 1 },
          { id: 'b', label: 'B', selected: false, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 1 },
          { id: 'c', label: 'C', selected: false, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 1 },
        ],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
      state: 'ok',
    });

    const afterUnknown = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('plan', true)],
      models: {
        items: [{ id: 'b', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: 0.5, selectable: true, observedAt: 2 }],
        completeness: 'unknown',
        filterActive: false,
        observedAt: 2,
      },
      state: 'ok',
    });
    assert.equal(afterUnknown?.modes.length, 3);
    assert.equal(afterUnknown?.models.items.length, 3);
    assert.equal(afterUnknown?.models.completeness, 'complete');
    assert.equal(afterUnknown?.modes.find((item) => item.id === 'plan')?.current, true);
    assert.equal(afterUnknown?.models.items.find((item) => item.id === 'b')?.selected, true);
    assert.equal(afterUnknown?.models.items.find((item) => item.id === 'a')?.selected, false);

    mgr.bumpTargetGeneration('t1');
    const afterReconnect = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 2,
      modes: [mode('plan', true)],
      models: {
        items: [{ id: 'b', label: 'B', selected: true, scope: 'composer', idStability: 'label', source: 'aria', confidence: 0.5, selectable: true, observedAt: 3 }],
        completeness: 'unknown',
        filterActive: false,
        observedAt: 3,
      },
      state: 'ok',
    });
    assert.equal(afterReconnect?.status.state, 'stale');
    assert.equal(afterReconnect?.modes.length, 3);
    assert.equal(afterReconnect?.models.items.length, 3);
    assert.equal(afterReconnect?.models.completeness, 'unknown');

    const afterComplete = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 2,
      modes: [
        { ...mode('agent'), source: 'menu' },
        { ...mode('plan', true), source: 'menu' },
      ],
      models: {
        items: [
          { id: 'b', label: 'B', selected: true, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 4 },
          { id: 'd', label: 'D', selected: false, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 4 },
        ],
        completeness: 'complete',
        filterActive: false,
        observedAt: 4,
      },
      state: 'ok',
    });
    assert.notEqual(afterComplete?.status.state, 'stale');
    assert.deepEqual(afterComplete?.modes.map((item) => item.id), ['agent', 'plan']);
    assert.deepEqual(afterComplete?.models.items.map((item) => item.id), ['b', 'd']);
    assert.equal(afterComplete?.models.completeness, 'complete');
  });

  it('does not let StateManager DOM extraction replace capability state', async () => {
    const caps = new CapabilityStateManager();
    const state = new StateManager(0);
    caps.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('plan', true)],
      state: 'ok',
    });
    const before = caps.getSnapshot('t1');

    const extracted: CursorState = {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
    };
    state.onConnectionChanged(true);
    state.onExtraction(extracted);
    await wait(20);

    const after = caps.getSnapshot('t1');
    assert.equal(after?.revision, before?.revision);
    assert.equal(after?.modes[0]?.id, 'plan');
    assert.equal(state.getCurrentState().mode.current, 'agent');
  });

  it('projects unknown/stale as empty mode/model instead of Agent/Auto', () => {
    assert.deepEqual(projectModeModel(null), {
      mode: { current: '', available: [] },
      model: { current: '', currentId: '' },
      status: 'unknown',
    });
    const mgr = new CapabilityStateManager();
    mgr.setActiveTarget('t1', 1);
    const projected = mgr.projectModeModel('t1');
    assert.equal(projected.mode.current, '');
    assert.equal(projected.model.current, '');
    assert.notEqual(projected.mode.current, 'agent');
    assert.notEqual(projected.model.current, 'Auto');

    mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('ask', true)],
      models: {
        items: [{
          id: 'gpt',
          label: 'GPT',
          selected: true,
          scope: 'composer',
          idStability: 'stable',
          source: 'menu',
          confidence: 1,
          selectable: true,
          observedAt: 1,
        }],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
      state: 'ok',
    });
    const live = mgr.projectModeModel('t1');
    assert.equal(live.mode.current, 'ask');
    assert.equal(live.model.current, 'GPT');
    assert.equal(live.model.currentId, 'gpt');
  });

  it('emits capabilities:patch with targetId, generation, and revision', () => {
    const mgr = new CapabilityStateManager();
    const patches: Array<{ targetId: string; targetGeneration: number; revision: number }> = [];
    mgr.on('capabilities:patch', (p) => patches.push(p));
    mgr.applyObserved({ targetId: 'win', targetGeneration: 4, state: 'ok' });
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.targetId, 'win');
    assert.equal(patches[0]?.targetGeneration, 4);
    assert.equal(patches[0]?.revision, 1);
  });

  it('emits capabilities:full as { activeTargetId, snapshots } including target switches', () => {
    const mgr = new CapabilityStateManager();
    const events: Array<{ activeTargetId: string; snapshots: Array<{ targetId: string }> }> = [];
    mgr.on('capabilities:full', (p) => events.push(p));
    mgr.setActiveTarget('t1', 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.activeTargetId, 't1');
    assert.equal(events[0]?.snapshots[0]?.targetId, 't1');
    mgr.setActiveTarget('t2', 3);
    assert.equal(events.at(-1)?.activeTargetId, 't2');
    assert.ok(events.at(-1)?.snapshots.some((snap) => snap.targetId === 't2'));
    mgr.setActiveTarget('t1', 1);
    assert.equal(events.at(-1)?.activeTargetId, 't1');
  });

  it('wraps a raw snapshot into the public capabilities:full envelope', () => {
    const raw = snapshot('raw-target', 2, 5);
    const wrapped = toPublicCapabilityFull(raw, 'active');
    assert.equal(wrapped.activeTargetId, 'active');
    assert.equal(wrapped.snapshots[0]?.targetId, 'raw-target');
    const already = toPublicCapabilityFull({ activeTargetId: 't9', snapshots: [raw] });
    assert.equal(already.activeTargetId, 't9');
    assert.equal(already.snapshots.length, 1);
  });

  it('does not elevate whole state to degraded solely because the model menu is partial or unknown', () => {
    const partialDiff = compareCapabilities(
      { modes: [{ id: 'agent' }], models: { items: [{ id: 'a' }], completeness: 'complete' } },
      { modes: [{ id: 'agent' }], models: { items: [{ id: 'a' }], completeness: 'partial' } },
    );
    assert.notEqual(partialDiff.state, 'degraded');
    assert.equal(partialDiff.completeness, 'partial');
    assert.equal(partialDiff.canReportRemoval, false);

    const unknownDiff = compareCapabilities(
      { modes: [{ id: 'agent' }], models: { items: [{ id: 'a' }], completeness: 'complete' } },
      { modes: [{ id: 'agent' }], models: { items: [{ id: 'a' }], completeness: 'unknown' } },
    );
    assert.notEqual(unknownDiff.state, 'degraded');
    assert.equal(unknownDiff.completeness, 'unknown');

    const mgr = new CapabilityStateManager();
    const partial = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('agent', true), mode('plan')],
      models: {
        items: [{
          id: 'm1',
          label: 'Composer',
          selected: true,
          scope: 'composer',
          idStability: 'stable',
          source: 'menu',
          confidence: 1,
          selectable: true,
          observedAt: 1,
        }],
        completeness: 'partial',
        filterActive: false,
        observedAt: 1,
      },
      state: 'ok',
    });
    assert.ok(partial?.status.state === 'ok' || partial?.status.state === 'changed');
    assert.notEqual(partial?.status.state, 'degraded');
    assert.equal(partial?.status.completeness, 'partial');
    assert.equal(partial?.models.completeness, 'partial');
    assert.equal(partial?.modes.length, 2);

    const unknown = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      models: {
        items: [{
          id: 'm1',
          label: 'Composer',
          selected: true,
          scope: 'composer',
          idStability: 'label',
          source: 'aria',
          confidence: 0.5,
          selectable: true,
          observedAt: 2,
        }],
        completeness: 'unknown',
        filterActive: false,
        observedAt: 2,
      },
      state: 'ok',
    });
    assert.notEqual(unknown?.status.state, 'degraded');
    assert.ok(unknown?.modes.some((item) => item.id === 'plan'));
  });

  it('still records explicit degraded and unavailable observations', () => {
    const mgr = new CapabilityStateManager();
    const degraded = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      modes: [mode('agent', true)],
      models: {
        items: [{
          id: 'm1',
          label: 'Composer',
          selected: true,
          scope: 'composer',
          idStability: 'stable',
          source: 'menu',
          confidence: 1,
          selectable: true,
          observedAt: 1,
        }],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
      state: 'degraded',
    });
    assert.equal(degraded?.status.state, 'degraded');

    const unavailable = mgr.applyObserved({
      targetId: 't1',
      targetGeneration: 1,
      state: 'unavailable',
    });
    assert.equal(unavailable?.status.state, 'unavailable');
  });
});