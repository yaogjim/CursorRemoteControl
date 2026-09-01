import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';
import type { CursorState } from '../src/server/types.js';

const HTML_PATH = resolve('src/client/index.html');
const APP_JS_PATH = resolve('src/client/app.js');
const STYLES_PATH = resolve('src/client/styles.css');
const RELAY_PATH = resolve('src/server/relay.ts');

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
  handlers: Map<string, EventHandler>;
  on(event: string, fn: EventHandler): void;
  emit(event: string, ...args: unknown[]): void;
  fire(event: string, ...args: unknown[]): void;
  connected: boolean;
  id: string;
  emitted: Array<{ event: string; args: unknown[] }>;
}

function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve('fixtures/recordings', name), 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

interface MockNotificationRecord {
  title: string;
  body?: string;
  tag?: string;
}

function createTestEnv(opts: { storage?: Record<string, string>; prefersDark?: boolean } = {}) {
  const html = readFileSync(HTML_PATH, 'utf-8');
  const appJs = readFileSync(APP_JS_PATH, 'utf-8');

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: Window) {
      const mockSocket: MockSocket = {
        handlers: new Map(),
        connected: true,
        id: 'test-socket-id',
        emitted: [],
        on(event: string, fn: EventHandler) {
          this.handlers.set(event, fn);
        },
        emit(event: string, ...args: unknown[]) {
          this.emitted.push({ event, args });
        },
        fire(event: string, ...args: unknown[]) {
          const handler = this.handlers.get(event);
          if (handler) handler(...args);
        },
      };

      (window as any).io = function () {
        return mockSocket;
      };

      (window as any).__mockSocket = mockSocket;

      const storage: Record<string, string> = { ...(opts.storage ?? {}) };
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (key: string) => storage[key] ?? null,
          setItem: (key: string, val: string) => { storage[key] = val; },
          removeItem: (key: string) => { delete storage[key]; },
        },
      });

      const schemeListeners: Array<(ev: { matches: boolean }) => void> = [];
      const darkQuery = {
        matches: !!opts.prefersDark,
        media: '(prefers-color-scheme: dark)',
        addEventListener(_type: string, fn: (ev: { matches: boolean }) => void) {
          schemeListeners.push(fn);
        },
        removeEventListener(_type: string, fn: (ev: { matches: boolean }) => void) {
          const i = schemeListeners.indexOf(fn);
          if (i >= 0) schemeListeners.splice(i, 1);
        },
        addListener(fn: (ev: { matches: boolean }) => void) {
          schemeListeners.push(fn);
        },
        removeListener(fn: (ev: { matches: boolean }) => void) {
          const i = schemeListeners.indexOf(fn);
          if (i >= 0) schemeListeners.splice(i, 1);
        },
        dispatchEvent() { return false; },
        onchange: null as ((ev: { matches: boolean }) => void) | null,
      };
      window.matchMedia = ((query: string) => {
        if (String(query).includes('prefers-color-scheme: dark')) {
          return darkQuery as unknown as MediaQueryList;
        }
        return {
          matches: false,
          media: query,
          addEventListener() { /* noop */ },
          removeEventListener() { /* noop */ },
          addListener() { /* noop */ },
          removeListener() { /* noop */ },
          dispatchEvent() { return false; },
          onchange: null,
        } as unknown as MediaQueryList;
      }) as typeof window.matchMedia;
      (window as any).__setPrefersDark = (dark: boolean) => {
        darkQuery.matches = dark;
        const ev = { matches: dark };
        for (const fn of [...schemeListeners]) fn(ev);
        if (typeof darkQuery.onchange === 'function') darkQuery.onchange(ev);
      };

      (window as any).requestAnimationFrame = (cb: () => void) => {
        setTimeout(cb, 0);
        return 0;
      };

      const notifications: MockNotificationRecord[] = [];
      class MockNotification {
        static permission = 'granted';
        static requestPermission() {
          return Promise.resolve('granted');
        }
        constructor(title: string, opts?: { body?: string; tag?: string }) {
          notifications.push({ title, body: opts?.body, tag: opts?.tag });
        }
      }
      (window as any).Notification = MockNotification;
      (window as any).__notifications = notifications;

      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      (window as any).__fetchCalls = fetchCalls;
      (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        if (url.includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ authRequired: false, sessionValid: true }) };
        }
        if (url.includes('/api/csrf')) {
          return { ok: true, status: 200, json: async () => ({ csrfToken: 'test-csrf-token' }) };
        }
        if (url.includes('/api/capabilities/diff')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              targetId: 'target-1234567890',
              added: ['mode:plan'],
              removed: [],
              changed: [],
              conflicts: [],
            }),
          };
        }
        if (url.includes('/api/adapters/history')) {
          return { ok: true, status: 200, json: async () => ({ revision: 0, activeBindings: [], adapters: [], history: [] }) };
        }
        if (url.includes('/api/discovery/run')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, data: { revision: 1 } }) };
        }
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      };

      const loc = {
        href: 'http://localhost:3000/',
        assign(url: string) { this.href = url; },
        replace(url: string) { this.href = url; },
        reload() { /* noop */ },
        toString() { return this.href; },
      };
      try {
        Object.defineProperty(window, 'location', {
          configurable: true,
          value: loc,
        });
      } catch {
        (window as any).__locationStub = loc;
      }
    },
  });

  const window = dom.window;
  const document = window.document;

  try {
    const loc = {
      href: 'http://localhost:3000/',
      assign(url: string) { this.href = url; },
      replace(url: string) { this.href = url; },
      reload() { /* noop */ },
      toString() { return this.href; },
    };
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  } catch {
    // JSDOM Location is sometimes non-configurable
  }

  const scriptEl = document.createElement('script');
  scriptEl.textContent = appJs;
  document.body.appendChild(scriptEl);

  const mockSocket = (window as any).__mockSocket as MockSocket;

  return { dom, window, document, mockSocket };
}

function fireFullState(mockSocket: MockSocket, state: CursorState) {
  mockSocket.fire('state:full', state);
}

function firePatch(mockSocket: MockSocket, patch: Partial<CursorState>) {
  mockSocket.fire('state:patch', patch);
}

// ─── Connection status rendering ───

describe('web: connection status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('shows connected when extractorStatus is ok', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const dot = env.document.getElementById('connection-dot')!;
    const text = env.document.getElementById('connection-text')!;
    assert.ok(dot.classList.contains('connected'));
    assert.match(text.textContent!, /Connected/i);
  });

  it('shows stale when extractorStatus is stale', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const dot = env.document.getElementById('connection-dot')!;
    assert.ok(dot.classList.contains('stale'), `Expected stale class, got: ${dot.className}`);
    assert.equal(dot.getAttribute('data-extractor'), 'stale');
    assert.equal(dot.getAttribute('data-layer'), 'extractor');
    assert.equal(dot.getAttribute('data-socket'), 'connected');
    assert.equal(dot.getAttribute('data-cdp'), 'connected');
    assert.match(dot.title, /Extractor stale/i);
  });
});

// ─── Agent status rendering ───

describe('web: agent status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('shows idle when agent is idle', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });

  it('shows thinking label when shimmer active', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Planning next moves/i);
  });

  it('clears activity when shimmer stops', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[4].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });
});

// ─── Message rendering ───

describe('web: message rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders human message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const humanEl = msgs.querySelector('.el-human');
    assert.ok(humanEl, 'Should render human message (.el-human)');
    assert.match(humanEl!.textContent!, /Fix the bug/);
  });

  it('renders assistant message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    assert.ok(msgs.querySelector('.el-assistant'), 'Should render assistant message (.el-assistant)');
  });

  it('renders tool element with filename', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render tool messages (.el-tool)');
  });

  it('updates messages on patch', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const initialCount = msgs.querySelectorAll('[data-id]').length;

    firePatch(env.mockSocket, {
      messages: fixture[4].state!.messages,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
    });
    const updatedCount = msgs.querySelectorAll('[data-id]').length;
    assert.ok(updatedCount > initialCount, `Expected more messages after patch, got ${initialCount} -> ${updatedCount}`);
  });
});

// ─── Run command / approval rendering ───

