import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CommandExecutor } from '../src/server/command-executor.js';
import { ActionRegistry } from '../src/server/action-registry.js';
import { TargetUiCoordinator } from '../src/server/target-ui-coordinator.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeClickClient(log: string[], label: string, delayMs: number): CdpClient {
  return {
    isConnected: () => true,
    click: async (selector: string) => {
      log.push(`${label}:start:${selector}`);
      await sleep(delayMs);
      log.push(`${label}:end:${selector}`);
    },
    evaluate: async () => null,
  } as unknown as CdpClient;
}

describe('CommandExecutor per-window serial queue', () => {
  it('serializes concurrent commands on the same window client', async () => {
    const log: string[] = [];
    const client = fakeClickClient(log, 'w1', 40);
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(client);

    const first = executor.clickAction('cmd-1', '#one');
    const second = executor.clickAction('cmd-2', '#two');
    await Promise.all([first, second]);

    assert.deepEqual(log, [
      'w1:start:#one',
      'w1:end:#one',
      'w1:start:#two',
      'w1:end:#two',
    ]);
  });

  it('does not let a second window wait on a different client', async () => {
    const log: string[] = [];
    const clientA = fakeClickClient(log, 'A', 50);
    const clientB = fakeClickClient(log, 'B', 50);
    const executor = new CommandExecutor({} as SelectorConfig);

    executor.setClient(clientA);
    const first = executor.clickAction('cmd-a', '#a');
    executor.setClient(clientB);
    const second = executor.clickAction('cmd-b', '#b');
    await Promise.all([first, second]);

    const aStart = log.indexOf('A:start:#a');
    const bStart = log.indexOf('B:start:#b');
    const aEnd = log.indexOf('A:end:#a');
    assert.ok(aStart >= 0 && bStart >= 0 && aEnd >= 0);
    assert.ok(bStart < aEnd, 'second window should start before the first window finishes');
  });

  it('keeps the existing not-connected result without queueing work', async () => {
    const executor = new CommandExecutor({} as SelectorConfig);
    const result = await executor.clickAction('cmd-x', '#x');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not connected to Cursor');
  });
});

