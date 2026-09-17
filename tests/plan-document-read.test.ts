import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { CommandExecutor } from '../src/server/command-executor.js';
import { TargetUiCoordinator } from '../src/server/target-ui-coordinator.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

// Real selectors.json entries for the non-message editor elements. A missing
// key fails loudly instead of falling back to a hardcoded selector.
const PLAN_SELECTORS: SelectorConfig = {
  chatContainer: { strategies: [] },
  approveButton: { strategies: [] },
  rejectButton: { strategies: [] },
  chatInput: { strategies: [] },
  agentStatus: { strategies: [] },
  planDocumentTab: { strategies: [".tabs-container [role='tab'][data-resource-name]"] },
  planDocumentBreadcrumbIcon: { strategies: [".breadcrumbs-control .plan-file-icon[aria-label]"] },
  planDocumentEditor: { strategies: ['.plan-editor__richtext'] },
  planDocumentEditorGroup: { strategies: ['.editor-group-container'] },
  composerMessagesScroll: { strategies: ['.virtualized-composer-messages-scroll-container'] },
};

const PLANS_PREFIX = '~/.cursor/plans/';
const PLAN_FILE = '工作区_agent_托管方案_e00f35aa.plan.md';
const OTHER_PLAN_FILE = '工作区_agent_托管方案_bbbbbbbb.plan.md';
const HOME_PLANS_DIR = resolve(homedir(), '.cursor', 'plans');
const HOME_PLAN_URI = `file://${HOME_PLANS_DIR}/${PLAN_FILE}`;
const HOME_OTHER_PLAN_URI = `file://${HOME_PLANS_DIR}/${OTHER_PLAN_FILE}`;
const BASELINE_TAB = 'index.ts';
const OTHER_TAB = 'other.ts';
const PLAN_BODY = 'PLAN_BODY_SHOULD_NOT_LEAK';
const FILE_WORKSPACE_ID = '265d56b2c491736926ee6e06eeffd5de';
const FILE_WORKSPACE_PATH = '/Users/yaogj/works/ccspace/cursorremote';
const FILE_WORKSPACE_PLANS = `${FILE_WORKSPACE_PATH}/.cursor/plans`;
const FILE_WORKSPACE = {
  id: FILE_WORKSPACE_ID,
  uri: { scheme: 'file', authority: '', path: FILE_WORKSPACE_PATH },
};

function installWorkspace(dom: JSDOM, workspace: unknown) {
  (dom.window as unknown as { vscode: unknown }).vscode = {
    context: { configuration: () => ({ workspace }) },
  };
}

/**
 * jsdom defines `isTrusted` as a non-configurable own accessor on every event,
 * so it cannot be redefined. This wraps `document.addEventListener` for the
 * event types the page-side watch subscribes to and hands that listener the
 * real event with only `isTrusted` reporting true while the gate is open.
 * Everything else (including this program's own clicks and MouseEvents) keeps
 * jsdom's untrusted value. This tests the filter, not real desktop input.
 */