describe('web: approval widgets', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders run_command with command text', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCard = msgs.querySelector('.run-card');
    assert.ok(runCard, 'Should render run_command card');
    assert.match(runCard!.textContent!, /npm test/);
  });

  it('renders run_command with Skip and Run buttons', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const buttons = msgs.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ run buttons, got ${buttons.length}`);
  });

  it('preserves command text across updates', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[2].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCards = msgs.querySelectorAll('.run-card');
    const hasNpmTest = Array.from(runCards).some(
      card => card.textContent!.includes('npm test')
    );
    assert.ok(hasNpmTest, 'npm test should be preserved in run cards');
  });
});

// ─── Plan widget rendering ───

describe('web: plan widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders plan block with title and progress', () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const planEl = msgs.querySelector('.el-plan');
    assert.ok(planEl, 'Should render plan block (.el-plan)');
    assert.match(planEl!.textContent!, /Auth System/);
  });
});

// ─── Code block rendering ───

describe('web: code block rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders diff block with viewport', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const diffBlock = msgs.querySelector('.code-block-viewport');
    assert.ok(diffBlock, 'Should render a code block viewport');
  });

  it('preserves newlines in code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const codeEl = msgs.querySelector('.code-block-viewport pre code');
    if (codeEl) {
      const text = codeEl.textContent ?? '';
      assert.ok(text.includes('\n'), 'Code block text should preserve newlines');
    }
  });

  it('renders assistant message with code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const assistant = msgs.querySelector('.el-assistant');
    assert.ok(assistant, 'Should render assistant message (.el-assistant)');
  });
});

// ─── Fetch tool rendering ───

describe('web: fetch tool', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders fetch tool with action text and URL', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool (.el-tool)');
    assert.match(toolEl!.textContent!, /Fetch/);
    assert.match(toolEl!.textContent!, /reddit\.com/);
  });

  it('renders fetch tool with approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool');
    const actionRow = toolEl!.querySelector('.tool-actions-row');
    assert.ok(actionRow, 'Should have tool-actions-row with buttons');
    const buttons = actionRow!.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ action buttons, got ${buttons.length}`);
  });

  it('renders completed fetch tool without approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[3].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render fetch tool');
    const lastTool = toolEls[toolEls.length - 1];
    const actionRow = lastTool.querySelector('.tool-actions-row');
    assert.ok(!actionRow, 'Completed tool should not have action buttons');
  });
});

// ─── Mode/model pill rendering ───

