import type { CdpClient } from './cdp-client.js';
import type { SelectorConfig, CommandResult, PlanModelOption, CapabilitySummary } from './types.js';
import { planFailResult, planRequestedTarget } from './plan-command-failure.js';
import { TargetUiCoordinator, TargetUiError } from './target-ui-coordinator.js';
import { ActionRegistry, ActionRegistryError, isExecutableActionType } from './action-registry.js';
import { capabilityAllows } from './capability-guard.js';
import { fileWorkspacePlansRoot, planFileFromFileUri } from './plan-files.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;
const COMMAND_RESULT_TTL_MS = 60_000;
const MAX_CACHED_COMMAND_RESULTS = 1_000;

// Cursor 3.8+ uses data-message-index; older builds use data-flat-index.
const MESSAGE_WRAPPER_SELECTOR = '[data-message-index], [data-flat-index]';

// Plan document read: the plan path is only trustworthy when Cursor itself
// opened it under this prefix, so anything else is rejected rather than guessed.
const PLAN_DOCUMENT_PATH_PREFIX = '~/.cursor/plans/';
const PLAN_DOCUMENT_SCROLL_MAX_STEPS = 24;
// One composer's transcript can hold a lot of plan cards; the reported list and
// the per-card text are both hard-capped so a discovery response stays small.
const PLAN_DISCOVERY_MAX_PLANS = 32;
const PLAN_DOCUMENT_RENDER_WAIT_MS = 150;
const PLAN_DOCUMENT_OPEN_POLL_MAX = 40;
const PLAN_DOCUMENT_OPEN_POLL_WAIT_MS = 150;
const PLAN_DOCUMENT_RESTORE_POLL_MAX = 20;
const PLAN_DOCUMENT_READ_TIMEOUT_MS = 30_000;

// Makes each read attempt's in-page interaction watch token unique. Not
// persisted; a page reload simply loses the old watches.
let planWatchSeq = 0;