function trustedInputGate(dom: JSDOM) {
  const doc = dom.window.document;
  const watched = new Set(['pointerdown', 'mousedown', 'keydown', 'wheel']);
  const wrappers = new Map<string, Map<EventListenerOrEventListenerObject, EventListener>>();
  const originalAdd = doc.addEventListener.bind(doc);
  const originalRemove = doc.removeEventListener.bind(doc);
  let open = false;

  doc.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (watched.has(type) && typeof listener === 'function') {
      let byListener = wrappers.get(type);
      if (!byListener) {
        byListener = new Map();
        wrappers.set(type, byListener);
      }
      const wrapped: EventListener = (event) => {
        if (!open) {
          (listener as EventListener).call(doc, event);
          return;
        }
        // jsdom brand-checks events, so a hand-made copy is rejected by its own
        // `type` getter. A proxy keeps the real event's identity and reports only
        // `isTrusted` as true, which is what a desktop click looks like to the
        // page-side filter.
        const shaped = new Proxy(event, {
          get: (target, prop) => (prop === 'isTrusted' ? true : Reflect.get(target, prop)),
        });
        (listener as EventListener).call(doc, shaped as Event);
      };
      byListener.set(listener, wrapped);
      originalAdd(type, wrapped, options as AddEventListenerOptions);
      return;
    }
    originalAdd(type, listener as EventListener, options as AddEventListenerOptions);
  }) as unknown as typeof doc.addEventListener;

  doc.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    const wrapped = wrappers.get(type)?.get(listener);
    if (wrapped) {
      wrappers.get(type)?.delete(listener);
      originalRemove(type, wrapped, options as EventListenerOptions);
      return;
    }
    originalRemove(type, listener as EventListener, options as EventListenerOptions);
  }) as unknown as typeof doc.removeEventListener;

  return {
    emit(type: string) {
      open = true;
      try {
        doc.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
      } finally {
        open = false;
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function visibleRect() {
    return { width: 200, height: 40, top: 0, left: 0, bottom: 40, right: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  return dom;
}

function editorGroupHtml(): string {
  return `
    <div class="editor-group-container">
      <div class="tabs-container">
        <div role="tab" data-resource-name="${BASELINE_TAB}" aria-selected="true" id="tab-baseline">${BASELINE_TAB}</div>
        <div role="tab" data-resource-name="${OTHER_TAB}" aria-selected="false" id="tab-other">${OTHER_TAB}</div>
      </div>
      <div class="breadcrumbs-control"></div>
      <div class="editor-body"></div>
    </div>
  `;
}

function composerHtml(composerId: string, messagesHtml: string, draft = ''): string {
  return `
    <section data-composer-id="${composerId}">
      <div class="virtualized-composer-messages-scroll-container">
        <div class="messages">${messagesHtml}</div>
      </div>
      <div contenteditable="true" class="draft">${draft}</div>
    </section>
  `;
}

function planCardHtml(toolCallId: string, viewPlanButton = '<button id="view-plan">View Plan</button>'): string {
  return `
    <div data-message-role="ai" data-message-kind="tool" data-message-id="ac3" data-tool-call-id="${toolCallId}">
      <div class="ui-tool-call-card" data-tool-call-card-marker="root">
        <span data-testid="composer-plan-filename">${PLAN_FILE}</span>
        <div class="markdown-root">plan summary only</div>
        ${viewPlanButton}
        <button id="build">Build</button>
      </div>
    </div>
  `;
}

function installCreatePlanFiber(dom: JSDOM, opts: {
  planUri?: string;
  bubbleId?: string;
  vmCallId?: string;
  vmCase?: string;
  tfdName?: string;
  tfdCallId?: string;
} = {}) {
  const card = dom.window.document.querySelector('.ui-tool-call-card') as HTMLElement;
  const host = card.closest('[data-tool-call-id]') as HTMLElement;
  const messageId = host.getAttribute('data-message-id') || '';
  const toolCallId = host.getAttribute('data-tool-call-id') || '';
  const planUri = opts.planUri ?? '';
  const handle = {
    data: {
      conversationMap: {
        [messageId]: {
          toolFormerData: {
            name: opts.tfdName ?? 'create_plan',
            toolCallId: opts.tfdCallId ?? toolCallId,
            additionalData: { planUri },
          },
        },
      },
    },
  };
  const fiber = {
    memoizedProps: {},
    return: {
      memoizedProps: {},
      return: {
        memoizedProps: {
          bubbleId: opts.bubbleId ?? messageId,
          composerDataHandle: handle,
          vm: {
            callId: opts.vmCallId ?? toolCallId,
            case: opts.vmCase ?? 'createPlanToolCall',
          },
        },
        return: null,
      },
    },
  };
  Object.defineProperty(card, '__reactFiber$test', {
    value: fiber,
    enumerable: true,
    configurable: true,
  });
}

interface WiringOptions {
  planFileName?: string;
  breadcrumbPath?: string;
  revealDelayMs?: number;
  reveal?: 'sync' | 'async' | 'never';
}

function planWiring(dom: JSDOM, options: WiringOptions = {}) {
  const doc = dom.window.document;
  const baselineTab = doc.getElementById('tab-baseline') as HTMLElement;
  const otherTab = doc.getElementById('tab-other') as HTMLElement;
  const group = doc.querySelector('.editor-group-container') as HTMLElement;
  const tabsContainer = group.querySelector('.tabs-container') as HTMLElement;
  const fileName = options.planFileName ?? PLAN_FILE;
  const breadcrumbPath = options.breadcrumbPath ?? `${PLANS_PREFIX}${fileName}`;
  let clicks = 0;
  let buildClicks = 0;
  let planTab: HTMLElement | null = null;
  const tabs = [baselineTab, otherTab];

  const select = (target: HTMLElement) => {
    for (const tab of tabs) tab.setAttribute('aria-selected', tab === target ? 'true' : 'false');
    if (planTab) planTab.setAttribute('aria-selected', planTab === target ? 'true' : 'false');
  };
  for (const tab of tabs) tab.addEventListener('mousedown', () => select(tab));

  const reveal = () => {
    planTab = doc.createElement('div');
    planTab.setAttribute('role', 'tab');
    planTab.setAttribute('data-resource-name', fileName);
    planTab.setAttribute('aria-selected', 'false');
    planTab.addEventListener('mousedown', () => select(planTab as HTMLElement));
    tabsContainer.appendChild(planTab);
    (group.querySelector('.breadcrumbs-control') as HTMLElement).innerHTML =
      `<span class="plan-file-icon" aria-label="${breadcrumbPath}"></span>`;
    const editor = doc.createElement('div');
    editor.className = 'plan-editor__richtext';
    editor.setAttribute('data-streaming', 'false');
    editor.textContent = PLAN_BODY;
    (group.querySelector('.editor-body') as HTMLElement).appendChild(editor);
    select(planTab);
  };

  const wireCard = () => {
    const viewPlan = doc.getElementById('view-plan');
    if (viewPlan && !viewPlan.hasAttribute('data-wired')) {
      viewPlan.setAttribute('data-wired', 'true');
      viewPlan.addEventListener('click', () => {
        clicks += 1;
        if (options.reveal === 'never') return;
        if (options.reveal === 'sync') { reveal(); return; }
        dom.window.setTimeout(reveal, options.revealDelayMs ?? 30);
      });
    }
    const build = doc.getElementById('build');
    if (build && !build.hasAttribute('data-wired')) {
      build.setAttribute('data-wired', 'true');
      build.addEventListener('click', () => { buildClicks += 1; });
    }
  };
  wireCard();

  return {
    clicks: () => clicks,
    buildClicks: () => buildClicks,
    wireCard,
    reveal,
    selectOther: () => select(otherTab),
    selectBaseline: () => select(baselineTab),
    setDraft: (text: string) => {
      (doc.querySelector('.draft') as HTMLElement).textContent = text;
    },
    // A different, self-consistent plan document: its tab name and breadcrumb
    // path agree with each other, so only the interaction watch can catch it.
    switchToOtherPlan: () => {
      if (!planTab) return;
      planTab.setAttribute('data-resource-name', OTHER_PLAN_FILE);
      (group.querySelector('.breadcrumbs-control') as HTMLElement).innerHTML =
        `<span class="plan-file-icon" aria-label="${PLANS_PREFIX}${OTHER_PLAN_FILE}"></span>`;
    },
  };
}

interface ExecutorOptions {
  onReadOk?: () => void;
  onEvaluate?: (expression: string, index: number) => void;
  generation?: () => number;
  isCurrent?: () => boolean;
  withCoordinator?: boolean;
}

function makeExecutor(dom: JSDOM, options: ExecutorOptions = {}) {
  const calls: string[] = [];
  const client = {
    isConnected: () => true,
    click: async () => { throw new Error('unexpected raw click'); },
    evaluate: async (expression: string) => {
      const index = calls.length;
      calls.push(expression);
      options.onEvaluate?.(expression, index);
      const value = await Promise.resolve(dom.window.eval(expression) as unknown);
      if (expression.includes('planStepReadOpen(') && value && (value as { status?: string }).status === 'ok') {
        options.onReadOk?.();
      }
      return value;
    },
  } as unknown as CdpClient;
  const executor = new CommandExecutor(PLAN_SELECTORS);
  executor.setClient(client);
  const coordinator = new TargetUiCoordinator();
  coordinator.setGeneration('target-a', 3);
  if (options.withCoordinator !== false) {
    executor.setUiCoordinator(coordinator, () => 'target-a', options.generation ?? (() => 3));
  }
  return { executor, coordinator, client, calls, isCurrent: options.isCurrent ?? (() => true) };
}

function expected(composerId = 'composer-a', toolCallId = 'tc_1') {
  return { windowId: 'target-a', composerId, planId: 'ac3', toolCallId };
}

function selectedTabName(dom: JSDOM): string | null {
  const element = dom.window.document.querySelector(".tabs-container [role='tab'][aria-selected='true']");
  return element ? element.getAttribute('data-resource-name') : null;
}

/**
 * A virtualized composer transcript: writing `scrollTop` renders whatever
 * screen that offset holds. Records how many writes happened so a test can see
 * whether the original position was put back.
 */
function virtualizedScroll(dom: JSDOM, initialTop: number, viewport: number, onWrite?: (value: number) => void) {
  const host = dom.window.document.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
  const state = { top: initialTop, writes: 0 };
  Object.defineProperty(host, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = value;
      state.writes += 1;
      onWrite?.(value);
    },
  });
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => viewport });
  Object.defineProperty(host, 'scrollHeight', { configurable: true, get: () => 5000 });
  return state;
}

function discoverScope(composerId = 'composer-a') {
  return { windowId: 'target-a', composerId };
}