describe('web: mode/model pills', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function capabilitySnapshot(overrides: Record<string, unknown> = {}) {
    return {
      targetId: 'target-1234567890',
      targetGeneration: 4,
      revision: 8,
      status: { state: 'ok', completeness: 'complete' },
      modes: [{ id: 'agent', label: 'Agent', icon: '∞', current: true, selectable: true }],
      models: {
        completeness: 'complete',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
      tools: [{ id: 'terminal', label: 'Terminal' }],
      ...overrides,
    };
  }

  function fireCapabilities(snapshot: ReturnType<typeof capabilitySnapshot>) {
    env.mockSocket.fire('capabilities:full', {
      activeTargetId: snapshot.targetId,
      snapshots: [snapshot],
    });
  }

  function modePill() {
    return env.document.getElementById('pill-mode') as HTMLButtonElement;
  }

  function modelPill() {
    return env.document.getElementById('pill-model') as HTMLButtonElement;
  }

  function sheetHidden(id: string) {
    return env.document.getElementById(id)!.classList.contains('hidden');
  }

  function modelOptionEmits() {
    return env.mockSocket.emitted.filter((item) => item.event === 'command:get_model_options');
  }

  async function openModelSheetWithOptions(options: Array<{ id: string; label: string; selected?: boolean }>) {
    modelPill().click();
    const emitted = modelOptionEmits();
    assert.ok(emitted.length > 0, 'Expected get_model_options when model mutation is enabled');
    const commandId = (emitted[emitted.length - 1].args[0] as { commandId: string }).commandId;
    env.mockSocket.fire('command:result', { commandId, ok: true, data: { options } });
    await Promise.resolve();
    await Promise.resolve();
  }

  it('starts with mode/model pills disabled until a usable snapshot arrives', () => {
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    modePill().click();
    modelPill().click();
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.equal(sheetHidden('sheet-model'), true);
    assert.equal(modelOptionEmits().length, 0);
  });

  it('renders mode and model from state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const modeText = env.document.getElementById('pill-mode-text')!;
    const modelText = env.document.getElementById('pill-model-text')!;
    assert.ok(modeText.textContent!.length > 0, 'Mode text should be set');
    assert.ok(modelText.textContent!.length > 0, 'Model text should be set');
  });

  it('renders live capability completeness and counts', () => {
    fireCapabilities(capabilitySnapshot());

    const summary = env.document.getElementById('capability-diagnostics-summary')!;
    const body = env.document.getElementById('capability-diagnostics-body')!;
    assert.match(summary.textContent!, /ok · complete/);
    assert.match(body.textContent!, /1 modes · 1 models · 1 tools/);
    assert.match(body.textContent!, /generation 4/);
  });

  it('enables mode and model pills when status is ok and models are complete', () => {
    fireCapabilities(capabilitySnapshot());
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, false);
    assert.equal(modePill().getAttribute('aria-disabled'), 'false');
    assert.equal(modelPill().getAttribute('aria-disabled'), 'false');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
    assert.equal(modePill().getAttribute('data-capability-state'), 'ok');
    assert.equal(modelPill().getAttribute('data-capability-state'), 'ok');
    assert.equal(modelPill().getAttribute('data-completeness'), 'complete');
    assert.equal(modePill().getAttribute('data-mutation'), 'enabled');
    assert.equal(modelPill().getAttribute('data-mutation'), 'enabled');
    assert.match(modePill().title, /Mode capability: ok/);
    assert.match(modelPill().title, /Model capability: ok/);
    assert.doesNotMatch(modePill().title, /unavailable/);
    assert.equal(env.document.getElementById('mode-model-status')!.hasAttribute('hidden'), true);
    assert.equal(env.document.getElementById('mode-model-status-text')!.textContent, '');
    assert.equal((env.document.getElementById('btn-mode-model-refresh') as HTMLButtonElement).hidden, true);

    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), false);
    assert.match(env.document.getElementById('sheet-mode-list')!.textContent!, /Agent/);
    assert.equal(modelOptionEmits().length, 0, 'Mode sheet must not fetch Cursor model menus');
  });

  it('keeps Codicon class names out of mode sheet text and preserves row structure', () => {
    fireCapabilities(capabilitySnapshot({
      modes: [
        { id: 'agent', label: 'Agent', icon: 'codicon-infinity', current: true, selectable: true },
        { id: 'plan', label: 'Plan', icon: 'codicon-todos', current: false, selectable: true },
        { id: 'debug', label: 'Debug', icon: 'codicon-bug', current: false, selectable: true },
        { id: 'multitask', label: 'Multitask', icon: 'codicon-circles', current: false, selectable: true },
        { id: 'chat', label: 'Ask', icon: 'codicon-chat', current: false, selectable: true },
      ],
    }));

    assert.equal(env.document.getElementById('pill-mode-icon')!.textContent, '');
    modePill().click();

    const list = env.document.getElementById('sheet-mode-list')!;
    const rows = [...list.querySelectorAll('.sheet-item')];
    assert.equal(rows.length, 5);
    assert.doesNotMatch(list.textContent!, /codicon/i);
    assert.deepEqual(
      rows.map((row) => row.querySelector('.sheet-item-label')?.textContent),
      ['Agent', 'Plan', 'Debug', 'Multitask', 'Ask']
    );
    assert.equal(list.querySelectorAll('.sheet-item-icon').length, 0);
    assert.equal(list.querySelectorAll('.sheet-item-right').length, 5);
    assert.equal(rows[0].getAttribute('aria-selected'), 'true');
    assert.equal(rows[0].querySelector('.sheet-item-check')?.textContent, '✓');
    assert.equal(rows[1].getAttribute('aria-selected'), 'false');
  });

  it('enables pills when status is changed and models are complete', async () => {
    fireCapabilities(capabilitySnapshot({
      status: { state: 'changed', completeness: 'complete' },
    }));
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, false);

    await openModelSheetWithOptions([{ id: 'auto', label: 'Auto', selected: true }]);
    assert.equal(sheetHidden('sheet-model'), false);
    assert.match(env.document.getElementById('sheet-model-list')!.textContent!, /Auto/);
  });

  for (const state of ['degraded', 'stale', 'unknown', 'unavailable'] as const) {
    it(`disables mode/model pills when status is ${state} and click does not open sheets`, () => {
      fireCapabilities(capabilitySnapshot({
        status: { state, completeness: 'complete' },
      }));
      assert.equal(modePill().disabled, true);
      assert.equal(modelPill().disabled, true);
      assert.equal(modePill().getAttribute('aria-disabled'), 'true');
      assert.equal(modelPill().getAttribute('aria-disabled'), 'true');
      assert.equal(modePill().getAttribute('data-capability-state'), state);
      assert.equal(modelPill().getAttribute('data-capability-state'), state);
      assert.equal(modePill().getAttribute('data-mutation'), 'locked');
      assert.equal(modelPill().getAttribute('data-mutation'), 'locked');
      assert.ok(modePill().classList.contains(`pill-${state}`));
      assert.ok(modelPill().classList.contains(`pill-${state}`));
      assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
      assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
      assert.match(modePill().title, new RegExp(`${state}.*unavailable`));
      assert.match(modelPill().title, new RegExp(`${state}/complete.*unavailable`));

      modePill().click();
      modelPill().click();
      assert.equal(sheetHidden('sheet-mode'), true);
      assert.equal(sheetHidden('sheet-model'), true);
      assert.equal(sheetHidden('sheet-overlay'), true);
      assert.equal(modelOptionEmits().length, 0);
      assert.equal(env.mockSocket.emitted.filter((item) => item.event === 'command:set_mode').length, 0);
      assert.equal(env.mockSocket.emitted.filter((item) => item.event === 'command:set_model').length, 0);
    });
  }

  it('disables model mutation when completeness is partial, without fabricating options', () => {
    fireCapabilities(capabilitySnapshot({
      models: {
        completeness: 'partial',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.equal(modePill().disabled, false, 'mode is not gated on model completeness');
    assert.equal(modelPill().disabled, true);
    assert.equal(modePill().getAttribute('data-mutation'), 'enabled');
    assert.equal(modelPill().getAttribute('data-mutation'), 'locked');
    assert.equal(modelPill().getAttribute('data-completeness'), 'partial');
    assert.ok(modelPill().classList.contains('pill-partial'));
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
    assert.match(modelPill().title, /partial.*unavailable/);
    assert.match(env.document.getElementById('mode-model-status')!.textContent!, /model list is not fully verified/i);

    modelPill().click();
    assert.equal(sheetHidden('sheet-model'), true);
    assert.equal(modelOptionEmits().length, 0);
  });

  it('disables model mutation when completeness is unknown', () => {
    fireCapabilities(capabilitySnapshot({
      models: {
        completeness: 'unknown',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.equal(modelPill().disabled, true);
    modelPill().click();
    assert.equal(sheetHidden('sheet-model'), true);
    assert.equal(modelOptionEmits().length, 0);
  });

  it('disables mode mutation when no selectable current/available mode exists', () => {
    fireCapabilities(capabilitySnapshot({
      modes: [{ id: 'agent', label: 'Agent', current: true, selectable: false }],
    }));
    assert.equal(modePill().disabled, true);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), true);
  });

  it('disables model mutation when no selectable composer model exists', () => {
    fireCapabilities(capabilitySnapshot({
      models: {
        completeness: 'complete',
        items: [{ id: 'plan-1', label: 'Plan Model', selected: true, scope: 'plan', selectable: true }],
      },
    }));
    assert.equal(modelPill().disabled, true);
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Model unavailable');
    modelPill().click();
    assert.equal(sheetHidden('sheet-model'), true);
    assert.equal(modelOptionEmits().length, 0);
  });

  it('closes the open mode sheet when capability becomes degraded', () => {
    fireCapabilities(capabilitySnapshot({ revision: 1 }));
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), false);

    fireCapabilities(capabilitySnapshot({
      revision: 2,
      status: { state: 'degraded', completeness: 'complete' },
    }));
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.equal(sheetHidden('sheet-overlay'), true);
    assert.equal(modePill().disabled, true);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');

    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), true);
  });

  it('closes the model sheet and clears cached options when completeness becomes partial', async () => {
    fireCapabilities(capabilitySnapshot({ revision: 1 }));
    await openModelSheetWithOptions([{ id: 'cached-stale', label: 'Cached Stale Model', selected: true }]);
    assert.match(env.document.getElementById('sheet-model-list')!.textContent!, /Cached Stale Model/);

    fireCapabilities(capabilitySnapshot({
      revision: 2,
      models: {
        completeness: 'partial',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.equal(sheetHidden('sheet-model'), true);
    assert.equal(modelPill().disabled, true);

    fireCapabilities(capabilitySnapshot({ revision: 3 }));
    assert.equal(modelPill().disabled, false);
    modelPill().click();
    assert.equal(sheetHidden('sheet-model'), false);
    assert.match(env.document.getElementById('sheet-model-list')!.textContent!, /Loading models/);
    assert.doesNotMatch(env.document.getElementById('sheet-model-list')!.textContent!, /Cached Stale Model/);

    const last = modelOptionEmits().at(-1);
    env.mockSocket.fire('command:result', {
      commandId: (last!.args[0] as { commandId: string }).commandId,
      ok: true,
      data: { options: [{ id: 'auto', label: 'Auto', selected: true }] },
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it('closes open sheets on capabilities:stale and keeps observed labels', () => {
    fireCapabilities(capabilitySnapshot());
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), false);

    env.mockSocket.fire('capabilities:stale', { targetId: 'target-1234567890' });
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
    assert.match(modePill().title, /stale.*unavailable/);
    const recovery = env.document.getElementById('mode-model-status')!;
    assert.equal(recovery.hasAttribute('hidden'), false);
    assert.match(recovery.textContent!, /changed or reconnected.*Refresh its capabilities/i);
    assert.equal((env.document.getElementById('btn-mode-model-refresh') as HTMLButtonElement).hidden, false);
  });

  it('shows pending adapters without activating them', () => {
    env.mockSocket.fire('adapter:pending', {
      id: 'adapter-pending-123',
      status: 'pending_confirmation',
      capabilityKinds: ['model'],
      createdAt: Date.now(),
    });

    const summary = env.document.getElementById('capability-diagnostics-summary')!;
    const pending = env.document.querySelector('.pending-adapter')!;
    assert.match(summary.textContent!, /1 pending adapter/);
    assert.match(pending.textContent!, /model adapter/);
    assert.match(pending.textContent!, /activation unavailable/);
    assert.equal(env.document.querySelector('[data-adapter-apply]'), null);
    assert.doesNotMatch(pending.textContent!, /\bApply\b/);
  });

  it('accepts a raw capabilities:full snapshot as well as the public envelope', () => {
    env.mockSocket.fire('capabilities:full', capabilitySnapshot({ revision: 3 }));
    assert.equal(modePill().disabled, false);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
  });

  it('resets caches and closes sheets when the active target changes', () => {
    fireCapabilities(capabilitySnapshot({ revision: 1 }));
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), false);

    fireCapabilities(capabilitySnapshot({
      targetId: 'target-other',
      targetGeneration: 1,
      revision: 1,
      status: { state: 'unknown', completeness: 'unknown' },
      modes: [],
      models: { completeness: 'unknown', items: [] },
    }));
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.doesNotMatch(env.document.getElementById('sheet-mode-list')!.textContent || '', /Agent/);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Mode unavailable');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Model unavailable');
    assert.equal(modePill().getAttribute('data-catalog'), 'empty');
    assert.equal(modelPill().getAttribute('data-catalog'), 'empty');
    assert.equal(modePill().getAttribute('data-capability-state'), 'unknown');
  });

  it('ignores capability patches for a different target and accepts the active target without activeWindowId', () => {
    fireCapabilities(capabilitySnapshot({ revision: 4 }));
    env.mockSocket.fire('capabilities:patch', {
      targetId: 'other-window',
      targetGeneration: 9,
      revision: 99,
      status: { state: 'ok', completeness: 'complete' },
      modes: [{ id: 'debug', label: 'Debug', current: true, selectable: true }],
    });
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');

    env.mockSocket.fire('capabilities:patch', {
      targetId: 'target-1234567890',
      targetGeneration: 4,
      revision: 9,
      status: { state: 'ok', completeness: 'complete' },
      modes: [{ id: 'plan', label: 'Plan', current: true, selectable: true }],
    });
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Plan');
  });

  it('disables mode/model and closes sheets on socket disconnect', () => {
    fireCapabilities(capabilitySnapshot());
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), false);
    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.match(env.document.getElementById('capability-diagnostics-summary')!.textContent!, /stale · reconnecting/);
    modePill().click();
    assert.equal(sheetHidden('sheet-mode'), true);
    assert.equal(modelOptionEmits().length, 0);
  });

  it('does not auto-run discovery and only POSTs /api/discovery/run from the refresh button', async () => {
    const calls = (env.window as unknown as { __fetchCalls: Array<{ url: string; init?: RequestInit }> }).__fetchCalls;
    env.mockSocket.fire('connect');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.some((item) => item.url.includes('/api/discovery/run')), false);

    fireCapabilities(capabilitySnapshot());
    const refresh = env.document.getElementById('btn-capability-refresh') as HTMLButtonElement;
    assert.ok(refresh);
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const run = calls.filter((item) => item.url.includes('/api/discovery/run'));
    assert.equal(run.length, 1);
    const headers = (run[0].init?.headers || {}) as Record<string, string>;
    assert.ok(headers['X-Operation-Id']);
    assert.equal(headers['X-CSRF-Token'], 'test-csrf-token');
    assert.match(env.document.getElementById('capability-refresh-status')!.textContent!, /finished|Refreshing|failed/i);
  });

  it('offers an explicit inline recovery action when capabilities are stale', async () => {
    const calls = (env.window as unknown as { __fetchCalls: Array<{ url: string; init?: RequestInit }> }).__fetchCalls;
    fireCapabilities(capabilitySnapshot({
      status: { state: 'stale', completeness: 'unknown' },
      models: {
        completeness: 'unknown',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));

    const recovery = env.document.getElementById('mode-model-status')!;
    const refresh = env.document.getElementById('btn-mode-model-refresh') as HTMLButtonElement;
    assert.equal(recovery.hasAttribute('hidden'), false);
    assert.equal(refresh.hidden, false);
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const runs = calls.filter((item) => item.url.includes('/api/discovery/run'));
    assert.equal(runs.length, 1);
    assert.equal(refresh.disabled, false);
    assert.equal(refresh.textContent, 'Refresh capabilities');
    assert.equal(env.mockSocket.emitted.some((item) => item.event === 'command:set_mode'), false);
    assert.equal(env.mockSocket.emitted.some((item) => item.event === 'command:set_model'), false);
  });

  it('renders capability diff diagnostics from the status endpoint payload', async () => {
    env.mockSocket.fire('connect');
    await new Promise((resolve) => setTimeout(resolve, 30));
    fireCapabilities(capabilitySnapshot());
    const body = env.document.getElementById('capability-diagnostics-body')!;
    assert.match(body.textContent!, /\+1 \/ −0 \/ 0 changed \/ 0 conflicts/);
  });
});

// ─── Connection / capability state matrix ───

describe('web: connection/capability state matrix', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function capabilitySnapshot(overrides: Record<string, unknown> = {}) {
    return {
      targetId: 'target-1234567890',
      targetGeneration: 4,
      revision: 8,
      status: { state: 'ok', completeness: 'complete' },
      modes: [{ id: 'agent', label: 'Agent', icon: '∞', current: true, selectable: true }],
      models: {
        completeness: 'complete',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
      tools: [{ id: 'terminal', label: 'Terminal' }],
      ...overrides,
    };
  }

  function fireCapabilities(snapshot: ReturnType<typeof capabilitySnapshot>) {
    env.mockSocket.fire('capabilities:full', {
      activeTargetId: snapshot.targetId,
      snapshots: [snapshot],
    });
  }

  function connectedCursor() {
    return loadFixture('connection-states.jsonl')[0].state!;
  }

  function modePill() {
    return env.document.getElementById('pill-mode') as HTMLButtonElement;
  }

  function modelPill() {
    return env.document.getElementById('pill-model') as HTMLButtonElement;
  }

  function connectionDot() {
    return env.document.getElementById('connection-dot')!;
  }

  it('keeps pills locked after relay reconnect until capabilities:full arrives', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot());
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, false);

    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');
    assert.equal(connectionDot().className, 'dot disconnected');
    assert.equal(connectionDot().getAttribute('data-socket'), 'disconnected');
    assert.equal(connectionDot().getAttribute('data-layer'), 'socket');
    assert.match(env.document.getElementById('connection-text')!.textContent!, /Relay disconnected/);
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
    assert.equal(modePill().getAttribute('data-catalog'), 'present');

    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    assert.equal(modePill().disabled, true, 'must stay locked while awaiting capabilities:full');
    assert.equal(modelPill().disabled, true);
    assert.equal(modePill().getAttribute('data-awaiting-full'), 'true');
    assert.equal(modePill().getAttribute('data-capability-state'), 'awaiting');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.ok(connectionDot().classList.contains('connected'));
    assert.equal(connectionDot().getAttribute('data-capability'), 'awaiting');

    env.mockSocket.fire('capabilities:patch', {
      targetId: 'target-1234567890',
      targetGeneration: 4,
      revision: 9,
      status: { state: 'ok', completeness: 'complete' },
      modes: [{ id: 'plan', label: 'Plan', current: true, selectable: true }],
    });
    assert.equal(modePill().disabled, true, 'a patch must not clear awaiting-full');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Plan');

    fireCapabilities(capabilitySnapshot({
      revision: 10,
      modes: [{ id: 'agent', label: 'Agent', current: true, selectable: true }],
    }));
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, false);
    assert.equal(modePill().getAttribute('data-awaiting-full'), 'false');
    assert.equal(modePill().getAttribute('data-mutation'), 'enabled');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
  });

  it('shows CDP disconnect independently of capability pills', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    fireCapabilities(capabilitySnapshot());
    assert.equal(modePill().disabled, false);

    fireFullState(env.mockSocket, fixture[3].state!);
    const dot = connectionDot();
    assert.ok(dot.classList.contains('reconnecting'));
    assert.equal(dot.getAttribute('data-layer'), 'cdp');
    assert.equal(dot.getAttribute('data-cdp'), 'disconnected');
    assert.equal(dot.getAttribute('data-socket'), 'connected');
    assert.equal(dot.getAttribute('data-extractor'), 'ok');
    assert.match(env.document.getElementById('connection-text')!.textContent!, /Waiting for Cursor/);
    assert.match(dot.title, /CDP disconnected/);
    assert.equal(modePill().disabled, false, 'CDP layer does not rewrite capability mutation');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(modePill().getAttribute('data-capability-state'), 'ok');
  });

  it('renders extractor stale and recovers without mixing in capability state', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireCapabilities(capabilitySnapshot());
    const dot = connectionDot();
    assert.ok(dot.classList.contains('stale'));
    assert.equal(dot.getAttribute('data-layer'), 'extractor');
    assert.equal(dot.getAttribute('data-extractor'), 'stale');
    assert.equal(dot.getAttribute('data-capability'), 'ok');
    assert.match(env.document.getElementById('connection-text')!.textContent!, /backgrounded|stalled/i);
    assert.equal(modePill().disabled, false);
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');

    fireFullState(env.mockSocket, fixture[2].state!);
    assert.ok(dot.classList.contains('connected'));
    assert.equal(dot.getAttribute('data-layer'), 'ok');
    assert.equal(dot.getAttribute('data-extractor'), 'ok');
    assert.match(env.document.getElementById('connection-text')!.textContent!, /Connected/);
    assert.equal(modePill().disabled, false);
  });

  it('keeps the connection green when capabilities are stale', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot());
    env.mockSocket.fire('capabilities:stale', { targetId: 'target-1234567890' });

    const dot = connectionDot();
    assert.ok(dot.classList.contains('connected'));
    assert.equal(dot.getAttribute('data-layer'), 'ok');
    assert.equal(dot.getAttribute('data-socket'), 'connected');
    assert.equal(dot.getAttribute('data-cdp'), 'connected');
    assert.equal(dot.getAttribute('data-extractor'), 'ok');
    assert.equal(dot.getAttribute('data-capability'), 'stale');
    assert.match(dot.title, /Capabilities stale/);
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.equal(modePill().getAttribute('data-capability-state'), 'stale');
    assert.ok(modePill().classList.contains('pill-stale'));
    assert.ok(modelPill().classList.contains('pill-stale'));
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
  });

  it('locks pills on generation bump while preserving last-known labels', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot({ revision: 1 }));
    modePill().click();
    assert.equal(env.document.getElementById('sheet-mode')!.classList.contains('hidden'), false);

    fireCapabilities(capabilitySnapshot({
      targetGeneration: 5,
      revision: 0,
      status: { state: 'stale', completeness: 'unknown' },
      models: {
        completeness: 'unknown',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.equal(env.document.getElementById('sheet-mode')!.classList.contains('hidden'), true);
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);
    assert.equal(modePill().getAttribute('data-capability-state'), 'stale');
    assert.equal(modelPill().getAttribute('data-completeness'), 'unknown');
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');
    assert.equal(env.document.getElementById('pill-model-text')!.textContent, 'Auto');
    assert.ok(connectionDot().classList.contains('connected'));
  });

  it('distinguishes unavailable and degraded pill presentation', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot({
      status: { state: 'unavailable', completeness: 'complete' },
    }));
    assert.equal(modePill().getAttribute('data-capability-state'), 'unavailable');
    assert.ok(modePill().classList.contains('pill-unavailable'));
    assert.ok(!modePill().classList.contains('pill-degraded'));
    assert.equal(env.document.getElementById('pill-mode-text')!.textContent, 'Agent');

    fireCapabilities(capabilitySnapshot({
      revision: 9,
      status: { state: 'degraded', completeness: 'complete' },
    }));
    assert.equal(modePill().getAttribute('data-capability-state'), 'degraded');
    assert.ok(modePill().classList.contains('pill-degraded'));
    assert.ok(!modePill().classList.contains('pill-unavailable'));
    assert.match(modePill().title, /degraded.*unavailable/);
    assert.ok(connectionDot().classList.contains('connected'));
  });

  it('keeps Mode writable on ok+partial while locking Model', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot({
      models: {
        completeness: 'partial',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.ok(connectionDot().classList.contains('connected'));
    assert.equal(connectionDot().getAttribute('data-completeness'), 'partial');
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, true);
    assert.equal(modePill().getAttribute('data-capability-state'), 'ok');
    assert.equal(modelPill().getAttribute('data-completeness'), 'partial');
    assert.ok(modelPill().classList.contains('pill-partial'));
    assert.match(modelPill().title, /partial.*unavailable/);
    assert.doesNotMatch(modePill().title, /unavailable/);
  });

  it('unlocks Mode and Model after full recovery', () => {
    fireFullState(env.mockSocket, connectedCursor());
    fireCapabilities(capabilitySnapshot({
      status: { state: 'stale', completeness: 'unknown' },
      models: {
        completeness: 'unknown',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
    }));
    assert.equal(modePill().disabled, true);
    assert.equal(modelPill().disabled, true);

    fireCapabilities(capabilitySnapshot({ revision: 12 }));
    assert.equal(modePill().disabled, false);
    assert.equal(modelPill().disabled, false);
    assert.equal(modePill().getAttribute('data-mutation'), 'enabled');
    assert.equal(modelPill().getAttribute('data-mutation'), 'enabled');
    assert.equal(modePill().getAttribute('data-capability-state'), 'ok');
    assert.equal(modelPill().getAttribute('data-completeness'), 'complete');
    assert.equal(env.document.getElementById('mode-model-status')!.hasAttribute('hidden'), true);
  });

  it('renders extractor waiting as a reconnecting CDP-independent layer', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    fireCapabilities(capabilitySnapshot());
    const dot = connectionDot();
    assert.ok(dot.classList.contains('reconnecting'));
    assert.equal(dot.getAttribute('data-layer'), 'extractor');
    assert.equal(dot.getAttribute('data-extractor'), 'waiting');
    assert.equal(dot.getAttribute('data-cdp'), 'connected');
    assert.match(env.document.getElementById('connection-text')!.textContent!, /Waiting for snapshot/);
    assert.equal(modePill().disabled, false);
  });

  it('defines distinguishable CSS for unknown, stale, degraded, unavailable, and partial', () => {
    const css = readFileSync(STYLES_PATH, 'utf-8');
    assert.match(css, /\.dot\.stale\s*\{/);
    assert.match(css, /\.dot\.unknown\s*\{/);
    assert.match(css, /\.dot\.degraded\s*\{/);
    assert.match(css, /\.dot\.unavailable\s*\{/);
    assert.match(css, /\[data-capability-state="stale"\]/);
    assert.match(css, /\[data-capability-state="degraded"\]/);
    assert.match(css, /\[data-capability-state="unknown"\]/);
    assert.match(css, /\[data-capability-state="unavailable"\]/);
    assert.match(css, /\[data-completeness="partial"\]/);
  });
});

// ─── Questionnaire widget rendering ───

describe('web: questionnaire widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function baseState(): CursorState {
    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: Date.now(),
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
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
    };
  }

  it('hides questionnaire bar when questionnaire is null', () => {
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'Questionnaire bar should be hidden');
  });

  it('shows questionnaire bar with questions', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Pick a color?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-red' },
            { letter: 'B', label: 'Blue', isFreeform: false, selectorPath: 'sp-blue' },
          ],
        },
      ],
      activeIndex: 0,
      totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip',
      continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Questionnaire bar should be visible');
    const stepper = env.document.getElementById('questionnaire-stepper')!;
    assert.equal(stepper.textContent, '1 of 1');
    const questions = bar.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 1);
    const options = bar.querySelectorAll('.questionnaire-option');
    assert.equal(options.length, 2);
    assert.match(options[0].textContent!, /A.*Red/);
    assert.match(options[1].textContent!, /B.*Blue/);
  });

  it('disables continue button when continueDisabled is true', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-q-continue')! as HTMLButtonElement;
    assert.ok(btn.disabled, 'Continue should be disabled');
  });

  it('hides questionnaire bar when questionnaire becomes null via patch', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Should be visible initially');

    firePatch(env.mockSocket, { questionnaire: null });
    assert.ok(bar.classList.contains('hidden'), 'Should hide after patch with null');
  });

  it('marks active question with active class', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        { number: '1.', text: 'Q1?', isActive: false, options: [] },
        { number: '2.', text: 'Q2?', isActive: true, options: [] },
      ],
      activeIndex: 1, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const questions = env.document.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 2);
    assert.ok(!questions[0].classList.contains('questionnaire-question-active'));
    assert.ok(questions[1].classList.contains('questionnaire-question-active'));
  });
});

