import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { capabilityAllows } from '../src/server/capability-guard.js';
import { CommandExecutor, MODE_ITEM_PICK_JS } from '../src/server/command-executor.js';
import { TargetUiCoordinator } from '../src/server/target-ui-coordinator.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type {
  CapabilityState,
  CapabilitySummary,
  MenuCompleteness,
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

function model(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
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
    targetGeneration: 3,
    revision: 1,
    modes: [mode('agent', { current: true }), mode('plan')],
    models: {
      items: [model('model-opus', { selected: true })],
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
      targetGeneration: 3,
    },
    adapterBindings: { mode: '', model: '', tool: '' },
    observedAt: 1,
    ...overrides,
  };
}

function allowCtx(snap: CapabilitySummary | null, generation = 3, activeTargetId = 'target-a') {
  return {
    snapshot: snap,
    activeTargetId,
    getTargetGeneration: () => generation,
  };
}

describe('capabilityAllows', () => {
  it('allows catalog mode and composer model ids when state is ok/changed', () => {
    assert.equal(capabilityAllows('mode', 'plan', allowCtx(snapshot())), null);
    assert.equal(capabilityAllows('model', 'model-opus', allowCtx(snapshot({
      status: { ...snapshot().status, state: 'changed' },
    }))), null);
  });

  it('rejects missing, stale, degraded, unavailable, incomplete, and unlisted ids', () => {
    assert.equal(capabilityAllows('mode', 'plan', allowCtx(null)), 'Capability state is not verified');
    assert.equal(
      capabilityAllows('mode', 'plan', allowCtx(snapshot(), 3, 'other-target')),
      'Capability target is not active',
    );
    assert.equal(
      capabilityAllows('mode', 'plan', allowCtx(snapshot(), 4)),
      'Capability target generation changed',
    );

    for (const state of ['stale', 'degraded', 'unavailable', 'unknown'] as CapabilityState[]) {
      const snap = snapshot({ status: { ...snapshot().status, state } });
      assert.equal(capabilityAllows('mode', 'plan', allowCtx(snap)), `Capability mode is ${state}`);
      assert.equal(capabilityAllows('model', 'model-opus', allowCtx(snap)), `Capability model is ${state}`);
    }

    for (const completeness of ['partial', 'unknown'] as MenuCompleteness[]) {
      const snap = snapshot({
        models: { ...snapshot().models, completeness },
      });
      assert.equal(capabilityAllows('model', 'model-opus', allowCtx(snap)), 'Capability model is degraded');
      assert.equal(capabilityAllows('mode', 'plan', allowCtx(snap)), null, 'mode is not gated on model completeness');
    }

    assert.equal(
      capabilityAllows('mode', 'debug', allowCtx(snapshot())),
      'mode is not an observed selectable capability',
    );
    assert.equal(
      capabilityAllows('mode', 'plan', allowCtx(snapshot({
        modes: [mode('agent', { current: true }), mode('plan', { selectable: false })],
      }))),
      'mode is not an observed selectable capability',
    );
    assert.equal(
      capabilityAllows('model', 'model-opus', allowCtx(snapshot({
        models: { ...snapshot().models, items: [model('model-opus', { scope: 'plan' })] },
      }))),
      'model is not an observed selectable capability',
    );
    assert.equal(
      capabilityAllows('mode', HOSTILE_MODE_ID, allowCtx(snapshot())),
      'mode is not an observed selectable capability',
    );
    assert.equal(
      capabilityAllows('mode', '', allowCtx(snapshot())),
      'mode is not an observed selectable capability',
    );
  });
});

describe('pickModeById CSS safety', () => {
  it('matches by attribute equality and ignores selector breakout payloads', () => {
    const dom = new JSDOM(`
      <div class="composer-bar-input-buttons">
        <button id="composer-mode-agent" data-mode="agent">Hidden agent</button>
      </div>
      <button id="composer-mode-agent" data-mode="agent">Agent</button>
      <button id="pwned">Pwned</button>
      <div role="menuitem">Plan</div>
    `, { runScripts: 'outside-only' });
    const proto = dom.window.Element.prototype;
    proto.getBoundingClientRect = function getBoundingClientRect() {
      return { width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10, x: 0, y: 0, toJSON() { return {}; } };
    };

    const clicked: string[] = [];
    for (const el of Array.from(dom.window.document.querySelectorAll('button, [role="menuitem"]'))) {
      el.addEventListener('click', () => clicked.push((el as HTMLElement).id || el.textContent?.trim() || ''));
    }

    const run = (modeId: string) => dom.window.eval(`(() => {
      ${MODE_ITEM_PICK_JS}
      return pickModeById(${JSON.stringify(modeId)});
    })()`) as { ok: boolean; count: number };

    const hostile = run(HOSTILE_MODE_ID);
    assert.equal(hostile.ok, false);
    assert.equal(hostile.count, 0);
    assert.deepEqual(clicked, []);
    const agent = run('agent');
    assert.equal(agent.ok, true);
    assert.equal(agent.count, 1);
    assert.deepEqual(clicked, ['composer-mode-agent']);
    clicked.length = 0;
    const plan = run('plan');
    assert.equal(plan.ok, true);
    assert.equal(plan.count, 1);
    assert.deepEqual(clicked, ['Plan']);
  });
});