describe('CommandExecutor.resolvePlanFile', () => {
  it('opens the plan once, reads the breadcrumb path asynchronously, and restores the tab', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor, calls, isCurrent } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-ok', expected(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string; observedAt: number };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal(typeof data.observedAt, 'number');
    assert.equal(wiring.clicks(), 1, 'View Plan must be clicked exactly once');
    assert.equal(wiring.buildClicks(), 0, 'Build must never be clicked');
    const readCalls = calls.filter((entry) => entry.includes('planStepReadOpen(')).length;
    assert.ok(readCalls >= 2, `read-back must poll the live DOM, saw ${readCalls} reads`);
    assert.ok(calls.every((entry) => !entry.includes('scrollIntoView')), 'no unrecorded scroll');
    assert.equal(selectedTabName(dom), BASELINE_TAB, 'the original editor tab must be restored');
    assert.ok(!JSON.stringify(result.data).includes(PLAN_BODY));
    assert.ok(!JSON.stringify(result.data).includes('~/.cursor/plans'));
    dom.window.close();
  });

  it('reads a direct home-plans file URI from the card fiber without clicking View Plan', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    installCreatePlanFiber(dom, { planUri: HOME_PLAN_URI });
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-direct-uri', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string; plansRoot?: string; observedAt: number };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal(typeof data.observedAt, 'number');
    assert.equal('plansRoot' in data, false);
    assert.equal(wiring.clicks(), 0, 'View Plan must not be clicked when the direct URI is trusted');
    assert.equal(wiring.buildClicks(), 0);
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    assert.equal(calls.some((entry) => entry.includes('planStepReadDirectUri(')), true);
    assert.equal(calls.some((entry) => entry.includes('planStepClickViewPlan(')), false);
    const serialized = JSON.stringify(result.data);
    assert.ok(!serialized.includes(HOME_PLANS_DIR));
    assert.ok(!serialized.includes('file:'));
    assert.ok(!serialized.includes(PLAN_BODY));
    dom.window.close();
  });

  it('falls back to View Plan when a direct URI is outside the allowed roots', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    installCreatePlanFiber(dom, { planUri: 'file:///etc/outside.plan.md' });
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-direct-unsafe-fallback', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal(wiring.clicks(), 1, 'an unusable direct URI must keep the existing click fallback');
    assert.equal(calls.some((entry) => entry.includes('planStepClickViewPlan(')), true);
    assert.ok(!JSON.stringify(result.data).includes('/etc/'));
    dom.window.close();
  });

  it('ignores a fiber URI whose tool identity does not match and keeps the click flow', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    installCreatePlanFiber(dom, { planUri: HOME_OTHER_PLAN_URI, vmCallId: 'tc_other' });
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-direct-mismatch', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal(wiring.clicks(), 1, 'identity mismatch must not consume the fiber URI');
    assert.ok(!JSON.stringify(result.data).includes(HOME_PLANS_DIR));
    assert.ok(!JSON.stringify(result.data).includes(OTHER_PLAN_FILE));
    dom.window.close();
  });

  it('rejects a wrong expected.windowId before any DOM work', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile(
      'cmd-wrong-window',
      { ...expected(), windowId: 'target-b' },
      () => true,
    );

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(calls.length, 0, 'a mismatched window must not touch the DOM');
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('refuses a non-empty composer draft without clicking anything', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1'), 'unsent draft'));
    const wiring = planWiring(dom);
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-draft', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '该会话输入框已有草稿');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.equal(calls.filter((entry) => entry.includes('planStepReadOpen(')).length, 0);
    dom.window.close();
  });

  it('stops without clicking when a draft appears between preflight and the scroll step', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom, {
      onEvaluate: (_expression, index) => {
        if (index === 1) wiring.setDraft('typed while reading');
      },
    });

    const result = await executor.resolvePlanFile('cmd-late-draft', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '该会话输入框已有草稿');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('stops without clicking when the selection changes between preflight and the click', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor, calls } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepClickViewPlan(')) wiring.selectOther();
      },
    });

    const result = await executor.resolvePlanFile('cmd-late-selection', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '编辑器选中的文档已改变');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.equal(calls.filter((entry) => entry.includes('planStepReadOpen(')).length, 0);
    dom.window.close();
  });

  it('refuses a different composer session without clicking anything', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-b', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-wrong-session', expected('composer-a'), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.equal(calls.filter((entry) => entry.includes('planStepReadOpen(')).length, 0);
    dom.window.close();
  });

  it('refuses a tool card that is not a plan card', async () => {
    const card = `
      <div data-message-role="ai" data-message-kind="tool" data-message-id="ac3" data-tool-call-id="tc_1">
        <div class="ui-tool-call-card" data-tool-call-card-marker="root"><button>View</button></div>
      </div>
    `;
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', card));
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-non-plan', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '该消息卡片不是计划卡片');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('requires an exactly-cased View Plan label and a usable button', async () => {
    const cases: Array<{ button: string; error: string }> = [
      { button: '<button id="view-plan">VIEW PLAN</button>', error: '计划卡片没有唯一的 View Plan 按钮' },
      { button: '<button id="view-plan">View Plan now</button>', error: '计划卡片没有唯一的 View Plan 按钮' },
      { button: '<button id="view-plan" disabled>View Plan</button>', error: 'View Plan 按钮已禁用' },
      { button: '<button id="view-plan" aria-disabled="true">View Plan</button>', error: 'View Plan 按钮已禁用' },
      { button: '<button id="view-plan" style="display:none">View Plan</button>', error: 'View Plan 按钮不可见' },
      { button: '<button id="view-plan" hidden>View Plan</button>', error: 'View Plan 按钮不可见' },
    ];

    for (const item of cases) {
      const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1', item.button)));
      const wiring = planWiring(dom);
      const { executor } = makeExecutor(dom);

      const result = await executor.resolvePlanFile('cmd-button', expected(), () => true);

      assert.equal(result.ok, false, item.button);
      assert.equal(result.error, item.error, item.button);
      assert.equal(result.data, undefined, item.button);
      assert.equal(wiring.clicks(), 0, item.button);
      dom.window.close();
    }
  });

  it('never maps a plain file-name label to a plan path', async () => {
    const card = `
      <div data-message-role="ai" data-message-kind="tool" data-message-id="ac3" data-tool-call-id="tc_1">
        <div class="ui-tool-call-card" data-tool-call-card-marker="root">
          <span class="ui-edit-tool-call__filename">/etc/passwd.plan.md</span>
          <button id="view-plan">View Plan</button>
        </div>
      </div>
    `;
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', card));
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-filename', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.ok(!(result.error ?? '').includes('passwd'));
    assert.ok(!(result.error ?? '').includes('.plan.md'));
    dom.window.close();
  });

  it('rejects a breadcrumb that does not match the selected plan tab', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom, {
      planFileName: 'other_name.plan.md',
      breadcrumbPath: `${PLANS_PREFIX}${PLAN_FILE}`,
    });
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-mismatch', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 1);
    assert.ok(!(result.error ?? '').includes(PLAN_FILE));
    dom.window.close();
  });

  it('accepts a local file-workspace breadcrumb and returns that plans root internally', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    installWorkspace(dom, FILE_WORKSPACE);
    const wiring = planWiring(dom, { breadcrumbPath: `${FILE_WORKSPACE_PLANS}/${PLAN_FILE}` });
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-workspace-ok', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string; plansRoot?: string; observedAt: number };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal(data.plansRoot, FILE_WORKSPACE_PLANS);
    assert.equal(typeof data.observedAt, 'number');
    assert.equal(wiring.clicks(), 1);
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    const readOpens = calls.filter((entry) => entry.includes('planStepReadOpen('));
    assert.ok(readOpens.length >= 1);
    assert.ok(
      readOpens.every((entry) => entry.includes('vscode.context.configuration().workspace')),
      'workspace identity must be read in the same evaluate as the open document',
    );
    assert.ok(!JSON.stringify(result.data).includes(PLAN_BODY));
    assert.ok(!(result.error ?? '').includes(FILE_WORKSPACE_PATH));
    dom.window.close();
  });

  it('keeps ~/.cursor/plans even when the live workspace identity is remote', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    installWorkspace(dom, {
      id: FILE_WORKSPACE_ID,
      uri: { scheme: 'vscode-remote', authority: 'ssh-remote+host', path: FILE_WORKSPACE_PATH },
    });
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-home-despite-remote', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    const data = result.data as { fileName: string; plansRoot?: string };
    assert.equal(data.fileName, PLAN_FILE);
    assert.equal('plansRoot' in data, false);
    assert.equal(wiring.clicks(), 1);
    dom.window.close();
  });

  it('rejects a workspace breadcrumb outside the file workspace, a remote identity, and a name mismatch', async () => {
    const cases: Array<{ workspace: unknown; breadcrumbPath: string; planFileName?: string; leaked: string[] }> = [
      {
        workspace: FILE_WORKSPACE,
        breadcrumbPath: `/tmp/other/.cursor/plans/${PLAN_FILE}`,
        leaked: ['/tmp/other', PLAN_FILE, FILE_WORKSPACE_PATH],
      },
      {
        workspace: {
          id: FILE_WORKSPACE_ID,
          uri: { scheme: 'vscode-remote', authority: '', path: FILE_WORKSPACE_PATH },
        },
        breadcrumbPath: `${FILE_WORKSPACE_PLANS}/${PLAN_FILE}`,
        leaked: [FILE_WORKSPACE_PATH, 'vscode-remote', PLAN_FILE],
      },
      {
        workspace: FILE_WORKSPACE,
        planFileName: OTHER_PLAN_FILE,
        breadcrumbPath: `${FILE_WORKSPACE_PLANS}/${PLAN_FILE}`,
        leaked: [PLAN_FILE, OTHER_PLAN_FILE, FILE_WORKSPACE_PATH],
      },
    ];

    for (const item of cases) {
      const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
      installWorkspace(dom, item.workspace);
      const wiring = planWiring(dom, {
        planFileName: item.planFileName ?? PLAN_FILE,
        breadcrumbPath: item.breadcrumbPath,
      });
      const { executor } = makeExecutor(dom);

      const result = await executor.resolvePlanFile('cmd-workspace-reject', expected(), () => true);

      assert.equal(result.ok, false, item.breadcrumbPath);
      assert.equal(result.data, undefined, item.breadcrumbPath);
      assert.equal(wiring.clicks(), 1, item.breadcrumbPath);
      const error = result.error ?? '';
      for (const leaked of item.leaked) {
        assert.ok(!error.includes(leaked), `${item.breadcrumbPath} leaked ${leaked}`);
      }
      dom.window.close();
    }
  });

  it('rejects traversal and out-of-root breadcrumb paths', async () => {
    const cases: Array<{ planFileName: string; breadcrumbPath: string; leaked: string }> = [
      { planFileName: 'escape.plan.md', breadcrumbPath: `${PLANS_PREFIX}../escape.plan.md`, leaked: 'escape' },
      { planFileName: 'passwd.plan.md', breadcrumbPath: '/etc/passwd.plan.md', leaked: 'passwd' },
      { planFileName: 'secret.plan.md', breadcrumbPath: '~/Documents/secret.plan.md', leaked: 'secret' },
    ];

    for (const item of cases) {
      const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
      const wiring = planWiring(dom, { planFileName: item.planFileName, breadcrumbPath: item.breadcrumbPath });
      const { executor } = makeExecutor(dom);

      const result = await executor.resolvePlanFile('cmd-traversal', expected(), () => true);

      assert.equal(result.ok, false, item.breadcrumbPath);
      assert.equal(result.data, undefined, item.breadcrumbPath);
      assert.ok(!(result.error ?? '').includes(item.leaked), item.breadcrumbPath);
      dom.window.close();
    }
  });

  it('does no DOM work when isCurrent turns false while waiting for the lane', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    let current = true;
    const { executor, coordinator, calls } = makeExecutor(dom, { isCurrent: () => current });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = coordinator.enqueue('target-a', async () => { await gate; }, { generation: 3 });
    const run = executor.resolvePlanFile('cmd-wait', expected(), () => current);
    await sleep(20);
    current = false;
    release();
    const [result] = await Promise.all([run, hold]);

    assert.equal(result.ok, false);
    assert.equal(result.error, '计划文档请求已失效');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.equal(calls.length, 0, 'a stale request must not touch the DOM');
    dom.window.close();
  });

  it('does not read or restore when only the DOM composer disappears during the read', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom, { reveal: 'sync' });
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepReadOpen(')) {
          dom.window.document.querySelector('[data-composer-id="composer-a"]')?.remove();
        }
      },
    });

    const result = await executor.resolvePlanFile('cmd-read-composer-gone', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '未找到该会话的输入区');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 1);
    assert.equal(selectedTabName(dom), PLAN_FILE, 'a changed DOM must not be restored');
    dom.window.close();
  });

  it('does not report success when the request is cancelled before the final scroll restore', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const doc = dom.window.document;
    const scrollHost = doc.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
    let scrollTop = 2000;
    let scrollOps = 0;
    Object.defineProperty(scrollHost, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollOps += 1;
        if (scrollOps === 3) {
          (doc.querySelector('.messages') as HTMLElement).innerHTML = planCardHtml('tc_1');
          wiring.wireCard();
        }
      },
    });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(scrollHost, 'scrollHeight', { configurable: true, get: () => 5000 });
    let current = true;
    const { executor, calls } = makeExecutor(dom, {
      isCurrent: () => current,
      onEvaluate: (expression) => {
        if (expression.includes('planStepRestoreScroll(')) current = false;
      },
    });

    const result = await executor.resolvePlanFile('cmd-cancel-restore', expected(), () => current);

    assert.equal(result.ok, false);
    assert.equal(result.error, '计划文档请求已失效');
    assert.equal(result.data, undefined);
    assert.ok(calls.some((entry) => entry.includes('planStepRestoreScroll(')), 'the restore step was reached');
    dom.window.close();
  });

  it('does not restore or return data when the target changes after the read', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    let generation = 3;
    const { executor } = makeExecutor(dom, {
      generation: () => generation,
      onReadOk: () => { generation = 4; },
    });

    const result = await executor.resolvePlanFile('cmd-target-change', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '计划文档目标已改变');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 1);
    assert.equal(selectedTabName(dom), PLAN_FILE, 'a changed target must not be restored');
    dom.window.close();
  });

  it('scrolls the exact composer transcript to find a virtualized card, then restores scroll', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const doc = dom.window.document;
    const scrollHost = doc.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
    let scrollTop = 2000;
    let scrollOps = 0;
    Object.defineProperty(scrollHost, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollOps += 1;
        if (scrollOps === 3) {
          (doc.querySelector('.messages') as HTMLElement).innerHTML = planCardHtml('tc_1');
          wiring.wireCard();
        }
      },
    });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(scrollHost, 'scrollHeight', { configurable: true, get: () => 5000 });
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-scroll', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { fileName: string }).fileName, PLAN_FILE);
    assert.equal(wiring.clicks(), 1);
    assert.ok(scrollOps >= 3 && scrollOps <= 26, `bounded scroll, saw ${scrollOps} writes`);
    assert.equal(scrollTop, 2000, 'the initial transcript scroll must be restored');
    dom.window.close();
  });

  it('gives up on a missing card without clicking and leaves the transcript where it was', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const doc = dom.window.document;
    const scrollHost = doc.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
    let scrollTop = 2000;
    let scrollOps = 0;
    Object.defineProperty(scrollHost, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; scrollOps += 1; },
    });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(scrollHost, 'scrollHeight', { configurable: true, get: () => 5000 });
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-missing', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '未找到该计划卡片');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    assert.ok(scrollOps <= 26, `search must stay bounded, saw ${scrollOps}`);
    assert.equal(scrollTop, 2000, 'an unchanged page must be left with its original scroll');
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    dom.window.close();
  });

  it('refuses a manual switch to another valid plan between the click and the read', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom, { reveal: 'sync' });
    const gate = trustedInputGate(dom);
    const { executor, calls } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepReadOpen(')) {
          wiring.switchToOtherPlan();
          gate.emit('pointerdown');
        }
      },
    });

    const result = await executor.resolvePlanFile('cmd-manual-switch', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '检测到人工输入，已中止计划文档读取');
    assert.equal(result.data, undefined, 'a manually chosen plan must not become the filename');
    assert.equal(wiring.clicks(), 1);
    assert.equal(selectedTabName(dom), OTHER_PLAN_FILE, 'no restore after human input');
    assert.ok(calls.some((entry) => entry.includes('planStepReadOpen(')));
    dom.window.close();
  });

  it('fails the attempt when trusted input arrives during the button click response', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    planWiring(dom, { reveal: 'sync' });
    const gate = trustedInputGate(dom);
    // Real user input delivered synchronously while Cursor handles our click.
    dom.window.document.getElementById('view-plan')?.addEventListener('click', () => gate.emit('keydown'));
    const { executor, calls } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-click-input', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '检测到人工输入，已中止计划文档读取');
    assert.equal(result.data, undefined);
    assert.equal(calls.filter((entry) => entry.includes('planStepReadOpen(')).length, 0, 'no read-back after user input');
    dom.window.close();
  });

  it('ignores untrusted programmatic input, including its own click', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    planWiring(dom, { reveal: 'sync' });
    const doc = dom.window.document;
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (!expression.includes('planStepReadOpen(')) return;
        // Events a script dispatches itself — the category this flow's own
        // .click() and tab restore belong to — are never trusted, so they must
        // neither abort the attempt nor block input.
        for (const type of ['pointerdown', 'mousedown', 'wheel', 'keydown', 'input', 'click']) {
          doc.body.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
        }
      },
    });

    const result = await executor.resolvePlanFile('cmd-untrusted-input', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { fileName: string }).fileName, PLAN_FILE);
    assert.equal(selectedTabName(dom), BASELINE_TAB, 'the original editor tab must be restored');
    dom.window.close();
  });

  it('refuses a filename when input lands after the final guarded step', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom, { reveal: 'sync' });
    const gate = trustedInputGate(dom);
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        // Only the attempt's last watch read: real input arriving in the window
        // between the last side effect and the success return.
        if (expression.includes('\nreturn planWatchState(')) gate.emit('keydown');
      },
    });

    const result = await executor.resolvePlanFile('cmd-input-after-restore', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '检测到人工输入，已中止计划文档读取');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 1);
    dom.window.close();
  });

  it('removes only its own interaction watch and leaves a foreign watch untouched', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1'), 'existing draft'));
    const wiring = planWiring(dom);
    let foreignCleanupCalls = 0;
    (dom.window as unknown as { __cursorRemotePlanWatch: Record<string, unknown> }).__cursorRemotePlanWatch = {
      'foreign-token': { events: ['keydown'], cleanup: () => { foreignCleanupCalls += 1; } },
    };
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-foreign-watch', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '该会话输入框已有草稿');
    const registry = (dom.window as unknown as { __cursorRemotePlanWatch?: Record<string, unknown> })
      .__cursorRemotePlanWatch;
    assert.ok(registry, 'the foreign watch must survive');
    assert.deepEqual(Object.keys(registry ?? {}), ['foreign-token']);
    assert.deepEqual((registry?.['foreign-token'] as { events: string[] }).events, ['keydown']);
    assert.equal(foreignCleanupCalls, 0, 'another attempt\'s listeners must not be removed');
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('fails closed when the interaction watch is gone before the preflight', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepPreflight(')) {
          delete (dom.window as unknown as { __cursorRemotePlanWatch?: unknown }).__cursorRemotePlanWatch;
        }
      },
    });

    const result = await executor.resolvePlanFile('cmd-watch-lost', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '计划文档交互监测已失效');
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('refuses when no target ui coordinator is configured', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor } = makeExecutor(dom, { withCoordinator: false });

    const result = await executor.resolvePlanFile('cmd-no-coordinator', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });
});