/** Extract the single `.plan.md` name under a known plans root prefix, or null. Never a path. */
function planFileNameFromPrefix(path: string, prefix: string): string | null {
  if (typeof path !== 'string' || !path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  if (!name || name === '.plan.md') return null;
  if (!name.endsWith('.plan.md')) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name;
}

/** Extract the single `.plan.md` name under the plans root, or null. Never a path. */
function planFileNameFromPath(path: string): string | null {
  return planFileNameFromPrefix(path, PLAN_DOCUMENT_PATH_PREFIX);
}

// In-browser helpers for the plan document read. Non-message editor elements
// (tabs / breadcrumb / plan editor group) come from selectors.json; the plan
// tool card markers are message-internal and stay here. Injected as
// `${PLAN_DOCUMENT_HELPERS_JS}` inside an evaluate().
const PLAN_DOCUMENT_HELPERS_JS = `
  const planNormalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();

  const planUniqueAttrRoot = (attribute, value) => {
    if (!value) return null;
    const matches = Array.from(document.querySelectorAll('[' + attribute + ']'))
      .filter((el) => el.getAttribute(attribute) === value);
    const roots = matches.filter((el) => !matches.some((other) => other !== el && other.contains(el)));
    return roots.length === 1 ? roots[0] : null;
  };

  const planComposerRoot = (composerId) => {
    const root = planUniqueAttrRoot('data-composer-id', composerId);
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return root;
  };

  const planDraftText = (root) => {
    if (!root) return null;
    for (const field of Array.from(root.querySelectorAll('[contenteditable="true"], textarea'))) {
      const text = field.isContentEditable
        ? (field.textContent || '')
        : (typeof field.value === 'string' && field.value.length > 0 ? field.value : (field.textContent || ''));
      if (text.trim().length > 0) return text.trim();
    }
    return '';
  };

  const planCardCandidates = (root, toolCallId) => {
    if (!root || !toolCallId) return [];
    const hosts = Array.from(root.querySelectorAll('[data-tool-call-id]'))
      .filter((el) => el.getAttribute('data-tool-call-id') === toolCallId)
      .filter((el) => el.getAttribute('data-message-role') === 'ai'
        && el.getAttribute('data-message-kind') === 'tool');
    const cards = [];
    for (const host of hosts) {
      const card = host.querySelector('.ui-tool-call-card[data-tool-call-card-marker="root"]');
      if (card && !cards.includes(card)) cards.push(card);
    }
    return cards;
  };

  const planViewPlanButton = (card) => {
    if (!card) return null;
    // Strict, case-exact label match: a differently-cased label is not the same button.
    const buttons = Array.from(card.querySelectorAll('button'))
      .filter((btn) => planNormalizeText(btn.textContent) === 'View Plan');
    return buttons.length === 1 ? buttons[0] : null;
  };

  const planLocateCard = (root, toolCallId) => {
    const cards = planCardCandidates(root, toolCallId);
    if (cards.length === 0) return { status: 'missing' };
    if (cards.length > 1) return { status: 'ambiguous' };
    const card = cards[0];
    if (!card.querySelector('[data-testid="composer-plan-filename"]')) return { status: 'not_plan' };
    if (!planViewPlanButton(card)) return { status: 'no_view_plan' };
    return { status: 'ok', card: card };
  };

  // Read-only: the uniquely located card's React fiber, then one composerDataHandle
  // on the return chain. Identity must match the host; the URI is never guessed
  // from title / params.name / planId, and nothing here scans the disk.
  const planReactFiber = (el) => {
    if (!el) return null;
    const keys = Object.keys(el).filter((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
    if (keys.length !== 1) return null;
    const fiber = el[keys[0]];
    return fiber && typeof fiber === 'object' ? fiber : null;
  };

  const planFileUriOrEmpty = (value) => {
    if (typeof value !== 'string' || !value) return '';
    if (value.indexOf('file:///') !== 0) return '';
    if (value.indexOf('?') !== -1 || value.indexOf('#') !== -1) return '';
    if (value.indexOf('\\\\') !== -1 || value.indexOf('%') !== -1 || value.indexOf('..') !== -1) return '';
    if (value.length < 8 || value.slice(-8) !== '.plan.md') return '';
    const path = value.slice(7);
    if (!path || path.charAt(0) !== '/' || path.charAt(path.length - 1) === '/') return '';
    const slash = path.lastIndexOf('/');
    const name = slash === -1 ? '' : path.slice(slash + 1);
    if (!name || name === '.plan.md' || name.indexOf('/') !== -1) return '';
    return value;
  };

  const planDirectPlanUri = (card, expectedToolCallId) => {
    if (!card || !expectedToolCallId) return '';
    const host = card.closest('[data-message-role="ai"][data-message-kind="tool"][data-tool-call-id]');
    if (!host) return '';
    const messageId = host.getAttribute('data-message-id');
    const hostCallId = host.getAttribute('data-tool-call-id');
    if (!messageId || !hostCallId || hostCallId !== expectedToolCallId) return '';
    const start = planReactFiber(card);
    if (!start) return '';
    const hits = [];
    let fiber = start;
    for (let i = 0; i < 16 && fiber; i += 1) {
      const props = fiber.memoizedProps;
      if (props && props.composerDataHandle) hits.push(props);
      fiber = fiber.return;
    }
    if (hits.length !== 1) return '';
    const props = hits[0];
    const vm = props.vm;
    if (props.bubbleId !== messageId) return '';
    if (!vm || vm.callId !== expectedToolCallId || vm.case !== 'createPlanToolCall') return '';
    const handle = props.composerDataHandle;
    const map = handle && handle.data ? handle.data.conversationMap : null;
    if (!map || !Object.prototype.hasOwnProperty.call(map, messageId)) return '';
    const toolCall = map[messageId];
    const tfd = toolCall ? toolCall.toolFormerData : null;
    if (!tfd || tfd.toolCallId !== expectedToolCallId || tfd.name !== 'create_plan') return '';
    const additional = tfd.additionalData;
    return planFileUriOrEmpty(additional ? additional.planUri : '');
  };

const planSelectedTabs = (tabSelector) => Array.from(document.querySelectorAll(tabSelector))
    .filter((tab) => tab.getAttribute('aria-selected') === 'true')
    .filter((tab) => (tab.getAttribute('data-resource-name') || '').length > 0);

  // Exactly one selected resource tab, inside exactly one editor group. An
  // editor switch caused by this flow opening the plan is expected; a
  // multi-selection or an ungrouped selection is not.
  const planSelection = (selectors) => {
    const tabs = planSelectedTabs(selectors.tab);
    if (tabs.length !== 1) return { status: 'selection_ambiguous', count: tabs.length };
    if (!tabs[0].closest(selectors.group)) return { status: 'selection_group_missing' };
    return { status: 'ok', resourceName: tabs[0].getAttribute('data-resource-name') || '' };
  };

  const planButtonBlocker = (button) => {
    if (button.disabled === true || button.hasAttribute('disabled')) return 'disabled';
    if (button.getAttribute('aria-disabled') === 'true') return 'disabled';
    if (button.hasAttribute('hidden') || button.getAttribute('aria-hidden') === 'true' || button.closest('[hidden]')) return 'hidden';
    const style = getComputedStyle(button);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return 'hidden';
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 'hidden';
    return '';
  };

  const planScrollContainer = (root, selector) => (root ? root.querySelector(selector) : null);

  // Short-lived observation of real user input on this page, one entry per read
  // attempt and keyed by that attempt's token. Only trusted browser events
  // count, so this program's own .click() and dispatched MouseEvents are
  // ignored. Listeners are passive: user input is never blocked, only noted.
  const planWatchEvents = ['pointerdown', 'mousedown', 'keydown', 'input', 'wheel'];

  const planWatchInstall = (token) => {
    if (!token) return { status: 'watch_invalid' };
    const registry = window.__cursorRemotePlanWatch || (window.__cursorRemotePlanWatch = {});
    if (registry[token]) return { status: 'watch_conflict' };
    const entry = { events: [], cleanup: null };
    const record = (event) => {
      if (!event || event.isTrusted !== true) return;
      if (entry.events.indexOf(event.type) === -1) entry.events.push(event.type);
    };
    for (const type of planWatchEvents) {
      document.addEventListener(type, record, { capture: true, passive: true });
    }
    entry.cleanup = () => {
      for (const type of planWatchEvents) document.removeEventListener(type, record, { capture: true });
    };
    registry[token] = entry;
    return { status: 'ok' };
  };

  const planWatchState = (token) => {
    const registry = window.__cursorRemotePlanWatch;
    const entry = registry && token ? registry[token] : null;
    if (!entry) return { status: 'watch_lost' };
    if (entry.events.length > 0) return { status: 'user_activity', events: entry.events.slice() };
    return { status: 'ok' };
  };

  const planWatchRemove = (token) => {
    const registry = window.__cursorRemotePlanWatch;
    const entry = registry && token ? registry[token] : null;
    if (!entry) return { status: 'absent' };
    if (typeof entry.cleanup === 'function') entry.cleanup();
    delete registry[token];
    if (Object.keys(registry).length === 0) delete window.__cursorRemotePlanWatch;
    return { status: 'removed' };
  };

  // Layout-compensation record for the transcript scroll. Cursor can re-anchor
  // the virtualized transcript right after this flow writes scrollTop: the
  // content above the viewport changes height and the browser keeps the visual
  // anchor by moving scrollTop by exactly the same amount. Each attempt records
  // what it just wrote - the scroller, its offsets, and the uniquely keyed
  // non-sticky message rows it could see - and a later step accepts a moved
  // offset only when every part of that story still holds. Nothing here waits
  // or allows a height difference on its own: a missing piece keeps the strict
  // rejection. Records live in this attempt's watch entry and die with it.
  const planScrollAnchorLimit = 6;

  const planScrollAnchors = (scroller) => {
    if (!scroller) return [];
    const rows = Array.from(scroller.querySelectorAll('[data-find-row-key][data-sticky="false"]'));
    // A Map, so a key that happens to collide with an Object prototype name
    // ("constructor", "toString") still counts as exactly one row.
    const keyCounts = new Map();
    for (const row of rows) {
      const key = row.getAttribute('data-find-row-key');
      if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const anchors = [];
    for (const row of rows) {
      if (anchors.length >= planScrollAnchorLimit) break;
      const key = row.getAttribute('data-find-row-key');
      // A key that is not unique in this transcript cannot anchor anything.
      if (!key || keyCounts.get(key) !== 1) continue;
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const top = rect.top - scrollerRect.top;
      // Only a row actually on screen can anchor a visual position.
      if (top + rect.height <= 0 || top >= scroller.clientHeight) continue;
      anchors.push({ key: key, top: top, height: rect.height });
    }
    return anchors;
  };

  const planScrollObserve = (token, scroller) => {
    const registry = window.__cursorRemotePlanWatch;
    const entry = registry && token ? registry[token] : null;
    if (!entry || !scroller) return { status: 'scroll_missing' };
    entry.scroll = {
      scroller: scroller,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
      anchors: planScrollAnchors(scroller),
    };
    return { status: 'ok' };
  };

  // True only for a layout shift this attempt can prove: the same scroller, an
  // unchanged viewport, an offset that moved by exactly what the content height
  // moved, and at least one uniquely keyed non-sticky row still at the same
  // place on screen (1px of rounding). On success the record advances, so the
  // same shift can never be counted twice.
  const planScrollReanchored = (token, scroller) => {
    const registry = window.__cursorRemotePlanWatch;
    const entry = registry && token ? registry[token] : null;
    const record = entry && entry.scroll ? entry.scroll : null;
    if (!record || record.scroller !== scroller) return false;
    const top = scroller.scrollTop;
    const height = scroller.scrollHeight;
    if (top === record.top) return false;
    if (scroller.clientHeight !== record.client) return false;
    if (top - record.top !== height - record.height) return false;
    const anchors = planScrollAnchors(scroller);
    let reanchored = false;
    for (const anchor of anchors) {
      const before = record.anchors.find((item) => item.key === anchor.key);
      if (!before) continue;
      if (Math.abs(anchor.top - before.top) <= 1 && Math.abs(anchor.height - before.height) <= 1) {
        reanchored = true;
        break;
      }
    }
    if (!reanchored) return false;
    record.top = top;
    record.height = height;
    record.anchors = anchors;
    return true;
  };

  // The offset this step may stand behind, or null when the transcript cannot be
  // tied to what this attempt recorded. The record has to name this very
  // scroller even when the offset already looks right: a freshly swapped
  // container that happens to sit at the same offset is still a change. A moved
  // offset is accepted only as the re-anchor proof above.
  const planScrollConfirmed = (token, scroller, expectedTop) => {
    if (!scroller) return null;
    const registry = window.__cursorRemotePlanWatch;
    const entry = registry && token ? registry[token] : null;
    const record = entry && entry.scroll ? entry.scroll : null;
    if (!record || record.scroller !== scroller) return null;
    const top = scroller.scrollTop;
    if (top === expectedTop) return top;
    return planScrollReanchored(token, scroller) ? scroller.scrollTop : null;
  };

  // Shared pre-side-effect check for one read attempt. Every mutating step
  // (transcript scroll, View Plan click, tab restore) and every read of the
  // plan editor runs this inside the same evaluate, so a DOM change the outer
  // poll has not observed yet still blocks the step. The token's interaction
  // watch is checked first and fails closed when it is gone. The expected
  // selection is '' before a selection is recorded; the expected scroll top is
  // null before this flow has scrolled.
  const planFlowState = (token, selectors, composerId, expectedSelection, flowScrollTop) => {
    const watch = planWatchState(token);
    if (watch.status !== 'ok') return { status: watch.status };
    const root = planComposerRoot(composerId);
    if (!root) return { status: 'composer_missing' };
    if (planDraftText(root) !== '') return { status: 'draft_present' };
    const selection = planSelection(selectors);
    if (selection.status !== 'ok') return { status: selection.status };
    if (expectedSelection && selection.resourceName !== expectedSelection) return { status: 'selection_changed' };
    if (flowScrollTop !== null) {
      const scroller = planScrollContainer(root, selectors.scroll);
      // A moved offset is accepted only as Cursor's own re-anchor, re-proved
      // against the same visible rows inside this same evaluate. Anything else
      // stays the strict rejection, and no record at all means no acceptance.
      const confirmed = planScrollConfirmed(token, scroller, flowScrollTop);
      if (confirmed === null) return { status: 'scroll_changed' };
      return { status: 'ok', root: root, resourceName: selection.resourceName, scrollTop: confirmed };
    }
    return { status: 'ok', root: root, resourceName: selection.resourceName };
  };

  const planStepPreflight = (token, selectors, composerId, toolCallId) => {
    const state = planFlowState(token, selectors, composerId, '', null);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', baseline: state.resourceName, cardStatus: planLocateCard(state.root, toolCallId).status };
  };

  const planStepScrollUp = (token, selectors, composerId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const scroller = planScrollContainer(state.root, selectors.scroll);
    if (!scroller) return { status: 'scroll_missing' };
    const before = scroller.scrollTop;
    // Both branches report the offset this guard just confirmed: a compensation
    // accepted above moved the transcript before this step wrote, so the caller
    // has to see it in order to keep following the position.
    if (before <= 0) return { status: 'scroll_top', scrollTop: state.scrollTop };
    const step = Math.max(1, Math.floor(scroller.clientHeight));
    scroller.scrollTop = Math.max(0, before - step);
    // Recorded in the same evaluate as the write, so a later re-anchor is
    // measured against exactly what this flow left behind.
    planScrollObserve(token, scroller);
    return { status: 'scrolled', before: before, after: scroller.scrollTop, scrollTop: state.scrollTop };
  };

  const planStepCardProbe = (token, selectors, composerId, toolCallId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', cardStatus: planLocateCard(state.root, toolCallId).status, scrollTop: state.scrollTop };
  };

  const planStepClickViewPlan = (token, selectors, composerId, toolCallId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const located = planLocateCard(state.root, toolCallId);
    if (located.status !== 'ok') return { status: 'card_' + located.status };
    const button = planViewPlanButton(located.card);
    if (!button) return { status: 'card_no_view_plan' };
    const blocker = planButtonBlocker(button);
    if (blocker) return { status: 'card_button_' + blocker };
    button.click();
    // Input that arrives while Cursor handles this click synchronously has to
    // invalidate the attempt in the same evaluate, before any read-back.
    const afterClick = planWatchState(token);
    if (afterClick.status !== 'ok') return { status: afterClick.status };
    return { status: 'clicked', scrollTop: state.scrollTop };
  };

  const planStepReadDirectUri = (token, selectors, composerId, toolCallId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const located = planLocateCard(state.root, toolCallId);
    if (located.status !== 'ok') return { status: 'card_' + located.status };
    let workspace = null;
    try {
      const ws = vscode.context.configuration().workspace;
      if (ws && ws.uri) {
        workspace = {
          id: ws.id,
          uri: { scheme: ws.uri.scheme, authority: ws.uri.authority, path: ws.uri.path },
          folderCount: Array.isArray(ws.folders) ? ws.folders.length : 1,
        };
      }
    } catch (e) {}
    return {
      status: 'ok',
      planUri: planDirectPlanUri(located.card, toolCallId) || '',
      workspace: workspace,
      scrollTop: state.scrollTop,
    };
  };

  const planStepReadOpen = (token, selectors, composerId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, '', flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const selection = planSelection(selectors);
    if (selection.status !== 'ok') return { status: selection.status };
    const resourceName = selection.resourceName;
    if (resourceName === expectedSelection) {
      return { status: 'not_open', resourceName: resourceName, scrollTop: state.scrollTop };
    }
    const group = planSelectedTabs(selectors.tab)[0].closest(selectors.group);
    const icons = Array.from(group.querySelectorAll(selectors.breadcrumb))
      .filter((icon) => (icon.getAttribute('aria-label') || '').trim().length > 0);
    if (icons.length !== 1) {
      return { status: 'path_ambiguous', resourceName: resourceName, count: icons.length, scrollTop: state.scrollTop };
    }
    const editors = Array.from(group.querySelectorAll(selectors.editor));
    if (editors.length !== 1) {
      return { status: 'editor_missing', resourceName: resourceName, count: editors.length, scrollTop: state.scrollTop };
    }
    if (editors[0].getAttribute('data-streaming') !== 'false') {
      return { status: 'editor_streaming', resourceName: resourceName, scrollTop: state.scrollTop };
    }
    let workspace = null;
    try {
      const ws = vscode.context.configuration().workspace;
      if (ws && ws.uri) {
        workspace = {
          id: ws.id,
          uri: { scheme: ws.uri.scheme, authority: ws.uri.authority, path: ws.uri.path },
          folderCount: Array.isArray(ws.folders) ? ws.folders.length : 1,
        };
      }
    } catch (e) {}
    return {
      status: 'ok',
      resourceName: resourceName,
      breadcrumbPath: (icons[0].getAttribute('aria-label') || '').trim(),
      workspace: workspace,
      scrollTop: state.scrollTop,
    };
  };

  const planStepRestoreTab = (token, selectors, composerId, expectedPlanSelection, baselineSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedPlanSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const tabs = planSelectedTabs(selectors.tab);
    if (tabs.length !== 1) return { status: 'selection_ambiguous' };
    const group = tabs[0].closest(selectors.group);
    if (!group) return { status: 'selection_group_missing' };
    const target = Array.from(group.querySelectorAll(selectors.tab))
      .find((tab) => tab.getAttribute('data-resource-name') === baselineSelection);
    if (!target) return { status: 'baseline_missing' };
    const dispatch = (type, buttons) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button: 0, buttons: buttons,
    }));
    dispatch('mousedown', 1);
    dispatch('mouseup', 0);
    return { status: 'restored', scrollTop: state.scrollTop };
  };

  // Read-only confirmation: exactly one document is selected, optionally the
  // one named here, and - when this flow scrolled - the transcript is at the
  // offset this attempt recorded. Used both by the restore poll and by the
  // final post-restore confirmation.
  const planStepVerifySelection = (token, selectors, composerId, flowScrollTop, expectedSelection) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection || '', flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', selection: state.resourceName, scrollTop: state.scrollTop };
  };

  const planStepRestoreScroll = (token, selectors, composerId, expectedSelection, flowScrollTop, restoreBase) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    const scroller = planScrollContainer(state.root, selectors.scroll);
    if (!scroller) return { status: 'scroll_missing' };
    // The guard above may have just accepted one more layout compensation: the
    // transcript moved by that much before this step could write, so the target
    // absorbs the delta instead of landing short of the original position.
    const delta = (typeof state.scrollTop === 'number' && typeof flowScrollTop === 'number')
      ? state.scrollTop - flowScrollTop
      : 0;
    const target = restoreBase + delta;
    scroller.scrollTop = target;
    if (scroller.scrollTop !== target) return { status: 'scroll_unverified' };
    // The restored position becomes this attempt's new record, so the final
    // confirmation can apply the same re-anchor proof instead of raw pixels.
    planScrollObserve(token, scroller);
    return { status: 'ok', restoredTop: scroller.scrollTop };
  };

  // --- Plan discovery, in the same page helpers ---------------------------
  // Reads only this exact composer's own AI tool wrappers that carry the
  // dedicated plan-filename marker. Nothing is expanded, clicked, or switched;
  // text is hard-clipped so a plan body can never ride along, and a label that
  // looks like a path is dropped instead of reported.
  const planDiscoverMaxCards = ${PLAN_DISCOVERY_MAX_PLANS};
  const planDiscoverTextMax = 200;
  const planDiscoverClip = (value) => {
    const text = planNormalizeText(value);
    return text.length > planDiscoverTextMax ? text.slice(0, planDiscoverTextMax) : text;
  };
  const planDiscoverTitle = (card) => {
    const label = card.querySelector('[data-testid="composer-plan-filename"]');
    if (!label) return '';
    const title = planDiscoverClip(label.textContent);
    if (!title) return '';
    for (const separator of [String.fromCharCode(47), String.fromCharCode(92)]) {
      if (title.indexOf(separator) !== -1) return '';
    }
    return title;
  };
  const planDiscoverCards = (root) => {
    if (!root) return [];
    const plans = [];
    const seen = new Set();
    const hosts = Array.from(root.querySelectorAll('[data-message-role="ai"][data-message-kind="tool"][data-tool-call-id]'));
    for (const host of hosts) {
      if (plans.length >= planDiscoverMaxCards) break;
      const toolCallId = planNormalizeText(host.getAttribute('data-tool-call-id'));
      if (!toolCallId || seen.has(toolCallId)) continue;
      const card = host.querySelector('.ui-tool-call-card[data-tool-call-card-marker="root"]');
      if (!card) continue;
      const title = planDiscoverTitle(card);
      if (!title) continue;
      seen.add(toolCallId);
      const summary = card.querySelector('.markdown-root');
      const description = planDiscoverClip(summary ? summary.textContent : '');
      plans.push(description
        ? { toolCallId: toolCallId, title: title, description: description }
        : { toolCallId: toolCallId, title: title });
    }
    return plans;
  };

  // Discovery preflight: the same watch / composer root / draft / single
  // selection checks as a read, with no card to locate. Only plain values
  // leave the page.
  const planStepDiscoverStart = (token, selectors, composerId) => {
    const state = planFlowState(token, selectors, composerId, '', null);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', baseline: state.resourceName };
  };

  const planStepScanPlans = (token, selectors, composerId, expectedSelection, flowScrollTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, flowScrollTop);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', plans: planDiscoverCards(state.root), scrollTop: state.scrollTop };
  };

  // Post-restore confirmation: this attempt's watch is still live, the composer
  // still holds no draft, exactly one document is still selected, and - when
  // this flow scrolled - the transcript is back where it started. The scroll
  // half is the same proof as everywhere else: a re-anchored view passes only
  // while the visible rows this attempt recorded are still in place.
  const planStepDiscoverDone = (token, selectors, composerId, expectedSelection, restoreTop) => {
    const state = planFlowState(token, selectors, composerId, expectedSelection, restoreTop);
    if (state.status !== 'ok') return { status: state.status };
    return { status: 'ok', selection: state.resourceName };
  };
`;

// Client-facing failures for every step status. Plan paths, plan bodies, and CDP
// exception text never reach a caller.
const PLAN_DOCUMENT_STEP_ERRORS: Record<string, string> = {
  watch_invalid: '计划文档交互监测不可用',
  watch_conflict: '计划文档交互监测不可用',
  watch_lost: '计划文档交互监测已失效',
  watch_install_failed: '计划文档交互监测不可用',
  user_activity: '检测到人工输入，已中止计划文档读取',
  composer_missing: '未找到该会话的输入区',
  draft_present: '该会话输入框已有草稿',
  selection_ambiguous: '编辑器选中的文档不唯一',
  selection_group_missing: '编辑器组不可用',
  selection_changed: '编辑器选中的文档已改变',
  scroll_missing: '未找到会话滚动容器',
  scroll_changed: '会话滚动位置已改变',
  scroll_unverified: '会话滚动位置无法恢复',
  card_missing: '未找到该计划卡片',
  card_ambiguous: '计划卡片不唯一',
  card_not_plan: '该消息卡片不是计划卡片',
  card_no_view_plan: '计划卡片没有唯一的 View Plan 按钮',
  card_button_disabled: 'View Plan 按钮已禁用',
  card_button_hidden: 'View Plan 按钮不可见',
  path_ambiguous: '计划文档路径不唯一',
  editor_missing: '未找到计划文档编辑器',
  editor_streaming: '计划文档仍在生成中',
  not_open: '计划文档未打开',
  doc_path_unsafe: '计划文档路径不可安全读取',
  doc_path_mismatch: '计划文档路径与打开的编辑器不一致',
  doc_not_opened: '计划文档未如期打开',
  doc_other_opened: '打开了其他文档',
  baseline_missing: '原编辑器标签已不存在',
  restore_unverified: '原编辑器标签未能恢复',
};
// Resolves the currently-open model picker menu element across Cursor versions.
// Older builds expose `[data-testid="model-picker-menu"]`; newer builds (~3.5.17)
// removed the testid and render the picker as a generic `[role="menu"]` opened
// via `.ui-model-picker__trigger`, so we cascade through several lookups.
// Stable across model-picker renders — Cursor's React 19 useId-generated IDs
// (`_r_ld_`, `_r_qm_`, …) change on every mount, so they round-trip badly as
// model identifiers. Treat anything matching this pattern as no-id and fall
// back to the synthetic `label::<text>` form.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

// Shared in-browser helpers for reading and clicking model-picker rows. Both
// the read path (`get_model_options`) and the write path (`set_model` /
// `set_plan_model`) use the same `collectModelItems()` / `pickModelById()`
// implementations so the round-trip is consistent — there's exactly one
// definition of "what counts as a model row" and "how to map an id back to a
// row." Inject as `${MODEL_ITEM_HELPERS_JS}` inside an evaluate().
export const MODEL_ITEM_HELPERS_JS = `
  const REACT_USE_ID_RE = ${REACT_USE_ID_RE.toString()};

  const labelOf = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button, [role="button"], .ui-menu__row-actions'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').replace(/\\s*Edit\\s*$/i, '').trim();
  };

  const stableIdOf = (el) => {
    const raw = el.id || '';
    if (!raw || REACT_USE_ID_RE.test(raw)) return '';
    return raw;
  };

  // Prefer semantic rows. Looking at every descendant selectors makes
  // a nested Edit/configure control look like a second model.
  const modelRowsIn = (menu) => {
    if (!menu) return [];
    const semantic = Array.from(menu.querySelectorAll('[role="menuitem"], [role="option"], [data-testid^="model-item-"]'));
    const raw = semantic.length ? semantic : Array.from(menu.querySelectorAll('[id], button, [data-testid]'));
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const clickModelRow = (item) => {
    const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
    clickable.click();
  };

  const collectModelItems = (menu) => {
    const items = modelRowsIn(menu);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = labelOf(item);
      if (!label) continue;
      if (/^(edit|configure|remove|delete|star|mode|max mode|add models)$/i.test(label)) continue;
      const stableId = stableIdOf(item);
      const key = stableId || label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({
        id: stableId || ('label::' + label),
        label,
        selected,
      });
    }
    return out;
  };

  // Finds and clicks the row whose id (or synthesized label::id) matches the
  // requested target. Targets can be: a real DOM id ("model-opus"), a
  // synthesized "label::<text>" (when the row has no stable id), an unstable
  // React useId ("_r_ld_"), or the bare label text. Returns true on success.
  const pickModelById = (menu, targetId) => {
    if (!menu || !targetId) return false;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) {
        clickModelRow(byId);
        return true;
      }
    }

    const rows = modelRowsIn(menu);
    // Pass 1: exact match (preferred — avoids "GPT-5" matching "GPT-5.5").
    const exactMatches = [];
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) exactMatches.push(item);
      } else if (stableId === targetId || ('label::' + label) === targetId) {
        exactMatches.push(item);
      }
    }
    if (exactMatches.length === 1) {
      clickModelRow(exactMatches[0]);
      return true;
    }
    if (exactMatches.length > 1) return false;

    // Pass 2: fuzzy/substring fallback for label::-style targets, in case the
    // live row has extra text (e.g. a "Premium" badge, subtitle) beyond what
    // collectModelItems captured. Guarded by length to avoid partial matches
    // like "GPT-5" matching "GPT-5.5".
    const fuzzyMatches = [];
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) fuzzyMatches.push(item);
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        fuzzyMatches.push(item);
      }
    }
    if (fuzzyMatches.length === 1) {
      clickModelRow(fuzzyMatches[0]);
      return true;
    }
    return false;
  };
`;

/** Completeness requires an unfiltered menu plus exhaustive-inventory evidence. */
export const MODEL_MENU_COMPLETENESS_JS = `
  const assessModelMenuCompleteness = (menu, itemCount) => {
    if (!menu) return { completeness: 'unknown', filterActive: false };
    const filterActive = [...menu.querySelectorAll('input, textarea')].some((el) => (el.value || '').trim().length > 0);
    if (filterActive) return { completeness: 'partial', filterActive: true };

    const verticalScrollables = [menu, ...menu.querySelectorAll('*')]
      .filter((el) => el.scrollHeight > el.clientHeight + 1);
    const setSizes = [...menu.querySelectorAll('[aria-setsize]')]
      .map((el) => Number(el.getAttribute('aria-setsize')))
      .filter((n) => Number.isFinite(n) && n > 0);
    const menuSetSize = Number(menu.getAttribute('aria-setsize') || '0');
    const setSize = Math.max(
      setSizes.length ? Math.max(...setSizes) : 0,
      Number.isFinite(menuSetSize) ? menuSetSize : 0,
    );
    if (setSize > 0) {
      return {
        completeness: itemCount >= setSize ? 'complete' : 'partial',
        filterActive: false,
      };
    }
    if (verticalScrollables.length === 0) {
      return { completeness: itemCount > 0 ? 'complete' : 'unknown', filterActive: false };
    }

    // A scrollbar alone does not imply virtualization. Cursor can mount every
    // semantic row in one continuous content tree and merely clip it through a
    // scroll viewport. Prove that case from geometry; otherwise stay partial.
    const scroller = verticalScrollables
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    const rows = typeof modelRowsIn === 'function' ? modelRowsIn(menu) : [];
    const scrollerRect = scroller.getBoundingClientRect();
    const intervals = rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        top: rect.top - scrollerRect.top + scroller.scrollTop,
        bottom: rect.bottom - scrollerRect.top + scroller.scrollTop,
        height: rect.height,
      };
    }).filter((entry) => entry.height > 0).sort((a, b) => a.top - b.top);
    let maxGap = 0;
    for (let i = 1; i < intervals.length; i += 1) {
      maxGap = Math.max(maxGap, intervals[i].top - intervals[i - 1].bottom);
    }
    const first = intervals[0];
    const last = intervals[intervals.length - 1];
    const leadingAllowance = Math.max(96, scroller.clientHeight * 0.35);
    const averageHeight = intervals.length
      ? intervals.reduce((sum, entry) => sum + entry.height, 0) / intervals.length
      : 0;
    const inventoryMounted = itemCount > 0
      && intervals.length >= itemCount
      && first?.top <= leadingAllowance
      && last?.bottom >= scroller.scrollHeight - 8
      && maxGap <= Math.max(32, averageHeight * 2);
    return { completeness: inventoryMounted ? 'complete' : 'partial', filterActive: false };
  };
`;

// Back-compat alias for tests that imported the old name.
export const MODEL_ITEM_COLLECTOR_JS = MODEL_ITEM_HELPERS_JS;

// Inject as `${MODEL_MENU_LOOKUP_JS}` inside an evaluate; call `findModelMenu()`.
export const MODEL_MENU_LOOKUP_JS = `
  const findModelMenu = () => {
    const byTestId = document.querySelector('[data-testid="model-picker-menu"]');
    if (byTestId) return byTestId;
    const triggers = document.querySelectorAll(
      '.ui-model-picker__trigger[aria-expanded="true"],' +
      '.composer-unified-dropdown-model[aria-expanded="true"],' +
      '.composer-unified-dropdown[aria-expanded="true"]'
    );
    for (const t of Array.from(triggers)) {
      const controls = t.getAttribute('aria-controls');
      if (controls) {
        const byControls = document.getElementById(controls);
        if (byControls) return byControls;
      }
    }
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) return openMenu;
    const visibleMenus = document.querySelectorAll('[role="menu"]:not([hidden])');
    for (const m of Array.from(visibleMenus)) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    return null;
  };
`;

export type ActionClickTargetResult = { element: Element } | { error: string };

const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

function normalizeActionLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function elementLabelMatches(element: Element, expectedLabel: string): boolean {
  // Questionnaire option rows render letter + label ("A" + "Explore…"), so
  // whole-text equality can never pass; compare the dedicated label span.
  // Freeform ("Other") rows have a textarea instead of a label span — the
  // client-facing label for them is always "Other".
  const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label');
  if (optionLabel) {
    return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  if (element.classList.contains('composer-questionnaire-toolbar-option-freeform')) {
    return normalizeActionLabel(expectedLabel) === 'other';
  }
  const truncatedLabel = element.querySelector('span.truncate');
  if (truncatedLabel) {
    return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  const visibleLabel = element.textContent?.trim() || element.getAttribute('aria-label') || '';
  return normalizeActionLabel(visibleLabel) === normalizeActionLabel(expectedLabel);
}

function isElementRoot(root: Document | Element): root is Element {
  return root.nodeType === 1;
}

function queryAllWithin(root: Document | Element, selector: string): Element[] {
  try {
    const descendants = Array.from(root.querySelectorAll(selector));
    if (isElementRoot(root) && root.matches(selector)) {
      return [root, ...descendants.filter(element => element !== root)];
    }
    return descendants;
  } catch {
    return [];
  }
}

function queryWithin(root: Document | Element, selector: string): Element | null {
  const matches = queryAllWithin(root, selector);
  return matches.length === 1 ? matches[0] : null;
}

function firstSelectorSegment(selectorPath: string): string {
  return selectorPath.split('>')[0]?.trim() ?? '';
}

function actionSearchRoot(root: Document | Element, selectorPath: string): Document | Element {
  const firstSegment = firstSelectorSegment(selectorPath);
  if (!firstSegment) return root;
  return queryWithin(root, firstSegment) ?? root;
}

function buttonLikeCandidates(root: Document | Element): Element[] {
  const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
  if (isElementRoot(root) && root.matches(ACTION_BUTTON_SELECTOR)) {
    return [root, ...descendants.filter(el => el !== root)];
  }
  return descendants;
}

function matchingResolvedActionTargets(element: Element, expectedLabel: string): Element[] {
  const matches: Element[] = [];
  const add = (candidate: Element | null): void => {
    if (candidate && elementLabelMatches(candidate, expectedLabel) && !matches.includes(candidate)) {
      matches.push(candidate);
    }
  };

  add(element.closest(ACTION_BUTTON_SELECTOR));
  if (element.matches(ACTION_BUTTON_SELECTOR)) add(element);
  for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) add(child);
  if (matches.length === 0 && elementLabelMatches(element, expectedLabel)) add(element);
  return matches;
}

/** Attribute-level pre-click blockers. Keep in sync with ACTION_CLICK_RESOLVER_JS. */
export function actionTargetRevalidationError(element: Element): string | null {
  const ariaDisabled = element.getAttribute('aria-disabled');
  const dataDisabled = element.getAttribute('data-disabled');
  if (
    ('disabled' in element && (element as HTMLButtonElement).disabled)
    || element.hasAttribute('disabled')
    || ariaDisabled === 'true'
    || dataDisabled === 'true'
  ) {
    return 'action target is disabled';
  }
  if (
    (element as HTMLElement).hidden
    || element.hasAttribute('hidden')
    || element.getAttribute('aria-hidden') === 'true'
    || element.closest('[hidden]')
  ) {
    return 'action target is hidden';
  }
  return null;
}

function acceptResolvedTarget(element: Element): ActionClickTargetResult {
  const blocker = actionTargetRevalidationError(element);
  return blocker ? { error: blocker } : { element };
}

/** Pre-click failures must release the reservation; dispatched one-shots must consume. */
export function isActionRevalidationFailure(error?: string): boolean {
  if (!error) return false;
  if (error === 'Not connected to Cursor') return true;
  if (error === 'action composer scope changed') return true;
  if (error === 'action is not executable') return true;
  if (error.includes('generation_changed')) return true;
  if (error.startsWith('Pre-dispatch check failed')) return true;
  if (error.startsWith('action target is ')) return true;
  if (error.startsWith('action target not found')) return true;
  return false;
}

// Keep in sync with ACTION_CLICK_RESOLVER_JS below.
export function resolveActionClickTarget(
  root: Document | Element,
  selectorPath: string,
  expectedLabel: string,
  capabilityScope?: Element | null,
): ActionClickTargetResult {
  const exactTargets = queryAllWithin(root, selectorPath)
    .flatMap(element => matchingResolvedActionTargets(element, expectedLabel))
    .filter((element, index, all) => all.indexOf(element) === index)
    .filter(element => !capabilityScope || capabilityScope === element || capabilityScope.contains(element));
  if (exactTargets.length === 1) return acceptResolvedTarget(exactTargets[0]);
  if (exactTargets.length > 1) {
    return { error: `action target is ambiguous (label: ${expectedLabel})` };
  }

  const scope = capabilityScope ?? actionSearchRoot(root, selectorPath);
  const matches = buttonLikeCandidates(scope)
    .filter(element => elementLabelMatches(element, expectedLabel));

  if (matches.length === 1) return acceptResolvedTarget(matches[0]);
  return { error: matches.length > 1
    ? `action target is ambiguous (label: ${expectedLabel})`
    : `action target not found (label: ${expectedLabel})` };
}

// Keep in sync with resolveActionClickTarget() above. Inject as
// `${ACTION_CLICK_RESOLVER_JS}` inside an evaluate().
export const ACTION_CLICK_RESOLVER_JS = `
  const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

  const normalizeActionLabel = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();

  const elementLabelMatches = (element, expectedLabel) => {
    const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label');
    if (optionLabel) {
      return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    if (element.classList.contains('composer-questionnaire-toolbar-option-freeform')) {
      return normalizeActionLabel(expectedLabel) === 'other';
    }
    const truncatedLabel = element.querySelector('span.truncate');
    if (truncatedLabel) {
      return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    const visibleLabel = (element.textContent || '').trim() || element.getAttribute('aria-label') || '';
    return normalizeActionLabel(visibleLabel) === normalizeActionLabel(expectedLabel);
  };

  const queryAllWithin = (root, selector) => {
    try {
      const descendants = Array.from(root.querySelectorAll(selector));
      if (root instanceof Element && root.matches(selector)) {
        return [root, ...descendants.filter(element => element !== root)];
      }
      return descendants;
    } catch {
      return [];
    }
  };

  const queryWithin = (root, selector) => {
    const matches = queryAllWithin(root, selector);
    return matches.length === 1 ? matches[0] : null;
  };

  const firstSelectorSegment = (selectorPath) => {
    const first = selectorPath.split('>')[0];
    return first ? first.trim() : '';
  };

  const actionSearchRoot = (root, selectorPath) => {
    const firstSegment = firstSelectorSegment(selectorPath);
    if (!firstSegment) return root;
    return queryWithin(root, firstSegment) || root;
  };

  const buttonLikeCandidates = (root) => {
    const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
    if (root instanceof Element && root.matches(ACTION_BUTTON_SELECTOR)) {
      return [root, ...descendants.filter(el => el !== root)];
    }
    return descendants;
  };

  const matchingResolvedActionTargets = (element, expectedLabel) => {
    const matches = [];
    const add = (candidate) => {
      if (candidate && elementLabelMatches(candidate, expectedLabel) && !matches.includes(candidate)) {
        matches.push(candidate);
      }
    };

    add(element.closest(ACTION_BUTTON_SELECTOR));
    if (element.matches(ACTION_BUTTON_SELECTOR)) add(element);
    for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) add(child);
    if (matches.length === 0 && elementLabelMatches(element, expectedLabel)) add(element);
    return matches;
  };

  const actionTargetRevalidationError = (element) => {
    const ariaDisabled = element.getAttribute('aria-disabled');
    const dataDisabled = element.getAttribute('data-disabled');
    if (
      element.disabled === true
      || element.hasAttribute('disabled')
      || ariaDisabled === 'true'
      || dataDisabled === 'true'
    ) {
      return 'action target is disabled';
    }
    if (
      element.hidden
      || element.hasAttribute('hidden')
      || element.getAttribute('aria-hidden') === 'true'
      || element.closest('[hidden]')
    ) {
      return 'action target is hidden';
    }
    return null;
  };

  const acceptResolvedTarget = (element) => {
    const blocker = actionTargetRevalidationError(element);
    return blocker ? { error: blocker } : { element: element };
  };

  const resolveActionClickTarget = (root, selectorPath, expectedLabel, capabilityScope) => {
    const exactTargets = queryAllWithin(root, selectorPath)
      .flatMap(element => matchingResolvedActionTargets(element, expectedLabel))
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter(element => !capabilityScope || capabilityScope === element || capabilityScope.contains(element));
    if (exactTargets.length === 1) return acceptResolvedTarget(exactTargets[0]);
    if (exactTargets.length > 1) {
      return { error: 'action target is ambiguous (label: ' + expectedLabel + ')' };
    }

    const scope = capabilityScope || actionSearchRoot(root, selectorPath);
    const matches = buttonLikeCandidates(scope)
      .filter(element => elementLabelMatches(element, expectedLabel));

    if (matches.length === 1) return acceptResolvedTarget(matches[0]);
    return { error: matches.length > 1
      ? 'action target is ambiguous (label: ' + expectedLabel + ')'
      : 'action target not found (label: ' + expectedLabel + ')' };
  };
`;

interface CachedCommandResult {
  expiresAt: number;
  result: Promise<CommandResult>;
}

export interface CapabilityGuardSource {
  getSnapshot(targetId?: string): CapabilitySummary | null;
  getActiveTargetId(): string;
  getTargetGeneration(targetId?: string): number;
}

class CapabilityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDeniedError';
  }
}