function patchBaseState(): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [
      {
        type: 'assistant',
        id: 'asst-1',
        flatIndex: 0,
        text: 'Hello',
        html: '<p>Hello</p>',
        codeBlocks: [],
      },
    ],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

describe('web: patch field updates', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('does not rebuild messages on a health-only patch', () => {
    fireFullState(env.mockSocket, patchBaseState());
    const assistant = env.document.querySelector('.el-assistant') as HTMLElement;
    assert.ok(assistant);
    assistant.setAttribute('data-probe', 'keep');

    firePatch(env.mockSocket, {
      extractorStatus: 'ok',
      lastExtractionAt: Date.now(),
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
    });

    const after = env.document.querySelector('.el-assistant') as HTMLElement;
    assert.equal(after.getAttribute('data-probe'), 'keep');
  });

  it('updates connection UI from a health patch without touching messages', () => {
    fireFullState(env.mockSocket, patchBaseState());
    const assistant = env.document.querySelector('.el-assistant') as HTMLElement;
    assistant.setAttribute('data-probe', 'keep');

    firePatch(env.mockSocket, {
      extractorStatus: 'stale',
      lastExtractionError: 'CDP timeout',
      consecutiveExtractionFailures: 4,
    });

    assert.equal(
      env.document.querySelector('.el-assistant')!.getAttribute('data-probe'),
      'keep'
    );
    const text = env.document.getElementById('connection-text')!;
    assert.match(text.textContent!, /backgrounded|stalled/i);
  });

  it('does not rebuild messages on connection:status', () => {
    fireFullState(env.mockSocket, patchBaseState());
    const assistant = env.document.querySelector('.el-assistant') as HTMLElement;
    assistant.setAttribute('data-probe', 'keep');

    env.mockSocket.fire('connection:status', { connected: false });

    assert.equal(
      env.document.querySelector('.el-assistant')!.getAttribute('data-probe'),
      'keep'
    );
    const text = env.document.getElementById('connection-text')!;
    assert.match(text.textContent!, /Waiting for Cursor/i);
  });

  it('does not rewrite assistant innerHTML when content is unchanged', () => {
    const state = patchBaseState();
    fireFullState(env.mockSocket, state);
    const inner = env.document.querySelector('.assistant-content p') as HTMLElement;
    assert.ok(inner);
    inner.setAttribute('data-probe', 'keep');

    firePatch(env.mockSocket, { messages: state.messages });

    const after = env.document.querySelector('.assistant-content [data-probe]') as HTMLElement;
    assert.ok(after);
    assert.equal(after.getAttribute('data-probe'), 'keep');
  });

  it('rewrites assistant innerHTML when html changes', () => {
    const state = patchBaseState();
    fireFullState(env.mockSocket, state);
    const inner = env.document.querySelector('.assistant-content p') as HTMLElement;
    assert.ok(inner);
    inner.setAttribute('data-probe', 'keep');

    firePatch(env.mockSocket, {
      messages: [
        {
          type: 'assistant',
          id: 'asst-1',
          flatIndex: 0,
          text: 'Hello world',
          html: '<p>Hello world</p>',
          codeBlocks: [],
        },
      ],
    });

    assert.equal(env.document.querySelector('.assistant-content [data-probe]'), null);
    const after = env.document.querySelector('.assistant-content') as HTMLElement;
    assert.match(after.textContent!, /Hello world/);
  });
});