interface DiscoverData {
  plans: Array<{ toolCallId: string; title: string; description?: string }>;
  observedAt: number;
  reachedStart: boolean;
  completeness: string;
}

function readToolCard(toolCallId: string): string {
  return `
    <div data-message-role="ai" data-message-kind="tool" data-tool-call-id="${toolCallId}">
      <div class="ui-tool-call-card" data-tool-call-card-marker="root">
        <span class="ui-edit-tool-call__filename">src/index.ts</span>
        <div class="markdown-root">read output</div>
        <button>Read</button>
      </div>
    </div>
  `;
}

describe('CommandExecutor.discoverPlans', () => {
  it('walks the transcript upward, reports plan cards, and clicks nothing', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    // The card only exists once its own screen is rendered.
    const scroll = virtualizedScroll(dom, 2000, 500, (value) => {
      if (value > 1000) return;
      if (dom.window.document.querySelector('.messages [data-tool-call-id]')) return;
      (dom.window.document.querySelector('.messages') as HTMLElement).innerHTML = planCardHtml('tc_1');
      wiring.wireCard();
    });
    const { executor, calls, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-walk', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    assert.equal(data.completeness, 'partial');
    assert.equal(data.reachedStart, false, 'finding a card mid-walk must not claim the transcript start');
    assert.equal(typeof data.observedAt, 'number');
    assert.deepEqual(Array.from(data.plans, (plan) => plan.toolCallId), ['tc_1']);
    assert.equal(data.plans[0].title, PLAN_FILE);
    assert.equal(data.plans[0].description, 'plan summary only');
    assert.equal(wiring.clicks(), 0, 'discovery must never open a plan');
    assert.equal(wiring.buildClicks(), 0, 'discovery must never build');
    const steps = Array.from(new Set(calls.map(
      (entry) => entry.slice(entry.lastIndexOf('return ') + 'return '.length).split('(')[0]
    )));
    assert.deepEqual(steps, [
      'planWatchInstall',
      'planStepDiscoverStart',
      'planStepScanPlans',
      'planStepScrollUp',
      'planStepRestoreScroll',
      'planStepDiscoverDone',
      'planWatchRemove',
    ], 'only the discovery steps may run: no click, no expansion, no read-back');
    assert.equal(scroll.top, 2000, 'the original transcript position must come back');
    dom.window.close();
  });

  it('首屏新收集到计划卡后不再向上写，直接确认成功', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1') + planCardHtml('tc_2')));
    const scroll = virtualizedScroll(dom, 2000, 500);
    const { executor, calls, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-stop-first', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    assert.equal(data.completeness, 'partial');
    assert.equal(data.reachedStart, false);
    assert.deepEqual(Array.from(data.plans, (plan) => plan.toolCallId), ['tc_1', 'tc_2']);
    assert.equal(scroll.writes, 0, 'finding cards on the first screen must not scroll');
    assert.equal(calls.filter((entry) => entry.includes('planStepScrollUp(')).length, 0);
    assert.equal(calls.filter((entry) => entry.includes('planStepRestoreScroll(')).length, 0);
    assert.ok(calls.some((entry) => entry.includes('planStepDiscoverDone(')));
    assert.equal(scroll.top, 2000);
    dom.window.close();
  });

  it('某屏新收集到计划卡后不再额外向上写，恢复一次并成功', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const scroll = virtualizedScroll(dom, 2000, 500, (value) => {
      if (value > 1000) return;
      if (dom.window.document.querySelector('.messages [data-tool-call-id]')) return;
      (dom.window.document.querySelector('.messages') as HTMLElement).innerHTML =
        planCardHtml('tc_1') + planCardHtml('tc_2');
      wiring.wireCard();
    });
    const { executor, calls, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-stop-later', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    assert.equal(data.completeness, 'partial');
    assert.equal(data.reachedStart, false, 'stopping after a hit must not claim the transcript start');
    assert.deepEqual(Array.from(data.plans, (plan) => plan.toolCallId), ['tc_1', 'tc_2']);
    const scrollUps = calls.filter((entry) => entry.includes('planStepScrollUp(')).length;
    const restores = calls.filter((entry) => entry.includes('planStepRestoreScroll(')).length;
    assert.equal(scrollUps, 2, '2000→1500 empty, 1500→1000 finds cards');
    assert.equal(restores, 1, 'exactly one restore after the hit');
    assert.equal(scroll.writes, 3, 'two search steps plus the restore, no extra upward writes');
    assert.equal(scroll.top, 2000);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('ignores non-plan tool cards and never returns full card text', async () => {
    const longBody = 'PLAN_BODY_SHOULD_NOT_LEAK'.repeat(20);
    const longCard = `
      <div data-message-role="ai" data-message-kind="tool" data-tool-call-id="tc_long">
        <div class="ui-tool-call-card" data-tool-call-card-marker="root">
          <span data-testid="composer-plan-filename">${OTHER_PLAN_FILE}</span>
          <div class="markdown-root">${longBody}</div>
        </div>
      </div>
    `;
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', readToolCard('tc_read') + planCardHtml('tc_plan') + longCard));
    const wiring = planWiring(dom);
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-shape', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    assert.deepEqual(Array.from(data.plans, (plan) => plan.toolCallId), ['tc_plan', 'tc_long']);
    assert.equal(data.plans[1].title, OTHER_PLAN_FILE);
    assert.equal(data.plans[1].description?.length, 200, 'card text must be clipped');
    assert.ok(!JSON.stringify(result.data).includes(longBody), 'no full card text');
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('keeps same-title cards by tool-call id and bounds the reported list', async () => {
    const extras = Array.from({ length: 40 }, (_item, index) => planCardHtml(`tc_extra_${index}`)).join('');
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('constructor') + planCardHtml('tc_b') + extras));
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-same-title', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    const toolCallIds = Array.from(data.plans, (plan) => plan.toolCallId);
    assert.equal(toolCallIds.length, 32, 'the reported list is capped');
    assert.ok(toolCallIds.includes('constructor') && toolCallIds.includes('tc_b'), '同名卡片和原型同名标识均须保留');
    assert.ok(data.plans.every((plan) => plan.title === PLAN_FILE));
    assert.equal(data.completeness, 'partial');
    dom.window.close();
  });

  it('never reports cards from another composer and fails when the scope is gone', async () => {
    const dom = setup(
      editorGroupHtml() +
      composerHtml('composer-a', planCardHtml('tc_a')) +
      composerHtml('composer-b', planCardHtml('tc_b')),
    );
    const { executor, isCurrent } = makeExecutor(dom);

    const scoped = await executor.discoverPlans('cmd-discover-scope', discoverScope(), isCurrent);

    assert.equal(scoped.ok, true, scoped.error);
    assert.deepEqual(Array.from((scoped.data as DiscoverData).plans, (plan) => plan.toolCallId), ['tc_a']);

    const missing = await executor.discoverPlans('cmd-discover-no-scope', discoverScope('composer-z'), isCurrent);

    assert.equal(missing.ok, false);
    assert.equal(missing.error, '未找到该会话的输入区');
    assert.equal(missing.data, undefined);
    dom.window.close();
  });

  it('gives nothing when the request goes stale while waiting for the lane', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    let current = true;
    const { executor, coordinator, calls } = makeExecutor(dom, { isCurrent: () => current });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = coordinator.enqueue('target-a', async () => { await gate; }, { generation: 3 });
    const run = executor.discoverPlans('cmd-discover-stale', discoverScope(), () => current);
    await sleep(20);
    current = false;
    release();
    const [result] = await Promise.all([run, hold]);

    assert.equal(result.ok, false);
    assert.equal(result.error, '计划文档请求已失效');
    assert.equal(result.data, undefined);
    assert.equal(calls.length, 0, 'a stale discovery must not touch the DOM');
    dom.window.close();
  });

  it('gives no results and no restore once the user interacts', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const scroll = virtualizedScroll(dom, 2000, 500);
    const gate = trustedInputGate(dom);
    let scans = 0;
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (!expression.includes('planStepScanPlans(')) return;
        scans += 1;
        if (scans === 2) gate.emit('pointerdown');
      },
    });

    const result = await executor.discoverPlans('cmd-discover-input', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '检测到人工输入，已中止计划文档读取');
    assert.equal(result.data, undefined);
    assert.equal(scroll.top, 1500, 'a transcript the user touched must not be moved back');
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('发现恢复后编辑器目标改变时不返回引用', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', planCardHtml('tc_1')));
    const wiring = planWiring(dom);
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('return planStepDiscoverDone(')) wiring.selectOther();
      },
    });
    const result = await executor.discoverPlans('cmd-discover-late-selection', discoverScope(), isCurrent);
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(selectedTabName(dom), OTHER_TAB);
    assert.equal(wiring.clicks(), 0);
    dom.window.close();
  });

  it('stops at the walk limit and still reports partial results', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    // A short viewport means the top of a long empty transcript is never reached
    // within the bounded walk, so completeness can never be claimed.
    const scroll = virtualizedScroll(dom, 2000, 10);
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-discover-limit', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    const data = result.data as DiscoverData;
    assert.equal(data.reachedStart, false);
    assert.equal(data.completeness, 'partial');
    assert.deepEqual(data.plans, []);
    assert.equal(scroll.writes, 25, '24 bounded steps plus the restore');
    assert.equal(scroll.top, 2000, 'the original transcript position must come back');
    dom.window.close();
  });
});