function fakeClient(evals: string[]): CdpClient {
  return {
    isConnected: () => true,
    pressKey: async () => {},
    evaluate: async (expr: string) => {
      evals.push(expr);
      return { ok: true, count: 1 };
    },
  } as unknown as CdpClient;
}

function guardedExecutor(
  snap: CapabilitySummary,
  evals: string[] = [],
  live: { targetId?: string; generation?: number } = {},
) {
  const executor = new CommandExecutor({} as SelectorConfig);
  executor.setClient(fakeClient(evals));
  executor.setCapabilityGuard({
    getSnapshot: () => snap,
    getActiveTargetId: () => live.targetId ?? snap.targetId,
    getTargetGeneration: () => live.generation ?? snap.targetGeneration,
  });
  return executor;
}

describe('CommandExecutor setMode/setModel allowlist', () => {
  it('fail-closes when no capability guard is wired and never evaluates', async () => {
    const evals: string[] = [];
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient(evals));
    const mode = await executor.setMode('cmd-1', 'agent');
    const modelResult = await executor.setModel('cmd-2', 'model-opus');
    assert.equal(mode.error, 'Capability state is not verified');
    assert.equal(modelResult.error, 'Capability state is not verified');
    assert.equal(evals.length, 0);
  });

  it('rejects stale, degraded, incomplete, wrong-generation, and unlisted ids before CDP', async () => {
    const evals: string[] = [];
    const cases: Array<{ snap: CapabilitySummary; kind: 'mode' | 'model'; id: string; error: string; live?: { targetId?: string; generation?: number } }> = [
      { snap: snapshot({ status: { ...snapshot().status, state: 'stale' } }), kind: 'mode', id: 'plan', error: 'Capability mode is stale' },
      { snap: snapshot({ status: { ...snapshot().status, state: 'degraded' } }), kind: 'model', id: 'model-opus', error: 'Capability model is degraded' },
      { snap: snapshot({ models: { ...snapshot().models, completeness: 'partial' } }), kind: 'model', id: 'model-opus', error: 'Capability model is degraded' },
      { snap: snapshot({ targetGeneration: 2 }), kind: 'mode', id: 'plan', error: 'Capability target generation changed', live: { generation: 3 } },
      { snap: snapshot(), kind: 'mode', id: HOSTILE_MODE_ID, error: 'mode is not an observed selectable capability' },
      { snap: snapshot(), kind: 'model', id: 'not-in-catalog', error: 'model is not an observed selectable capability' },
    ];
    for (const item of cases) {
      evals.length = 0;
      const executor = guardedExecutor(item.snap, evals, item.live);
      const result = item.kind === 'mode'
        ? await executor.setMode('cmd', item.id)
        : await executor.setModel('cmd', item.id);
      assert.equal(result.ok, false, item.error);
      assert.equal(result.error, item.error);
      assert.equal(evals.length, 0, item.error);
    }
  });

  it('passes allowed catalog ids through to CDP and never interpolates a hostile id into CSS', async () => {
    const evals: string[] = [];
    const snap = snapshot({
      modes: [mode('agent', { current: true }), mode('plan'), mode(HOSTILE_MODE_ID)],
    });
    const executor = guardedExecutor(snap, evals);
    const allowed = await executor.setMode('cmd-ok', 'plan');
    assert.equal(allowed.ok, true);
    assert.ok(evals.some((src) => src.includes('pickModeById')));
    assert.ok(evals.every((src) => !src.includes("[id$=\"-' + modeId")));
    assert.ok(evals.every((src) => !src.includes("[data-mode=\"' + modeId")));

    evals.length = 0;
    const hostileAllowed = await executor.setMode('cmd-hostile', HOSTILE_MODE_ID);
    assert.equal(hostileAllowed.ok, true);
    const pickSrc = evals.find((src) => src.includes('pickModeById('));
    assert.ok(pickSrc);
    assert.match(pickSrc!, /pickModeById\(/);
    assert.equal(pickSrc!.includes(`[data-mode="${HOSTILE_MODE_ID}"]`), false);
    assert.equal(pickSrc!.includes(`[id$="-${HOSTILE_MODE_ID}"]`), false);
    assert.ok(pickSrc!.includes('getAttribute'));
  });

  it('still honors TargetUiCoordinator generation cancellation after the allowlist passes', async () => {
    const evals: string[] = [];
    const executor = guardedExecutor(snapshot(), evals);
    const coordinator = new TargetUiCoordinator();
    coordinator.setGeneration('target-a', 4);
    executor.setUiCoordinator(coordinator, () => 'target-a', () => 3);
    await assert.rejects(
      () => executor.setMode('cmd-gen', 'plan'),
      (err: unknown) => {
        assert.match(err instanceof Error ? err.message : String(err), /generation_changed/);
        return true;
      },
    );
    assert.equal(evals.length, 0);
  });
});