function setDocumentHidden(doc: Document, hidden: boolean) {
  Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(doc, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

function notificationsOf(env: ReturnType<typeof createTestEnv>): MockNotificationRecord[] {
  return (env.window as any).__notifications as MockNotificationRecord[];
}

describe('web: connect_error does not drop a valid token on weak network', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
    env.window.localStorage.setItem('cursor-remote-token', 'deadbeef'.repeat(8));
  });

  it('keeps the token after repeated transport/timeout failures', () => {
    for (let i = 0; i < 8; i++) {
      env.mockSocket.fire('connect_error', { message: i % 2 === 0 ? 'xhr poll error' : 'timeout' });
    }
    assert.equal(env.window.localStorage.getItem('cursor-remote-token'), 'deadbeef'.repeat(8));
  });

  it('clears the token only on Unauthorized', () => {
    try {
      env.mockSocket.fire('connect_error', { message: 'Unauthorized' });
    } catch {
      // JSDOM may throw if location navigation is not stubbed
    }
    assert.equal(env.window.localStorage.getItem('cursor-remote-token'), null);
  });
});

describe('web: New Chat stays reachable with 0–1 tabs', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('keeps the context bar visible with zero tabs', () => {
    const state = patchBaseState();
    state.windows = [{ id: 'w1', title: 'proj', url: 'vscode://window' }];
    state.activeWindowId = 'w1';
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('context-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'context bar should stay visible');
    assert.ok(env.document.getElementById('btn-new-chat'), 'New Chat button should exist');
  });

  it('keeps the context bar visible with a single tab', () => {
    const state = patchBaseState();
    state.windows = [{ id: 'w1', title: 'proj', url: 'vscode://window' }];
    state.activeWindowId = 'w1';
    state.chatTabs = [
      { composerId: 'c1', title: 'Only chat', isActive: true, isOpen: true, status: '', selectorPath: 'sp-1' },
    ];
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('context-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'context bar should stay visible with one tab');
    assert.ok(env.document.getElementById('btn-new-chat'), 'New Chat button should exist');
    assert.match(bar.textContent ?? '', /Only chat/);
  });

  it('shows open sessions first in desktop left-to-right order and styles history separately', () => {
    const state = patchBaseState();
    state.windows = [{ id: 'w1', title: 'proj', url: 'vscode://window' }];
    state.activeWindowId = 'w1';
    state.chatTabs = [
      { composerId: 'h1', title: 'History first from relay', isActive: false, isOpen: false, status: 'idle', selectorPath: 'sp-h1' },
      { composerId: 'o1', title: 'Open left', isActive: false, isOpen: true, status: 'idle', selectorPath: 'sp-o1' },
      { composerId: 'o2', title: 'Open right active', isActive: true, isOpen: true, status: 'active', selectorPath: 'sp-o2' },
      { composerId: 'h2', title: 'History last', isActive: false, isOpen: false, status: 'idle', selectorPath: 'sp-h2' },
    ];
    fireFullState(env.mockSocket, state);

    (env.document.getElementById('context-main') as HTMLButtonElement).click();
    const rows = Array.from(env.document.querySelectorAll<HTMLElement>('.session-row'));
    assert.deepEqual(
      rows.map(row => row.querySelector('.session-title')?.textContent),
      ['Open left', 'Open right active', 'History first from relay', 'History last']
    );
    assert.ok(rows[0].classList.contains('is-open'));
    assert.ok(rows[1].classList.contains('is-active'));
    assert.ok(rows[2].classList.contains('is-closed'));
    assert.equal(rows[1].dataset.sessionActive, 'true');
    assert.match(rows[0].textContent ?? '', /Open/);
    assert.match(rows[2].textContent ?? '', /History/);
  });

  it('keeps the drawer body as the touch-scroll container for long session lists', () => {
    const css = readFileSync(STYLES_PATH, 'utf-8');
    assert.match(css, /\.drawer-body\s*\{[^}]*min-height:\s*0;/s);
    assert.match(css, /\.drawer-body\s*\{[^}]*overflow-y:\s*auto;/s);
    assert.match(css, /\.drawer-body\s*\{[^}]*-webkit-overflow-scrolling:\s*touch;/s);
    assert.match(css, /\.drawer-body\s*\{[^}]*touch-action:\s*pan-y;/s);
  });
});

describe('web: background notifications', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('does not notify when the document is visible even if hasFocus is false', () => {
    setDocumentHidden(env.document, false);
    env.document.hasFocus = () => false;
    const state = patchBaseState();
    state.pendingApprovals = [
      {
        id: 'appr-1',
        description: 'Allow network',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: 'sp-a' },
          { label: 'Reject', type: 'reject', selectorPath: 'sp-r' },
        ],
      },
    ];
    fireFullState(env.mockSocket, state);
    assert.equal(notificationsOf(env).length, 0);
  });

  it('notifies when the document is hidden even if hasFocus is true', () => {
    setDocumentHidden(env.document, true);
    env.document.hasFocus = () => true;
    const state = patchBaseState();
    state.pendingApprovals = [
      {
        id: 'appr-1',
        description: 'Allow network',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: 'sp-a' },
          { label: 'Reject', type: 'reject', selectorPath: 'sp-r' },
        ],
      },
    ];
    fireFullState(env.mockSocket, state);
    const notes = notificationsOf(env);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].tag, 'cursor-approval:appr-1');
  });

  it('does not re-fire the same approval notification on a later patch', () => {
    setDocumentHidden(env.document, true);
    const state = patchBaseState();
    state.pendingApprovals = [
      {
        id: 'appr-1',
        description: 'Allow network',
        actions: [{ label: 'Accept', type: 'approve', selectorPath: 'sp-a' }],
      },
    ];
    fireFullState(env.mockSocket, state);
    firePatch(env.mockSocket, { pendingApprovals: state.pendingApprovals });
    assert.equal(notificationsOf(env).length, 1);
  });
});