interface ReanchorShift {
  /** scrollTop movement when Cursor re-anchors right after one of our writes. */
  top: number;
  /** scrollHeight movement in the same instant. */
  height: number;
  /** How the visible message rows react: keep their place, slide, or be swapped. */
  rows: 'stable' | 'moved' | 'replaced';
  /** How many of this flow's own upward writes trigger the change. */
  limit: number;
}

interface ReanchorScrollOptions {
  height: number;
  shift: ReanchorShift;
  onWrite?: (writes: number) => void;
  /**
   * Apply the shift right after each upward write (default). A test that needs
   * the shift to land at some other moment - straight before a later step - sets
   * this false and calls the returned `shift()` itself.
   */
  autoOnWrite?: boolean;
}

/**
 * A virtualized transcript that can re-anchor itself after one of this flow's
 * own scroll-up writes: the content above the viewport moves by `shift.top`
 * pixels and scrollHeight moves by `shift.height` in the same instant — the
 * exact pair of numbers Cursor 3.15 produced (both -16). Rows carry a stable
 * `data-find-row-key` and `data-sticky="false"`, and `shift.rows` picks whether
 * they keep their screen position, slide, or are swapped for other keys.
 * The change lands on a later tick, so a write's own read-back still returns
 * exactly what this flow set.
 */