/**
 * Pick a mode row by comparing DOM attributes / labels to `modeId`.
 * Selectors are static — the id is never interpolated into CSS.
 * Inject as `${MODE_ITEM_PICK_JS}` inside an evaluate(); call `pickModeById(modeId)`.
 */
export const MODE_ITEM_PICK_JS = `
  const pickModeById = (modeId) => {
    if (typeof modeId !== 'string' || !modeId) return { ok: false, count: 0 };
    const isVisible = (item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const matchesMode = (item) => {
      const idAttr = item.getAttribute('id') || '';
      const dataMode = item.getAttribute('data-mode') || '';
      const dataModeId = item.getAttribute('data-mode-id') || '';
      return (idAttr.includes('composer-mode-') && idAttr.endsWith('-' + modeId))
        || dataMode === modeId
        || dataModeId === modeId;
    };
    const direct = Array.from(document.querySelectorAll('[id*="composer-mode-"], [data-mode], [data-mode-id]'))
      .filter(item => !item.closest('.composer-bar-input-buttons'))
      .filter(isVisible)
      .filter(matchesMode);
    const directTargets = direct
      .map(item => item.querySelector('.composer-unified-context-menu-item') || item)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (directTargets.length === 1) {
      directTargets[0].click();
      return { ok: true, count: 1 };
    }
    if (directTargets.length > 1) return { ok: false, count: directTargets.length };

    const labelTargets = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
      .filter(item => (item.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === modeId.toLowerCase());
    if (labelTargets.length !== 1) return { ok: false, count: labelTargets.length };
    labelTargets[0].click();
    return { ok: true, count: 1 };
  };
`;