describe('CommandExecutor registered action boundary', () => {
  function registeredExecutor(options: { ttlMs?: number; evaluate?: () => Promise<unknown> } = {}) {
    const registry = new ActionRegistry({ ttlMs: options.ttlMs ?? 10_000 });
    const coordinator = new TargetUiCoordinator();
    coordinator.setGeneration('target-a', 3);
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient({
      isConnected: () => true,
      evaluate: options.evaluate ?? (async () => ({ ok: true })),
    } as unknown as CdpClient);
    executor.setActionRegistry(registry);
    executor.setUiCoordinator(coordinator, () => 'target-a', () => 3);
    const action = registry.register({
      windowId: 'target-a', targetId: 'target-a', targetGeneration: 3,
      composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin',
      actionType: 'approve', expectedLabel: 'Approve',
      selectorStrategyId: 'dom-observed', selectorPath: '#approve',
    });
    return { executor, registry, coordinator, action };
  }

  it('consumes a successful action and rejects replay with a new command id', async () => {
    const { executor, action } = registeredExecutor();
    const first = await executor.clickRegisteredAction('cmd-1', action.actionId, { actionType: 'approve' });
    const replay = await executor.clickRegisteredAction('cmd-2', action.actionId, { actionType: 'approve' });
    assert.equal(first.ok, true);
    assert.equal(replay.error, 'action_consumed');
  });

  it('rejects generation and action type mismatches before DOM evaluation', async () => {
    let evaluations = 0;
    const { executor, registry, action } = registeredExecutor({ evaluate: async () => { evaluations += 1; return { ok: true }; } });
    const otherGeneration = registry.register({
      windowId: 'target-a', targetId: 'target-a', targetGeneration: 4,
      composerId: 'composer-a', toolCallId: 'tool-b', adapterId: 'builtin',
      actionType: 'approve', expectedLabel: 'Approve',
      selectorStrategyId: 'dom-observed', selectorPath: '#approve',
    });
    const wrongGeneration = await executor.clickRegisteredAction('cmd-gen', otherGeneration.actionId, { actionType: 'approve' });
    const wrongType = await executor.clickRegisteredAction('cmd-type', action.actionId, { actionType: 'reject' });
    assert.equal(wrongGeneration.error, 'action_scope_changed');
    assert.equal(wrongType.error, 'action_scope_changed');
    assert.equal(evaluations, 0);
  });

  it('rejects expired and concurrently reserved actions', async () => {
    const expired = registeredExecutor({ ttlMs: 1 });
    await sleep(5);
    const expiredResult = await expired.executor.clickRegisteredAction('cmd-expired', expired.action.actionId, { actionType: 'approve' });
    assert.equal(expiredResult.error, 'action_expired');

    let releaseEvaluation!: () => void;
    const evaluationGate = new Promise<void>(resolve => { releaseEvaluation = resolve; });
    const concurrent = registeredExecutor({ evaluate: async () => { await evaluationGate; return { ok: true }; } });
    const first = concurrent.executor.clickRegisteredAction('cmd-first', concurrent.action.actionId, { actionType: 'approve' });
    const second = await concurrent.executor.clickRegisteredAction('cmd-second', concurrent.action.actionId, { actionType: 'approve' });
    releaseEvaluation();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(second.error, 'action_consumed');
  });

  it('cancels a queued action when the target generation changes', async () => {
    const { executor, action, coordinator } = registeredExecutor();
    coordinator.setGeneration('target-a', 4);
    const result = await executor.clickRegisteredAction('cmd-generation-change', action.actionId, { actionType: 'approve' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /generation_changed/);
  });

  it('does not retry a registered click after dispatch and consumes on timeout', async () => {
    let clicks = 0;
    const { executor, action } = registeredExecutor({
      evaluate: async () => {
        clicks += 1;
        throw new Error('CDP timeout after click');
      },
    });
    const result = await executor.clickRegisteredAction('cmd-timeout', action.actionId, { actionType: 'approve' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /CDP timeout after click/);
    assert.equal(clicks, 1);
    const replay = await executor.clickRegisteredAction('cmd-timeout-replay', action.actionId, { actionType: 'approve' });
    assert.equal(replay.error, 'action_consumed');
    assert.equal(clicks, 1);
  });
});

describe('CommandExecutor pre-click revalidation and one-shot settle', () => {
  function visibleRect(this: HTMLElement) {
    const style = this.ownerDocument.defaultView?.getComputedStyle(this);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() { return {}; } };
    }
    return { width: 40, height: 20, top: 0, left: 0, bottom: 20, right: 40, x: 0, y: 0, toJSON() { return {}; } };
  }

  function jsdomHarness(html: string) {
    const dom = new JSDOM(`<section data-composer-id="composer-a">${html}</section>`, { runScripts: 'outside-only' });
    dom.window.HTMLElement.prototype.getBoundingClientRect = visibleRect;
    dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    let clicks = 0;
    for (const el of Array.from(dom.window.document.querySelectorAll('button, [role="button"]'))) {
      el.addEventListener('click', () => { clicks += 1; });
    }
    const client = {
      isConnected: () => true,
      click: async () => { clicks += 1; },
      evaluate: async (expr: string) => (dom.window.eval(expr) as unknown),
    } as unknown as CdpClient;
    return {
      document: dom.window.document,
      client,
      clicks: () => clicks,
    };
  }

  function liveExecutor(html: string, actionType = 'approve', extra: Partial<Parameters<ActionRegistry['register']>[0]> = {}) {
    const harness = jsdomHarness(html);
    const registry = new ActionRegistry({ ttlMs: 10_000 });
    const coordinator = new TargetUiCoordinator();
    coordinator.setGeneration('target-a', 3);
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(harness.client);
    executor.setActionRegistry(registry);
    executor.setUiCoordinator(coordinator, () => 'target-a', () => 3);
    const action = registry.register({
      windowId: 'target-a', targetId: 'target-a', targetGeneration: 3,
      composerId: 'composer-a', toolCallId: 'tool-a', adapterId: 'builtin',
      actionType, expectedLabel: extra.expectedLabel ?? 'Approve',
      selectorStrategyId: 'dom-observed', selectorPath: extra.selectorPath ?? '#approve',
      ...extra,
    });
    return { ...harness, executor, registry, coordinator, action };
  }

  it('clicks exactly once for a valid registered action and refuses replay', async () => {
    const { executor, action, clicks, registry } = liveExecutor('<button id="approve">Approve</button>');
    const first = await executor.clickRegisteredAction('cmd-ok', action.actionId, { actionType: 'approve' });
    const replay = await executor.clickRegisteredAction('cmd-replay', action.actionId, { actionType: 'approve' });
    assert.equal(first.ok, true);
    assert.equal(clicks(), 1);
    assert.equal(replay.error, 'action_consumed');
    assert.equal(clicks(), 1);
    assert.equal(registry.public(action.actionId)?.executable, false);
  });

  it('does not click hidden, disabled, aria-disabled, ambiguous, or mismatched targets and releases them', async () => {
    const cases: Array<{ html: string; selector?: string; label?: string; error: RegExp; composerId?: string }> = [
      { html: '<button id="approve" hidden>Approve</button>', error: /action target is hidden/ },
      { html: '<button id="approve" disabled>Approve</button>', error: /action target is disabled/ },
      { html: '<button id="approve" aria-disabled="true">Approve</button>', error: /action target is disabled/ },
      { html: '<button class="approve">Approve</button><button class="approve">Approve</button>', selector: 'button.approve', error: /action target is ambiguous/ },
      { html: '<button id="approve">Reject</button>', error: /action target not found/ },
    ];

    for (const item of cases) {
      const live = liveExecutor(item.html, 'approve', {
        selectorPath: item.selector ?? '#approve',
        expectedLabel: item.label ?? 'Approve',
      });
      const result = await live.executor.clickRegisteredAction('cmd-neg', live.action.actionId, { actionType: 'approve' });
      assert.equal(result.ok, false, item.html);
      assert.match(result.error ?? '', item.error, item.html);
      assert.equal(live.clicks(), 0, item.html);
      assert.equal(live.registry.public(live.action.actionId)?.executable, true, item.html);
    }
  });

  it('rejects a composer scope mismatch before click and leaves the action reusable', async () => {
    const live = liveExecutor('<button id="approve">Approve</button>');
    const other = live.registry.register({
      windowId: 'target-a', targetId: 'target-a', targetGeneration: 3,
      composerId: 'composer-missing', toolCallId: 'tool-b', adapterId: 'builtin',
      actionType: 'approve', expectedLabel: 'Approve',
      selectorStrategyId: 'dom-observed', selectorPath: '#approve',
    });
    const result = await live.executor.clickRegisteredAction('cmd-scope', other.actionId, { actionType: 'approve' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /action composer scope changed/);
    assert.equal(live.clicks(), 0);
    assert.equal(live.registry.public(other.actionId)?.executable, true);
  });

  it('releases a hidden action so a later visible click can proceed once', async () => {
    const live = liveExecutor('<button id="approve" hidden>Approve</button>');
    const hidden = await live.executor.clickRegisteredAction('cmd-hidden', live.action.actionId, { actionType: 'approve' });
    assert.equal(hidden.ok, false);
    assert.equal(live.clicks(), 0);

    live.document.getElementById('approve')?.removeAttribute('hidden');
    const visible = await live.executor.clickRegisteredAction('cmd-visible', live.action.actionId, { actionType: 'approve' });
    assert.equal(visible.ok, true);
    assert.equal(live.clicks(), 1);
    const replay = await live.executor.clickRegisteredAction('cmd-visible-replay', live.action.actionId, { actionType: 'approve' });
    assert.equal(replay.error, 'action_consumed');
    assert.equal(live.clicks(), 1);
  });

  it('does not click a generation mismatch or an unknown action kind', async () => {
    const live = liveExecutor('<button id="approve">Approve</button>');
    live.coordinator.setGeneration('target-a', 4);
    const generation = await live.executor.clickRegisteredAction('cmd-gen', live.action.actionId, { actionType: 'approve' });
    assert.match(generation.error ?? '', /generation_changed/);
    assert.equal(live.clicks(), 0);

    const unknown = liveExecutor('<button id="approve">View</button>', 'generic_observe', {
      expectedLabel: 'View',
    });
    const result = await unknown.executor.clickRegisteredAction('cmd-unknown', unknown.action.actionId, { actionType: 'generic_observe' });
    assert.equal(result.error, 'action is not executable');
    assert.equal(unknown.clicks(), 0);
  });

  it('serializes concurrent valid clicks so only one dispatch happens', async () => {
    const live = liveExecutor('<button id="approve">Approve</button>');
    const first = live.executor.clickRegisteredAction('cmd-a', live.action.actionId, { actionType: 'approve' });
    const second = live.executor.clickRegisteredAction('cmd-b', live.action.actionId, { actionType: 'approve' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const okCount = [firstResult, secondResult].filter((result) => result.ok).length;
    const consumedCount = [firstResult, secondResult].filter((result) => result.error === 'action_consumed').length;
    assert.equal(okCount, 1);
    assert.equal(consumedCount, 1);
    assert.equal(live.clicks(), 1);
  });
});