function reanchoringScroll(
  dom: JSDOM,
  initialTop: number,
  viewport: number,
  options: ReanchorScrollOptions,
) {
  const doc = dom.window.document;
  const host = doc.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
  const messages = doc.querySelector('.messages') as HTMLElement;
  const state = { top: initialTop, height: options.height, writes: 0, shifts: 0 };
  // Where each mounted message row sits relative to the scroller. A real
  // virtualized transcript keeps the visible window mounted, so a row's screen
  // position is what this flow can actually observe at any scroll position.
  const rowTops = new Map<string, number>();

  const addRow = (key: string, top: number): void => {
    const row = doc.createElement('div');
    row.className = 'virtualized-composer-messages-row';
    row.setAttribute('data-find-row-key', key);
    row.setAttribute('data-sticky', 'false');
    row.getBoundingClientRect = () => {
      const rowTop = rowTops.get(key) as number;
      return {
        top: rowTop, bottom: rowTop + 20, height: 20, width: 200, left: 0, right: 200, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    };
    rowTops.set(key, top);
    messages.appendChild(row);
  };
  ['row-1', 'row-2'].forEach((key, index) => addRow(key, 60 + index * 40));

  const reanchor = (): void => {
    if (state.shifts >= options.shift.limit) return;
    state.shifts += 1;
    state.top = Math.max(0, state.top + options.shift.top);
    state.height += options.shift.height;
    if (options.shift.rows === 'replaced') {
      for (const row of Array.from(messages.querySelectorAll('[data-find-row-key]'))) row.remove();
      rowTops.clear();
      ['other-1', 'other-2'].forEach((key, index) => addRow(key, 60 + index * 40));
      return;
    }
    if (options.shift.rows === 'moved') {
      // The content stayed where it was, so the same rows slide on screen.
      for (const key of Array.from(rowTops.keys())) {
        rowTops.set(key, (rowTops.get(key) as number) + options.shift.top);
      }
    }
    // 'stable' moved the content with the offset, so the rows keep their place.
  };

  Object.defineProperty(host, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      const previous = state.top;
      state.top = value;
      state.writes += 1;
      options.onWrite?.(state.writes);
      if (options.autoOnWrite !== false && value < previous) dom.window.setTimeout(reanchor, 0);
    },
  });
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => viewport });
  Object.defineProperty(host, 'scrollHeight', { configurable: true, get: () => state.height });
  return Object.assign(state, { shift: reanchor });
}

