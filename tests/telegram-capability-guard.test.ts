import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandExecutor } from '../src/server/command-executor.js';
import {
  handleAgentCommand,
  handleCallbackQuery,
  handlePlanCommand,
  type CommandDeps,
} from '../src/server/transports/telegram/commands.js';
import type { BotContext } from '../src/server/transports/telegram/tg-types.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type {
  CapabilitySummary,
  CursorState,
  ModeCapability,
  ModelCapability,
  SelectorConfig,
} from '../src/server/types.js';

const HOSTILE_MODE_ID = 'x"], #pwned, [id$="x';

function mode(id: string, overrides: Partial<ModeCapability> = {}): ModeCapability {
  return {
    id,
    label: id,
    current: false,
    source: 'data_attribute',
    confidence: 1,
    scope: 'composer',
    selectable: true,
    observedAt: 1,
    ...overrides,
  };
}

function modelCap(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    label: id,
    selected: false,
    scope: 'composer',
    idStability: 'stable',
    source: 'menu',
    confidence: 1,
    selectable: true,
    observedAt: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CapabilitySummary> = {}): CapabilitySummary {
  return {
    targetId: 'target-a',
    targetGeneration: 1,
    revision: 1,
    modes: [mode('agent', { current: true }), mode('plan')],
    models: {
      items: [modelCap('model-opus', { selected: true }), modelCap('label::GPT-5.5 High')],
      completeness: 'complete',
      filterActive: false,
      observedAt: 1,
    },
    tools: [],
    status: {
      state: 'ok',
      confidence: 1,
      completeness: 'complete',
      revision: 1,
      targetGeneration: 1,
    },
    adapterBindings: { mode: '', model: '', tool: '' },
    observedAt: 1,
    ...overrides,
  };
}

function fakeClient(evals: string[]): CdpClient {
  let modelMenuChecks = 0;
  return {
    isConnected: () => true,
    pressKey: async () => {},
    evaluate: async (expr: string) => {
      evals.push(expr);
      if (expr.includes('pickModeById(')) return { ok: true, count: 1 };
      if (expr.includes('pickModelById(')) return true;
      if (expr.includes('findModelMenu() !== null')) {
        modelMenuChecks += 1;
        return modelMenuChecks === 1;
      }
      return { ok: true, count: 1 };
    },
  } as unknown as CdpClient;
}

function executorFor(
  snap: CapabilitySummary,
  evals: string[] = [],
  live: { targetId?: string; generation?: number } = {},
): CommandExecutor {
  const executor = new CommandExecutor({} as SelectorConfig);
  executor.setClient(fakeClient(evals));
  executor.setCapabilityGuard({
    getSnapshot: () => snap,
    getActiveTargetId: () => live.targetId ?? snap.targetId,
    getTargetGeneration: () => live.generation ?? snap.targetGeneration,
  });
  return executor;
}

function depsFor(executor: CommandExecutor, currentMode = 'agent'): CommandDeps {
  const state = {
    mode: { current: currentMode, available: [] },
    model: { current: 'Opus', currentId: 'model-opus' },
    windows: [],
    chatTabs: [],
  } as unknown as CursorState;
  return {
    commandExecutor: executor,
    stateManager: { getCurrentState: () => state },
  } as CommandDeps;
}

function callbackCtx(data: string): { ctx: BotContext; answers: string[]; edits: string[] } {
  const answers: string[] = [];
  const edits: string[] = [];
  const ctx: BotContext = {
    callbackQuery: { data, id: 'q1' },
    reply: async () => ({ message_id: 1 }),
    editMessageText: async (text) => { edits.push(text); },
    answerCallbackQuery: async (options) => { if (options?.text) answers.push(options.text); },
  };
  return { ctx, answers, edits };
}

