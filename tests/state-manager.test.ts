import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateManager,
  toPublicPatch,
  toPublicState,
} from '../src/server/state-manager.js';
import type { CursorState, RawSignals } from '../src/server/types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawSignals(): RawSignals {
  return {
    shimmer: [{ text: 'Thinking', inToolCall: false, inHeader: true }],
    loadingIndicator: false,
    elements: [],
    orphanIndicators: [],
  };
}

function extractionState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [
      { type: 'human', id: 'm1', flatIndex: 0, text: 'hello', mentions: [] },
    ],
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
    _rawSignals: rawSignals(),
    ...overrides,
  };
}

describe('toPublicState / toPublicPatch', () => {
  it('strips _rawSignals from full state and patches', () => {
    const state = extractionState();
    const publicState = toPublicState(state);
    assert.equal('_rawSignals' in publicState, false);
    assert.ok(state._rawSignals, 'internal snapshot keeps _rawSignals');

    const publicPatch = toPublicPatch({
      agentStatus: 'thinking',
      _rawSignals: rawSignals(),
    });
    assert.equal('_rawSignals' in publicPatch, false);
    assert.equal(publicPatch.agentStatus, 'thinking');
  });
});

describe('StateManager extraction heartbeat', () => {
  it('does not emit state:patch when only lastExtractionAt changes', async () => {
    const sm = new StateManager(0);
    const patches: Partial<CursorState>[] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.onConnectionChanged(true);
    sm.onExtraction(extractionState());
    await wait(20);

    const afterFirst = patches.length;
    assert.ok(afterFirst >= 2, 'connection + first extraction should patch');
    assert.equal(
      patches.some((p) => 'lastExtractionAt' in p),
      false,
      'heartbeat timestamp must not appear on patches'
    );

    const t1 = sm.getCurrentState().lastExtractionAt;
    assert.ok(t1 != null);

    await wait(5);
    sm.onExtraction(extractionState());
    await wait(20);

    assert.equal(patches.length, afterFirst, 'heartbeat-only extraction must not patch');
    const t2 = sm.getCurrentState().lastExtractionAt;
    assert.ok(t2 != null);
    assert.ok(t2 >= t1, 'health heartbeat still updates lastExtractionAt');
    assert.ok(sm.getCurrentState()._rawSignals, 'internal state still has _rawSignals');
  });

  it('emits a patch when messages change', async () => {
    const sm = new StateManager(0);
    const patches: Partial<CursorState>[] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.onConnectionChanged(true);
    sm.onExtraction(extractionState());
    await wait(20);
    const afterFirst = patches.length;

    sm.onExtraction(extractionState({
      messages: [
        { type: 'human', id: 'm1', flatIndex: 0, text: 'hello', mentions: [] },
        { type: 'assistant', id: 'a1', flatIndex: 1, text: 'hi', html: '<p>hi</p>', codeBlocks: [] },
      ],
    }));
    await wait(20);

    assert.ok(patches.length > afterFirst);
    const last = patches[patches.length - 1];
    assert.ok(last.messages);
    assert.equal(last.messages.length, 2);
    assert.equal('lastExtractionAt' in last, false);
    assert.equal('_rawSignals' in last, false);
  });

  it('still patches extractor health failures', async () => {
    const sm = new StateManager(0);
    const patches: Partial<CursorState>[] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.onConnectionChanged(true);
    sm.onExtraction(extractionState());
    await wait(20);
    const afterOk = patches.length;

    sm.onExtractionFailure('timeout');
    await wait(20);

    assert.ok(patches.length > afterOk);
    const last = patches[patches.length - 1];
    assert.equal(last.extractorStatus, 'stale');
    assert.equal(last.consecutiveExtractionFailures, 1);
    assert.equal(last.lastExtractionError, 'timeout');
  });
});