/**
 * Replaces the transcript scroll container with a different element that holds
 * the same children at the same offsets. A flow that only compared numbers
 * would see nothing change; the record's scroller identity is what catches it.
 */
function swapScroller(dom: JSDOM, state: { top: number; height: number; writes: number }, viewport: number): void {
  const doc = dom.window.document;
  const host = doc.querySelector('.virtualized-composer-messages-scroll-container') as HTMLElement;
  const replacement = doc.createElement('div');
  replacement.className = 'virtualized-composer-messages-scroll-container';
  while (host.firstChild) replacement.appendChild(host.firstChild);
  Object.defineProperty(replacement, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => { state.top = value; state.writes += 1; },
  });
  Object.defineProperty(replacement, 'clientHeight', { configurable: true, get: () => viewport });
  Object.defineProperty(replacement, 'scrollHeight', { configurable: true, get: () => state.height });
  host.replaceWith(replacement);
}

/** How many times a step has already been evaluated, counted from 1. */
function stepCounter(): (predicate: string) => number {
  const counts = new Map<string, number>();
  return (predicate: string) => {
    const next = (counts.get(predicate) || 0) + 1;
    counts.set(predicate, next);
    return next;
  };
}

describe('CommandExecutor 计划滚动布局补偿', () => {
  // Cursor 3.15 moved scrollTop and scrollHeight by the same 16px while the
  // visible rows kept their place: that is the one shape the flow accepts.
  const ACCEPT_SHIFT: ReanchorShift = { top: -16, height: -16, rows: 'stable', limit: 1 };
  // The same compensation in the other direction: content above the viewport
  // grew, which is the shape a shift can still have at the very top.
  const GROW_SHIFT: ReanchorShift = { top: 16, height: 16, rows: 'stable', limit: 1 };

  it('接受 Cursor 自身的 16px 布局补偿，并按校正后的位置恢复发现流程', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, { height: 5000, shift: ACCEPT_SHIFT });
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-reanchor-discover', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as DiscoverData).reachedStart, true);
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 5, 'four bounded scroll steps plus the restore');
    assert.equal(scroll.height, 4984);
    assert.equal(scroll.top, 1984, '恢复必须使用校正后的 2000-16 而不是过期的 2000');
    dom.window.close();
  });

  it('读取流程接受同样的补偿并恢复校正后的位置', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom);
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      onWrite: (writes) => {
        if (writes !== 1) return;
        (dom.window.document.querySelector('.messages') as HTMLElement)
          .insertAdjacentHTML('beforeend', planCardHtml('tc_1'));
        wiring.wireCard();
      },
    });
    const { executor } = makeExecutor(dom);

    const result = await executor.resolvePlanFile('cmd-reanchor-read', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { fileName: string }).fileName, PLAN_FILE);
    assert.equal(wiring.clicks(), 1, 'View Plan must still be clicked exactly once');
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 2, 'one search step plus the restore');
    assert.equal(scroll.top, 1984, '恢复必须使用校正后的 2000-16 而不是过期的 2000');
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    dom.window.close();
  });

  it('拒绝位移变化而内容高度不变的滚动', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: { top: -16, height: 0, rows: 'stable', limit: 1 },
    });
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-reanchor-top-only', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '会话滚动位置已改变');
    assert.equal(result.data, undefined);
    assert.equal(scroll.writes, 1, '拒绝后不得回滚滚动');
    assert.equal(scroll.top, 1484);
    dom.window.close();
  });

  it('拒绝内容高度同变但可见消息行已经移动的滚动', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: { top: -16, height: -16, rows: 'moved', limit: 1 },
    });
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-reanchor-moved', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '会话滚动位置已改变');
    assert.equal(result.data, undefined);
    assert.equal(scroll.writes, 1, '拒绝后不得回滚滚动');
    assert.equal(scroll.top, 1484);
    dom.window.close();
  });

  it('拒绝内容高度同变但可见消息行已被替换的滚动', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: { top: -16, height: -16, rows: 'replaced', limit: 1 },
    });
    const { executor, isCurrent } = makeExecutor(dom);

    const result = await executor.discoverPlans('cmd-reanchor-replaced', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '会话滚动位置已改变');
    assert.equal(result.data, undefined);
    assert.equal(scroll.writes, 1, '拒绝后不得回滚滚动');
    assert.equal(scroll.top, 1484);
    dom.window.close();
  });

  it('同样的补偿伴随人工输入时仍然拒绝且不恢复', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, { height: 5000, shift: ACCEPT_SHIFT });
    const gate = trustedInputGate(dom);
    let scans = 0;
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (!expression.includes('planStepScanPlans(')) return;
        scans += 1;
        if (scans === 2) gate.emit('pointerdown');
      },
    });

    const result = await executor.discoverPlans('cmd-reanchor-input', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '检测到人工输入，已中止计划文档读取');
    assert.equal(result.data, undefined);
    assert.equal(scroll.writes, 1, '人工接回后不得移动滚动');
    assert.equal(scroll.top, 1484);
    dom.window.close();
  });

  // The compensation can also land between two of this flow's own steps, before
  // the next step's guard runs. Those steps then have to hand the corrected
  // offset back, or the walk keeps counting from a stale position.
  it('补偿恰好发生在下一次 ScrollUp 之前时仍然跟随并正确恢复', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
    });
    const nextStep = stepCounter();
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepScrollUp(') && nextStep('scrollUp') === 2) scroll.shift();
      },
    });

    const result = await executor.discoverPlans('cmd-reanchor-before-scrollup', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as DiscoverData).reachedStart, true);
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 5, 'four bounded scroll steps plus the restore');
    assert.equal(scroll.top, 1984, '恢复必须包含发生在 ScrollUp 之前的 16px 补偿');
    assert.equal(scroll.height, 4984);
    dom.window.close();
  });

  it('补偿恰好发生在命中顶部的 ScrollUp 之前时也不丢失', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    // 2016 with a 500px viewport puts this flow's fifth step exactly at the top
    // once Cursor moves the transcript by the usual 16px.
    const scroll = reanchoringScroll(dom, 2016, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
    });
    const nextStep = stepCounter();
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepScrollUp(') && nextStep('scrollUp') === 5) scroll.shift();
      },
    });

    const result = await executor.discoverPlans('cmd-reanchor-at-top', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as DiscoverData).reachedStart, true, '补偿后正好到达顶部');
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 5, 'four writes plus the restore, nothing written at the top');
    assert.equal(scroll.top, 2000, '恢复必须包含顶部分支确认的 16px 补偿');
    dom.window.close();
  });

  it('补偿恰好发生在 RestoreScroll 之前时恢复目标包含追加的 delta', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: GROW_SHIFT,
      autoOnWrite: false,
    });
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepRestoreScroll(')) scroll.shift();
      },
    });

    const result = await executor.discoverPlans('cmd-reanchor-before-restore', discoverScope(), isCurrent);

    assert.equal(result.ok, true, result.error);
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 5, 'four bounded scroll steps plus the restore');
    assert.equal(scroll.top, 2016, 'restore 必须把 guard 刚接受的补偿也算进目标位置');
    assert.equal(scroll.height, 5016);
    dom.window.close();
  });

  it('读取流程在 RestoreScroll 之前发生补偿时同样恢复到校正位置', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom, { reveal: 'sync' });
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
      onWrite: (writes) => {
        if (writes !== 1) return;
        (dom.window.document.querySelector('.messages') as HTMLElement)
          .insertAdjacentHTML('beforeend', planCardHtml('tc_1'));
        wiring.wireCard();
      },
    });
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepRestoreScroll(')) scroll.shift();
      },
    });

    const result = await executor.resolvePlanFile('cmd-reanchor-read-restore', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { fileName: string }).fileName, PLAN_FILE);
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 2, 'one search step plus the restore');
    assert.equal(scroll.top, 1984, 'restore 必须吸收 guard 刚接受的 16px 补偿');
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    dom.window.close();
  });

  it('等待 plan 编辑器打开期间发生补偿仍能继续等待并正确恢复', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    // The plan editor takes a while to appear, so the poll runs several
    // not-open rounds - the window in which Cursor re-anchored here.
    const wiring = planWiring(dom, { revealDelayMs: 500 });
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
      onWrite: (writes) => {
        if (writes !== 1) return;
        (dom.window.document.querySelector('.messages') as HTMLElement)
          .insertAdjacentHTML('beforeend', planCardHtml('tc_1'));
        wiring.wireCard();
      },
    });
    const nextStep = stepCounter();
    const { executor, calls } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (expression.includes('planStepReadOpen(') && nextStep('readOpen') === 2) scroll.shift();
      },
    });

    const result = await executor.resolvePlanFile('cmd-reanchor-during-open', expected(), () => true);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { fileName: string }).fileName, PLAN_FILE);
    assert.ok(nextStep('readOpen') >= 3, '等待分支确实被走过');
    assert.equal(scroll.shifts, 1, 'exactly one layout compensation');
    assert.equal(scroll.writes, 2, 'one search step plus the restore');
    assert.equal(scroll.top, 1984, '等待期间确认的补偿必须带到最终恢复位置');
    assert.equal(selectedTabName(dom), BASELINE_TAB);
    assert.ok(calls.length > 0);
    dom.window.close();
  });

  it('恢复之后原文档被换掉时最终确认拒绝并返回空', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const wiring = planWiring(dom, { reveal: 'sync' });
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
      onWrite: (writes) => {
        if (writes !== 1) return;
        (dom.window.document.querySelector('.messages') as HTMLElement)
          .insertAdjacentHTML('beforeend', planCardHtml('tc_1'));
        wiring.wireCard();
      },
    });
    // The first evaluate after the restore is the post-restore confirmation.
    let afterRestore = false;
    const { executor } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        if (afterRestore) {
          afterRestore = false;
          wiring.selectOther();
          return;
        }
        if (expression.includes('planStepRestoreScroll(')) afterRestore = true;
      },
    });

    const result = await executor.resolvePlanFile('cmd-reanchor-after-restore', expected(), () => true);

    assert.equal(result.ok, false);
    assert.equal(result.error, '编辑器选中的文档已改变');
    assert.equal(result.data, undefined, '恢复未被确认时不得返回文件名');
    assert.equal(wiring.clicks(), 1);
    assert.equal(scroll.shifts, 0);
    assert.equal(scroll.top, 2000, '恢复已经发生，但确认失败');
    dom.window.close();
  });

  it('同 top 换掉滚动容器时拒绝', async () => {
    const dom = setup(editorGroupHtml() + composerHtml('composer-a', ''));
    const scroll = reanchoringScroll(dom, 2000, 500, {
      height: 5000,
      shift: ACCEPT_SHIFT,
      autoOnWrite: false,
    });
    const nextStep = stepCounter();
    const { executor, isCurrent } = makeExecutor(dom, {
      onEvaluate: (expression) => {
        // Same children, same offsets, same scrollTop: only the element itself
        // is different, which is what the recorded scroller catches.
        if (expression.includes('planStepScrollUp(') && nextStep('scrollUp') === 2) {
          swapScroller(dom, scroll, 500);
        }
      },
    });

    const result = await executor.discoverPlans('cmd-reanchor-swapped', discoverScope(), isCurrent);

    assert.equal(result.ok, false);
    assert.equal(result.error, '会话滚动位置已改变');
    assert.equal(result.data, undefined);
    assert.equal(scroll.writes, 1, '拒绝后不得再写滚动');
    assert.equal(scroll.top, 1500);
    dom.window.close();
  });
});