function commandCtx(match: string): { ctx: BotContext; replies: string[] } {
  const replies: string[] = [];
  const ctx: BotContext = {
    match,
    message: { text: match },
    reply: async (text) => {
      replies.push(text);
      return { message_id: 1 };
    },
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { ctx, replies };
}

describe('Telegram mode/model capability allowlist', () => {
  it('rejects unlisted, hostile, stale, and incomplete mode/model callbacks without CDP', async () => {
    const evals: string[] = [];
    const cases: Array<{ data: string; snap: CapabilitySummary; error: string; live?: { targetId?: string; generation?: number } }> = [
      { data: 'mode:debug', snap: snapshot(), error: 'mode is not an observed selectable capability' },
      { data: `mode:${HOSTILE_MODE_ID}`, snap: snapshot(), error: 'mode is not an observed selectable capability' },
      { data: 'model:unknown-model', snap: snapshot(), error: 'model is not an observed selectable capability' },
      {
        data: 'mode:plan',
        snap: snapshot({ status: { ...snapshot().status, state: 'stale' } }),
        error: 'Capability mode is stale',
      },
      {
        data: 'model:model-opus',
        snap: snapshot({ models: { ...snapshot().models, completeness: 'unknown' } }),
        error: 'Capability model is degraded',
      },
      {
        data: 'mode:plan',
        snap: snapshot({ targetId: 'other' }),
        error: 'Capability target is not active',
        live: { targetId: 'target-a' },
      },
    ];

    for (const item of cases) {
      evals.length = 0;
      const { ctx, answers, edits } = callbackCtx(item.data);
      await handleCallbackQuery(ctx, depsFor(executorFor(item.snap, evals, item.live)));
      assert.equal(answers.length, 1, item.data);
      assert.equal(answers[0], `Error: ${item.error}`);
      assert.equal(edits.length, 0);
      assert.equal(evals.length, 0, item.data);
    }
  });

  it('applies allowed catalog entries from mode and model callbacks', async () => {
    const evals: string[] = [];
    const snap = snapshot();
    const executor = executorFor(snap, evals);

    const modeCb = callbackCtx('mode:plan');
    await handleCallbackQuery(modeCb.ctx, depsFor(executor));
    assert.equal(modeCb.answers[0], 'Mode: plan');
    assert.match(modeCb.edits[0] ?? '', /plan/);
    assert.ok(evals.some((src) => src.includes('pickModeById')));

    evals.length = 0;
    const modelCb = callbackCtx('model:label::GPT-5.5 High');
    await handleCallbackQuery(modelCb.ctx, depsFor(executor));
    assert.equal(modelCb.answers[0], 'Model: GPT-5.5 High');
    assert.ok(evals.length > 0);
  });

  it('rejects /plan and /agent when the hardcoded mode is not a live selectable capability', async () => {
    const evals: string[] = [];
    const snap = snapshot({
      modes: [mode('debug', { current: true })],
      status: { ...snapshot().status, state: 'unavailable' },
    });
    const executor = executorFor(snap, evals);
    const plan = commandCtx('write a plan');
    await handlePlanCommand(plan.ctx, depsFor(executor, 'agent'));
    assert.match(plan.replies[0] ?? '', /Failed to switch to Plan mode/);
    assert.match(plan.replies[0] ?? '', /unavailable/);
    assert.equal(evals.length, 0);

    const agent = commandCtx('ship it');
    await handleAgentCommand(agent.ctx, depsFor(executor, 'plan'));
    assert.match(agent.replies[0] ?? '', /Failed to switch to Agent mode/);
    assert.equal(evals.length, 0);
  });

  it('lets /plan proceed past setMode when plan is an allowed catalog entry', async () => {
    const evals: string[] = [];
    const executor = executorFor(snapshot(), evals);
    let sendCalled = false;
    executor.sendMessage = async (commandId, text) => {
      sendCalled = true;
      assert.equal(text, 'write a plan');
      return { commandId, ok: true };
    };

    const plan = commandCtx('write a plan');
    await handlePlanCommand(plan.ctx, depsFor(executor, 'agent'));
    assert.equal(plan.replies.length, 0);
    assert.equal(sendCalled, true);
    assert.ok(evals.some((src) => src.includes('pickModeById')));
  });
});