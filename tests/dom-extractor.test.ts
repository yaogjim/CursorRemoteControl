import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { CursorState } from '../src/server/types.js';

function withDom(
  html: string,
  options: {
    approveSelectors?: string[];
    approveTextMatch?: string[];
    rejectSelectors?: string[];
    rejectTextMatch?: string[];
    chatTabSelectors?: string[];
    openChatTabSelectors?: string[];
    windowTitle?: string;
  } = {},
): CursorState {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: dom.window.Node,
  });
  try {
    const state = extractionFunction(
      ['#root'],
      options.approveSelectors ?? [],
      options.approveTextMatch ?? [],
      options.rejectSelectors ?? [],
      options.rejectTextMatch ?? [],
      [],
      [],
      options.chatTabSelectors ?? [],
      [],
      [],
      options.windowTitle,
      options.openChatTabSelectors ?? []
    );
    assert.ok(state, 'expected extractionFunction to return state');
    return state;
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      delete globalThis.document;
    }
    if (nodeDescriptor) {
      Object.defineProperty(globalThis, 'Node', nodeDescriptor);
    } else {
      delete globalThis.Node;
    }
  }
}

describe('extractionFunction', () => {
  it('emits Cursor 3.8 activity tool-placeholder rows without data-message-role', () => {
    const state = withDom(`
      <main id="root">
        <div data-find-row-key="tool-placeholder:call-1">
          <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
            <div data-tool-call-id="call-1" data-tool-status="completed">
              <span class="ui-tool-call-line-action">Read</span>
              <span class="ui-tool-call-line-details">src/server/dom-extractor.ts</span>
            </div>
          </article>
        </div>
      </main>
    `);

    const tool = state.messages.find((message) => message.type === 'tool');

    assert.ok(tool, 'expected a tool element to be emitted');
    assert.equal(tool.toolCallId, 'call-1');
    assert.equal(tool.action, 'Read');
  });

  it('uses anchored selector paths for data-click-ready questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true">
              <span><span class="truncate">Skip</span></span>
            </div>
            <div class="shortcut">Esc</div>
            <div data-click-ready="true" data-disabled="true">
              <span><span class="truncate">Continue</span></span>
            </div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(3)'
    );
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('emits anchored option-row selector paths for questionnaire options (public#50)', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
              <div class="composer-questionnaire-toolbar-options">
                <div class="composer-questionnaire-toolbar-option" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
                  <span class="composer-questionnaire-toolbar-option-label">Explore the codebase</span>
                </div>
                <div class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
                  <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    const [question] = state.questionnaire.questions;
    assert.equal(question.options.length, 2);
    assert.equal(question.options[0].label, 'Explore the codebase');
    assert.equal(
      question.options[0].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(1)'
    );
    assert.equal(question.options[1].label, 'Other');
    assert.equal(question.options[1].isFreeform, true);
    assert.equal(
      question.options[1].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)'
    );
  });

  it('does not turn historical tool output containing action words into approvals', () => {
    const state = withDom(`
      <main id="root">
        <button>npm run build\nfail 0\ncancelled 0</button>
        <button>source line: approveTextMatch and rejectTextMatch</button>
      </main>
    `, {
      approveTextMatch: ['Approve', 'Run', 'Allow'],
      rejectTextMatch: ['Reject', 'Cancel', 'Skip'],
    });

    assert.deepEqual(state.pendingApprovals, []);
    assert.notEqual(state.agentStatus, 'waiting_approval');
  });

  it('keeps exact text and aria approval labels available', () => {
    const state = withDom(`
      <main id="root">
        <button aria-label="Approve"></button>
        <button>Cancel</button>
      </main>
    `, {
      approveSelectors: ['button[aria-label*="Approve"]'],
      approveTextMatch: ['Approve'],
      rejectTextMatch: ['Cancel'],
    });

    assert.equal(state.pendingApprovals.length, 1);
    assert.deepEqual(state.pendingApprovals[0].actions.map(action => [action.label, action.type]), [
      ['Approve', 'approve'],
      ['Cancel', 'reject'],
    ]);
  });

  it('keeps buildSelectorPath selectors for legacy questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <section class="composer-questionnaire-toolbar-actions">
            <div class="composer-skip-button">Skip</div>
            <div class="composer-run-button" data-disabled="false">Continue</div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(2)'
    );
    assert.equal(state.questionnaire.continueDisabled, false);
  });

  it('marks questionnaire options selected from aria/data attributes', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
              <div class="composer-questionnaire-toolbar-options">
                <div class="composer-questionnaire-toolbar-option" role="button" aria-pressed="true">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
                  <span class="composer-questionnaire-toolbar-option-label">Explore</span>
                </div>
                <div class="composer-questionnaire-toolbar-option" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
                  <span class="composer-questionnaire-toolbar-option-label">Skip this</span>
                </div>
              </div>
            </div>
          </div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true"><span><span class="truncate">Skip</span></span></div>
            <div data-click-ready="true" aria-disabled="true"><span><span class="truncate">Continue</span></span></div>
          </section>
        </div>
      </div>
    `);
    assert.ok(state.questionnaire);
    assert.equal(state.questionnaire.questions[0].options[0].selected, true);
    assert.equal(state.questionnaire.questions[0].options[1].selected, false);
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('marks a native disabled questionnaire Continue button as disabled', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
            </div>
          </div>
          <section class="composer-questionnaire-toolbar-actions">
            <button data-click-ready="true">Skip</button>
            <button data-click-ready="true" disabled>Continue</button>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('copies step-group preview into thought detail and ignores thinking body', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0">
          <div class="ui-collapsible ui-step-group-collapsible">
            <div class="ui-collapsible-header">
              <span>Explored</span>
              <span class="ui-step-group-preview">Found 3 files in src/server</span>
            </div>
            <div class="ui-collapsible-content">SECRET_THINKING_BODY should stay hidden</div>
          </div>
        </article>
      </main>
    `);
    const thought = state.messages.find((message) => message.type === 'thought');
    assert.ok(thought);
    assert.equal(thought.action, 'Explored');
    assert.match(thought.detail || '', /Found 3 files/);
    assert.equal((thought.detail || '').includes('SECRET_THINKING_BODY'), false);
  });

  it('keeps compact tool details when header-content is present', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="ai" data-message-kind="tool" data-message-id="m-tool">
          <div data-tool-call-id="call-2" data-tool-status="completed">
            <div class="composer-tool-former-message">
              <div class="composer-tool-call-header-content">
                <span>Read</span>
                <span>src/server/relay.ts</span>
              </div>
            </div>
          </div>
        </article>
      </main>
    `);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.action, 'Read');
    assert.equal(tool.details, 'src/server/relay.ts');
  });

  it('splits nested compact header spans into action and details', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="ai" data-message-kind="tool" data-message-id="m-tool">
          <div data-tool-call-id="call-3" data-tool-status="completed">
            <div class="composer-tool-former-message">
              <div class="composer-tool-call-header-content">
                <span>Read<span>src/server/relay.ts</span></span>
              </div>
            </div>
          </div>
        </article>
      </main>
    `);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.action, 'Read');
    assert.equal(tool.details, 'src/server/relay.ts');
  });

  it('fills compact tool details from a truncate sibling when header only has the action', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="ai" data-message-kind="tool" data-message-id="m-tool">
          <div data-tool-call-id="call-4" data-tool-status="completed">
            <div class="composer-tool-former-message">
              <div class="composer-tool-call-header-content">
                <span>Grep</span>
              </div>
              <span class="truncate-one-line">foo in src/server</span>
            </div>
          </div>
        </article>
      </main>
    `);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.action, 'Grep');
    assert.equal(tool.details, 'foo in src/server');
  });

  it('does not copy thinking body into a compact tool summary', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="ai" data-message-kind="tool" data-message-id="m-tool">
          <div data-tool-call-id="call-5" data-tool-status="completed">
            <div class="composer-tool-former-message">
              <div class="composer-tool-call-header-content">
                <span>Read</span>
              </div>
            </div>
            <div class="ui-collapsible-content">SECRET_THINKING_BODY should stay hidden</div>
          </div>
        </article>
      </main>
    `);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.action, 'Read');
    assert.equal((tool.details || '').includes('SECRET_THINKING_BODY'), false);
    assert.equal((tool.summaryText || '').includes('SECRET_THINKING_BODY'), false);
  });

  it('uses the local history sidebar when Cursor hides the unified cross-project sidebar', () => {
    const state = withDom(`
      <body class="sidebarvisible unifiedsidebarhidden">
        <main id="root"></main>
        <div class="auxiliary-bar-title--agent-mode">
          <ul><li class="composite-bar-action-tab checked" role="tab" aria-selected="true">
            <a aria-id="chat-horizontal-tab" aria-label="Only open">Only open</a>
          </li></ul>
        </div>
        <div class="agent-sidebar">
          <div class="agent-sidebar-cell" data-has-hover-actions="false"><span class="agent-sidebar-cell-text">New Agent</span></div>
          <div class="agent-sidebar-cell" data-has-hover-actions="true" data-selected="true"><span class="agent-sidebar-cell-text">Only open</span></div>
          <div class="agent-sidebar-cell" data-has-hover-actions="true"><span class="agent-sidebar-cell-text">Older history</span></div>
        </div>
      </body>
    `, {
      chatTabSelectors: ['.agent-sidebar-cell'],
      openChatTabSelectors: [
        ".auxiliary-bar-title--agent-mode li.composite-bar-action-tab[role='tab']",
      ],
      windowTitle: 'cursorremote',
    });

    assert.deepEqual(
      state.chatTabs.map(tab => [tab.title, tab.isOpen]),
      [['Only open', true], ['Older history', false]]
    );
  });

  it('orders open sessions first, excludes utility rows, and keeps history scoped to the window', () => {
    const state = withDom(`
      <main id="root" data-composer-id="composer-current"></main>
      <div class="auxiliary-bar-title--agent-mode">
        <ul role="tablist" aria-label="Active View Switcher">
          <li class="composite-bar-action-tab" role="tab" aria-selected="false">
            <a aria-id="chat-horizontal-tab" aria-label="Open left">Open left</a>
          </li>
          <li class="composite-bar-action-tab checked" role="tab" aria-selected="true">
            <a aria-id="chat-horizontal-tab" aria-label="Open right">Open right</a>
          </li>
        </ul>
      </div>
      <section class="agent-sidebar-project-cell">
        <div class="agent-sidebar-workspace-name">cursorremote</div>
        <div class="agent-sidebar-cell" data-has-hover-actions="false">
          <span class="agent-sidebar-cell-text">New Agent</span>
        </div>
        <div class="agent-sidebar-cell" data-has-hover-actions="false">
          <span class="agent-sidebar-cell-text">Customize</span>
        </div>
        <div class="agent-sidebar-cell" data-has-hover-actions="true" data-selected="true">
          <span class="agent-sidebar-cell-text">Open right</span>
        </div>
        <div class="agent-sidebar-cell" data-has-hover-actions="true">
          <span class="agent-sidebar-cell-text">History only</span>
        </div>
      </section>
      <section class="agent-sidebar-project-cell">
        <div class="agent-sidebar-workspace-name">other-project</div>
        <div class="agent-sidebar-cell" data-has-hover-actions="true">
          <span class="agent-sidebar-cell-text">Wrong project session</span>
        </div>
      </section>
    `, {
      chatTabSelectors: ['.agent-sidebar-cell'],
      openChatTabSelectors: [
        ".auxiliary-bar-title--agent-mode li.composite-bar-action-tab[role='tab']",
      ],
      windowTitle: 'cursorremote',
    });

    assert.deepEqual(
      state.chatTabs.map(tab => ({ title: tab.title, isOpen: tab.isOpen, isActive: tab.isActive })),
      [
        { title: 'Open left', isOpen: true, isActive: false },
        { title: 'Open right', isOpen: true, isActive: true },
        { title: 'History only', isOpen: false, isActive: false },
      ]
    );
  });

  it('extracts a Cursor 3.15 CreatePlan card from the composer-plan-filename marker', () => {
    const state = withDom(`
      <main id="root" data-composer-id="4caf6000-d7cf-445c-9f01-ae914d61069c">
        <div class="virtualized-composer-messages-row" data-index="23">
          <div style="display:contents">
            <div data-message-id="ac3dd8d2-9316-4d01-9cae-ac7dcf9e1981" data-message-kind="tool" data-message-role="ai" data-react-transcript-row-kind="activity" data-tool-call-id="tc_2098230ea283_call_hUrBk8HLwY5bBPodOrbHmDKJ" data-tool-status="completed">
              <div class="ui-tool-call-card" data-tool-call-card-marker="root">
                <div class="ui-tool-call-card__header" title="工作区 Agent 托管方案">
                  <span>Created Plan</span>
                  <span data-testid="composer-plan-filename">工作区 Agent 托管方案</span>
                </div>
                <div class="ui-tool-call-card__body">
                  <div class="markdown-root"><p>Overview summary</p></div>
                </div>
                <div class="ui-tool-call-card__footer">
                  <button type="button">View Plan</button>
                  <button type="button">Build</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);

    const plan = state.messages.find((message) => message.type === 'plan');
    assert.ok(plan, 'expected a plan element to be emitted');
    assert.equal(plan.toolCallId, 'tc_2098230ea283_call_hUrBk8HLwY5bBPodOrbHmDKJ');
    assert.equal(plan.label, 'Created Plan');
    assert.equal(plan.fileName, undefined, '展示标签不是文件引用');
    assert.equal(plan.title, '工作区 Agent 托管方案');
    assert.equal(plan.description, 'Overview summary');
    assert.equal(plan.todosTotal, 0);
    assert.equal(plan.todos, undefined);
    assert.deepEqual(
      plan.actions?.map((action) => [action.label, action.type]),
      [['View Plan', 'view_plan']]
    );
    assert.equal(
      plan.actions?.[0].selectorPath,
      'main#root > div > div > div > div > div:nth-of-type(3) > button:nth-of-type(1)'
    );
  });

  it('extracts a CreatePlan card nested in a composer message group and keeps wrapper/tool-id association', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="5">
          <div class="composer-message-group">
            <div class="ui-collapsible ui-step-group-collapsible">
              <div class="ui-collapsible-header"><span>Explored</span></div>
              <div class="ui-collapsible-content">
                <div class="column">
                  <div data-message-role="ai" data-message-kind="tool" data-message-id="m-grouped-plan" data-tool-call-id="tc-grouped-plan" data-tool-status="completed">
                    <div class="ui-tool-call-card" data-tool-call-card-marker="root">
                      <div class="ui-tool-call-card__header" title="Grouped Plan">
                        <span>Created Plan</span>
                        <span data-testid="composer-plan-filename">Grouped Plan</span>
                      </div>
                      <div class="ui-tool-call-card__body">
                        <div class="markdown-root">Grouped overview</div>
                      </div>
                      <div class="ui-tool-call-card__footer">
                        <button type="button">View Plan</button>
                        <button type="button">Build</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </article>
      </main>
    `);

    const plans = state.messages.filter((message) => message.type === 'plan');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].toolCallId, 'tc-grouped-plan');
    assert.equal(plans[0].title, 'Grouped Plan');
    assert.deepEqual(
      plans[0].actions?.map((action) => [action.label, action.type]),
      [['View Plan', 'view_plan']]
    );
  });

  it('does not treat a Read tool that mentions a .plan.md file as a CreatePlan plan', () => {
    const state = withDom(`
      <main id="root">
        <div class="virtualized-composer-messages-row" data-index="24">
          <div style="display:contents">
            <div data-message-id="m-read-plan-file" data-message-kind="tool" data-message-role="ai" data-react-transcript-row-kind="activity" data-tool-call-id="tc-read-plan-file" data-tool-status="completed">
              <div class="ui-tool-call-card" data-tool-call-card-marker="root">
                <div class="ui-tool-call-card__header"><span>Read</span></div>
                <div class="ui-tool-call-line-details">.cursor/plans/工作区_agent_托管方案_622ce6c4.plan.md</div>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);

    assert.equal(state.messages.some((message) => message.type === 'plan'), false);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool, 'expected the Read tool to stay a tool element');
    assert.equal(tool.action, 'Read');
  });

  it('does not treat composer-plan-filename outside the root tool-call card as a plan', () => {
    const state = withDom(`
      <main id="root">
        <div data-message-id="m-stray-marker" data-message-kind="tool" data-message-role="ai" data-tool-call-id="tc-stray-marker" data-tool-status="completed">
          <div class="ui-tool-call-card">
            <div class="ui-tool-call-card__header"><span>Read</span></div>
            <span data-testid="composer-plan-filename">Not a plan card</span>
          </div>
        </div>
      </main>
    `);

    assert.equal(state.messages.some((message) => message.type === 'plan'), false);
    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.type, 'tool');
  });

  it('keeps legacy composer-create-plan-container semantics and adds its toolCallId', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="1" data-message-role="ai" data-message-kind="tool" data-message-id="m-legacy-plan" data-tool-call-id="tc-legacy-plan" data-tool-status="completed">
          <div class="composer-create-plan-container">
            <div class="composer-create-plan-label">Created Plan</div>
            <div class="composer-create-plan-title">Legacy Plan</div>
            <div class="composer-create-plan-text"><div class="markdown-root">Legacy overview</div></div>
            <div class="composer-create-plan-todo-item">
              <div class="composer-plan-todo-indicator completed"></div>
              <div class="composer-create-plan-todo-content">Step one</div>
            </div>
            <div class="composer-create-plan-view-plan-button">View Plan</div>
            <div class="composer-create-plan-build-button">Build</div>
          </div>
        </article>
      </main>
    `);

    const plan = state.messages.find((message) => message.type === 'plan');
    assert.ok(plan, 'expected the legacy plan element to be emitted');
    assert.equal(plan.toolCallId, 'tc-legacy-plan');
    assert.equal(plan.label, 'Created Plan');
    assert.equal(plan.title, 'Legacy Plan');
    assert.equal(plan.description, 'Legacy overview');
    assert.equal(plan.todosTotal, 1);
    assert.equal(plan.todosCompleted, 1);
    assert.deepEqual(
      plan.actions?.map((action) => [action.label, action.type]),
      [['View Plan', 'view_plan'], ['Build', 'build']]
    );
  });
});