export interface CommandDispatchOptions {
  /** Runs inside the target UI lane immediately before the first DOM/Input mutation. */
  beforeDispatch?: () => void | Promise<void>;
  /** Supervisory writes disable retries because a failed response may follow a real side effect. */
  retry?: boolean;
  /** Existing Web/Telegram calls are human initiated unless the scoped service opts out. */
  humanInitiated?: boolean;
}

export class CommandExecutor {
  private selectors: SelectorConfig;
  private client: CdpClient | null = null;
  /** Per-window (per CDP client) command tail — serialize clicks/typing on one window. */
  private commandTails = new WeakMap<object, Promise<unknown>>();
  private noClientTail: Promise<unknown> = Promise.resolve();
  private uiCoordinator: TargetUiCoordinator | null = null;
  private targetIdProvider: (() => string) | null = null;
  private targetGenerationProvider: (() => number) | null = null;
  private commandResultCache = new Map<string, CachedCommandResult>();
  private actionRegistry: ActionRegistry | null = null;
  private capabilityGuard: CapabilityGuardSource | null = null;
  private humanTakeoverHandler: (() => void | Promise<void>) | null = null;

  constructor(selectors: SelectorConfig) {
    this.selectors = selectors;
  }

  /**
   * Put every interactive command behind the same per-target lane used by
   * capability probes. The providers are deliberately read at enqueue time so
   * a reconnect or window switch cannot reuse an old target generation.
   */
  setUiCoordinator(
    coordinator: TargetUiCoordinator | null,
    targetIdProvider?: () => string,
    targetGenerationProvider?: () => number,
  ): void {
    this.uiCoordinator = coordinator;
    this.targetIdProvider = targetIdProvider ?? null;
    this.targetGenerationProvider = targetGenerationProvider ?? null;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  /** Read the current composer immediately; callers must already hold the target UI lane. */
  async hasComposerDraftNow(): Promise<boolean | null> {
    const client = this.client;
    if (!client || !client.isConnected()) return null;
    const strategies = this.selectors.chatInput.strategies;
    try {
      return await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          let input = null;
          for (const sel of strategies) {
            try { input = document.querySelector(sel); if (input) break; } catch {}
          }
          if (!input) return null;
          const valueText = typeof input.value === 'string' ? input.value : '';
          const contentText = input.textContent || input.innerText || '';
          const text = input.isContentEditable ? contentText : (valueText || contentText);
          return text.trim().length > 0;
        })()
      `) as boolean | null;
    } catch {
      return null;
    }
  }

  setHumanTakeoverHandler(handler: (() => void | Promise<void>) | null): void {
    this.humanTakeoverHandler = handler;
  }

  setActionRegistry(registry: ActionRegistry | null): void {
    this.actionRegistry = registry;
  }

  /**
   * Bind the runtime capability catalog used to authorize setMode/setModel.
   * Unset means fail-closed: no production mode/model mutation is allowed.
   */
  setCapabilityGuard(guard: CapabilityGuardSource | null): void {
    this.capabilityGuard = guard;
  }

  private capabilityError(kind: 'mode' | 'model', id: string): string | null {
    return capabilityAllows(kind, id, {
      snapshot: this.capabilityGuard?.getSnapshot() ?? null,
      activeTargetId: this.capabilityGuard?.getActiveTargetId() ?? this.targetIdProvider?.() ?? '',
      getTargetGeneration: (targetId) =>
        this.capabilityGuard?.getTargetGeneration(targetId) ?? this.targetGenerationProvider?.() ?? 0,
    });
  }

  /** Execute only a server-registered opaque action. The selector is never supplied by the client. */
  async clickRegisteredAction(
    commandId: string,
    actionId: string,
    expectedTarget?: { targetId?: string; targetGeneration?: number; actionType?: string },
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult> {
    if (!this.actionRegistry) return { commandId, ok: false, error: 'Action authorization is unavailable' };
    let reservedId = '';
    let dispatchAuthorized = false;
    const currentTargetId = this.targetIdProvider?.() ?? expectedTarget?.targetId;
    const currentGeneration = this.targetGenerationProvider?.() ?? expectedTarget?.targetGeneration;
    try {
      const target = this.actionRegistry.reserve(actionId, {
        targetId: currentTargetId,
        targetGeneration: currentGeneration,
        ...(expectedTarget?.actionType ? { actionType: expectedTarget.actionType } : {}),
      });
      reservedId = target.actionId;
      if (!isExecutableActionType(target.actionType)) {
        this.actionRegistry.release(actionId);
        return { commandId, ok: false, error: 'action is not executable' };
      }
      // The registry scope is checked before queueing and the coordinator
      // checks this generation again when the operation starts. This prevents
      // a queued action from crossing a reconnect/window switch.
      const guardedOptions: CommandDispatchOptions = {
        ...opts,
        beforeDispatch: async () => {
          await opts.beforeDispatch?.();
          dispatchAuthorized = true;
        },
      };
      const result = await this.clickAction(commandId, target.selectorPath, target.expectedLabel, {
        composerId: target.composerId,
        toolCallId: target.toolCallId,
      }, { ...guardedOptions, retry: opts.retry ?? false });
      const scope = { targetId: target.targetId, targetGeneration: target.targetGeneration, ...(expectedTarget?.actionType ? { actionType: expectedTarget.actionType } : {}) };
      if (!dispatchAuthorized && !result.ok) this.actionRegistry.release(actionId);
      else this.settleRegisteredAction(actionId, scope, result);
      return result;
    } catch (err) {
      if (!dispatchAuthorized && reservedId) this.actionRegistry.release(reservedId);
      else this.settleRegisteredActionError(actionId, reservedId, err);
      const message = err instanceof ActionRegistryError ? err.code : (err instanceof Error ? err.message : String(err));
      return { commandId, ok: false, error: message };
    }
  }

  async getRegisteredPlanModelOptions(commandId: string, actionId: string): Promise<CommandResult> {
    if (!this.actionRegistry) return { commandId, ok:false, error:'Action authorization is unavailable' };
    let target;
    try {
      target = this.actionRegistry.reserve(actionId, {
        targetId: this.targetIdProvider?.(),
        targetGeneration: this.targetGenerationProvider?.(),
        actionType: 'plan_model',
      });
      const result = await this.getPlanModelOptions(commandId, target.selectorPath);
      this.actionRegistry.release(actionId);
      return result;
    } catch (err) {
      if (target) this.actionRegistry.release(actionId);
      return { commandId, ok:false, error:err instanceof ActionRegistryError ? err.code : (err instanceof Error ? err.message : String(err)) };
    }
  }

  async setRegisteredPlanModel(
    commandId: string,
    actionId: string,
    planModelId: string,
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult> {
    if (!this.actionRegistry) return { commandId, ok:false, error:'Action authorization is unavailable' };
    let reservedId = '';
    let dispatchAuthorized = false;
    try {
      const target = this.actionRegistry.reserve(actionId, {
        targetId: this.targetIdProvider?.(),
        targetGeneration: this.targetGenerationProvider?.(),
        actionType: 'plan_model',
      });
      reservedId = target.actionId;
      const result = await this.setPlanModel(commandId, target.selectorPath, planModelId, {
        ...opts,
        beforeDispatch: async () => {
          await opts.beforeDispatch?.();
          dispatchAuthorized = true;
        },
      });
      const scope = { targetId: target.targetId, targetGeneration: target.targetGeneration, actionType: 'plan_model' };
      if (!dispatchAuthorized && !result.ok) this.actionRegistry.release(actionId);
      else this.settleRegisteredAction(actionId, scope, result);
      return result;
    } catch (err) {
      if (!dispatchAuthorized && reservedId) this.actionRegistry.release(reservedId);
      else this.settleRegisteredActionError(actionId, reservedId, err);
      return { commandId, ok:false, error:err instanceof ActionRegistryError ? err.code : (err instanceof Error ? err.message : String(err)) };
    }
  }

  /**
   * Consume after a dispatched one-shot. Release when the click never left
   * pre-click revalidation (hidden/disabled/ambiguous/scope/label/generation).
   */
  private settleRegisteredAction(
    actionId: string,
    scope: { targetId?: string; targetGeneration?: number; actionType?: string },
    result: CommandResult,
  ): void {
    if (!this.actionRegistry) return;
    if (result.ok || !isActionRevalidationFailure(result.error)) {
      this.actionRegistry.consume(actionId, scope);
      return;
    }
    this.actionRegistry.release(actionId);
  }

  private settleRegisteredActionError(actionId: string, reservedId: string, err: unknown): void {
    if (!this.actionRegistry || !reservedId) return;
    const generationOrCancel = err instanceof TargetUiError
      && (err.code === 'generation_changed' || err.code === 'cancelled' || err.code === 'aborted');
    const message = err instanceof Error ? err.message : String(err);
    if (generationOrCancel || isActionRevalidationFailure(message)) {
      this.actionRegistry.release(reservedId);
      return;
    }
    try { this.actionRegistry.consume(actionId); } catch { this.actionRegistry.release(reservedId); }
  }

  /**
   * Run `fn` after any in-flight command for the same window client.
   * Different clients (windows) do not block each other.
   */
  private enqueueWindowCommand<T>(client: CdpClient | null, fn: () => Promise<T>): Promise<T> {
    if (!client) {
      const next = this.noClientTail.then(fn, fn);
      this.noClientTail = next.then(() => undefined, () => undefined);
      return next;
    }
    const prev = this.commandTails.get(client) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.commandTails.set(client, next.then(() => undefined, () => undefined));
    return next;
  }

  async sendMessage(commandId: string, text: string, opts: CommandDispatchOptions = {}): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;

      // Step 1: Find and focus the input element (evaluate only for DOM query + focus)
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          let input = null;
          let matchedSelector = '';
          for (const sel of strategies) {
            try {
              input = document.querySelector(sel);
              if (input) { matchedSelector = sel; break; }
            } catch {}
          }
          if (!input) return { ok: false, error: 'Chat input not found (tried ' + strategies.length + ' selectors)' };

          const info = input.tagName + '.' + Array.from(input.classList).join('.') + ' | sel=' + matchedSelector;
          input.scrollIntoView({ block: 'center', behavior: 'instant' });
          input.focus();
          input.click();
          return { ok: true, info };
        })()
      `) as { ok: boolean; error?: string; info?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Failed to focus input');
      }

