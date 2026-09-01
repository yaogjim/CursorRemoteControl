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

  it('strips selectorPath authorization fields while leaving the internal snapshot intact', () => {
    const state = extractionState({
      chatTabs: [{ composerId: 'c1', title: 'Chat', isActive: true, status: '', selectorPath: 'tab-secret' }],
      pendingApprovals: [{
        id: 'ap1',
        description: 'Edit file',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: 'approve-secret', actionId: 'act_approve' },
          { label: 'Accept All', type: 'approve_all', selectorPath: 'approve-all-secret', actionId: 'act_all' },
        ],
      }],
      messages: [
        {
          type: 'run_command',
          id: 'r1',
          flatIndex: 1,
          toolCallId: 'tool-1',
          description: 'npm test',
          candidates: '',
          command: 'npm test',
          actions: [{ label: 'Run', type: 'run', selectorPath: 'run-secret', actionId: 'act_run' }],
        },
        {
          type: 'plan',
          id: 'p1',
          flatIndex: 2,
          label: 'Plan',
          title: 'Ship',
          todosCompleted: 0,
          todosTotal: 1,
          modelDropdownSelectorPath: 'model-secret',
          modelActionId: 'act_model',
          actions: [{ label: 'Build', type: 'build', selectorPath: 'build-secret', actionId: 'act_build' }],
        },
      ],
      questionnaire: {
        questions: [{
          number: '1',
          text: 'Pick',
          isActive: true,
          options: [{ letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'opt-secret', actionId: 'act_opt' }],
        }],
        activeIndex: 0,
        totalLabel: '1/1',
        skipSelectorPath: 'skip-secret',
        skipActionId: 'act_skip',
        continueSelectorPath: 'continue-secret',
        continueActionId: 'act_continue',
        continueDisabled: false,
      },
    });

    const publicState = toPublicState(state);
    const approval = publicState.pendingApprovals[0]?.actions[0] as { selectorPath?: string; actionId?: string };
    const run = publicState.messages.find((m) => m.type === 'run_command');
    const plan = publicState.messages.find((m) => m.type === 'plan');
    assert.equal('selectorPath' in approval, false);
    assert.equal(approval.actionId, 'act_approve');
    assert.equal(publicState.pendingApprovals[0]?.actions[1]?.type, 'approve_all');
    assert.equal('selectorPath' in (run && 'actions' in run ? run.actions[0] : {}), false);
    assert.equal(plan && 'modelDropdownSelectorPath' in plan, false);
    assert.equal(plan && 'modelActionId' in plan ? plan.modelActionId : '', 'act_model');
    assert.equal('selectorPath' in publicState.chatTabs[0], false);
    assert.equal('skipSelectorPath' in (publicState.questionnaire ?? {}), false);
    assert.equal(publicState.questionnaire?.skipActionId, 'act_skip');
    assert.equal('selectorPath' in (publicState.questionnaire?.questions[0]?.options[0] ?? {}), false);

    assert.equal(state.pendingApprovals[0]?.actions[0]?.selectorPath, 'approve-secret');
    assert.equal(state.questionnaire?.skipSelectorPath, 'skip-secret');
    assert.equal(state.chatTabs[0]?.selectorPath, 'tab-secret');

    const publicPatch = toPublicPatch({
      pendingApprovals: state.pendingApprovals,
      questionnaire: state.questionnaire,
    });
    assert.equal('selectorPath' in (publicPatch.pendingApprovals?.[0]?.actions[0] ?? {}), false);
    assert.equal('skipSelectorPath' in (publicPatch.questionnaire ?? {}), false);
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

  it('emits a mode patch when only available options change', async () => {
    const sm = new StateManager(0);
    const patches: Partial<CursorState>[] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.onConnectionChanged(true);
    sm.onExtraction(extractionState({
      mode: { current: 'agent', available: [{ id: 'agent', label: 'Agent', icon: '' }] },
    }));
    await wait(20);
    const afterFirst = patches.length;

    sm.onExtraction(extractionState({
      mode: {
        current: 'agent',
        available: [
          { id: 'agent', label: 'Agent', icon: '' },
          { id: 'plan', label: 'Plan', icon: '' },
        ],
      },
    }));
    await wait(20);

    assert.ok(patches.length > afterFirst);
    const last = patches[patches.length - 1];
    assert.equal(last.mode?.current, 'agent');
    assert.equal(last.mode?.available.length, 2);
  });
});