describe('web: sanitizeHtml', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function renderAssistantHtml(html: string) {
    const state = patchBaseState();
    state.messages = [
      {
        type: 'assistant',
        id: 'asst-xss',
        flatIndex: 0,
        text: 'payload',
        html,
        codeBlocks: [],
      },
    ];
    fireFullState(env.mockSocket, state);
    return env.document.querySelector('.assistant-content') as HTMLElement;
  }

  it('strips javascript/data URLs, svg, style, and base', () => {
    const el = renderAssistantHtml(
      '<p>safe</p>' +
      '<script>window.__xss=1</script>' +
      '<a href="javascript:alert(1)">js</a>' +
      '<a href="java\tscript:alert(1)">tab</a>' +
      '<a href="javascript&#58;alert(1)">entity</a>' +
      '<a href="data:text/html,alert(1)">datahtml</a>' +
      '<a ping="javascript:alert(1)">ping</a>' +
      '<img src="data:image/svg+xml;utf8,<svg></svg>">' +
      '<img src="data:text/html,alert(1)">' +
      '<svg onload="alert(1)"><script>alert(1)</script></svg>' +
      '<style>body{background:red}</style>' +
      '<base href="https://evil.test/">'
    );
    const html = el.innerHTML;
    assert.match(el.textContent ?? '', /safe/);
    assert.equal(el.querySelector('script'), null);
    assert.equal(el.querySelector('svg'), null);
    assert.equal(el.querySelector('style'), null);
    assert.equal(el.querySelector('base'), null);
    assert.equal((env.window as any).__xss, undefined);
    assert.ok(!/javascript:/i.test(html));
    assert.ok(!/data:text\/html/i.test(html));
    assert.ok(!/data:image\/svg/i.test(html));
    const jsLink = Array.from(el.querySelectorAll('a')).find(a => /javascript:/i.test(a.getAttribute('href') || ''));
    assert.equal(jsLink, undefined);
  });

  it('keeps safe image data URLs and https links', () => {
    const png = 'data:image/png;base64,AAAA';
    const el = renderAssistantHtml(
      `<p><a href="https://example.com/docs">docs</a></p><img src="${png}" alt="ok">`
    );
    const a = el.querySelector('a')!;
    assert.equal(a.getAttribute('href'), 'https://example.com/docs');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
    assert.equal(el.querySelector('img')!.getAttribute('src'), png);
  });
});

function themeColorOf(env: ReturnType<typeof createTestEnv>): string | null {
  return env.document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;
}

function extractCssVars(css: string, marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing CSS marker: ${marker}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = css.slice(open + 1, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[`--${match[1]}`] = match[2].trim();
  }
  return out;
}

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: [number, number, number]): number {
  return 0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2]);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssColor(value: string): { rgb: [number, number, number]; a: number } | null {
  const raw = value.trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      a: 1,
    };
  }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  return null;
}

function compositeOn(fg: { rgb: [number, number, number]; a: number }, bg: [number, number, number]): [number, number, number] {
  const a = Math.max(0, Math.min(1, fg.a));
  return [
    fg.rgb[0] * a + bg[0] * (1 - a),
    fg.rgb[1] * a + bg[1] * (1 - a),
    fg.rgb[2] * a + bg[2] * (1 - a),
  ];
}

function solidColor(tokens: Record<string, string>, name: string, fallbackBg?: [number, number, number]): [number, number, number] {
  const parsed = parseCssColor(tokens[name]);
  assert.ok(parsed, `unparsable token ${name}: ${tokens[name]}`);
  if (parsed.a >= 0.999) return parsed.rgb;
  const bg = fallbackBg ?? [255, 255, 255];
  return compositeOn(parsed, bg);
}

