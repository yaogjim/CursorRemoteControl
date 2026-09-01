import type { CdpClient } from './cdp-client.js';
import type { SelectorConfig, CommandResult, PlanModelOption, CapabilitySummary } from './types.js';
import { TargetUiCoordinator, TargetUiError } from './target-ui-coordinator.js';
import { ActionRegistry, ActionRegistryError, isExecutableActionType } from './action-registry.js';
import { capabilityAllows } from './capability-guard.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;
const COMMAND_RESULT_TTL_MS = 60_000;
const MAX_CACHED_COMMAND_RESULTS = 1_000;

// Cursor 3.8+ uses data-message-index; older builds use data-flat-index.
const MESSAGE_WRAPPER_SELECTOR = '[data-message-index], [data-flat-index]';

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
  ): Promise<CommandResult> {
    if (!this.actionRegistry) return { commandId, ok: false, error: 'Action authorization is unavailable' };
    let reservedId = '';
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
      const result = await this.clickAction(commandId, target.selectorPath, target.expectedLabel, {
        composerId: target.composerId,
        toolCallId: target.toolCallId,
      }, { retry: false });
      const scope = { targetId: target.targetId, targetGeneration: target.targetGeneration, ...(expectedTarget?.actionType ? { actionType: expectedTarget.actionType } : {}) };
      this.settleRegisteredAction(actionId, scope, result);
      return result;
    } catch (err) {
      this.settleRegisteredActionError(actionId, reservedId, err);
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

  async setRegisteredPlanModel(commandId: string, actionId: string, planModelId: string): Promise<CommandResult> {
    if (!this.actionRegistry) return { commandId, ok:false, error:'Action authorization is unavailable' };
    let reservedId = '';
    try {
      const target = this.actionRegistry.reserve(actionId, {
        targetId: this.targetIdProvider?.(),
        targetGeneration: this.targetGenerationProvider?.(),
        actionType: 'plan_model',
      });
      reservedId = target.actionId;
      const result = await this.setPlanModel(commandId, target.selectorPath, planModelId);
      this.settleRegisteredAction(actionId, { targetId: target.targetId, targetGeneration: target.targetGeneration, actionType: 'plan_model' }, result);
      return result;
    } catch (err) {
      this.settleRegisteredActionError(actionId, reservedId, err);
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

  async sendMessage(commandId: string, text: string): Promise<CommandResult> {
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
      if (trimmedText.length > 0) {
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
    });
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

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
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
    });
  }

  async clickAction(
    commandId: string,
    selectorPath: string,
    expectedLabel?: string,
    expectedScope?: { composerId?: string; toolCallId?: string },
    opts?: { retry?: boolean },
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
    }, { retry: opts?.retry });
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

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
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
    });
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
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
    });
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
    opts: { retry?: boolean } = {},
  ): Promise<CommandResult> {
    return this.getOrRunCommand(commandId, () => {
      const queuedClient = this.client;
      const run = () => this.enqueueWindowCommand(queuedClient, () =>
        this.runWithRetry(commandId, queuedClient, action, opts.retry !== false)
      );
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
      const run = () => this.enqueueWindowCommand(queuedClient, () =>
        this.runWithRetryValue(commandId, queuedClient, action)
      );
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