      console.log(`[command-executor] Focused: ${result.info}`);
      await sleep(FOCUS_DELAY_MS);

      // Step 2: Clear any existing text via Ctrl+A then Delete (CDP Input domain)
      await client.pressKey('a', 'KeyA', 65, 2); // 2 = Ctrl modifier
      await sleep(50);
      await client.pressKey('Backspace', 'Backspace', 8);
      await sleep(50);

      // Step 3: Insert text via CDP Input.insertText (native Chromium input pipeline)
      await client.typeText(text);
      console.log(`[command-executor] Text inserted via Input.insertText (${text.length} chars)`);
      await sleep(150);

      // Step 4: Submit with Enter via CDP Input.dispatchKeyEvent
      await client.pressKey('Enter', 'Enter', 13);
      console.log(`[command-executor] Enter pressed via CDP Input.dispatchKeyEvent`);

      const trimmedText = text.trim();
      if (opts.retry !== false && trimmedText.length > 0) {
        await sleep(300);
        const stillContainsTypedText = await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(strategies)};
            const typedText = ${JSON.stringify(trimmedText)};
            let input = null;
            for (const sel of strategies) {
              try {
                input = document.querySelector(sel);
                if (input) break;
              } catch {}
            }
            if (!input) return false;
            const valueText = typeof input.value === 'string' ? input.value : '';
            const contentText = input.textContent ?? input.innerText ?? '';
            const currentText = (input.isContentEditable ? contentText : (valueText || contentText)).trim();
            return currentText.length > 0 && currentText.includes(typedText);
          })()
        `) as boolean;

        if (stillContainsTypedText) {
          const isMac = process.platform === 'darwin';
          await client.pressKey('Enter', 'Enter', 13, isMac ? 4 : 2);
          console.log(`[command-executor] ${isMac ? 'Cmd' : 'Ctrl'}+Enter retry fired because composer still contained typed text`);
        }
      }
    }, opts);
  }

  async clickApproval(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.click(selectorPath);
    });
  }

  async approveAll(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const selector = await this.findApproveAllButton(client);
      if (!selector) {
        throw new Error('"Accept All" button not found');
      }
      await client.click(selector);
    });
  }

  async reject(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.clickApproval(commandId, selectorPath);
  }

  async scrollChatUp(commandId: string, times: number = 5): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      for (let i = 0; i < times; i++) {
        await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(containerSelectors)};
            for (const sel of strategies) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const scrollable = el.querySelector('[class*="scroll"]') || el;
                  scrollable.scrollTop = 0;
                  return true;
                }
              } catch {}
            }
            return false;
          })()
        `);
        await sleep(500);
      }
      console.log(`[command-executor] Scrolled chat up ${times} times`);
    });
  }

  async scrollChatToBottom(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(containerSelectors)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const scrollable = el.querySelector('[class*="scroll"]') || el;
                scrollable.scrollTop = scrollable.scrollHeight;
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `);
      console.log('[command-executor] Scrolled chat to bottom');
    });
  }

  async switchTab(
    commandId: string,
    tabTitle: string,
    _selectorPath?: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const clicked = await client.evaluate(`
        (() => {
          const title = ${JSON.stringify(tabTitle)};
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          const target = norm(title);
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function glassCompositeForBtn(btn) {
            const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
            const rawAgent = (labelEl?.textContent || '').trim();
            if (!rawAgent) return { composite: '', agentOnly: '' };
            const group = btn.closest('.ui-sidebar-group');
            const gt = group?.querySelector('.ui-sidebar-group-label-title');
            const rawGroup = (gt?.textContent || '').trim();
            let composite = cleanTabTitle(rawAgent);
            if (rawGroup) {
              const g = cleanTabTitle(rawGroup);
              if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
            }
            return { composite: norm(composite), agentOnly: norm(rawAgent) };
          }
          const glassBtns = Array.from(document.querySelectorAll(
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
          ));
          if (glassBtns.length > 0) {
            const rows = glassBtns.map((btn) => ({
              btn,
              ...glassCompositeForBtn(btn),
            })).filter((r) => r.composite);
            const byComp = rows.filter((r) => r.composite === target);
            if (byComp.length === 1) {
              byComp[0].btn.click();
              return true;
            }
            const byAgent = rows.filter((r) => r.agentOnly === target);
            if (byAgent.length === 1) {
              byAgent[0].btn.click();
              return true;
            }
            if (byComp.length > 1 || byAgent.length > 1) {
              throw new Error('Ambiguous tab title for glass sidebar: ' + title);
            }
          }
          const cells = document.querySelectorAll('.agent-sidebar-cell');
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text === target) {
              cell.click();
              return true;
            }
          }
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text.startsWith(target) || target.startsWith(text)) {
              cell.click();
              return true;
            }
          }
          return false;
        })()
      `) as boolean;
      if (!clicked) throw new Error('Tab not found: ' + tabTitle);
      console.log(`[command-executor] Switched tab: ${tabTitle}`);
    });
  }

  async newChat(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.newChatButton?.strategies ?? [];
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!result) throw new Error('New Chat button not found');
      console.log(`[command-executor] New chat created`);
    });
  }

  async setMode(commandId: string, modeId: string, opts: CommandDispatchOptions = {}): Promise<CommandResult> {
    const denied = this.capabilityError('mode', modeId);
    if (denied) return { commandId, ok: false, error: denied };

    return this.withRetry(commandId, async (client) => {
      const deniedNow = this.capabilityError('mode', modeId);
      if (deniedNow) throw new CapabilityDeniedError(deniedNow);

      const strategies = this.selectors.modeDropdown?.strategies ?? [];

      // Click the dropdown trigger to open the menu
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          const candidates = [];
          for (const sel of strategies) {
            try { candidates.push(...document.querySelectorAll(sel)); } catch {}
          }
          candidates.push(...document.querySelectorAll('.composer-unified-dropdown[data-mode], [data-mode-id]'));
          const triggers = [];
          for (const raw of candidates) {
            const element = raw.matches('.composer-unified-dropdown, [data-mode-id]')
              ? raw
              : raw.querySelector('.composer-unified-dropdown[data-mode], [data-mode-id]');
            if (!element || element.hasAttribute('data-stop-button') || triggers.includes(element)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) triggers.push(element);
          }
          if (triggers.length !== 1) return { ok: false, count: triggers.length };
          triggers[0].click();
          return { ok: true, count: 1 };
        })()
      `) as { ok: boolean; count: number } | null;
      if (!opened?.ok) throw new Error(`Mode dropdown target is not unique (found ${opened?.count ?? 0})`);

      await sleep(250);

      // Click the mode item by comparing attributes/labels — never interpolate modeId into CSS.
      const selected = await client.evaluate(`
        (() => {
          ${MODE_ITEM_PICK_JS}
          return pickModeById(${JSON.stringify(modeId)});
        })()
      `) as { ok: boolean; count: number } | null;
      if (!selected?.ok) throw new Error(`Mode "${modeId}" target is not unique (found ${selected?.count ?? 0})`);
      console.log(`[command-executor] Mode set to: ${modeId}`);
    }, opts);
  }

  async clickAction(
    commandId: string,
    selectorPath: string,
    expectedLabel?: string,
    expectedScope?: { composerId?: string; toolCallId?: string },
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (expectedLabel === undefined) {
        await client.click(selectorPath);
        console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)}`);
        return;
      }

      const result = await client.evaluate(`
        (() => {
          ${ACTION_CLICK_RESOLVER_JS}

          const selectorPath = ${JSON.stringify(selectorPath)};
          const expectedLabel = ${JSON.stringify(expectedLabel)};
          const composerId = ${JSON.stringify(expectedScope?.composerId ?? '')};
          const rawToolCallId = ${JSON.stringify(expectedScope?.toolCallId ?? '')};
          const toolCallId = rawToolCallId.startsWith('tool:') ? rawToolCallId.slice(5) : rawToolCallId;
          const findUniqueAttributeScope = (attribute, value) => {
            if (!value) return null;
            const matches = Array.from(document.querySelectorAll('[' + attribute + ']'))
              .filter(element => element.getAttribute(attribute) === value);
            const roots = matches.filter(element =>
              !matches.some(other => other !== element && other.contains(element))
            );
            return roots.length === 1 ? roots[0] : null;
          };
          const toolScope = findUniqueAttributeScope('data-tool-call-id', toolCallId);
          const composerScope = findUniqueAttributeScope('data-composer-id', composerId);
          if (composerId && !composerScope) return { ok: false, error: 'action composer scope changed' };
          const capabilityScope = toolScope || composerScope;
          const target = resolveActionClickTarget(document, selectorPath, expectedLabel, capabilityScope);
          if (!target.element) return { ok: false, error: target.error };
          const blocker = actionTargetRevalidationError(target.element);
          if (blocker) return { ok: false, error: blocker };
          const style = getComputedStyle(target.element);
          const rect = target.element.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return { ok: false, error: 'action target is hidden' };
          }
          if (rect.width <= 0 || rect.height <= 0) {
            return { ok: false, error: 'action target is hidden' };
          }

          try { target.element.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
          target.element.click();
          return { ok: true };
        })()
      `) as { ok: boolean; error?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? `action target not found (label: ${expectedLabel})`);
      }
      console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)} (${expectedLabel})`);
    }, opts);
  }

  async extractToolContent(toolCallId: string): Promise<{ code: string; language?: string; filename?: string } | null> {
    const queuedClient = this.client;
    const run = () => this.enqueueWindowCommand(queuedClient, () => this.extractToolContentOnClient(queuedClient, toolCallId));
    const targetId = this.targetIdProvider?.() ?? '';
    const generation = this.targetGenerationProvider?.() ?? undefined;
    if (!this.uiCoordinator || !targetId) return run();
    return this.uiCoordinator.enqueue(targetId, () => run(), { generation, label: 'command:extract_tool_content' });
  }

  private async extractToolContentOnClient(
    client: CdpClient | null,
    toolCallId: string
  ): Promise<{ code: string; language?: string; filename?: string } | null> {
    if (!client || !client.isConnected()) return null;

    const result = await client.evaluate(`
      (() => {
        const tcId = ${JSON.stringify(toolCallId)};
        const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
        const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
          || document.querySelector('[data-tool-call-id="' + tcId + '"]')?.closest(wrapperSel)
          || (() => {
            for (const el of document.querySelectorAll(wrapperSel)) {
              const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
              if (inner) return el;
            }
            return null;
          })();
        if (!wrapper) return null;

        const wasCollapsed = !!wrapper.querySelector('.composer-tool-former-message');
        if (wasCollapsed) {
          const header = wrapper.querySelector('.composer-tool-former-message') || wrapper.querySelector('.ui-collapsible-header');
          if (header) header.click();
        }

        function extract() {
          // Edit tool: look for code content in the diff viewer
          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();

            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          // Shell tool output
          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          // Generic expanded content
          const preEl = wrapper.querySelector('pre');
          if (preEl) {
            return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };
          }

          // Full text fallback
          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        }

        if (wasCollapsed) {
          return '__NEED_WAIT__';
        }
        return extract();
      })()
    `) as { code: string; language?: string; filename?: string } | '__NEED_WAIT__' | null;

    if (result === '__NEED_WAIT__') {
      await sleep(600);
      const expanded = await client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return null;

          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();
            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          const preEl = wrapper.querySelector('pre');
          if (preEl) return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };

          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        })()
      `) as { code: string; language?: string; filename?: string } | null;

      // Collapse back
      await client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return;
          const header = wrapper.querySelector('.ui-collapsible-header') || wrapper.querySelector('.composer-tool-former-message');
          if (header) header.click();
        })()
      `);

      return expanded;
    }

    return result;
  }

  async setModel(commandId: string, modelId: string, opts: CommandDispatchOptions = {}): Promise<CommandResult> {
    const denied = this.capabilityError('model', modelId);
    if (denied) return { commandId, ok: false, error: denied };

    return this.withRetry(commandId, async (client) => {
      const deniedNow = this.capabilityError('model', modelId);
      if (deniedNow) throw new CapabilityDeniedError(deniedNow);

      const strategies = this.selectors.modelDropdown?.strategies ?? [];

      // Step 1: Open the dropdown via JS .click() (same pattern as setMode).
      // Skip any trigger whose id starts with `plan-exec-model` (those belong
      // to the plan-execution picker, not the composer's model picker) — same
      // filter as openModelMenuAndReadOptions.
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          const candidates = [];
          for (const sel of strategies) { try { candidates.push(...document.querySelectorAll(sel)); } catch {} }
          candidates.push(...document.querySelectorAll('.vscode-model-picker__trigger, .ui-model-picker__trigger, [data-model], [data-model-id], button[aria-label*="model" i]'));
          const triggers = Array.from(new Set(candidates)).filter(candidate => {
            if ((candidate.getAttribute('id') || '').startsWith('plan-exec-model')) return false;
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (triggers.length !== 1) return { ok: false, count: triggers.length };
          triggers[0].click();
          return { ok: true, count: 1 };
        })()
      `) as { ok: boolean; count: number } | null;
      if (!opened?.ok) throw new Error(`Model dropdown target is not unique (found ${opened?.count ?? 0})`);

      await sleep(300);

      // Step 2: Verify menu opened
      const menuVisible = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (!menuVisible) throw new Error('Model picker did not open');

      // Step 3: Find and click the model item via the shared helper so
      // setModel, setPlanModel, web client, and Telegram all resolve the
      // same way.
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Model "${modelId}" not found in dropdown`);

      await sleep(200);

      // Step 4: Verify dropdown closed (confirms selection was accepted)
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        console.warn(`[command-executor] Model dropdown still open — pressing Escape`);
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      console.log(`[command-executor] Model set to: ${modelId} (menu closed: ${!menuStillOpen})`);
    }, opts);
  }

  private verifiedComposerModelOptions(): PlanModelOption[] {
    const snapshot = this.capabilityGuard?.getSnapshot() ?? null;
    if (!snapshot) return [];
    const activeTargetId = this.capabilityGuard?.getActiveTargetId() ?? this.targetIdProvider?.() ?? '';
    const liveGeneration = this.capabilityGuard?.getTargetGeneration(snapshot.targetId)
      ?? this.targetGenerationProvider?.()
      ?? 0;
    if (snapshot.targetId !== activeTargetId || snapshot.targetGeneration !== liveGeneration) return [];
    if (snapshot.status.state !== 'ok' && snapshot.status.state !== 'changed') return [];
    if (snapshot.models.completeness !== 'complete') return [];
    return snapshot.models.items
      .filter((item) =>
        item.scope === 'composer'
        && item.selectable
        && this.capabilityError('model', item.id) === null
      )
      .map((item) => ({ id: item.id, label: item.label, selected: item.selected }));
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    const liveData = result.data as {
      options?: PlanModelOption[];
      completeness?: 'complete' | 'partial' | 'unknown';
      filterActive?: boolean;
    } | undefined;
    if (result.ok && Array.isArray(liveData?.options) && liveData.options.length > 0) {
      return {
        commandId,
        ok: true,
        data: { ...liveData, source: 'live_menu' },
      };
    }

    const fallback = this.verifiedComposerModelOptions();
    if (fallback.length > 0) {
      return {
        commandId,
        ok: true,
        data: {
          options: fallback,
          completeness: 'complete',
          filterActive: false,
          source: 'capability_snapshot',
          ...(result.ok ? {} : { liveError: result.error || 'Live model menu read failed' }),
        },
      };
    }

    if (!result.ok) return result;
    return { commandId, ok: true, data: { ...liveData, source: 'live_menu' } };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(
    commandId: string,
    selectorPath: string,
    planModelId: string,
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openPlanModelMenu(client, selectorPath);
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(planModelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Plan model "${planModelId}" not found`);

      await sleep(200);
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }
      console.log(`[command-executor] Plan model set to: ${planModelId}`);
    }, opts);
  }

/**
   * Resolve the on-disk file name of the plan document behind one plan tool
   * card. No retries: one View Plan click, a bounded async read-back of the
   * editor tab / breadcrumb / plan editor, then a conditional tab and
   * transcript restore. The whole flow shares the configured target lane so it
   * cannot interleave with another window command.
   *
   * The tab/breadcrumb match shows the reader agrees on one file at read time;
   * it is not a transaction against the target window.
   */
  async resolvePlanFile(
    commandId: string,
    expected: { windowId: string; composerId: string; planId: string; toolCallId: string },
    isCurrent: () => boolean,
  ): Promise<CommandResult> {
    const coordinator = this.uiCoordinator;
    const queuedClient = this.client;
    const targetId = this.targetIdProvider?.() ?? '';
    if (typeof isCurrent !== 'function' || !coordinator || !targetId) {
      return planFailResult({
        commandId, error: '计划文档读取不可用', code: 'unknown', stage: 'resolve',
        requested: planRequestedTarget(expected),
      });
    }
    if (!queuedClient || !queuedClient.isConnected()) {
      return planFailResult({
        commandId, error: '未连接到 Cursor', code: 'connection', stage: 'resolve',
        requested: planRequestedTarget(expected),
      });
    }
    if (expected.windowId !== targetId) {
      return planFailResult({
        commandId, error: '计划文档目标窗口不匹配', code: 'window', stage: 'resolve',
        requested: planRequestedTarget(expected),
      });
    }
    const generationProvider = this.targetGenerationProvider;
    const generation = generationProvider?.() ?? coordinator.getGeneration(targetId);
    const guard = () => {
      if (this.client !== queuedClient) throw new Error('计划文档目标已改变');
      if (!queuedClient.isConnected()) throw new Error('未连接到 Cursor');
      if ((this.targetIdProvider?.() ?? '') !== targetId) throw new Error('计划文档目标已改变');
      if (expected.windowId !== (this.targetIdProvider?.() ?? '')) throw new Error('计划文档目标窗口已改变');
      if (generationProvider && generationProvider() !== generation) throw new Error('计划文档目标已改变');
      if (!isCurrent()) throw new Error('计划文档请求已失效');
    };
    try {
      return await coordinator.enqueue(targetId, (ctx) => {
        const stateGuard = () => {
          if (ctx.signal.aborted) throw new Error('计划文档读取已取消');
          guard();
        };
        return this.enqueueWindowCommand(queuedClient, () =>
          this.resolvePlanFileOnClient(commandId, queuedClient, expected, stateGuard)
        );
      }, { generation, label: `command:${commandId}`, timeoutMs: PLAN_DOCUMENT_READ_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof TargetUiError) {
        const message = err.code === 'generation_changed'
          ? '计划文档目标已改变'
          : err.code === 'timeout' ? '计划文档读取超时' : '计划文档读取已取消';
        const code = err.code === 'generation_changed' ? 'window' : err.code === 'timeout' ? 'expired' : 'unknown';
        return planFailResult({
          commandId, error: message, code, stage: 'resolve',
          requested: planRequestedTarget(expected),
        });
      }
      return planFailResult({
        commandId,
        error: err instanceof Error ? err.message : '计划文档读取未能完成',
        code: 'unknown',
        stage: 'resolve',
        requested: planRequestedTarget(expected),
      });
    }
  }

  private async resolvePlanFileOnClient(
    commandId: string,
    client: CdpClient,
    expected: { windowId: string; composerId: string; planId: string; toolCallId: string },
    guard: () => void,
  ): Promise<CommandResult> {
    const tabSelector = this.selectors.planDocumentTab?.strategies?.[0];
    const groupSelector = this.selectors.planDocumentEditorGroup?.strategies?.[0];
    const breadcrumbSelector = this.selectors.planDocumentBreadcrumbIcon?.strategies?.[0];
    const editorSelector = this.selectors.planDocumentEditor?.strategies?.[0];
    const scrollSelector = this.selectors.composerMessagesScroll?.strategies?.[0];
    if (!tabSelector || !groupSelector || !breadcrumbSelector || !editorSelector || !scrollSelector) {
      return { commandId, ok: false, error: 'Plan document selectors are unavailable' };
    }
    const composerId = expected.composerId;
    // The real tool-call id is matched exactly — no prefix normalization.
    const toolCallId = expected.toolCallId;
    if (!composerId || !toolCallId) {
      return { commandId, ok: false, error: '计划文档范围不可用' };
    }
    const token = `${commandId}:${++planWatchSeq}:${Date.now().toString(36)}`;
    const selectorsLiteral = JSON.stringify({
      tab: tabSelector,
      group: groupSelector,
      breadcrumb: breadcrumbSelector,
      editor: editorSelector,
      scroll: scrollSelector,
    });
    const composerLiteral = JSON.stringify(composerId);
    const toolCallLiteral = JSON.stringify(toolCallId);
    const tokenLiteral = JSON.stringify(token);

    type PlanStepResult = ({ status?: string } & Record<string, unknown>) | null;
    // Transcript scroll bookkeeping for this attempt. `scrollCorrection` sums
    // the layout shifts the page re-proved against rows that stayed put, so the
    // expected top follows Cursor's own re-anchor and the restore target is the
    // corrected original position instead of stale pixels. A step reports an
    // observed top only after re-checking it in the same evaluate.
    let flowScrollTop: number | null = null;
    let initialScrollTop: number | null = null;
    let scrollCorrection = 0;
    let scrolled = false;
    const flowArg = (): string => (flowScrollTop === null ? 'null' : String(flowScrollTop));
    const followScroll = (step: PlanStepResult): void => {
      if (!step) return;
      const observed = step.scrollTop;
      const expected = flowScrollTop;
      if (typeof observed !== 'number' || expected === null || observed === expected) return;
      scrollCorrection += observed - expected;
      flowScrollTop = observed;
    };
    // Every evaluate is bracketed by the Node-side guard so a cancellation,
    // window switch, or target replacement stops the flow before the next side
    // effect. The in-page steps re-check the same conditions plus this attempt's
    // interaction watch before they read or write anything.
    const runStep = async (call: string): Promise<PlanStepResult> => {
      guard();
      let value: PlanStepResult;
      try {
        value = await client.evaluate(`(() => {\n${PLAN_DOCUMENT_HELPERS_JS}\nreturn ${call};\n})()`) as PlanStepResult;
      } catch {
        throw new Error('计划文档读取时页面执行失败');
      }
      guard();
      followScroll(value);
      return value;
    };
    const fail = (status: string | undefined): CommandResult => ({
      commandId,
      ok: false,
      error: (status && PLAN_DOCUMENT_STEP_ERRORS[status]) || '计划文档读取未能完成',
    });
    // Removes only this attempt's listeners. Never restores UI, never touches
    // another attempt's entry, and never reaches the page at all when the
    // attempt was already stale before its watch could be installed.
    let watchAttempted = false;
    const removeWatch = async (): Promise<void> => {
      if (!watchAttempted) return;
      try {
        await client.evaluate(`(() => {\n${PLAN_DOCUMENT_HELPERS_JS}\nreturn planWatchRemove(${tokenLiteral});\n})()`);
      } catch {
        /* page context gone: its listeners died with it and nothing else is touched */
      }
    };

    const flow = async (): Promise<CommandResult> => {
      // The Node-side guard runs before the flag is set, so a request that is
      // already stale never touches the page and never claims a watch.
      guard();
      watchAttempted = true;
      const install = await runStep(`planWatchInstall(${tokenLiteral})`);
      if (!install) return fail('watch_install_failed');
      if (install.status !== 'ok') return fail(String(install.status ?? 'watch_install_failed'));

      let baseline = '';
      let planTabName = '';

      const preflight = await runStep(
        `planStepPreflight(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${toolCallLiteral})`
      );
      if (!preflight) return fail(undefined);
      if (preflight.status !== 'ok') return fail(preflight.status);
      baseline = String(preflight.baseline ?? '');
      let cardStatus = String(preflight.cardStatus ?? '');
      if (cardStatus !== 'missing' && cardStatus !== 'ok') return fail(`card_${cardStatus}`);

      // The card is normally already mounted; only a virtualized transcript
      // needs a bounded upward search in this exact composer's own container.
      for (let stepIndex = 0; cardStatus === 'missing' && stepIndex < PLAN_DOCUMENT_SCROLL_MAX_STEPS; stepIndex += 1) {
        const step = await runStep(
          `planStepScrollUp(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
        );
        if (!step) return fail(undefined);
        if (step.status === 'scroll_top') break;
        if (step.status !== 'scrolled') return fail(step.status);
        scrolled = true;
        if (initialScrollTop === null && typeof step.before === 'number') initialScrollTop = step.before;
        flowScrollTop = typeof step.after === 'number' ? step.after : flowScrollTop;
        await sleep(PLAN_DOCUMENT_RENDER_WAIT_MS);
        guard();
        const probe = await runStep(
          `planStepCardProbe(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${toolCallLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
        );
        if (!probe) return fail(undefined);
        if (probe.status !== 'ok') return fail(probe.status);
        cardStatus = String(probe.cardStatus ?? '');
        if (cardStatus !== 'missing' && cardStatus !== 'ok') return fail(`card_${cardStatus}`);
      }

      // Restores the transcript only while the environment is still the one
      // this attempt recorded; the check runs inside the evaluate with the write.
      // The page reports the position it actually reached, because the guard in
      // the same evaluate may absorb one more proven compensation before writing.
      const restoreSearchScroll = async (): Promise<boolean> => {
        const base = initialScrollTop;
        if (!scrolled || base === null) return true;
        const target = base + scrollCorrection;
        const state = await runStep(
          `planStepRestoreScroll(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()}, ${target})`
        );
        if (state?.status !== 'ok') return false;
        const restored = typeof state.restoredTop === 'number' ? state.restoredTop : target;
        scrollCorrection += restored - target;
        flowScrollTop = restored;
        return true;
      };

      if (cardStatus !== 'ok') {
        await restoreSearchScroll();
        return { commandId, ok: false, error: '未找到该计划卡片' };
      }

      const directState = await runStep(
        `planStepReadDirectUri(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${toolCallLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
      );
      if (!directState) return fail(undefined);
      if (directState.status !== 'ok') return fail(directState.status);
      if (typeof directState.planUri === 'string' && directState.planUri.length > 0) {
        const parsed = planFileFromFileUri(directState.planUri, directState.workspace);
        if (parsed) {
          const scrollRestored = await restoreSearchScroll();
          if (!scrollRestored) return fail('scroll_unverified');
          return {
            commandId,
            ok: true,
            data: { fileName: parsed.fileName, observedAt: Date.now(), ...(parsed.plansRoot ? { plansRoot: parsed.plansRoot } : {}) },
          };
        }
      }

      const clickState = await runStep(
        `planStepClickViewPlan(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${toolCallLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
      );
      if (!clickState) return fail(undefined);
      if (clickState.status !== 'clicked') return fail(clickState.status);

      let documentState: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < PLAN_DOCUMENT_OPEN_POLL_MAX; attempt += 1) {
        const state = await runStep(
          `planStepReadOpen(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
        );
        if (!state) return fail(undefined);
        if (state.status === 'ok') {
          documentState = state;
          break;
        }
        const selectedName = typeof state.resourceName === 'string' ? state.resourceName : '';
        if (state.status === 'path_ambiguous' && Number(state.count) > 1) {
          return fail('path_ambiguous');
        }
        if (state.status === 'editor_missing' || state.status === 'editor_streaming' || state.status === 'path_ambiguous') {
          // Wait only while the selected editor is itself a plan document; any
          // other document means something else opened, so refuse instead of
          // waiting for a plan editor that may show up later.
          if (!selectedName.endsWith('.plan.md')) return fail('doc_other_opened');
        } else if (state.status !== 'not_open') {
          return fail(state.status);
        }
        await sleep(PLAN_DOCUMENT_OPEN_POLL_WAIT_MS);
        guard();
      }
      if (!documentState) return fail('doc_not_opened');

      const resourceName = String(documentState.resourceName ?? '');
      const breadcrumbPath = String(documentState.breadcrumbPath ?? '');
      const homeName = planFileNameFromPath(breadcrumbPath);
      let fileName: string | null = null;
      let plansRoot: string | undefined;
      if (homeName) {
        if (homeName !== resourceName) return fail('doc_path_mismatch');
        fileName = homeName;
      } else {
        const workspaceRoot = fileWorkspacePlansRoot(documentState.workspace);
        const workspaceName = workspaceRoot
          ? planFileNameFromPrefix(breadcrumbPath, `${workspaceRoot}/`)
          : null;
        if (!workspaceName) return fail('doc_path_unsafe');
        if (workspaceName !== resourceName) return fail('doc_path_mismatch');
        fileName = workspaceName;
        plansRoot = workspaceRoot as string;
      }
      if (resourceName === baseline) return fail('not_open');
      planTabName = resourceName;

      const restoreState = await runStep(
        `planStepRestoreTab(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(planTabName)}, ${JSON.stringify(baseline)}, ${flowArg()})`
      );
      if (!restoreState) return fail(undefined);
      if (restoreState.status !== 'restored') return fail(restoreState.status);
      let restored = false;
      for (let attempt = 0; attempt < PLAN_DOCUMENT_RESTORE_POLL_MAX; attempt += 1) {
        const state = await runStep(
          `planStepVerifySelection(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${flowArg()})`
        );
        if (!state) return fail(undefined);
        if (state.status !== 'ok') return fail(state.status);
        if (state.selection === baseline) {
          restored = true;
          break;
        }
        await sleep(PLAN_DOCUMENT_RENDER_WAIT_MS);
        guard();
      }
      if (!restored) return fail('restore_unverified');

      // An unverifiable restore is never reported as success.
      const scrollRestored = await restoreSearchScroll();
      if (!scrollRestored) return fail('scroll_unverified');

      // Final confirmation of the restore itself: the original document is
      // selected again and the transcript sits at the position this attempt
      // recorded (including any proven compensation). Read-only, no side effect.
      const restoreConfirmed = await runStep(
        `planStepVerifySelection(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${flowArg()}, ${JSON.stringify(baseline)})`
      );
      if (!restoreConfirmed) return fail(undefined);
      if (restoreConfirmed.status !== 'ok') return fail(restoreConfirmed.status);

      // Last look at this attempt's own watch, after the final side effect: user
      // input that lands after the last guarded step must not yield a filename.
      const finalWatch = await runStep(`planWatchState(${tokenLiteral})`);
      if (!finalWatch) return fail(undefined);
      if (finalWatch.status !== 'ok') return fail(String(finalWatch.status));

      return { commandId, ok: true, data: { fileName, observedAt: Date.now(), ...(plansRoot ? { plansRoot } : {}) } };
    };

    try {
      return await flow();
    } finally {
      await removeWatch();
    }
  }

  /**
   * Structured discovery of CreatePlan cards in one composer's transcript,
   * walking upward screen by screen in the same UI lane as a plan read. Only
   * already-rendered cards are read: no card is expanded, View Plan is never
   * clicked, no editor opens, and the composer scope never changes. The
   * transcript scroll is restored only while this flow still owns the
   * environment — a changed target, draft, scroll, or any real user input
   * gives no results at all.
   *
   * Results are always `partial`: folded cards and history below the bounded
   * walk are not inspected, so a complete list is never claimed.
   */
  async discoverPlans(
    commandId: string,
    expected: { windowId: string; composerId: string },
    isCurrent: () => boolean,
  ): Promise<CommandResult> {
    const coordinator = this.uiCoordinator;
    const queuedClient = this.client;
    const targetId = this.targetIdProvider?.() ?? '';
    if (typeof isCurrent !== 'function' || !coordinator || !targetId || !expected.composerId) {
      return planFailResult({
        commandId, error: '计划发现不可用', code: 'unknown', stage: 'discover',
        requested: planRequestedTarget(expected),
      });
    }
    if (!queuedClient || !queuedClient.isConnected()) {
      return planFailResult({
        commandId, error: '未连接到 Cursor', code: 'connection', stage: 'discover',
        requested: planRequestedTarget(expected),
      });
    }
    if (expected.windowId !== targetId) {
      return planFailResult({
        commandId, error: '计划发现目标窗口不匹配', code: 'window', stage: 'discover',
        requested: planRequestedTarget(expected),
      });
    }
    const generationProvider = this.targetGenerationProvider;
    const generation = generationProvider?.() ?? coordinator.getGeneration(targetId);
    const guard = () => {
      if (this.client !== queuedClient) throw new Error('计划文档目标已改变');
      if (!queuedClient.isConnected()) throw new Error('未连接到 Cursor');
      if ((this.targetIdProvider?.() ?? '') !== targetId) throw new Error('计划文档目标已改变');
      if (expected.windowId !== (this.targetIdProvider?.() ?? '')) throw new Error('计划文档目标窗口已改变');
      if (generationProvider && generationProvider() !== generation) throw new Error('计划文档目标已改变');
      if (!isCurrent()) throw new Error('计划文档请求已失效');
    };
    try {
      return await coordinator.enqueue(targetId, (ctx) => {
        const stateGuard = () => {
          if (ctx.signal.aborted) throw new Error('计划发现已取消');
          guard();
        };
        return this.enqueueWindowCommand(queuedClient, () =>
          this.discoverPlansOnClient(commandId, queuedClient, expected.composerId, stateGuard)
        );
      }, { generation, label: `command:${commandId}`, timeoutMs: PLAN_DOCUMENT_READ_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof TargetUiError) {
        const message = err.code === 'generation_changed'
          ? '计划文档目标已改变'
          : err.code === 'timeout' ? '计划发现超时' : '计划发现已取消';
        const code = err.code === 'generation_changed' ? 'window' : err.code === 'timeout' ? 'expired' : 'unknown';
        return planFailResult({
          commandId, error: message, code, stage: 'discover',
          requested: planRequestedTarget(expected),
        });
      }
      return planFailResult({
        commandId,
        error: err instanceof Error ? err.message : '计划发现未能完成',
        code: 'unknown',
        stage: 'discover',
        requested: planRequestedTarget(expected),
      });
    }
  }

  private async discoverPlansOnClient(
    commandId: string,
    client: CdpClient,
    composerId: string,
    guard: () => void,
  ): Promise<CommandResult> {
    const tabSelector = this.selectors.planDocumentTab?.strategies?.[0];
    const groupSelector = this.selectors.planDocumentEditorGroup?.strategies?.[0];
    const scrollSelector = this.selectors.composerMessagesScroll?.strategies?.[0];
    // Discovery never looks at a plan document: the editor tab/group only give
    // the selection guard, and the scroll container the viewport walk.
    if (!tabSelector || !groupSelector || !scrollSelector) {
      return { commandId, ok: false, error: 'Plan document selectors are unavailable' };
    }
    const token = `${commandId}:${++planWatchSeq}:${Date.now().toString(36)}`;
    const selectorsLiteral = JSON.stringify({ tab: tabSelector, group: groupSelector, scroll: scrollSelector });
    const composerLiteral = JSON.stringify(composerId);
    const tokenLiteral = JSON.stringify(token);

    type PlanStepResult = ({ status?: string } & Record<string, unknown>) | null;
    // Same scroll bookkeeping as a read: the expected top and the restore
    // target both follow a layout shift only after the page re-proved it
    // against rows that kept their place on screen.
    let flowScrollTop: number | null = null;
    let initialScrollTop: number | null = null;
    let scrollCorrection = 0;
    let scrolled = false;
    const flowArg = (): string => (flowScrollTop === null ? 'null' : String(flowScrollTop));
    const followScroll = (step: PlanStepResult): void => {
      if (!step) return;
      const observed = step.scrollTop;
      const expected = flowScrollTop;
      if (typeof observed !== 'number' || expected === null || observed === expected) return;
      scrollCorrection += observed - expected;
      flowScrollTop = observed;
    };
    const runStep = async (call: string): Promise<PlanStepResult> => {
      guard();
      let value: PlanStepResult;
      try {
        value = await client.evaluate(`(() => {\n${PLAN_DOCUMENT_HELPERS_JS}\nreturn ${call};\n})()`) as PlanStepResult;
      } catch {
        throw new Error('计划发现时页面执行失败');
      }
      guard();
      followScroll(value);
      return value;
    };
    const fail = (status: string | undefined): CommandResult => ({
      commandId,
      ok: false,
      error: (status && PLAN_DOCUMENT_STEP_ERRORS[status]) || '计划发现未能完成',
    });
    // Same watch lifecycle as a read: only this attempt's listeners, no UI work,
    // and no page contact at all when the attempt was already stale.
    let watchAttempted = false;
    const removeWatch = async (): Promise<void> => {
      if (!watchAttempted) return;
      try {
        await client.evaluate(`(() => {\n${PLAN_DOCUMENT_HELPERS_JS}\nreturn planWatchRemove(${tokenLiteral});\n})()`);
      } catch {
        /* page context gone: its listeners died with it and nothing else is touched */
      }
    };

    const flow = async (): Promise<CommandResult> => {
      guard();
      watchAttempted = true;
      const install = await runStep(`planWatchInstall(${tokenLiteral})`);
      if (!install || install.status !== 'ok') return fail(String(install?.status ?? 'watch_install_failed'));
      const start = await runStep(`planStepDiscoverStart(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral})`);
      if (!start) return fail(undefined);
      if (start.status !== 'ok') return fail(start.status);
      const baseline = typeof start.baseline === 'string' ? start.baseline : '';

      const plans: Array<{ toolCallId: string; title: string; description?: string }> = [];
      const seen = new Set<string>();
      const collect = (step: PlanStepResult): number => {
        const before = plans.length;
        const list = step && Array.isArray(step.plans) ? step.plans : [];
        for (const item of list) {
          if (plans.length >= PLAN_DISCOVERY_MAX_PLANS) break;
          const entry = (item ?? {}) as { toolCallId?: unknown; title?: unknown; description?: unknown };
          const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : '';
          const title = typeof entry.title === 'string' ? entry.title : '';
          if (!toolCallId || !title || seen.has(toolCallId)) continue;
          seen.add(toolCallId);
          plans.push(typeof entry.description === 'string' && entry.description
            ? { toolCallId, title, description: entry.description }
            : { toolCallId, title });
        }
        return plans.length - before;
      };

      let reachedStart = false;
      const scan = (): Promise<PlanStepResult> =>
        runStep(`planStepScanPlans(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`);

      const first = await scan();
      if (!first) return fail(undefined);
      if (first.status !== 'ok') return fail(first.status);
      let foundNew = collect(first) > 0;

      // Upward only, one screen per step, bounded. Stop as soon as a scan newly
      // collects at least one plan card: extra walking is what lets a later
      // layout shift discard cards that were already in hand. No card is
      // expanded and no button is pressed anywhere in this walk.
      for (let stepIndex = 0; stepIndex < PLAN_DOCUMENT_SCROLL_MAX_STEPS; stepIndex += 1) {
        if (foundNew || plans.length >= PLAN_DISCOVERY_MAX_PLANS) break;
        const step = await runStep(
          `planStepScrollUp(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()})`
        );
        if (!step) return fail(undefined);
        if (step.status === 'scroll_top') {
          reachedStart = true;
          break;
        }
        if (step.status !== 'scrolled') return fail(step.status);
        scrolled = true;
        if (initialScrollTop === null && typeof step.before === 'number') initialScrollTop = step.before;
        flowScrollTop = typeof step.after === 'number' ? step.after : flowScrollTop;
        await sleep(PLAN_DOCUMENT_RENDER_WAIT_MS);
        guard();
        const next = await scan();
        if (!next) return fail(undefined);
        if (next.status !== 'ok') return fail(next.status);
        foundNew = collect(next) > 0;
      }

      // Restore and confirm only while this flow still owns the environment.
      // Both use the corrected original position: the pixels this flow wrote
      // are stale once Cursor moved the transcript by itself. The restore step
      // reports the position it actually reached, which also covers a
      // compensation its own guard absorbed right before the write.
      const restoreBase = initialScrollTop === null ? null : initialScrollTop + scrollCorrection;
      let restoreTop: number | null = null;
      if (scrolled && restoreBase !== null) {
        const restore = await runStep(
          `planStepRestoreScroll(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${flowArg()}, ${restoreBase})`
        );
        if (!restore) return fail(undefined);
        if (restore.status !== 'ok') return fail(restore.status);
        restoreTop = typeof restore.restoredTop === 'number' ? restore.restoredTop : restoreBase;
        scrollCorrection += restoreTop - restoreBase;
        flowScrollTop = restoreTop;
      }
      const restoreTopLiteral = restoreTop === null ? 'null' : String(restoreTop);
      const done = await runStep(
        `planStepDiscoverDone(${tokenLiteral}, ${selectorsLiteral}, ${composerLiteral}, ${JSON.stringify(baseline)}, ${restoreTopLiteral})`
      );
      if (!done) return fail(undefined);
      if (done.status !== 'ok') return fail(done.status);

      return {
        commandId,
        ok: true,
        data: { plans, observedAt: Date.now(), reachedStart, completeness: 'partial' },
      };
    };

    try {
      return await flow();
    } finally {
      await removeWatch();
    }
  }

  private getOrRunCommand<T extends CommandResult>(
    commandId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const cached = this.commandResultCache.get(commandId);
    if (cached) {
      if (cached.expiresAt > now) return cached.result as Promise<T>;
      this.commandResultCache.delete(commandId);
    }

    const result = run();
    this.commandResultCache.set(commandId, { expiresAt: now + COMMAND_RESULT_TTL_MS, result });
    while (this.commandResultCache.size > MAX_CACHED_COMMAND_RESULTS) {
      const oldest = this.commandResultCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.commandResultCache.delete(oldest);
    }
    return result;
  }

  private async withRetry(
    commandId: string,
    action: (client: CdpClient) => Promise<void>,
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult> {
    return this.getOrRunCommand(commandId, () => {
      const queuedClient = this.client;
      const run = () => this.enqueueWindowCommand(queuedClient, async () => {
        if (opts.humanInitiated !== false) await this.humanTakeoverHandler?.();
        await opts.beforeDispatch?.();
        return this.runWithRetry(commandId, queuedClient, action, opts.retry !== false);
      });
      const targetId = this.targetIdProvider?.() ?? '';
      const generation = this.targetGenerationProvider?.() ?? undefined;
      if (!this.uiCoordinator || !targetId) return run();
      return this.uiCoordinator.enqueue(targetId, () => run(), { generation, label: `command:${commandId}` });
    });
  }

  private async runWithRetry(
    commandId: string,
    queuedClient: CdpClient | null,
    action: (client: CdpClient) => Promise<void>,
    retry = true,
  ): Promise<CommandResult> {
    if (!queuedClient || !queuedClient.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    const maxAttempts = retry ? MAX_RETRIES : 0;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        await action(queuedClient);
        return { commandId, ok: true };
      } catch (err) {
        if (err instanceof CapabilityDeniedError) {
          return { commandId, ok: false, error: err.message };
        }
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${maxAttempts + 1} failed: ${lastError}`
        );
        if (attempt < maxAttempts) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async withRetryValue<T>(
    commandId: string,
    action: (client: CdpClient) => Promise<T>
  ): Promise<CommandResult & { data?: T }> {
    return this.getOrRunCommand(commandId, () => {
      const queuedClient = this.client;
      const run = () => this.enqueueWindowCommand(queuedClient, async () => {
        await this.humanTakeoverHandler?.();
        return this.runWithRetryValue(commandId, queuedClient, action);
      });
      const targetId = this.targetIdProvider?.() ?? '';
      const generation = this.targetGenerationProvider?.() ?? undefined;
      if (!this.uiCoordinator || !targetId) return run();
      return this.uiCoordinator.enqueue(targetId, () => run(), { generation, label: `command:${commandId}` });
    });
  }

  private async runWithRetryValue<T>(
    commandId: string,
    queuedClient: CdpClient | null,
    action: (client: CdpClient) => Promise<T>
  ): Promise<CommandResult & { data?: T }> {
    if (!queuedClient || !queuedClient.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await action(queuedClient);
        return { commandId, ok: true, data };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async openPlanModelMenu(client: CdpClient, selectorPath: string): Promise<void> {
    const opened = await client.evaluate(`
      (() => {
        const selector = ${JSON.stringify(selectorPath)};
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `) as boolean;
    if (!opened) throw new Error('Plan model dropdown trigger not found');

    await sleep(300);
    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Plan model picker did not open');
  }

  private async openPlanModelMenuAndReadOptions(
    client: CdpClient,
    selectorPath: string
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openPlanModelMenu(client, selectorPath);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async openModelMenuAndReadOptions(
    client: CdpClient
  ): Promise<{ options: PlanModelOption[]; completeness: 'complete' | 'partial' | 'unknown'; filterActive: boolean }> {
    const strategies = this.selectors.modelDropdown?.strategies ?? [];

    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        const candidates = [];
        for (const sel of strategies) { try { candidates.push(...document.querySelectorAll(sel)); } catch {} }
        candidates.push(...document.querySelectorAll('[data-model], [data-model-id], button[aria-label*="model" i]'));
        for (const c of Array.from(candidates)) {
          const cId = c.getAttribute('id') || '';
          if (cId.startsWith('plan-exec-model')) continue;
          const rect = c.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) { c.click(); return true; }
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Model dropdown trigger not found');

    await sleep(300);

    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Model picker did not open');

    const data = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        ${MODEL_MENU_COMPLETENESS_JS}
        const menu = findModelMenu();
        const options = collectModelItems(menu);
        const assessed = assessModelMenuCompleteness(menu, options.length);
        return { options, completeness: assessed.completeness, filterActive: assessed.filterActive };
      })()
    `) as { options: PlanModelOption[]; completeness: 'complete' | 'partial' | 'unknown'; filterActive: boolean };

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return data;
  }

  private async findFirstMatchingSelector(
    client: CdpClient,
    strategies: string[]
  ): Promise<string | null> {
    for (const selector of strategies) {
      try {
        if (await client.exists(selector)) return selector;
      } catch {
        // invalid selector, skip
      }
    }
    return null;
  }

  private async findApproveAllButton(client: CdpClient): Promise<string | null> {
    const found = await client.evaluate(`
      (() => {
        const keywords = ${JSON.stringify(this.selectors.approveButton.textMatch ?? [])};
        const strategies = ${JSON.stringify(this.selectors.approveButton.strategies)};
        const containerStrategies = ${JSON.stringify(this.selectors.chatContainer.strategies)};
        let root = null;
        for (const sel of containerStrategies) {
          try {
            root = document.querySelector(sel);
            if (root) break;
          } catch {}
        }
        if (!root) root = document.body;

        // Skip menu-trigger buttons (e.g. Cursor's "Auto-Run in Sandbox"
        // mode dropdown) — they open a settings menu, not an approval.
        const isMenuTrigger = (b) => {
          const p = b.getAttribute('aria-haspopup');
          return p === 'menu' || p === 'true' || p === 'listbox';
        };

        for (const selector of strategies) {
          try {
            const buttons = root.querySelectorAll(selector);
            for (const btn of Array.from(buttons)) {
              if (isMenuTrigger(btn)) continue;
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('all')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
              }
            }
          } catch {}
        }

        const allButtons = root.querySelectorAll('button');
        for (const btn of Array.from(allButtons)) {
          if (isMenuTrigger(btn)) continue;
          const text = (btn.textContent || '').trim().toLowerCase();
          for (const kw of keywords) {
            if (kw.toLowerCase().includes('all') && text.includes(kw.toLowerCase())) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
        }

        return false;
      })()
    `) as boolean;

    if (!found) {
      throw new Error('"Accept All" button not found');
    }
    return '__clicked_inline__';
  }

  private async clickElementCenter(client: CdpClient, selector: string): Promise<void> {
    const rect = await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;

    if (!rect || rect.width === 0 || rect.height === 0) {
      throw new Error(`Element not clickable: ${selector}`);
    }

    await client.clickAtCoords(rect.x, rect.y);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