describe('web: color theme', () => {
  it('defaults to system and light theme-color when the OS is light', () => {
    const env = createTestEnv({ prefersDark: false });
    assert.equal(env.document.documentElement.dataset.theme, 'system');
    assert.equal((env.document.getElementById('theme-select') as HTMLSelectElement).value, 'system');
    assert.equal(themeColorOf(env), '#f7f8fa');
  });

  it('restores a saved light preference before app bootstrap finishes', () => {
    const env = createTestEnv({ storage: { 'cursor-remote-theme': 'light' }, prefersDark: true });
    assert.equal(env.document.documentElement.dataset.theme, 'light');
    assert.equal((env.document.getElementById('theme-select') as HTMLSelectElement).value, 'light');
    assert.equal(themeColorOf(env), '#f7f8fa');
  });

  it('restores a saved dark preference', () => {
    const env = createTestEnv({ storage: { 'cursor-remote-theme': 'dark' }, prefersDark: false });
    assert.equal(env.document.documentElement.dataset.theme, 'dark');
    assert.equal((env.document.getElementById('theme-select') as HTMLSelectElement).value, 'dark');
    assert.equal(themeColorOf(env), '#141414');
  });

  it('falls back to system for an invalid stored value', () => {
    const env = createTestEnv({ storage: { 'cursor-remote-theme': 'neon' }, prefersDark: false });
    assert.equal(env.document.documentElement.dataset.theme, 'system');
    assert.equal((env.document.getElementById('theme-select') as HTMLSelectElement).value, 'system');
  });

  it('persists each of the three choices from the theme control', () => {
    const env = createTestEnv();
    const select = env.document.getElementById('theme-select') as HTMLSelectElement;
    for (const value of ['light', 'dark', 'system'] as const) {
      select.value = value;
      select.dispatchEvent(new env.window.Event('change'));
      assert.equal(env.window.localStorage.getItem('cursor-remote-theme'), value);
      assert.equal(env.document.documentElement.dataset.theme, value);
    }
  });

  it('updates theme-color when prefers-color-scheme changes in system mode', () => {
    const env = createTestEnv({ prefersDark: false });
    assert.equal(env.document.documentElement.dataset.theme, 'system');
    assert.equal(themeColorOf(env), '#f7f8fa');
    (env.window as any).__setPrefersDark(true);
    assert.equal(env.document.documentElement.dataset.theme, 'system');
    assert.equal(themeColorOf(env), '#141414');
    (env.window as any).__setPrefersDark(false);
    assert.equal(themeColorOf(env), '#f7f8fa');
  });

  it('does not follow system changes when the user picked light', () => {
    const env = createTestEnv({ storage: { 'cursor-remote-theme': 'light' }, prefersDark: false });
    (env.window as any).__setPrefersDark(true);
    assert.equal(env.document.documentElement.dataset.theme, 'light');
    assert.equal(themeColorOf(env), '#f7f8fa');
  });

  it('keeps approval and toast status colors tokenized so they follow the theme', () => {
    const css = readFileSync(STYLES_PATH, 'utf-8');
    assert.match(css, /\.btn-approve\s*\{[^}]*background:\s*var\(--accent-green\)/s);
    assert.match(css, /\.btn-reject\s*\{[^}]*background:\s*var\(--accent-red\)/s);
    assert.match(css, /\.toast\.error\s*\{[^}]*var\(--accent-red\)/s);
    assert.match(css, /\.toast\.success\s*\{[^}]*var\(--accent-green\)/s);
    assert.match(css, /:root\[data-theme='dark'\]/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /:root\[data-theme='system'\]/);
  });

  it('keeps status, approval, and notification colors readable in light and dark tokens', () => {
    const css = readFileSync(STYLES_PATH, 'utf-8');
    const light = extractCssVars(css, ':root {');
    const dark = extractCssVars(css, ":root[data-theme='dark'] {");

    for (const [label, tokens] of [['light', light], ['dark', dark]] as const) {
      const bg = solidColor(tokens, '--bg-primary', label === 'dark' ? [24, 24, 24] : [247, 248, 250]);
      const surface = solidColor(tokens, '--bg-secondary', bg);
      const pairs: Array<[string, string, number]> = [
        ['--text-primary', '--bg-primary', 4.5],
        ['--accent-red', '--bg-primary', 4.5],
        ['--accent-green', '--bg-primary', 4.5],
        ['--accent-yellow', '--bg-primary', 4.5],
        ['--accent-red', '--bg-secondary', 4.5],
        ['--accent-green', '--bg-secondary', 4.5],
        ['--on-accent', '--accent-green', 3],
        ['--on-accent', '--accent-red', 3],
      ];
      for (const [fgName, bgName, min] of pairs) {
        const bgRgb = bgName === '--bg-primary' ? bg : bgName === '--bg-secondary' ? surface : solidColor(tokens, bgName, bg);
        const fgRgb = solidColor(tokens, fgName, bgRgb);
        const ratio = contrastRatio(fgRgb, bgRgb);
        assert.ok(
          ratio + 1e-6 >= min,
          `${label} ${fgName} on ${bgName} contrast ${ratio.toFixed(2)} < ${min}`
        );
      }
    }
  });

  it('applies the saved theme on the login page markup', () => {
    const relay = readFileSync(RELAY_PATH, 'utf-8');
    assert.match(relay, /cursor-remote-theme/);
    assert.match(relay, /href="styles\.css"/);
    assert.match(relay, /data-theme="system"/);
    assert.match(relay, /class="login-page"/);
    assert.doesNotMatch(relay, /background: #181818/);
  });
});

const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function lastCommandPayload(mock: MockSocket, event: string): Record<string, unknown> {
  const found = mock.emitted.filter((item) => item.event === event);
  assert.ok(found.length > 0, `expected at least one ${event} emit`);
  return found[found.length - 1].args[0] as Record<string, unknown>;
}

function commandEmits(mock: MockSocket, event?: string) {
  return mock.emitted.filter((item) => (
    event ? item.event === event : String(item.event).startsWith('command:')
  ));
}

function assertBoundedUniqueOperation(payload: Record<string, unknown>, seen?: Set<string>) {
  assert.equal(typeof payload.commandId, 'string');
  assert.ok((payload.commandId as string).length > 0, 'commandId is required for correlation');
  assert.equal(typeof payload.operationId, 'string');
  assert.match(payload.operationId as string, OPERATION_ID_RE);
  assert.notEqual(payload.commandId, payload.operationId);
  if (seen) {
    assert.equal(seen.has(payload.operationId as string), false, 'operationId must be unique');
    seen.add(payload.operationId as string);
  }
}

function assertClickActionPayload(
  payload: Record<string, unknown>,
  expected: { actionId: string; actionType: string; dangerous?: boolean },
) {
  assert.equal(payload.actionId, expected.actionId);
  assert.equal(payload.actionType, expected.actionType);
  assert.equal('selectorPath' in payload, false);
  assert.equal(payload.selectorPath, undefined);
  if (expected.dangerous) {
    assertBoundedUniqueOperation(payload);
  } else {
    assert.equal(payload.operationId, undefined);
    assert.equal(typeof payload.commandId, 'string');
  }
}

describe('web: relay command protocol', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function fireState(overrides: Partial<CursorState> = {}) {
    fireFullState(env.mockSocket, { ...patchBaseState(), ...overrides });
  }

  function capabilitySnapshot() {
    return {
      targetId: 'target-1234567890',
      targetGeneration: 4,
      revision: 8,
      status: { state: 'ok', completeness: 'complete' },
      modes: [
        { id: 'agent', label: 'Agent', current: true, selectable: true },
        { id: 'plan', label: 'Plan', current: false, selectable: true },
      ],
      models: {
        completeness: 'complete',
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', selectable: true }],
      },
      tools: [],
    };
  }

  function enableModeModel() {
    env.mockSocket.fire('capabilities:full', {
      activeTargetId: 'target-1234567890',
      snapshots: [capabilitySnapshot()],
    });
  }

  function sendComposerText(text: string) {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    input.value = text;
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    (env.document.getElementById('btn-send') as HTMLButtonElement).click();
  }

  it('sends a bounded unique operationId on send_message and new_chat while keeping commandId', () => {
    fireState({ inputAvailable: true });
    const seen = new Set<string>();
    sendComposerText('hello from phone');
    sendComposerText('second message');
    const sends = commandEmits(env.mockSocket, 'command:send_message');
    assert.equal(sends.length, 2);
    for (const item of sends) {
      const payload = item.args[0] as Record<string, unknown>;
      assertBoundedUniqueOperation(payload, seen);
      assert.equal(typeof payload.text, 'string');
    }

    (env.document.getElementById('btn-new-chat') as HTMLButtonElement).click();
    const created = lastCommandPayload(env.mockSocket, 'command:new_chat');
    assertBoundedUniqueOperation(created, seen);
  });

  it('preserves approve vs approve_all and never sends selectorPath', () => {
    fireState({
      pendingApprovals: [{
        id: 'appr-1',
        description: 'Allow network',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: 'secret-approve', actionId: 'act_approve' },
          { label: 'Reject', type: 'reject', selectorPath: 'secret-reject', actionId: 'act_reject' },
        ],
      }],
    });
    (env.document.getElementById('btn-approve') as HTMLButtonElement).click();
    const approve = lastCommandPayload(env.mockSocket, 'command:approve');
    assert.equal(approve.actionId, 'act_approve');
    assertBoundedUniqueOperation(approve);
    assert.equal('selectorPath' in approve, false);
    assert.equal(commandEmits(env.mockSocket, 'command:approve_all').length, 0);

    fireState({
      pendingApprovals: [{
        id: 'appr-all',
        description: 'Accept all edits',
        actions: [
          { label: 'Accept All', type: 'approve_all', selectorPath: 'secret-all', actionId: 'act_all' },
        ],
      }],
    });
    env.mockSocket.emitted.length = 0;
    (env.document.getElementById('btn-approve') as HTMLButtonElement).click();
    const approveAll = lastCommandPayload(env.mockSocket, 'command:approve_all');
    assert.equal(approveAll.actionId, 'act_all');
    assertBoundedUniqueOperation(approveAll);
    assert.equal('selectorPath' in approveAll, false);
    assert.equal(commandEmits(env.mockSocket, 'command:approve').length, 0);
  });

  it('emits click_action with exact run/skip/allow types and no selectorPath', () => {
    fireState({
      messages: [{
        type: 'tool',
        id: 'fetch1',
        flatIndex: 0,
        toolCallId: 'tc-fetch',
        status: 'loading',
        action: 'Fetch',
        details: 'https://example.com',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'secret-skip', actionId: 'act_skip' },
          { label: 'Allowlist example.com', type: 'allow', selectorPath: 'secret-allow', actionId: 'act_allow' },
          { label: 'Run', type: 'run', selectorPath: 'secret-run', actionId: 'act_run' },
        ],
      }],
    });
    const buttons = [...env.document.querySelectorAll('.run-btn')] as HTMLButtonElement[];
    assert.equal(buttons.length, 3);
    assert.equal(buttons.every((btn) => !btn.disabled), true);

    buttons.find((btn) => btn.textContent === 'Skip')!.click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_skip', actionType: 'skip',
    });

    buttons.find((btn) => btn.textContent === 'Allowlist example.com')!.click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_allow', actionType: 'allow', dangerous: true,
    });

    buttons.find((btn) => btn.textContent === 'Run')!.click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_run', actionType: 'run', dangerous: true,
    });
  });

  it('does not emit click_action without an opaque actionId', () => {
    fireState({
      messages: [{
        type: 'run_command',
        id: 'rc1',
        flatIndex: 0,
        toolCallId: 'tc-run',
        description: 'Run outside sandbox',
        candidates: '',
        command: 'npm test',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'secret-skip' },
          { label: 'Run', type: 'run', selectorPath: 'secret-run' },
        ],
      }],
    });
    const buttons = [...env.document.querySelectorAll('.run-btn')] as HTMLButtonElement[];
    assert.equal(buttons.length, 2);
    assert.equal(buttons.every((btn) => btn.disabled), true);
    for (const btn of buttons) btn.click();
    assert.equal(commandEmits(env.mockSocket, 'command:click_action').length, 0);

    fireState({
      pendingApprovals: [{
        id: 'appr-bare',
        description: 'Needs approval',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: 'secret-approve' },
          { label: 'Reject', type: 'reject', selectorPath: 'secret-reject' },
        ],
      }],
    });
    env.mockSocket.emitted.length = 0;
    const approveBtn = env.document.getElementById('btn-approve') as HTMLButtonElement;
    const rejectBtn = env.document.getElementById('btn-reject') as HTMLButtonElement;
    assert.equal(approveBtn.disabled, true);
    assert.equal(rejectBtn.disabled, true);
    approveBtn.click();
    rejectBtn.click();
    assert.equal(commandEmits(env.mockSocket).length, 0);
  });

  it('emits exact build/continue/questionnaire_option types and disables unauthorized options', () => {
    fireState({
      messages: [{
        type: 'plan',
        id: 'plan1',
        flatIndex: 0,
        label: 'Auth System',
        title: 'Auth System',
        todosCompleted: 0,
        todosTotal: 1,
        todos: [{ text: 'Add login', status: 'pending' }],
        model: 'Auto',
        modelActionId: 'act_plan_model',
        actions: [
          { label: 'View Plan', type: 'view_plan', selectorPath: 'secret-view' },
          { label: 'Build', type: 'build', selectorPath: 'secret-build', actionId: 'act_build' },
        ],
      }],
      questionnaire: {
        questions: [
          {
            number: '1.',
            text: 'Pick a color?',
            isActive: true,
            options: [
              { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'secret-red', actionId: 'act_opt_a' },
              { letter: 'B', label: 'Blue', isFreeform: false, selectorPath: 'secret-blue' },
            ],
          },
        ],
        activeIndex: 0,
        totalLabel: '1 of 1',
        skipSelectorPath: 'secret-q-skip',
        skipActionId: 'act_q_skip',
        continueSelectorPath: 'secret-q-continue',
        continueActionId: 'act_q_continue',
        continueDisabled: false,
      },
    });

    const buildBtn = env.document.querySelector('.plan-btn-build') as HTMLButtonElement;
    assert.ok(buildBtn);
    assert.equal(buildBtn.disabled, false);
    buildBtn.click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_build', actionType: 'build', dangerous: true,
    });

    const optionButtons = [...env.document.querySelectorAll('.questionnaire-option')] as HTMLButtonElement[];
    assert.equal(optionButtons.length, 2);
    assert.equal(optionButtons[0].disabled, false);
    assert.equal(optionButtons[1].disabled, true);
    env.mockSocket.emitted.length = 0;
    optionButtons[1].click();
    assert.equal(commandEmits(env.mockSocket, 'command:click_action').length, 0);
    optionButtons[0].click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_opt_a', actionType: 'questionnaire_option',
    });

    env.mockSocket.emitted.length = 0;
    (env.document.getElementById('btn-q-skip') as HTMLButtonElement).click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_q_skip', actionType: 'skip',
    });

    env.mockSocket.emitted.length = 0;
    (env.document.getElementById('btn-q-continue') as HTMLButtonElement).click();
    assertClickActionPayload(lastCommandPayload(env.mockSocket, 'command:click_action'), {
      actionId: 'act_q_continue', actionType: 'continue', dangerous: true,
    });
  });

  it('sends set_mode and set_model with modeId/modelId plus operationId', async () => {
    fireState();
    enableModeModel();

    (env.document.getElementById('pill-mode') as HTMLButtonElement).click();
    const planRow = [...env.document.querySelectorAll('#sheet-mode-list .sheet-item')].find(
      (row) => row.textContent?.includes('Plan')
    ) as HTMLButtonElement;
    assert.ok(planRow);
    planRow.click();
    const modePayload = lastCommandPayload(env.mockSocket, 'command:set_mode');
    assert.equal(modePayload.modeId, 'plan');
    assertBoundedUniqueOperation(modePayload);

    (env.document.getElementById('pill-model') as HTMLButtonElement).click();
    const getOpts = lastCommandPayload(env.mockSocket, 'command:get_model_options');
    assert.equal(typeof getOpts.commandId, 'string');
    env.mockSocket.fire('command:result', {
      commandId: getOpts.commandId,
      ok: true,
      data: { options: [{ id: 'gpt-5', label: 'GPT-5', selected: false }] },
    });
    await Promise.resolve();
    await Promise.resolve();
    const modelRow = [...env.document.querySelectorAll('#sheet-model-list .sheet-item')].find(
      (row) => row.textContent?.includes('GPT-5')
    ) as HTMLButtonElement;
    assert.ok(modelRow);
    modelRow.click();
    const modelPayload = lastCommandPayload(env.mockSocket, 'command:set_model');
    assert.equal(modelPayload.modelId, 'gpt-5');
    assertBoundedUniqueOperation(modelPayload);
  });

  it('loads and sets plan model via actionId without selectorPath', async () => {
    fireState({
      messages: [{
        type: 'plan',
        id: 'plan1',
        flatIndex: 0,
        label: 'Auth System',
        title: 'Auth System',
        todosCompleted: 0,
        todosTotal: 0,
        model: 'Auto',
        modelActionId: 'act_plan_model',
        actions: [{ label: 'Build', type: 'build', selectorPath: 'secret-build', actionId: 'act_build' }],
      }],
    });
    const pill = env.document.querySelector('.plan-model-pill') as HTMLButtonElement;
    assert.ok(pill, 'plan model pill must appear from modelActionId alone');
    pill.click();
    await Promise.resolve();
    const getOpts = lastCommandPayload(env.mockSocket, 'command:get_plan_model_options');
    assert.equal(getOpts.actionId, 'act_plan_model');
    assert.equal('selectorPath' in getOpts, false);
    env.mockSocket.fire('command:result', {
      commandId: getOpts.commandId,
      ok: true,
      data: { options: [{ id: 'plan-opus', label: 'Opus', selected: false }] },
    });
    await Promise.resolve();
    await Promise.resolve();
    const option = [...env.document.querySelectorAll('#sheet-plan-model-list .sheet-item')].find(
      (row) => row.textContent?.includes('Opus')
    ) as HTMLButtonElement;
    assert.ok(option);
    option.click();
    await Promise.resolve();
    const setPayload = lastCommandPayload(env.mockSocket, 'command:set_plan_model');
    assert.equal(setPayload.actionId, 'act_plan_model');
    assert.equal(setPayload.planModelId, 'plan-opus');
    assert.equal('selectorPath' in setPayload, false);
    assertBoundedUniqueOperation(setPayload);
  });

  it('disables plan Build when actionId is missing', () => {
    fireState({
      messages: [{
        type: 'plan',
        id: 'plan1',
        flatIndex: 0,
        label: 'Auth System',
        title: 'Auth System',
        todosCompleted: 0,
        todosTotal: 0,
        actions: [{ label: 'Build', type: 'build', selectorPath: 'secret-build' }],
      }],
    });
    const buildBtn = env.document.querySelector('.plan-btn-build') as HTMLButtonElement;
    assert.ok(buildBtn);
    assert.equal(buildBtn.disabled, true);
    buildBtn.click();
    assert.equal(commandEmits(env.mockSocket, 'command:click_action').length, 0);
  });
});
