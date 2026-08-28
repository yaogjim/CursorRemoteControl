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
        on(event: string, fn: EventHandler) {
          this.handlers.set(event, fn);
        },
        emit() { /* noop for tests */ },
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
    assert.ok(
      dot.classList.contains('stale') || dot.classList.contains('reconnecting'),
      `Expected stale/reconnecting class, got: ${dot.className}`
    );
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

  it('renders mode and model from state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const modeText = env.document.getElementById('pill-mode-text')!;
    const modelText = env.document.getElementById('pill-model-text')!;
    assert.ok(modeText.textContent!.length > 0, 'Mode text should be set');
    assert.ok(modelText.textContent!.length > 0, 'Model text should be set');
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
      { composerId: 'c1', title: 'Only chat', isActive: true, status: '', selectorPath: 'sp-1' },
    ];
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('context-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'context bar should stay visible with one tab');
    assert.ok(env.document.getElementById('btn-new-chat'), 'New Chat button should exist');
    assert.match(bar.textContent ?? '', /Only chat/);
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
