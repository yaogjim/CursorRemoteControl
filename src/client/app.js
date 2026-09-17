/* global io */

(function () {
  'use strict';

  const AUTH_TOKEN_KEY = 'cursor-remote-token';
  const THEME_KEY = 'cursor-remote-theme';
  const THEME_COLOR_LIGHT = '#f7f8fa';
  const THEME_COLOR_DARK = '#141414';
  const HEALTH_TIMEOUT_MS = 3000;
  const STATE_FULL_WATCHDOG_MS = 1500;
  const QUESTIONNAIRE_NULL_HOLD_MS = 600;
  const QUESTIONNAIRE_SYNC_WATCHDOG_MS = 1500;
  const SOCKET_CONNECT_TIMEOUT_MS = 20000;
  const startupNow = () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  );
  const startupTiming = {
    startedAt: startupNow(),
    authStartedAt: 0,
    authDoneAt: 0,
    socketConnectedAt: 0,
    stateFullAt: 0,
    firstRenderAt: 0,
    reported: false,
  };

  function readThemePreference() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      /* private mode / blocked storage */
    }
    return 'system';
  }

  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      return false;
    }
  }

  function themeResolvesDark(pref) {
    if (pref === 'dark') return true;
    if (pref === 'light') return false;
    return systemPrefersDark();
  }

  function applyTheme(pref) {
    document.documentElement.dataset.theme = pref;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeResolvesDark(pref) ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
  }

  function initTheme() {
    const pref = readThemePreference();
    applyTheme(pref);

    const select = document.getElementById('theme-select');
    if (select) {
      select.value = pref;
      select.addEventListener('change', () => {
        const next = select.value;
        const value = next === 'light' || next === 'dark' || next === 'system' ? next : 'system';
        try {
          localStorage.setItem(THEME_KEY, value);
        } catch {
          /* ignore quota / private mode */
        }
        applyTheme(value);
      });
    }

    try {
      const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      const onChange = () => {
        if (readThemePreference() === 'system') applyTheme('system');
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    } catch {
      /* matchMedia unsupported: keep the first resolved system value */
    }
  }

  initTheme();

  const defaultState = {
    connected: false,
    extractorStatus: 'idle',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    mode: { current: '', available: [] },
    model: { current: '', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
  };

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function newCommandId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  /** Matches Relay OPERATION_ID_RE: 8–128 of [A-Za-z0-9._:-]. Unique per mutation. */
  function newOperationId() {
    return 'op-' + newCommandId();
  }

  async function checkAuth() {
    startupTiming.authStartedAt = startupNow();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch('/health', {
          credentials: 'same-origin',
          headers: getAuthHeaders(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired) {
          if (data.sessionValid === true) return true;
          if (data.sessionValid === false) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = '/login';
            return false;
          }
          // Older relay without sessionValid: fall back to presence of stored token
          if (getAuthToken()) return true;
          window.location.href = '/login';
          return false;
        }
      }
    } catch { /* network error, proceed anyway */ }
    return true;
  }

  async function init() {
    const authorized = await checkAuth();
    startupTiming.authDoneAt = startupNow();
    if (!authorized) return;
    bootstrap();
  }

  function bootstrap() {

  let state = { ...defaultState };
  let supervisionState = null;
  let supervisionOverview = null;
  let supervisionContextPending = false;
  let capabilityState = null;
  let capabilityDiff = null;
  let adapterHistory = { activeBindings: {}, adapters: [], history: [] };
  let activeSheet = null;
  let cachedModelOptions = null;
  let capabilityLive = true;
  let awaitingCapabilityFull = false;
  let csrfTokenCache = '';
  const CSRF_COOKIE_NAME = 'cursor_remote_csrf';
  let queueDetailsOpen = false;
  let sessionPlansOpen = false;
  // Short-lived, session-scoped reading references returned by discover_plans.
  // Simple holder + one expiry timer; no framework, never persisted.
  let discoveredPlanRefs = null;
  let discoveredPlanSessionIdentity = '';
  let discoveredPlanNonceSession = '';
  let discoveredPlanNonce = '';
  let discoveredPlanSeq = 0;
  let discoveredPlanExpiryTimer = 0;
  let planStatusBasisExpiryTimer = 0;
  let discoveredPlanScanInFlight = false;
  let discoveredPlanError = '';
  let discoveredPlanNotice = '';
  let approvalHighlightTimer = 0;

  let userScrolledUp = false;
  let autoScrollJob = 0;
  let notificationPermission =
    typeof Notification !== 'undefined' && Notification.permission
      ? Notification.permission
      : 'default';
  const notifiedMessageIds = new Set();
  const notifiedKeys = new Set();
  let activePlanModal = null;
  let planModalInstanceCounter = 0;
  let messagesSessionIdentity = '';
  let activePlanModelContext = null;
  const pendingCommandResults = new Map();
  const lateCommandResults = new Map();
  const settledCommandIds = new Set();
  const MAX_TRACKED_COMMAND_RESULTS = 128;

  function isNearMessagesBottom() {
    const threshold = 80;
    return $messages.scrollTop + $messages.clientHeight >= $messages.scrollHeight - threshold;
  }

  function scheduleMessagesAutoScroll() {
    const jobId = ++autoScrollJob;
    requestAnimationFrame(() => {
      if (jobId !== autoScrollJob) return;
      if (userScrolledUp) return;
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  const $messages = document.getElementById('messages');
  const $emptyState = document.getElementById('empty-state');
  const $emptyPrimary = document.getElementById('empty-state-primary');
  const $emptyHint = document.getElementById('empty-state-hint');
  const $connDot = document.getElementById('connection-dot');
  const $connText = document.getElementById('connection-text');
  const $statusIcon = document.getElementById('agent-status-icon');
  const $statusText = document.getElementById('agent-status-text');
  const $statusDetail = document.getElementById('agent-status-detail');
  const $headerRight = document.querySelector('#header .header-right');
  const $approvalBar = document.getElementById('approval-bar');
  const $approvalDesc = document.getElementById('approval-desc');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnReject = document.getElementById('btn-reject');
  const $questionnaireBar = document.getElementById('questionnaire-bar');
  const $questionnaireStepper = document.getElementById('questionnaire-stepper');
  const $questionnaireQuestions = document.getElementById('questionnaire-questions');
  const $btnQSkip = document.getElementById('btn-q-skip');
  const $btnQContinue = document.getElementById('btn-q-continue');
  const $input = document.getElementById('message-input');
  const $btnSend = document.getElementById('btn-send');
  const $toastContainer = document.getElementById('toast-container');
  const $supervisionPanel = document.getElementById('supervision-panel');
  const $supervisionStatus = document.getElementById('supervision-status');
  const $supervisionSummary = document.getElementById('supervision-summary');
  const $btnSupervisionCheck = document.getElementById('btn-supervision-check');
  const $btnSupervisionRequest = document.getElementById('btn-supervision-request');
  const $supervisionIssues = document.getElementById('supervision-issues');
  const $supervisionChecks = document.getElementById('supervision-checks');
  const $supervisionOperations = document.getElementById('supervision-operations');
  const $supervisionOwnerActions = document.getElementById('supervision-owner-actions');

  const $contextBar = document.getElementById('context-bar');
  const $contextMain = document.getElementById('context-main');
  const $contextWindow = document.getElementById('context-window');
  const $contextCount = document.getElementById('context-count');
  const $contextSession = document.getElementById('context-session');
  const $drawer = document.getElementById('drawer');
  const $drawerOverlay = document.getElementById('drawer-overlay');
  const $drawerClose = document.getElementById('drawer-close');
  const $drawerHint = document.getElementById('drawer-hint');
  const $drawerBody = document.getElementById('drawer-body');
  const $btnNewChat = document.getElementById('btn-new-chat');
  const $pillMode = document.getElementById('pill-mode');
  const $pillModeIcon = document.getElementById('pill-mode-icon');
  const $pillModeText = document.getElementById('pill-mode-text');
  const $pillModel = document.getElementById('pill-model');
  const $pillModelText = document.getElementById('pill-model-text');
  const $modeModelStatus = document.getElementById('mode-model-status');
  const $modeModelStatusText = document.getElementById('mode-model-status-text');
  const $btnModeModelRefresh = document.getElementById('btn-mode-model-refresh');
  const $capabilityDiagnostics = document.getElementById('capability-diagnostics');
  const $capabilityDiagnosticsSummary = document.getElementById('capability-diagnostics-summary');
  const $capabilityDiagnosticsBody = document.getElementById('capability-diagnostics-body');
  const $btnCapabilityRefresh = document.getElementById('btn-capability-refresh');
  const $capabilityRefreshStatus = document.getElementById('capability-refresh-status');
  const $sheetOverlay = document.getElementById('sheet-overlay');
  const $sheetMode = document.getElementById('sheet-mode');
  const $sheetModeList = document.getElementById('sheet-mode-list');
  const $sheetModel = document.getElementById('sheet-model');
  const $sheetModelList = document.getElementById('sheet-model-list');
  const $sheetPlanModel = document.getElementById('sheet-plan-model');
  const $sheetPlanModelHeader = document.getElementById('sheet-plan-model-header');
  const $sheetPlanModelList = document.getElementById('sheet-plan-model-list');
  const $planModalOverlay = document.getElementById('plan-modal-overlay');
  const $planModalLabel = document.getElementById('plan-modal-label');
  const $planModalTitle = document.getElementById('plan-modal-title');
  const $planModalBody = document.getElementById('plan-modal-body');
  const $planModalClose = document.getElementById('plan-modal-close');
  const $btnSystem = document.getElementById('btn-system');
  const $systemPanel = document.getElementById('system-panel');
  const $systemOverlay = document.getElementById('system-overlay');
  const $systemPanelClose = document.getElementById('system-panel-close');
  const $btnApprovalView = document.getElementById('btn-approval-view');
  const $questionnaireTrigger = document.getElementById('questionnaire-trigger');
  const $questionnaireTriggerLabel = document.getElementById('questionnaire-trigger-label');
  const $questionnaireSheet = document.getElementById('questionnaire-sheet');
  const $questionnaireSheetOverlay = document.getElementById('questionnaire-sheet-overlay');
  const $questionnaireSheetClose = document.getElementById('questionnaire-sheet-close');
  const $queueToggle = document.getElementById('composer-queue-toggle');
  const $sessionPlansToggle = document.getElementById('session-plans-toggle');
  const $app = document.getElementById('app');

  function syncAppViewport() {
    const viewport = window.visualViewport;
    const height = viewport && typeof viewport.height === 'number'
      ? viewport.height
      : window.innerHeight;
    const offset = viewport && typeof viewport.offsetTop === 'number'
      ? viewport.offsetTop
      : 0;
    document.documentElement.style.setProperty('--app-height', height + 'px');
    document.documentElement.style.setProperty('--app-offset', offset + 'px');
  }
  syncAppViewport();
  window.addEventListener('resize', syncAppViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncAppViewport);
    window.visualViewport.addEventListener('scroll', syncAppViewport);
  }

  function layerFocusable(root) {
    if (!root) return [];
    return Array.prototype.slice.call(root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }

  function isUsableFocusTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (typeof el.focus !== 'function') return false;
    if (el.disabled === true) return false;
    if (el.hasAttribute && el.hasAttribute('disabled')) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.closest === 'function' && el.closest('.hidden, [hidden], [aria-hidden="true"]')) return false;
    return true;
  }

  function bindLayer(panel, overlay, options) {
    const opts = options || {};
    let open = false;
    let trigger = null;
    function setOpenAttr(isOpen) {
      panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      if (overlay) overlay.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      if (opts.triggerEl) opts.triggerEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = layerFocusable(panel);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function setBackgroundInert(isOpen) {
      if (!$app) return;
      Array.prototype.forEach.call($app.children, function (child) {
        if (child === panel || child === overlay) {
          child.removeAttribute('inert');
          return;
        }
        if (isOpen) child.setAttribute('inert', '');
        else child.removeAttribute('inert');
      });
    }
    function restoreFocus() {
      const fallback = typeof opts.restoreFallback === 'function' ? opts.restoreFallback() : null;
      const target = isUsableFocusTarget(trigger)
        ? trigger
        : (isUsableFocusTarget(fallback) ? fallback : null);
      if (target) {
        try { target.focus(); } catch { /* ignore */ }
      }
    }
    function openFrom(fromEl) {
      trigger = fromEl || document.activeElement;
      panel.classList.remove('hidden');
      if (overlay) overlay.classList.remove('hidden');
      setOpenAttr(true);
      setBackgroundInert(true);
      document.removeEventListener('keydown', onKeydown);
      document.addEventListener('keydown', onKeydown);
      const focusEl = (opts.initialFocus && opts.initialFocus()) || layerFocusable(panel)[0];
      if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
      open = true;
      if (opts.onOpen) opts.onOpen();
    }
    function close() {
      if (!open && panel.classList.contains('hidden')) return;
      panel.classList.add('hidden');
      if (overlay) overlay.classList.add('hidden');
      setOpenAttr(false);
      setBackgroundInert(false);
      document.removeEventListener('keydown', onKeydown);
      open = false;
      restoreFocus();
      trigger = null;
      if (opts.onClose) opts.onClose();
    }
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
    }
    return {
      open: openFrom,
      close,
      isOpen: function () { return open; },
    };
  }

  const $themeSelect = document.getElementById('theme-select');
  const $planModal = document.getElementById('plan-modal');
  const systemLayer = bindLayer($systemPanel, $systemOverlay, {
    triggerEl: $btnSystem,
    initialFocus: function () { return $themeSelect || $systemPanelClose; },
  });
  const drawerLayer = bindLayer($drawer, $drawerOverlay, {
    triggerEl: $contextMain,
    initialFocus: function () { return $drawerClose; },
  });
  const questionnaireLayer = bindLayer($questionnaireSheet, $questionnaireSheetOverlay, {
    triggerEl: $questionnaireTrigger,
    initialFocus: function () { return $questionnaireSheetClose; },
    restoreFallback: function () { return $input; },
  });
  const modeLayer = bindLayer($sheetMode, $sheetOverlay, {
    triggerEl: $pillMode,
    onClose: function () { if (activeSheet === 'mode') activeSheet = null; },
  });
  const modelLayer = bindLayer($sheetModel, $sheetOverlay, {
    triggerEl: $pillModel,
    onClose: function () { if (activeSheet === 'model') activeSheet = null; },
  });
  const planModelLayer = bindLayer($sheetPlanModel, $sheetOverlay, {
    onClose: function () { if (activeSheet === 'plan-model') activeSheet = null; },
  });
  const planLayer = bindLayer($planModal, $planModalOverlay, {
    initialFocus: function () { return $planModalClose; },
    onClose: function () {
      activePlanModal = null;
      if ($planModalBody) $planModalBody.innerHTML = '';
    },
  });

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: SOCKET_CONNECT_TIMEOUT_MS,
    rememberUpgrade: true,
    tryAllTransports: true,
    withCredentials: true,
    auth: (cb) => {
      try {
        cb({ token: getAuthToken() || '' });
      } catch {
        cb({ token: '' });
      }
    },
  });

  let socketPhase = 'connecting';
  let stateSnapshotFresh = false;
  let stateFullWatchdog = 0;
  let sendInFlight = false;
  let sendEnvelope = null;
  let approvalInFlight = false;
  let approvalEnvelope = null;
  let rejectInFlight = false;
  let rejectEnvelope = null;
  let qActionInFlight = false;
  let capabilityDiscoveryInFlight = false;
  let supervisionPostInFlight = false;
  const mutationSubmitInFlight = new Set();
  const qEnvelopes = new Map();
  const genericActionInFlight = new Set();
  const genericActionEnvelopes = new Map();
  let questionnaireNullHoldTimer = 0;
  let questionnaireAwaitingSnapshot = false;
  let questionnaireSyncWatchdog = 0;
  let questionnaireOptimistic = {};

  const DANGEROUS_SOCKET_COMMANDS = new Set([
    'send_message',
    'approve',
    'approve_all',
    'reject',
    'new_chat',
    'set_mode',
    'set_model',
    'set_plan_model',
  ]);
  const DANGEROUS_ACTION_TYPES = new Set([
    'approve',
    'approve_all',
    'allow',
    'run',
    'build',
    'continue',
    'skip',
    'questionnaire_option',
  ]);

  const SUPERVISED_WRITE_ROUTES = new Set([
    'send_message',
    'approve',
    'approve_all',
    'reject',
    'set_mode',
    'set_model',
    'set_plan_model',
    'click_action',
  ]);
  const SUPERVISOR_DENIED_ROUTES = new Set([
    'new_chat',
    'switch_tab',
    'switch_window',
    'get_model_options',
    'get_plan_model_options',
  ]);

  function socketRoute(eventName) {
    return eventName.indexOf('command:') === 0 ? eventName.slice('command:'.length) : eventName;
  }

  function commandRequiresOperationId(eventName, payload) {
    const route = socketRoute(eventName);
    if (DANGEROUS_SOCKET_COMMANDS.has(route)) return true;
    return route === 'click_action' && !!(payload && DANGEROUS_ACTION_TYPES.has(payload.actionType));
  }

  function withCommandEnvelope(eventName, payload) {
    const body = Object.assign({}, payload || {});
    if (typeof body.commandId !== 'string' || body.commandId.length === 0) {
      body.commandId = newCommandId();
    }
    if (commandRequiresOperationId(eventName, body)) {
      if (typeof body.operationId !== 'string' || body.operationId.length === 0) {
        body.operationId = newOperationId();
      }
    }
    const route = socketRoute(eventName);
    const grant = supervisionState && supervisionState.grant;
    if (grant && SUPERVISED_WRITE_ROUTES.has(route)) {
      body.composerId = body.composerId || state.activeComposerId;
      body.windowId = body.windowId || state.activeWindowId;
      body.planVersion = grant.planVersion;
      body.authorizationVersion = grant.authorizationVersion;
      body.controlVersion = grant.controlVersion;
      const actionType = route === 'click_action' ? body.actionType : route;
      const approvedIssue = findMatchingApprovedIssue(body.composerId, actionType, body.actionId);
      if (approvedIssue) {
        body.issueId = approvedIssue.issueId;
        if (!body.actionId && approvedIssue.actionId) body.actionId = approvedIssue.actionId;
        body.contentDigest = approvedIssue.contentDigest;
      }
    }
    return body;
  }

  /** Reuse an already-enveloped payload for retries of the same mutation. */
  function reuseEnvelope(eventName, payload, previous) {
    if (previous && mutationFieldsMatch(previous, payload)) return previous;
    return withCommandEnvelope(eventName, payload);
  }

  function mutationFieldsMatch(previous, payload) {
    const next = payload || {};
    for (const key of Object.keys(next)) {
      if (key === 'commandId' || key === 'operationId') continue;
      if (previous[key] !== next[key]) return false;
    }
    return true;
  }

  function commandErrorMessage(result, fallback) {
    const err = result && typeof result.error === 'string' ? result.error.trim() : '';
    if (!err) return fallback;
    if (/action_expired/i.test(err)) return 'This action expired. Wait for the next snapshot and try again.';
    if (/action_consumed/i.test(err)) return 'This action was already used. Wait for a new prompt.';
    if (/timed out/i.test(err)) return 'Command timed out. Check the connection and try again.';
    if (/disconnected from relay/i.test(err)) return 'Relay disconnected. Waiting to reconnect.';
    return err;
  }

  function mutationOutcomeUncertain(result) {
    return result?.outcomeUnknown === true;
  }

  function emitCommand(eventName, payload) {
    const blocked = cursorMutationBlockedReason(eventName, payload);
    if (blocked) return null;
    const body = withCommandEnvelope(eventName, payload);
    socket.emit(eventName, body);
    return body;
  }

  function hasOpaqueActionId(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function rememberBounded(mapOrSet, key, value) {
    if (mapOrSet instanceof Map) mapOrSet.set(key, value);
    else mapOrSet.add(key);
    while (mapOrSet.size > MAX_TRACKED_COMMAND_RESULTS) {
      const oldest = mapOrSet.keys().next().value;
      mapOrSet.delete(oldest);
    }
  }

  function markCommandSettled(commandId) {
    lateCommandResults.delete(commandId);
    rememberBounded(settledCommandIds, commandId);
  }

  /**
   * Await command:result for this emit. If `payload` already has commandId
   * (and operationId when required), those ids are reused so retries stay idempotent.
   */
  function sendCommandAwaitResult(eventName, payload) {
    return new Promise((resolve) => {
      const blocked = cursorMutationBlockedReason(eventName, payload);
      if (blocked) {
        resolve({
          commandId: payload && payload.commandId,
          ok: false,
          error: blocked,
        });
        return;
      }
      const body = withCommandEnvelope(eventName, payload);
      const commandId = body.commandId;
      const lateResult = lateCommandResults.get(commandId);
      if (lateResult) {
        lateCommandResults.delete(commandId);
        markCommandSettled(commandId);
        resolve(lateResult);
        return;
      }
      settledCommandIds.delete(commandId);
      const timer = setTimeout(() => {
        pendingCommandResults.delete(commandId);
        resolve({ commandId, ok: false, error: 'Command timed out', outcomeUnknown: true });
      }, 12000);

      pendingCommandResults.set(commandId, (result) => {
        clearTimeout(timer);
        if (!mutationOutcomeUncertain(result)) markCommandSettled(commandId);
        resolve(result);
      });

      socket.emit(eventName, body);
    });
  }

  function readCookie(name) {
    try {
      const parts = String(document.cookie || '').split(';');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (part.indexOf(name + '=') === 0) {
          return decodeURIComponent(part.slice(name.length + 1));
        }
      }
    } catch { /* cookies blocked */ }
    return '';
  }

  async function getCsrfToken() {
    if (csrfTokenCache) return csrfTokenCache;
    const fromCookie = readCookie(CSRF_COOKIE_NAME);
    if (fromCookie) {
      csrfTokenCache = fromCookie;
      return csrfTokenCache;
    }
    if (typeof fetch !== 'function') return '';
    const res = await fetch('/api/csrf', {
      credentials: 'same-origin',
      headers: getAuthHeaders(),
    });
    if (!res.ok) return '';
    const data = await res.json();
    csrfTokenCache = typeof data.csrfToken === 'string' ? data.csrfToken : '';
    return csrfTokenCache;
  }

  async function apiWrite(path, body) {
    const csrf = await getCsrfToken();
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'X-Operation-Id': newOperationId(),
    }, getAuthHeaders());
    if (csrf) headers['X-CSRF-Token'] = csrf;
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
  }

  function clearDiagnosticsBody() {
    if (!$capabilityDiagnosticsBody) return;
    while ($capabilityDiagnosticsBody.firstChild) {
      $capabilityDiagnosticsBody.removeChild($capabilityDiagnosticsBody.firstChild);
    }
  }

  function appendDiagnosticRow(label, value, className) {
    const row = document.createElement('div');
    row.className = 'capability-diagnostics-row';
    const key = document.createElement('span');
    key.className = 'capability-diagnostics-label';
    key.textContent = label;
    const text = document.createElement('span');
    text.className = 'capability-diagnostics-value' + (className ? ' ' + className : '');
    text.textContent = value;
    row.append(key, text);
    $capabilityDiagnosticsBody.appendChild(row);
  }

  function renderCapabilityDiagnostics() {
    if (!$capabilityDiagnostics || !$capabilityDiagnosticsSummary || !$capabilityDiagnosticsBody) return;
    const status = capabilityState?.status || {};
    const stateLabel = !capabilityLive ? 'stale' : (status.state || 'unknown');
    const completeness = !capabilityLive
      ? 'reconnecting'
      : (status.completeness || capabilityState?.models?.completeness || 'unknown');
    const modes = Array.isArray(capabilityState?.modes) ? capabilityState.modes : [];
    const models = Array.isArray(capabilityState?.models?.items) ? capabilityState.models.items : [];
    const tools = Array.isArray(capabilityState?.tools) ? capabilityState.tools : [];
    const adapters = Array.isArray(adapterHistory.adapters) ? adapterHistory.adapters : [];
    const pending = adapters.filter((adapter) => adapter?.status === 'pending_confirmation');
    const issueCount = pending.length + (stateLabel === 'ok' && completeness === 'complete' ? 0 : 1);
    const layers = connectionLayers();

    $capabilityDiagnostics.classList.remove(
      'ok', 'warning', 'stale', 'degraded', 'unknown', 'unavailable', 'partial', 'changed',
    );
    $capabilityDiagnostics.classList.add(issueCount ? 'warning' : 'ok');
    if (stateLabel && stateLabel !== 'ok') $capabilityDiagnostics.classList.add(stateLabel);
    if (completeness === 'partial') $capabilityDiagnostics.classList.add('partial');
    $capabilityDiagnostics.dataset.capabilityState = stateLabel;
    $capabilityDiagnostics.dataset.completeness = completeness;
    $capabilityDiagnostics.dataset.socket = layers.socket;
    $capabilityDiagnostics.dataset.cdp = layers.cdp;
    $capabilityDiagnostics.dataset.extractor = layers.extractor;
    $capabilityDiagnosticsSummary.textContent = `Capabilities: ${stateLabel} · ${completeness}${pending.length ? ` · ${pending.length} pending adapter${pending.length === 1 ? '' : 's'}` : ''}`;
    $capabilityDiagnosticsSummary.title = connectionA11yTitle(layers, `Capabilities ${stateLabel}/${completeness}`);
    clearDiagnosticsBody();

    appendDiagnosticRow('Discovery', `${stateLabel} / ${completeness}`, issueCount ? 'warning' : 'ok');
    appendDiagnosticRow(
      'Connection',
      `relay ${layers.socket} · CDP ${layers.cdp} · extractor ${layers.extractor}`,
      layers.socket === 'connected' && layers.cdp === 'connected' && layers.extractor === 'ok' ? 'ok' : 'warning',
    );
    appendDiagnosticRow('Available', `${modes.length} modes · ${models.length} models · ${tools.length} tools`);
    if (capabilityState?.targetId) {
      appendDiagnosticRow('Target', `${String(capabilityState.targetId).slice(0, 12)} · generation ${Number(capabilityState.targetGeneration || 0)}`);
    }

    if (capabilityDiff) {
      const added = Array.isArray(capabilityDiff.added) ? capabilityDiff.added.length : 0;
      const removed = Array.isArray(capabilityDiff.removed) ? capabilityDiff.removed.length : 0;
      const changed = Array.isArray(capabilityDiff.changed) ? capabilityDiff.changed.length : 0;
      const conflicts = Array.isArray(capabilityDiff.conflicts) ? capabilityDiff.conflicts.length : 0;
      appendDiagnosticRow('Observed diff', `+${added} / −${removed} / ${changed} changed / ${conflicts} conflicts`);
    }

    const bindings = Array.isArray(adapterHistory.activeBindings)
      ? adapterHistory.activeBindings.length
      : (adapterHistory.activeBindings && typeof adapterHistory.activeBindings === 'object'
        ? Object.keys(adapterHistory.activeBindings).length : 0);
    appendDiagnosticRow('Adapters', `${bindings} active binding${bindings === 1 ? '' : 's'} · ${pending.length} awaiting confirmation`, pending.length ? 'warning' : '');
    if (pending.length) {
      appendDiagnosticRow('Activation', 'unavailable from this UI — confirm manually', 'warning');
    }

    for (const adapter of pending) {
      const card = document.createElement('div');
      card.className = 'pending-adapter';
      const title = document.createElement('strong');
      title.textContent = Array.isArray(adapter.capabilityKinds) && adapter.capabilityKinds.length
        ? `${adapter.capabilityKinds.join('/')} adapter` : 'Capability adapter';
      const metadata = document.createElement('span');
      metadata.textContent = `${String(adapter.id || '').slice(0, 12)} · activation unavailable — confirm manually`;
      card.append(title, metadata);
      $capabilityDiagnosticsBody.appendChild(card);
    }
  }

  async function refreshCapabilityDiagnostics() {
    if (typeof fetch !== 'function') return;
    try {
      const headers = getAuthHeaders();
      const [diffResponse, adapterResponse] = await Promise.all([
        fetch('/api/capabilities/diff', { credentials: 'same-origin', headers }),
        fetch('/api/adapters/history', { credentials: 'same-origin', headers }),
      ]);
      if (diffResponse.ok) capabilityDiff = await diffResponse.json();
      if (adapterResponse.ok) adapterHistory = await adapterResponse.json();
      renderCapabilityDiagnostics();
    } catch {
      // Socket capability state remains usable while diagnostics endpoints recover.
    }
  }

  function setCapabilityRefreshStatus(message, isError) {
    if (!$capabilityRefreshStatus) return;
    if (!message) {
      $capabilityRefreshStatus.hidden = true;
      $capabilityRefreshStatus.textContent = '';
      $capabilityRefreshStatus.classList.remove('error');
      return;
    }
    $capabilityRefreshStatus.hidden = false;
    $capabilityRefreshStatus.textContent = message;
    $capabilityRefreshStatus.classList.toggle('error', !!isError);
  }

  function setCapabilityRefreshBusy(busy) {
    if ($btnCapabilityRefresh) {
      $btnCapabilityRefresh.disabled = busy;
      $btnCapabilityRefresh.textContent = busy ? 'Refreshing Cursor capabilities…' : 'Refresh Cursor capabilities';
    }
    if ($btnModeModelRefresh) {
      $btnModeModelRefresh.disabled = busy;
      $btnModeModelRefresh.textContent = busy ? 'Refreshing…' : 'Refresh capabilities';
    }
  }

  async function runCapabilityDiscovery() {
    if (capabilityDiscoveryInFlight) return;
    if (supervisionContextPending || supervisionState) {
      showToast('Capability discovery is outside this supervision grant', 'error');
      return;
    }
    capabilityDiscoveryInFlight = true;
    setCapabilityRefreshBusy(true);
    setCapabilityRefreshStatus('Refreshing Cursor capabilities… this may open and close menus.');
    try {
      const res = await apiWrite('/api/discovery/run', {});
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        const models = Array.isArray(data.data?.models?.items) ? data.data.models.items : [];
        const selectableComposerModels = models.filter((model) =>
          model && model.scope === 'composer' && model.selectable === true
        );
        const complete = data.data?.models?.completeness === 'complete';
        if (selectableComposerModels.length > 0 && complete) {
          setCapabilityRefreshStatus(
            `Capability refresh finished: ${selectableComposerModels.length} selectable composer model${selectableComposerModels.length === 1 ? '' : 's'}.`
          );
        } else {
          const detail = selectableComposerModels.length === 0
            ? 'no verified selectable composer models'
            : `${selectableComposerModels.length} composer models, but the list is not complete`;
          setCapabilityRefreshStatus(
            `Capability refresh finished with a warning: ${detail}. Open the model menu in Cursor and retry.`,
            true,
          );
        }
        void refreshCapabilityDiagnostics();
      } else {
        setCapabilityRefreshStatus(data.error || `Capability refresh failed (${res.status})`, true);
      }
    } catch {
      setCapabilityRefreshStatus('Capability refresh failed', true);
    } finally {
      capabilityDiscoveryInFlight = false;
      setCapabilityRefreshBusy(false);
      applySupervisionChrome();
    }
  }

  if ($btnCapabilityRefresh) {
    $btnCapabilityRefresh.title = 'Opens Cursor mode and model menus to rediscover capabilities. Never runs automatically.';
    $btnCapabilityRefresh.addEventListener('click', () => { void runCapabilityDiscovery(); });
  }
  if ($btnModeModelRefresh) {
    $btnModeModelRefresh.title = 'Explicitly opens and closes Cursor mode and model menus to verify this window.';
    $btnModeModelRefresh.addEventListener('click', () => { void runCapabilityDiscovery(); });
  }

  renderCapabilityDiagnostics();

  function reportStartupTiming() {
    if (startupTiming.reported || !startupTiming.firstRenderAt) return;
    startupTiming.reported = true;
    const resourceMs = {};
    try {
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        for (const entry of performance.getEntriesByType('resource')) {
          const name = String(entry.name || '');
          const file = ['styles.css', 'vendor-socket.io.min.js', 'app.js'].find((item) => name.includes(item));
          if (file) resourceMs[file] = Math.round(entry.duration || 0);
        }
      }
    } catch { /* Resource Timing may be unavailable or privacy-restricted. */ }
    const healthMs = Math.round(Math.max(0, startupTiming.authDoneAt - startupTiming.authStartedAt));
    window.__cursorRemoteStartupTiming = {
      healthMs,
      authMs: healthMs,
      socketMs: Math.round(Math.max(0, startupTiming.socketConnectedAt - startupTiming.startedAt)),
      stateFullMs: Math.round(Math.max(0, startupTiming.stateFullAt - startupTiming.startedAt)),
      firstRenderMs: Math.round(Math.max(0, startupTiming.firstRenderAt - startupTiming.startedAt)),
      resourceMs,
    };
  }

  function isSocketLive() {
    return !!socket.connected && stateSnapshotFresh && state.connected === true;
  }

  function relaySocketLayer() {
    if (socket.connected) return 'connected';
    if (socketPhase === 'connecting') return 'connecting';
    if (socketPhase === 'reconnecting') return 'reconnecting';
    return 'disconnected';
  }

  function tryReconnectSocket() {
    if (socket.connected) return;
    if (typeof socket.connect === 'function') socket.connect();
  }

  function clearStateFullWatchdog() {
    if (stateFullWatchdog) {
      clearTimeout(stateFullWatchdog);
      stateFullWatchdog = 0;
    }
  }

  function armStateFullWatchdog() {
    clearStateFullWatchdog();
    stateFullWatchdog = setTimeout(() => {
      stateFullWatchdog = 0;
      if (!socket.connected) return;
      socket.emit('state:request');
    }, STATE_FULL_WATCHDOG_MS);
  }

  function failPendingCommands(error) {
    const pending = Array.from(pendingCommandResults.entries());
    pendingCommandResults.clear();
    lateCommandResults.clear();
    settledCommandIds.clear();
    for (let i = 0; i < pending.length; i++) {
      pending[i][1]({
        commandId: pending[i][0],
        ok: false,
        error: error,
        outcomeUnknown: true,
      });
    }
  }

  function refreshInteractiveUi() {
    renderConnectionStatus();
    renderAgentStatus();
    renderInputState();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderSessionPlans();
  }

  window.addEventListener('online', tryReconnectSocket);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tryReconnectSocket();
  });

  socket.on('connect', () => {
    socketPhase = 'connected';
    stateSnapshotFresh = false;
    supervisionContextPending = true;
    supervisionState = null;
    supervisionOverview = null;
    renderSupervision();
    if (!startupTiming.socketConnectedAt) startupTiming.socketConnectedAt = startupNow();
    capabilityLive = true;
    awaitingCapabilityFull = true;
    armStateFullWatchdog();
    renderModeModel();
    renderCapabilityDiagnostics();
    refreshInteractiveUi();
    renderSessionPlans();
    void refreshCapabilityDiagnostics();
  });
  socket.on('disconnect', (reason) => {
    socketPhase = reason === 'io client disconnect' ? 'disconnected' : 'reconnecting';
    stateSnapshotFresh = false;
    supervisionContextPending = true;
    supervisionState = null;
    supervisionOverview = null;
    renderSupervision();
    clearQuestionnaireSyncWait();
    clearStateFullWatchdog();
    failPendingCommands('Disconnected from relay');
    capabilityLive = false;
    awaitingCapabilityFull = true;
    if (capabilityState) {
      capabilityState = { ...capabilityState, status: { ...(capabilityState.status || {}), state: 'stale' } };
    }
    cachedModelOptions = null;
    clearPlanDiscovery();
    closePlanModal();
    if (activeSheet === 'mode' || activeSheet === 'model') closeSheet();
    renderModeModel();
    renderCapabilityDiagnostics();
    refreshInteractiveUi();
    renderSessionPlans();
  });

  if (socket.io && typeof socket.io.on === 'function') {
    socket.io.on('reconnect_attempt', () => {
      socketPhase = 'reconnecting';
      refreshInteractiveUi();
    });
    socket.io.on('reconnect_failed', () => {
      socketPhase = 'disconnected';
      refreshInteractiveUi();
    });
  }

  socket.on('connect_error', (err) => {
    const msg = typeof err === 'string' ? err : (err && err.message) ? String(err.message) : '';
    // Only real auth rejection clears the session. Transient/weak-network
    // connect_error (xhr poll error, timeout, transport close) must not
    // drop a still-valid token and bounce the user to /login.
    if (msg === 'Unauthorized' || /unauthorized/i.test(msg)) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      window.location.href = '/login';
    }
  });

  socket.on('state:full', (newState) => {
    clearStateFullWatchdog();
    clearQuestionnaireNullHold();
    stateSnapshotFresh = true;
    clearQuestionnaireSyncWait();
    if (!startupTiming.stateFullAt) startupTiming.stateFullAt = startupNow();
    reconcileQuestionnaireEnvelopes(newState?.questionnaire ?? null, state.questionnaire);
    state = { ...defaultState, ...newState };
    messagesSessionIdentity = currentPlanSessionIdentity();
    renderAll();
    if (!startupTiming.firstRenderAt) {
      startupTiming.firstRenderAt = startupNow();
      reportStartupTiming();
    }
  });

  socket.on('state:patch', (patch) => {
    const prevQuestionnaire = state.questionnaire;
    Object.assign(state, patch);
    if (hasPatchKey(patch, 'messages')) {
      messagesSessionIdentity = currentPlanSessionIdentity();
    }
    if (hasPatchKey(patch, 'questionnaire')) {
      stabilizeQuestionnairePatch(patch.questionnaire, prevQuestionnaire);
    }
    applyStatePatch(patch);
  });

  socket.on('supervision:state', (snapshot) => {
    supervisionContextPending = false;
    supervisionState = snapshot && typeof snapshot === 'object' ? snapshot : null;
    supervisionOverview = null;
    renderSupervision();
    renderModeModel();
    refreshInteractiveUi();
  });

  socket.on('supervision:overview', (overview) => {
    supervisionContextPending = false;
    supervisionOverview = overview && typeof overview === 'object' ? overview : null;
    if (!supervisionState) {
      renderSupervision();
      renderModeModel();
      refreshInteractiveUi();
    }
  });

  async function postSupervision(path, body) {
    const csrf = await getCsrfToken();
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, getAuthHeaders()),
      body: JSON.stringify(body || {}),
    });
  }

  async function decideSupervisionIssue(issueId, decision) {
    if (supervisionPostInFlight) return;
    if (supervisionState) return;
    supervisionPostInFlight = true;
    try {
      const res = await postSupervision(
        '/api/supervision/issues/' + encodeURIComponent(issueId) + '/decision',
        { decision: decision },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(body.error || 'Decision was rejected', 'error');
      }
    } finally {
      supervisionPostInFlight = false;
    }
  }

  function currentIssueCandidate() {
    const approval = Array.isArray(state.pendingApprovals) ? state.pendingApprovals[0] : null;
    if (approval && Array.isArray(approval.actions)) {
      const action = approval.actions.find((item) => item && hasOpaqueActionId(item.actionId));
      if (action) return {
        actionType: action.type,
        actionId: action.actionId,
        evidence: approval.description || action.label || 'Current approval requires a human decision',
      };
    }
    const messages = Array.isArray(state.messages) ? state.messages.slice().reverse() : [];
    for (const message of messages) {
      const action = Array.isArray(message.actions)
        ? message.actions.find((item) => item && hasOpaqueActionId(item.actionId) && DANGEROUS_ACTION_TYPES.has(item.type))
        : null;
      if (action) return {
        actionType: action.type,
        actionId: action.actionId,
        evidence: action.label || 'Current Cursor action requires a human decision',
      };
    }
    return null;
  }

  async function recordSupervisionCheck() {
    if (supervisionPostInFlight) return;
    if (!supervisionState || !supervisionState.grant) return;
    supervisionPostInFlight = true;
    try {
      const status = state.connected && state.extractorStatus === 'ok' ? 'ok' : 'attention';
      const res = await postSupervision('/api/supervision/checks', {
        status: status,
        summary: 'Browser check of connection, extraction, target and visible task state',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(body.error || 'Active check was rejected', 'error');
      }
    } finally {
      supervisionPostInFlight = false;
    }
  }

  async function requestCurrentIssueDecision() {
    if (supervisionPostInFlight) return;
    const grant = supervisionState && supervisionState.grant;
    const candidate = currentIssueCandidate();
    if (!grant || !candidate) {
      showToast('No current authorized action is available for a decision request', 'error');
      return;
    }
    supervisionPostInFlight = true;
    try {
      const res = await postSupervision('/api/supervision/issues', {
        composerId: state.activeComposerId,
        actionType: candidate.actionType,
        actionId: candidate.actionId,
        planVersion: grant.planVersion,
        authorizationVersion: grant.authorizationVersion,
        contentDigest: candidate.actionId,
        expiresAt: Date.now() + 10 * 60 * 1000,
        evidence: candidate.evidence,
        recommendation: 'Review the visible Cursor action and approve or reject this issue only.',
        attemptedActions: [],
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(body.error || 'Decision request was rejected', 'error');
      }
    } finally {
      supervisionPostInFlight = false;
    }
  }

  async function resumeSupervisionRecovery(grantId) {
    if (supervisionPostInFlight) return;
    if (supervisionState || !grantId) return;
    supervisionPostInFlight = true;
    try {
      const res = await postSupervision(
        '/api/supervision/grants/' + encodeURIComponent(grantId) + '/resume-recovery',
        {},
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(body.error || 'Resume recovery was rejected', 'error');
      }
    } finally {
      supervisionPostInFlight = false;
    }
  }

  async function resumeSupervisionAfterTakeover(grantId) {
    if (supervisionPostInFlight) return;
    if (supervisionState || !grantId) return;
    supervisionPostInFlight = true;
    try {
      const res = await postSupervision(
        '/api/supervision/grants/' + encodeURIComponent(grantId) + '/resume-supervision',
        {},
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(body.error || 'Resume supervision was rejected', 'error');
      }
    } finally {
      supervisionPostInFlight = false;
    }
  }

  if ($btnSupervisionCheck) {
    $btnSupervisionCheck.addEventListener('click', () => { void recordSupervisionCheck(); });
  }
  if ($btnSupervisionRequest) {
    $btnSupervisionRequest.addEventListener('click', () => { void requestCurrentIssueDecision(); });
  }

  function clearSupervisionPanelContent() {
    if ($supervisionStatus) $supervisionStatus.textContent = '';
    if ($supervisionSummary) $supervisionSummary.textContent = '';
    if ($supervisionIssues) $supervisionIssues.textContent = '';
    if ($supervisionChecks) $supervisionChecks.textContent = '';
    if ($supervisionOperations) $supervisionOperations.textContent = '';
    if ($supervisionOwnerActions) $supervisionOwnerActions.textContent = '';
    if ($btnSupervisionCheck) {
      $btnSupervisionCheck.classList.add('hidden');
      $btnSupervisionCheck.disabled = true;
    }
    if ($btnSupervisionRequest) {
      $btnSupervisionRequest.classList.add('hidden');
      $btnSupervisionRequest.disabled = true;
    }
  }

  function applySupervisionChrome() {
    const blockedNav = supervisionContextPending || !!supervisionState;
    if ($btnNewChat) {
      $btnNewChat.disabled = blockedNav;
      $btnNewChat.title = supervisionContextPending
        ? 'Waiting to confirm supervision context.'
        : (supervisionState ? 'New chat is outside this supervision grant' : '');
    }
    if ($btnCapabilityRefresh && !capabilityDiscoveryInFlight) {
      $btnCapabilityRefresh.disabled = blockedNav;
      $btnCapabilityRefresh.title = blockedNav
        ? 'Capability discovery is outside this supervision grant'
        : 'Opens Cursor mode and model menus to rediscover capabilities. Never runs automatically.';
    }
    if ($btnModeModelRefresh && !capabilityDiscoveryInFlight) {
      $btnModeModelRefresh.disabled = blockedNav;
    }
  }

  function renderSupervision() {
    if (!$supervisionPanel) return;
    const ownerSnapshots = supervisionOverview && Array.isArray(supervisionOverview.grants)
      ? supervisionOverview.grants
      : [];
    const snapshots = supervisionState ? [supervisionState] : ownerSnapshots;
    if (snapshots.length === 0) {
      $supervisionPanel.classList.add('hidden');
      clearSupervisionPanelContent();
      applySupervisionChrome();
      return;
    }
    $supervisionPanel.classList.remove('hidden');
    const grants = snapshots.map((snapshot) => snapshot && snapshot.grant).filter(Boolean);
    const paused = grants.filter((grant) => grant.status !== 'active' || (grant.pauseReasons || []).length > 0);
    $supervisionStatus.textContent = paused.length > 0 ? 'Paused or awaiting recovery' : 'Active';
    $supervisionSummary.textContent = grants.map((grant) => {
      const reasons = Array.isArray(grant.pauseReasons) && grant.pauseReasons.length > 0
        ? ' · pauses: ' + grant.pauseReasons.join(', ')
        : '';
      return grant.goal + ' · plan ' + grant.planVersion + ' · authorization ' + grant.authorizationVersion
        + ' · operations ' + grant.operationsUsed + '/' + grant.operationLimit + reasons;
    }).join(' | ');

    const isSupervisor = !!supervisionState;
    const grant = supervisionState && supervisionState.grant;
    if ($btnSupervisionCheck) {
      $btnSupervisionCheck.classList.toggle('hidden', !isSupervisor);
      $btnSupervisionCheck.disabled = !isSupervisor || !grant;
    }
    if ($btnSupervisionRequest) {
      const canRequest = isSupervisor && !!grant && !!currentIssueCandidate();
      $btnSupervisionRequest.classList.toggle('hidden', !isSupervisor);
      $btnSupervisionRequest.disabled = !canRequest;
    }

    if ($supervisionOwnerActions) {
      $supervisionOwnerActions.textContent = '';
      if (!isSupervisor) {
        grants.forEach((item) => {
          if (!item) return;
          if (item.status === 'pending_recovery') {
            const resume = document.createElement('button');
            resume.type = 'button';
            resume.textContent = 'Resume recovery';
            resume.setAttribute('aria-label', 'Resume recovery for grant ' + item.grantId);
            resume.dataset.grantId = item.grantId;
            resume.addEventListener('click', () => { void resumeSupervisionRecovery(item.grantId); });
            $supervisionOwnerActions.appendChild(resume);
          }
          if (item.status === 'active' && Array.isArray(item.pauseReasons) && item.pauseReasons.includes('human_takeover')) {
            const resume = document.createElement('button');
            resume.type = 'button';
            resume.textContent = 'Resume supervision';
            resume.setAttribute('aria-label', 'Resume supervision after human takeover for grant ' + item.grantId);
            resume.dataset.grantId = item.grantId;
            resume.addEventListener('click', () => { void resumeSupervisionAfterTakeover(item.grantId); });
            $supervisionOwnerActions.appendChild(resume);
          }
        });
      }
    }

    $supervisionIssues.textContent = '';
    snapshots.forEach((snapshot) => {
      (Array.isArray(snapshot.issues) ? snapshot.issues : []).forEach((issue) => {
        const row = document.createElement('div');
        row.className = 'supervision-issue';
        const text = document.createElement('div');
        text.textContent = 'Issue ' + String(issue.issueId || '').slice(0, 12)
          + ' · ' + issue.actionType + ' · ' + issue.status + '/' + (issue.decision || 'pending')
          + (issue.evidence ? ' · ' + issue.evidence : '')
          + (issue.recommendation ? ' · recommendation: ' + issue.recommendation : '')
          + ' · notification: ' + (issue.notificationStatus || 'unknown');
        row.appendChild(text);
        if (!supervisionState && issue.status === 'pending' && issue.decision === 'pending') {
          const actions = document.createElement('div');
          actions.className = 'supervision-issue-actions';
          const approve = document.createElement('button');
          approve.type = 'button';
          approve.textContent = 'Approve this issue once';
          approve.setAttribute('aria-label', 'Approve issue ' + issue.issueId + ' once');
          approve.addEventListener('click', () => { void decideSupervisionIssue(issue.issueId, 'approved'); });
          const reject = document.createElement('button');
          reject.type = 'button';
          reject.textContent = 'Reject';
          reject.setAttribute('aria-label', 'Reject issue ' + issue.issueId);
          reject.addEventListener('click', () => { void decideSupervisionIssue(issue.issueId, 'rejected'); });
          actions.appendChild(approve);
          actions.appendChild(reject);
          row.appendChild(actions);
        }
        $supervisionIssues.appendChild(row);
      });
    });

    const checks = snapshots.flatMap((snapshot) => Array.isArray(snapshot.checks) ? snapshot.checks : []);
    const latest = checks.length > 0 ? checks[checks.length - 1] : null;
    $supervisionChecks.textContent = latest
      ? 'Last active check: ' + new Date(latest.checkedAt).toLocaleString() + ' · ' + latest.status + ' · ' + latest.summary
      : 'No active supervisor check has been recorded.';
    const operations = snapshots.flatMap((snapshot) => Array.isArray(snapshot.operations) ? snapshot.operations : []);
    const lastOperation = operations.length > 0 ? operations[operations.length - 1] : null;
    $supervisionOperations.textContent = lastOperation
      ? 'Last operation: ' + lastOperation.operationId + ' · ' + lastOperation.status
      : 'No supervised operation receipt has been recorded.';
    applySupervisionChrome();
  }

  const CAPABILITY_MUTATION_STATES = new Set(['ok', 'changed']);

  function capabilityStatusState() {
    return capabilityState?.status?.state || 'unknown';
  }

  function capabilityModelCompleteness() {
    return capabilityState?.models?.completeness
      || capabilityState?.status?.completeness
      || 'unknown';
  }

  function observedModes() {
    return Array.isArray(capabilityState?.modes) ? capabilityState.modes : [];
  }

  function observedModels() {
    return Array.isArray(capabilityState?.models?.items) ? capabilityState.models.items : [];
  }

  function selectableModes() {
    return observedModes().filter((mode) =>
      mode && typeof mode.id === 'string' && mode.id && mode.selectable === true);
  }

  function selectableComposerModels() {
    return observedModels().filter((model) =>
      model
      && typeof model.id === 'string'
      && model.id
      && model.selectable === true
      && model.scope === 'composer');
  }

  function isModeMutationEnabled() {
    if (!capabilityLive || awaitingCapabilityFull) return false;
    if (!capabilityState) return false;
    if (!CAPABILITY_MUTATION_STATES.has(capabilityStatusState())) return false;
    return selectableModes().length > 0;
  }

  function isModelMutationEnabled() {
    if (!capabilityLive || awaitingCapabilityFull) return false;
    if (!capabilityState) return false;
    if (!CAPABILITY_MUTATION_STATES.has(capabilityStatusState())) return false;
    if (capabilityModelCompleteness() !== 'complete') return false;
    return selectableComposerModels().length > 0;
  }

  function clearModelOptionsIfUnusable() {
    if (!isModelMutationEnabled() || capabilityModelCompleteness() !== 'complete') {
      cachedModelOptions = null;
    }
  }

  function projectObservedCapabilities(snapshot) {
    const modes = Array.isArray(snapshot.modes) ? snapshot.modes : [];
    const models = Array.isArray(snapshot.models?.items) ? snapshot.models.items : [];
    const currentMode = modes.find((mode) => mode.current);
    // Selectable ids only — never fabricate Agent/Plan/Ask/Debug defaults.
    state.mode = {
      current: currentMode?.id || '',
      available: modes
        .filter((mode) => mode && typeof mode.id === 'string' && mode.id && mode.selectable === true)
        .map((mode) => ({ id: mode.id, label: mode.label, icon: mode.icon || '' })),
    };
    const selectedComposer = models.find((model) => model.selected && model.scope === 'composer');
    state.model = selectedComposer
      ? { current: selectedComposer.label || selectedComposer.id, currentId: selectedComposer.id }
      : { current: '', currentId: '' };
  }

  function resetCapabilityCaches() {
    cachedModelOptions = null;
    state.mode = { current: '', available: [] };
    state.model = { current: '', currentId: '' };
    if ($sheetModeList) $sheetModeList.textContent = '';
    if ($sheetModelList) $sheetModelList.textContent = '';
    if (activeSheet === 'mode' || activeSheet === 'model') closeSheet();
  }

  function snapshotFromCapabilityFull(payload) {
    if (!payload || typeof payload !== 'object') return { activeTargetId: '', snapshot: null };
    if (Array.isArray(payload.snapshots)) {
      const activeTargetId = typeof payload.activeTargetId === 'string' ? payload.activeTargetId : '';
      const snapshot = payload.snapshots.find((item) => item && item.targetId === activeTargetId)
        || payload.snapshots[0]
        || null;
      return { activeTargetId: activeTargetId || snapshot?.targetId || '', snapshot };
    }
    if (typeof payload.targetId === 'string' && payload.targetId) {
      return { activeTargetId: payload.targetId, snapshot: payload };
    }
    return { activeTargetId: '', snapshot: null };
  }

  function capabilityIdentityChanged(snapshot) {
    if (!snapshot) return !!capabilityState;
    if (!capabilityState) return false;
    return capabilityState.targetId !== snapshot.targetId
      || Number(capabilityState.targetGeneration || 0) !== Number(snapshot.targetGeneration || 0);
  }

  function applyCapabilitySnapshot(snapshot) {
    if (!snapshot) return;
    if (capabilityState && capabilityState.targetId === snapshot.targetId) {
      const currentGeneration = Number(capabilityState.targetGeneration || 0);
      const nextGeneration = Number(snapshot.targetGeneration || 0);
      const currentRevision = Number(capabilityState.revision || 0);
      const nextRevision = Number(snapshot.revision || 0);
      if (nextGeneration < currentGeneration || (nextGeneration === currentGeneration && nextRevision < currentRevision)) return;
    }
    if (capabilityIdentityChanged(snapshot)) resetCapabilityCaches();
    capabilityState = snapshot;
    projectObservedCapabilities(snapshot);
    clearModelOptionsIfUnusable();
    renderModeModel();
    renderCapabilityDiagnostics();
    renderConnectionStatus();
    if (activeSheet === 'mode') renderModeSheet();
    else if (activeSheet === 'model' && cachedModelOptions) renderModelSheet(cachedModelOptions);
  }

  function patchTargetAccepted(targetId) {
    if (!targetId) return false;
    if (capabilityState && capabilityState.targetId) return targetId === capabilityState.targetId;
    if (state.activeWindowId) return targetId === state.activeWindowId;
    return true;
  }

  socket.on('capabilities:full', (payload) => {
    const parsed = snapshotFromCapabilityFull(payload);
    awaitingCapabilityFull = false;
    if (!parsed.snapshot) {
      if (Array.isArray(payload?.snapshots)) {
        resetCapabilityCaches();
        capabilityState = null;
        renderModeModel();
        renderCapabilityDiagnostics();
        renderConnectionStatus();
      }
      return;
    }
    applyCapabilitySnapshot(parsed.snapshot);
  });

  socket.on('capabilities:patch', (patch) => {
    if (!patch || !patchTargetAccepted(patch.targetId)) return;
    const current = capabilityState && capabilityState.targetId === patch.targetId
      ? capabilityState : { targetId: patch.targetId, modes: [], models: { items: [] } };
    applyCapabilitySnapshot({ ...current, ...patch, status: patch.status || current.status });
  });

  socket.on('capabilities:stale', (patch) => {
    if (capabilityState && capabilityState.targetId === patch?.targetId) {
      capabilityState = { ...capabilityState, status: { ...(capabilityState.status || {}), state: 'stale' } };
      cachedModelOptions = null;
      if (activeSheet === 'mode' || activeSheet === 'model') closeSheet();
      renderModeModel();
      renderCapabilityDiagnostics();
      renderConnectionStatus();
    }
  });

  socket.on('adapter:pending', (adapter) => {
    if (!adapter?.id) return;
    const adapters = Array.isArray(adapterHistory.adapters) ? adapterHistory.adapters : [];
    adapterHistory = { ...adapterHistory, adapters: [...adapters.filter((item) => item?.id !== adapter.id), adapter] };
    renderCapabilityDiagnostics();
    showToast(`New ${Array.isArray(adapter.capabilityKinds) ? adapter.capabilityKinds.join('/') : ''} adapter pending — activation unavailable from this UI`, 'success');
    void refreshCapabilityDiagnostics();
  });
  socket.on('adapter:changed', () => {
    showToast('Adapter configuration changed', 'success');
    void refreshCapabilityDiagnostics();
  });

  socket.on('connection:status', (data) => {
    state.connected = data.connected;
    refreshInteractiveUi();
  });

  socket.on('command:result', (result) => {
    const pending = pendingCommandResults.get(result.commandId);
    if (pending) {
      pendingCommandResults.delete(result.commandId);
      pending(result);
      return;
    }
    if (settledCommandIds.has(result.commandId)) return;
    rememberBounded(lateCommandResults, result.commandId, result);
  });

  $messages.addEventListener('scroll', () => {
    autoScrollJob++;
    userScrolledUp = !isNearMessagesBottom();
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    renderInputState();
  });

  // Send-on-Enter behaves differently per primary input device:
  //   - Touch (mobile): Enter = newline (textarea default), tap Send to send.
  //     Mobile keyboards have no Shift+Enter so without this you can't write
  //     multi-line messages — reported as public#5.
  //   - Mouse/keyboard (desktop): Enter = send (preserved existing behavior),
  //     Shift+Enter = newline.
  // Cmd/Ctrl+Enter always sends, both platforms — for hardware keyboards
  // attached to phones/tablets and as a familiar shortcut on desktop.
  const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
  $input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    if (e.shiftKey) return; // textarea default → newline
    if (isTouchPrimary()) return; // mobile: newline, send button only
    e.preventDefault();
    sendMessage();
  });

  $btnSend.addEventListener('click', sendMessage);

  $btnApprove.addEventListener('click', () => { void submitApproval('approve'); });

  $btnReject.addEventListener('click', () => { void submitApproval('reject'); });

  $btnQSkip.addEventListener('click', () => {
    if (!state.questionnaire) return;
    if (!isSocketLive()) {
      showToast('Relay disconnected', 'error');
      return;
    }
    if (!hasOpaqueActionId(state.questionnaire.skipActionId)) {
      showToast('Questionnaire authorization is unavailable; refresh CursorRemote', 'error');
      return;
    }
    void submitQuestionnaireAction('skip', state.questionnaire.skipActionId);
  });

  $btnQContinue.addEventListener('click', () => {
    if (!state.questionnaire) return;
    if (!isSocketLive()) {
      showToast('Relay disconnected', 'error');
      return;
    }
    if (state.questionnaire.continueDisabled) {
      showToast('Continue is still disabled until Cursor accepts an answer', 'error');
      return;
    }
    if (!hasOpaqueActionId(state.questionnaire.continueActionId)) {
      showToast('Questionnaire authorization is unavailable; refresh CursorRemote', 'error');
      return;
    }
    void submitQuestionnaireAction('continue', state.questionnaire.continueActionId);
  });

  $btnNewChat.addEventListener('click', () => {
    if (mutationSubmitInFlight.has('new_chat')) return;
    const blocked = cursorMutationBlockedReason('command:new_chat', {});
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }
    mutationSubmitInFlight.add('new_chat');
    try {
      const body = emitCommand('command:new_chat', {});
      if (body) showToast('Creating new chat...', 'success');
    } finally {
      mutationSubmitInFlight.delete('new_chat');
    }
  });

  if ($btnSystem) $btnSystem.addEventListener('click', openSystemPanel);
  if ($systemPanelClose) $systemPanelClose.addEventListener('click', closeSystemPanel);
  $contextMain.addEventListener('click', () => {
    if (supervisionContextPending || supervisionState) {
      showToast('Session and window switching is outside this supervision grant', 'error');
      return;
    }
    openDrawer();
  });
  $drawerClose.addEventListener('click', closeDrawer);
  $drawerOverlay.addEventListener('click', closeDrawer);
  if ($questionnaireTrigger) $questionnaireTrigger.addEventListener('click', openQuestionnaireSheet);
  if ($questionnaireSheetClose) $questionnaireSheetClose.addEventListener('click', closeQuestionnaireSheet);
  if ($queueToggle) $queueToggle.addEventListener('click', toggleQueueDetails);
  if ($sessionPlansToggle) $sessionPlansToggle.addEventListener('click', toggleSessionPlans);
  if ($headerRight) {
    $headerRight.addEventListener('click', toggleQueueDetails);
    $headerRight.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleQueueDetails();
    });
  }
  if ($btnApprovalView) {
    $btnApprovalView.addEventListener('click', () => {
      const approval = state.pendingApprovals[0];
      const card = findApprovalCard(approval);
      if (!scrollToApprovalCard(card)) renderApprovals();
    });
  }

  $pillMode.addEventListener('click', () => {
    if (!isModeMutationEnabled()) return;
    openSheet('mode');
  });
  $pillModel.addEventListener('click', () => {
    if (!isModelMutationEnabled()) return;
    openSheet('model');
  });
  $sheetOverlay.addEventListener('click', closeSheet);
  $planModalClose.addEventListener('click', closePlanModal);

  function sendMessage() {
    void submitSendMessage();
  }

  async function submitSendMessage() {
    if (sendInFlight || !isSocketLive()) return;
    const text = $input.value.trim();
    if (!text) return;
    const blocked = cursorMutationBlockedReason('command:send_message', { text });
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }
    sendEnvelope = reuseEnvelope('command:send_message', { text }, sendEnvelope);
    sendInFlight = true;
    renderInputState();
    const result = await sendCommandAwaitResult('command:send_message', sendEnvelope);
    sendInFlight = false;
    if (!result.ok) {
      if (!mutationOutcomeUncertain(result)) sendEnvelope = null;
      renderInputState();
      showToast(commandErrorMessage(result, 'Failed to send message'), 'error');
      return;
    }
    if ($input.value.trim() === text) {
      $input.value = '';
      $input.style.height = 'auto';
    }
    sendEnvelope = null;
    renderInputState();
    showToast('Message sent', 'success');
  }

  async function submitApproval(kind) {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    if ($approvalBar && $approvalBar.dataset.mode !== 'fallback') return;
    if (!isSocketLive()) {
      showToast('Relay disconnected', 'error');
      return;
    }
    if (kind === 'reject') {
      if (rejectInFlight || approvalInFlight) return;
      const action = approval.actions.find(a => a.type === 'reject' && hasOpaqueActionId(a.actionId));
      if (!action) { showToast('Approval authorization is unavailable; refresh CursorRemote', 'error'); return; }
      const blocked = cursorMutationBlockedReason('command:reject', { approvalId: approval.id, actionId: action.actionId });
      if (blocked) { showToast(blocked, 'error'); return; }
      rejectEnvelope = reuseEnvelope('command:reject', { approvalId: approval.id, actionId: action.actionId }, rejectEnvelope);
      rejectInFlight = true;
      renderApprovals();
      const result = await sendCommandAwaitResult('command:reject', rejectEnvelope);
      rejectInFlight = false;
      renderApprovals();
      if (!result.ok) {
        if (!mutationOutcomeUncertain(result)) rejectEnvelope = null;
        showToast(commandErrorMessage(result, 'Reject failed'), 'error');
        return;
      }
      rejectEnvelope = null;
      showToast('Rejected', 'success');
      return;
    }
    if (approvalInFlight || rejectInFlight) return;
    const action = approval.actions.find(a => (a.type === 'approve' || a.type === 'approve_all') && hasOpaqueActionId(a.actionId));
    if (!action) { showToast('Approval authorization is unavailable; refresh CursorRemote', 'error'); return; }
    const eventName = action.type === 'approve_all' ? 'command:approve_all' : 'command:approve';
    const blocked = cursorMutationBlockedReason(eventName, { approvalId: approval.id, actionId: action.actionId });
    if (blocked) { showToast(blocked, 'error'); return; }
    approvalEnvelope = reuseEnvelope(eventName, { approvalId: approval.id, actionId: action.actionId }, approvalEnvelope);
    approvalInFlight = true;
    renderApprovals();
    const result = await sendCommandAwaitResult(eventName, approvalEnvelope);
    approvalInFlight = false;
    renderApprovals();
    if (!result.ok) {
      if (!mutationOutcomeUncertain(result)) approvalEnvelope = null;
      showToast(commandErrorMessage(result, 'Approve failed'), 'error');
      return;
    }
    approvalEnvelope = null;
    showToast(action.type === 'approve_all' ? 'Accepted all' : 'Approved', 'success');
  }

  async function submitQuestionnaireAction(actionType, actionId, questionNumber) {
    if (!isSocketLive()) {
      showToast('Relay disconnected', 'error');
      return;
    }
    if (questionnaireNullHoldTimer || questionnaireAwaitingSnapshot) {
      showToast('Questionnaire is refreshing. Wait for the next snapshot.', 'error');
      return;
    }
    if (qActionInFlight) return;
    if (!hasOpaqueActionId(actionId) || typeof actionType !== 'string' || actionType.length === 0) return;
    const blocked = cursorMutationBlockedReason('command:click_action', { actionId, actionType });
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }
    const payload = { actionId, actionType };
    const previous = qEnvelopes.get(actionId);
    const envelope = reuseEnvelope('command:click_action', payload, previous);
    qEnvelopes.set(actionId, envelope);
    qActionInFlight = true;
    renderQuestionnaire();
    const result = await sendCommandAwaitResult('command:click_action', envelope);
    qActionInFlight = false;
    if (!result.ok && actionType === 'questionnaire_option' && questionNumber) {
      delete questionnaireOptimistic[questionNumber];
    }
    renderQuestionnaire();
    if (!result.ok) {
      if (!mutationOutcomeUncertain(result)) qEnvelopes.delete(actionId);
      showToast(commandErrorMessage(result, questionnaireActionError(actionType)), 'error');
      return;
    }
    qEnvelopes.delete(actionId);
    awaitQuestionnaireSnapshot();
    renderQuestionnaire();
    if (actionType === 'skip') showToast('Skipped', 'success');
    else if (actionType === 'continue') showToast('Continued', 'success');
    else showToast('Answer submitted', 'success');
  }

  function questionnaireActionError(actionType) {
    if (actionType === 'skip') return 'Skip failed';
    if (actionType === 'continue') return 'Continue failed';
    return 'Failed to submit questionnaire answer';
  }

  function renderAll() {
    renderConnectionStatus();
    renderAgentStatus();
    renderComposerQueue();
    renderWindowsAndSessions();
    renderSessionPlans();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderInputState();
    renderSupervision();
    renderModeModel();
    syncPlanModalFromState();
  }

  function hasPatchKey(patch, key) {
    return Object.prototype.hasOwnProperty.call(patch, key);
  }

  /** Apply a socket patch by field — health/connection-only updates skip message re-render. */
  function applyStatePatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const has = (key) => hasPatchKey(patch, key);

    if (
      has('connected') ||
      has('extractorStatus') ||
      has('lastExtractionAt') ||
      has('consecutiveExtractionFailures') ||
      has('lastExtractionError')
    ) {
      renderConnectionStatus();
    }
    if (has('connected') || has('inputAvailable')) renderInputState();
    if (has('connected')) {
      renderApprovals();
      renderQuestionnaire();
      if (!has('messages')) renderMessages();
    }
    if (
      has('connected') ||
      has('extractorStatus') ||
      has('agentStatus') ||
      has('agentActivityText') ||
      has('agentActivityLive') ||
      has('agentActivitySource') ||
      has('composerQueue')
    ) {
      renderAgentStatus();
    }
    if (has('composerQueue')) renderComposerQueue();
    if (has('windows') || has('activeWindowId') || has('chatTabs')) {
      renderWindowsAndSessions();
      if (drawerLayer && drawerLayer.isOpen()) renderDrawer();
    }
    if (has('activeWindowId') && state.activeWindowId && capabilityState && capabilityState.targetId !== state.activeWindowId) {
      resetCapabilityCaches();
      capabilityState = null;
      awaitingCapabilityFull = true;
      renderModeModel();
      renderCapabilityDiagnostics();
      renderConnectionStatus();
    }
    if (has('messages') || has('activeComposerId') || has('activeWindowId')) {
      if (has('messages')) renderMessages();
    }
    if (
      has('connected') ||
      has('extractorStatus') ||
      has('lastExtractionAt') ||
      has('agentStatus') ||
      has('agentActivityLive') ||
      has('agentActivitySource') ||
      has('messages') ||
      has('activeComposerId') ||
      has('activeWindowId')
    ) {
      renderSessionPlans();
    }
    if (has('pendingApprovals') || has('messages')) renderApprovals();
    if (has('questionnaire')) renderQuestionnaire();
    if (has('mode') || has('model')) renderModeModel();
    if (
      has('messages') ||
      has('activeComposerId') ||
      has('activeWindowId') ||
      has('mode') ||
      has('model')
    ) syncPlanModalFromState();
  }

  function questionnaireIsPresent(q) {
    return !!(q && Array.isArray(q.questions) && q.questions.length > 0);
  }

  function questionnaireIdentity(q) {
    if (!questionnaireIsPresent(q)) return '';
    return JSON.stringify({
      totalLabel: q.totalLabel || '',
      questions: q.questions.map((question) => ({
        number: question.number,
        text: question.text,
        options: question.options.map((option) => [option.letter, option.label, option.actionId || '']),
      })),
      skipActionId: q.skipActionId || '',
      continueActionId: q.continueActionId || '',
    });
  }

  function reconcileQuestionnaireEnvelopes(nextQuestionnaire, previousQuestionnaire) {
    if (!questionnaireIsPresent(nextQuestionnaire)) {
      qEnvelopes.clear();
      return;
    }
    if (
      questionnaireIsPresent(previousQuestionnaire)
      && questionnaireIdentity(nextQuestionnaire) !== questionnaireIdentity(previousQuestionnaire)
    ) {
      qEnvelopes.clear();
    }
    const liveActionIds = new Set([
      nextQuestionnaire.skipActionId,
      nextQuestionnaire.continueActionId,
      ...nextQuestionnaire.questions.flatMap((question) => question.options.map((option) => option.actionId)),
    ].filter(hasOpaqueActionId));
    for (const actionId of qEnvelopes.keys()) {
      if (!liveActionIds.has(actionId)) qEnvelopes.delete(actionId);
    }
  }

  function clearQuestionnaireSyncWait() {
    questionnaireAwaitingSnapshot = false;
    if (questionnaireSyncWatchdog) {
      clearTimeout(questionnaireSyncWatchdog);
      questionnaireSyncWatchdog = 0;
    }
  }

  function awaitQuestionnaireSnapshot() {
    clearQuestionnaireSyncWait();
    questionnaireAwaitingSnapshot = true;
    if (socket.connected) socket.emit('state:request');
    questionnaireSyncWatchdog = setTimeout(() => {
      questionnaireSyncWatchdog = 0;
      questionnaireAwaitingSnapshot = false;
      renderQuestionnaire();
      showToast('Questionnaire confirmation is still pending. You can retry.', 'error');
    }, QUESTIONNAIRE_SYNC_WATCHDOG_MS);
  }

  function clearQuestionnaireNullHold() {
    if (questionnaireNullHoldTimer) {
      clearTimeout(questionnaireNullHoldTimer);
      questionnaireNullHoldTimer = 0;
    }
  }

  function stabilizeQuestionnairePatch(nextQuestionnaire, previousQuestionnaire) {
    if (questionnaireIsPresent(nextQuestionnaire)) {
      clearQuestionnaireNullHold();
      clearQuestionnaireSyncWait();
      reconcileQuestionnaireEnvelopes(nextQuestionnaire, previousQuestionnaire);
      return;
    }
    if (!questionnaireIsPresent(previousQuestionnaire)) {
      clearQuestionnaireNullHold();
      reconcileQuestionnaireEnvelopes(null, previousQuestionnaire);
      return;
    }
    state.questionnaire = previousQuestionnaire;
    if (questionnaireNullHoldTimer) return;
    questionnaireNullHoldTimer = setTimeout(() => {
      questionnaireNullHoldTimer = 0;
      reconcileQuestionnaireEnvelopes(null, state.questionnaire);
      state.questionnaire = null;
      clearQuestionnaireSyncWait();
      questionnaireOptimistic = {};
      renderQuestionnaire();
    }, QUESTIONNAIRE_NULL_HOLD_MS);
  }

  function renderConnectionStatus() {
    const ui = getConnectionUiState();
    updateConnectionUI(ui);
    if (state.messages.length === 0) {
      $emptyState.style.display = '';
      $emptyPrimary.textContent = ui.emptyPrimary;
      $emptyHint.innerHTML = ui.emptyHint;
    }
  }

  function connectionLayers() {
    const capability = !capabilityLive
      ? 'stale'
      : (awaitingCapabilityFull ? 'awaiting' : (capabilityState?.status?.state || 'unknown'));
    return {
      socket: relaySocketLayer(),
      cdp: state.connected ? 'connected' : 'disconnected',
      extractor: state.extractorStatus || 'idle',
      capability,
      completeness: capabilityModelCompleteness(),
    };
  }

  function connectionA11yTitle(layers, label) {
    return [
      label,
      `Relay ${layers.socket}`,
      `CDP ${layers.cdp}`,
      `Extractor ${layers.extractor}`,
      `Capabilities ${layers.capability}`,
      `Model list ${layers.completeness}`,
    ].join('. ');
  }

  function updateConnectionUI(ui) {
    const layers = ui.layers || connectionLayers();
    $connDot.className = 'dot ' + ui.status;
    $connDot.dataset.socket = layers.socket;
    $connDot.dataset.cdp = layers.cdp;
    $connDot.dataset.extractor = layers.extractor;
    $connDot.dataset.capability = layers.capability;
    $connDot.dataset.completeness = layers.completeness;
    $connDot.dataset.layer = ui.layer;
    const title = connectionA11yTitle(layers, ui.label);
    $connDot.title = title;
    $connText.textContent = ui.label;
    $connText.title = title;
  }

  function getConnectionUiState() {
    const lastError = (state.lastExtractionError || '').trim();
    const timeoutLike = /timeout/i.test(lastError);
    const layers = connectionLayers();

    if (!socket.connected) {
      const layer = relaySocketLayer();
      if (layer === 'connecting') {
        return {
          status: 'reconnecting',
          layer: 'socket',
          layers,
          label: 'Connecting…',
          emptyPrimary: 'Connecting to relay...',
          emptyHint: 'Waiting for the CursorRemote server.',
        };
      }
      if (layer === 'reconnecting') {
        return {
          status: 'reconnecting',
          layer: 'socket',
          layers,
          label: 'Reconnecting…',
          emptyPrimary: 'Reconnecting to relay...',
          emptyHint: 'The page will resume automatically when the connection returns.',
        };
      }
      return {
        status: 'disconnected',
        layer: 'socket',
        layers,
        label: 'Relay disconnected',
        emptyPrimary: 'Waiting for relay connection...',
        emptyHint: 'Check that this page can reach the CursorRemote server.',
      };
    }

    if (!stateSnapshotFresh) {
      return {
        status: 'reconnecting',
        layer: 'socket',
        layers,
        label: 'Syncing state…',
        emptyPrimary: 'Connected to relay, waiting for current state...',
        emptyHint: 'Actions will unlock after a fresh snapshot arrives.',
      };
    }

    if (!state.connected) {
      return {
        status: 'reconnecting',
        layer: 'cdp',
        layers,
        label: 'Waiting for Cursor',
        emptyPrimary: 'Connecting to Cursor IDE...',
        emptyHint: 'Make sure Cursor is running with<br><code>--remote-debugging-port=9222</code>',
      };
    }

    if (state.extractorStatus === 'stale') {
      return {
        status: 'stale',
        layer: 'extractor',
        layers,
        label: timeoutLike ? 'Cursor backgrounded' : 'Cursor stalled',
        emptyPrimary: timeoutLike
          ? 'Cursor is connected but background-throttled.'
          : 'Cursor is connected but extraction is failing.',
        emptyHint: timeoutLike
          ? 'Bring Cursor to the foreground on macOS, then wait for the next snapshot.'
          : ('Last extractor error:<br><code>' + escapeHtml(lastError || 'unknown error') + '</code>'),
      };
    }

    if (state.extractorStatus === 'waiting') {
      return {
        status: 'reconnecting',
        layer: 'extractor',
        layers,
        label: 'Waiting for snapshot',
        emptyPrimary: 'Connected to Cursor, waiting for the first snapshot...',
        emptyHint: lastError
          ? ('Last extractor error:<br><code>' + escapeHtml(lastError) + '</code>')
          : 'The relay is connected to Cursor but has not captured a fresh DOM snapshot yet.',
      };
    }

    return {
      status: 'connected',
      layer: 'ok',
      layers,
      label: 'Connected',
      emptyPrimary: 'No messages in this chat yet.',
      emptyHint: 'Send a message below or switch chat tab / window in Cursor.',
    };
  }

  function renderAgentStatus() {
    const connectionUi = getConnectionUiState();
    const statusFresh = connectionUi.layer === 'ok';
    const activity = (state.agentActivityText || '').trim();
    const activityLive = !!state.agentActivityLive;
    const queue = state.composerQueue && Array.isArray(state.composerQueue.items)
      ? state.composerQueue
      : { items: [] };
    let primary = 'Idle';
    let detail = '';
    let tone = '';
    let icon = '';

    if (!statusFresh) {
      if (connectionUi.layer === 'extractor' && state.extractorStatus === 'stale') {
        primary = 'Status may be stale';
      } else {
        primary = 'Syncing state';
      }
      detail = connectionUi.label;
    } else if (state.agentStatus === 'waiting_approval') {
      primary = 'Needs approval';
      tone = 'var(--accent-yellow)';
      icon = '!';
    } else if (state.agentStatus === 'error') {
      primary = 'Execution error';
      tone = 'var(--accent-red)';
      icon = '\u2715';
    } else if (activityLive) {
      primary = 'Running';
      detail = activity || (
        state.agentStatus === 'running_tool'
          ? 'Running tool'
          : state.agentStatus === 'generating'
            ? 'Generating'
            : 'Thinking'
      );
    } else if (state.agentStatus === 'idle' && queue.items.length > 0) {
      primary = 'Queued';
      detail = queue.queueLabel || `${queue.items.length} queued`;
      tone = 'var(--accent-yellow)';
    } else if (state.agentStatus !== 'idle') {
      primary = state.agentStatus === 'running_tool'
        ? 'Running'
        : state.agentStatus === 'generating'
          ? 'Generating'
          : 'Thinking';
    }

    $statusIcon.textContent = icon;
    $statusText.textContent = primary;
    $statusText.style.color = tone;
    $statusText.title = primary;
    $statusText.classList.toggle('agent-status-shimmer', statusFresh && activityLive);
    if ($statusDetail) {
      const max = 56;
      $statusDetail.textContent = detail.length > max ? detail.slice(0, max - 1) + '…' : detail;
      $statusDetail.hidden = !detail;
      $statusDetail.title = detail;
    }
    if ($headerRight) {
      $headerRight.classList.remove('header-right-hidden');
      $headerRight.dataset.status = statusFresh
        ? (primary === 'Queued' ? 'queued' : (state.agentStatus || 'idle'))
        : 'stale';
      $headerRight.dataset.live = statusFresh && activityLive ? '1' : '0';
    }
  }

  function queueItems() {
    return state.composerQueue && Array.isArray(state.composerQueue.items)
      ? state.composerQueue
      : { items: [] };
  }

  function toggleQueueDetails() {
    const q = queueItems();
    if (q.items.length === 0) return;
    queueDetailsOpen = !queueDetailsOpen;
    renderComposerQueue();
  }

  function toggleSessionPlans() {
    if (sessionPlanMessages().length === 0 && !plansEntryAvailable()) return;
    sessionPlansOpen = !sessionPlansOpen;
    renderSessionPlans();
  }

  /** Reuse this page's own draft notion so a history scan never steals Cursor while we type. */
  function hasComposerDraft() {
    return $input.value.trim().length > 0;
  }

  function newPlanDiscoveryNonce() {
    discoveredPlanSeq += 1;
    return `plan-discovery-${discoveredPlanSeq}`;
  }

  /** A discover/read target is only usable with a live relay and a confirmable window+session. */
  function planSessionTarget() {
    if (!isSocketLive()) return null;
    const windowId = typeof state.activeWindowId === 'string' ? state.activeWindowId : '';
    const composerId = typeof state.activeComposerId === 'string' ? state.activeComposerId : '';
    if (!windowId || !composerId) return null;
    return { windowId, composerId };
  }

  const PLAN_FAILURE_CODES = new Set([
    'session', 'window', 'connection', 'expired', 'extraction', 'auth',
    'busy', 'invalid', 'plan', 'file', 'unknown',
  ]);
  const PLAN_FAILURE_STAGES = new Set([
    'validate', 'guard', 'discover', 'resolve', 'read', 'emit',
  ]);
  const PLAN_FAILURE_CODE_LABELS = {
    session: '会话不匹配',
    window: '窗口不匹配',
    connection: '连接不可用',
    expired: '已失效',
    extraction: '提取失败',
    auth: '未授权',
    busy: '正在处理',
    invalid: '请求无效',
    plan: '计划无法确认',
    file: '文件读取失败',
    unknown: '原因未知',
  };
  const PLAN_FAILURE_STAGE_LABELS = {
    validate: '校验',
    guard: '守卫',
    discover: '发现',
    resolve: '解析',
    read: '读取',
    emit: '发出',
  };

  const PLAN_DIAGNOSTIC_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  function isSafePlanDiagnosticId(value) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= 128
      && value === value.trim()
      && !value.includes('..')
      && !value.includes('/')
      && !value.includes('\\')
      && PLAN_DIAGNOSTIC_ID_RE.test(value);
  }

  function formatPlanTargetIds(target) {
    if (!target || typeof target !== 'object') return '';
    const parts = [];
    if (isSafePlanDiagnosticId(target.windowId)) parts.push(`窗口 ${target.windowId}`);
    if (isSafePlanDiagnosticId(target.composerId)) parts.push(`会话 ${target.composerId}`);
    if (isSafePlanDiagnosticId(target.planId)) parts.push(`计划 ${target.planId}`);
    return parts.join(' · ');
  }

  function sanitizeClientPlanFailure(value, fallbackCommandId) {
    if (!value || typeof value !== 'object') return null;
    if (!PLAN_FAILURE_CODES.has(value.code) || !PLAN_FAILURE_STAGES.has(value.stage)) return null;
    const commandId = isSafePlanDiagnosticId(value.commandId)
      ? value.commandId
      : (isSafePlanDiagnosticId(fallbackCommandId) ? fallbackCommandId : '');
    const requested = {};
    const rawRequested = value.requested && typeof value.requested === 'object' ? value.requested : {};
    if (isSafePlanDiagnosticId(rawRequested.windowId)) requested.windowId = rawRequested.windowId;
    if (isSafePlanDiagnosticId(rawRequested.composerId)) requested.composerId = rawRequested.composerId;
    if (isSafePlanDiagnosticId(rawRequested.planId)) requested.planId = rawRequested.planId;
    return {
      code: value.code,
      stage: value.stage,
      commandId,
      requested: Object.keys(requested).length ? requested : undefined,
    };
  }

  function formatPlanDiagnosticError(error, failure, fallbackRequested) {
    const lines = [];
    if (failure && failure.code && failure.stage) {
      const codeLabel = PLAN_FAILURE_CODE_LABELS[failure.code];
      const stageLabel = PLAN_FAILURE_STAGE_LABELS[failure.stage];
      const codeText = codeLabel ? `${failure.code}（${codeLabel}）` : failure.code;
      const stageText = stageLabel ? `${failure.stage}（${stageLabel}）` : failure.stage;
      lines.push(`失败码：${codeText} · 阶段：${stageText}`);
    }
    if (failure && failure.commandId) lines.push(`命令：${failure.commandId}`);
    const requestedText = formatPlanTargetIds((failure && failure.requested) || fallbackRequested);
    if (requestedText) lines.push(`请求目标：${requestedText}`);
    if (error) lines.push(error);
    return lines.join('\n');
  }

  function appendPlanStatus(parent, id, text, extraClass) {
    const el = document.createElement('div');
    el.className = extraClass ? `session-plan-chip-status ${extraClass}` : 'session-plan-chip-status';
    if (id) el.id = id;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  const PLAN_STATUS_BASIS_STALE_MS = 15_000;
  const PLAN_STATUS_SOCKET_VALUES = new Set(['connected', 'connecting', 'reconnecting', 'disconnected']);
  const PLAN_STATUS_CDP_VALUES = new Set(['connected', 'disconnected']);
  const PLAN_STATUS_EXTRACTOR_VALUES = new Set(['idle', 'waiting', 'ok', 'stale']);
  const PLAN_STATUS_AGENT_VALUES = new Set([
    'idle', 'thinking', 'generating', 'running_tool', 'waiting_approval', 'error',
  ]);
  const PLAN_STATUS_ACTIVITY_SOURCES = new Set([
    'none', 'shimmer', 'loading_tool', 'loading_indicator', 'tail_thought',
  ]);

  function boundedPlanStatusValue(value, allowed) {
    return allowed.has(value) ? value : 'unknown';
  }

  function planStatusObservationKind(now) {
    const extractor = boundedPlanStatusValue(state.extractorStatus || 'idle', PLAN_STATUS_EXTRACTOR_VALUES);
    if (extractor !== 'ok') return 'missing';
    const extractedAt = state.lastExtractionAt;
    if (!isValidPlanTime(extractedAt) || extractedAt > now) return 'missing';
    if (now - extractedAt > PLAN_STATUS_BASIS_STALE_MS) return 'expired';
    const layers = connectionLayers();
    if (!stateSnapshotFresh || layers.socket !== 'connected' || layers.cdp !== 'connected') {
      return 'expired';
    }
    return 'fresh';
  }

  function buildPlanStatusBasisSection() {
    const box = document.createElement('div');
    box.className = 'plan-modal-status';
    box.id = 'plan-status-basis';
    const now = Date.now();
    const layers = connectionLayers();
    const socket = boundedPlanStatusValue(layers.socket, PLAN_STATUS_SOCKET_VALUES);
    const cdp = boundedPlanStatusValue(layers.cdp, PLAN_STATUS_CDP_VALUES);
    const extractor = boundedPlanStatusValue(state.extractorStatus || 'idle', PLAN_STATUS_EXTRACTOR_VALUES);
    const agentStatus = boundedPlanStatusValue(state.agentStatus || 'idle', PLAN_STATUS_AGENT_VALUES);
    const activitySource = boundedPlanStatusValue(
      state.agentActivitySource || 'none',
      PLAN_STATUS_ACTIVITY_SOURCES,
    );
    const kind = planStatusObservationKind(now);
    const freshnessLabel = kind === 'expired'
      ? '依据过期'
      : kind === 'missing'
        ? '依据缺失'
        : '观察新鲜（Connected 不是可信证明）';
    const extractorLabel = extractor === 'stale' ? `${extractor}（提取失败）` : extractor;
    const rows = [
      ['连接', `relay ${socket} · CDP ${cdp}`],
      ['提取', extractorLabel],
      ['观察新鲜度', freshnessLabel],
      ['快照记录的最近成功观察时间', `${formatPlanTime(state.lastExtractionAt)}（抽取时间，不是任务进展时间）`],
      ['界面 agentStatus', agentStatus],
      ['活动信号', state.agentActivityLive ? '有活动' : '无活动'],
      ['活动信号来源', activitySource],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.textContent = `${label}：${value}`;
      box.appendChild(row);
    });
    [
      'Idle不是完成证明',
      '任务完成：未知（未核对验收证据）',
      '监督者主动检查：未启用',
      '观察时间来自网页最近取得的状态快照，并非持续提取心跳',
      '依据过期不代表服务端停止提取',
    ].forEach((line) => {
      const row = document.createElement('div');
      row.textContent = line;
      box.appendChild(row);
    });
    if (kind === 'fresh' && isValidPlanTime(state.lastExtractionAt)) {
      if (planStatusBasisExpiryTimer) {
        clearTimeout(planStatusBasisExpiryTimer);
        planStatusBasisExpiryTimer = 0;
      }
      const delay = Math.max(0, Math.min(
        state.lastExtractionAt + PLAN_STATUS_BASIS_STALE_MS - now,
        2147483647,
      )) + 200;
      const timer = setTimeout(() => {
        planStatusBasisExpiryTimer = 0;
        renderSessionPlans();
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      planStatusBasisExpiryTimer = timer;
    } else if (planStatusBasisExpiryTimer) {
      clearTimeout(planStatusBasisExpiryTimer);
      planStatusBasisExpiryTimer = 0;
    }
    return box;
  }

  function buildPlanTaskBasisSection(fullData) {
    const box = document.createElement('div');
    box.className = 'plan-modal-status';
    box.id = 'plan-task-basis';
    const bodyPresent = !!(fullData && typeof fullData.body === 'string' && fullData.body.trim());
    const rows = [
      ['依据范围', bodyPresent
        ? '单次文件快照，不是完整任务或会话'
        : '未取得计划文件快照；以下摘要不代表完整任务或会话'],
      ['目标', '未知（未结构化取得）'],
      ['约束', '未知（未结构化取得）'],
      ['验收条件', '未知（未结构化取得）'],
      ['关键决策', '未知（未结构化取得）'],
      ['计划正文', bodyPresent ? '本次快照已读取' : '缺失'],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.textContent = `${label}：${value}`;
      box.appendChild(row);
    });
    return box;
  }

  /** The Plans entry stays discoverable even with zero plan cards, as long as the target is known. */
  function plansEntryAvailable() {
    return !!planSessionTarget();
  }

  function isPlanReferenceLive(refs) {
    return !!refs
      && isValidPlanTime(refs.expiresAt)
      && refs.expiresAt > Date.now();
  }

  /** Refs are only ever valid for the exact session that produced them. */
  function activePlanReferences() {
    const target = planSessionTarget();
    if (!target || !discoveredPlanRefs) return [];
    if (discoveredPlanSessionIdentity !== currentPlanSessionIdentity()) return [];
    if (discoveredPlanRefs.windowId !== target.windowId || discoveredPlanRefs.composerId !== target.composerId) return [];
    if (!isPlanReferenceLive(discoveredPlanRefs)) return [];
    return discoveredPlanRefs.plans;
  }

  function clearPlanDiscovery() {
    if (discoveredPlanExpiryTimer) {
      clearTimeout(discoveredPlanExpiryTimer);
      discoveredPlanExpiryTimer = 0;
    }
    discoveredPlanRefs = null;
    discoveredPlanSessionIdentity = '';
    discoveredPlanNonceSession = '';
    discoveredPlanScanInFlight = false;
    discoveredPlanError = '';
    // Bump the nonce so a late response for the abandoned session can never land.
    discoveredPlanNonce = newPlanDiscoveryNonce();
    if (activePlanModal && activePlanModal.fromReference) closePlanModal();
  }

  /**
   * Drop refs — and any scan still in flight — whose session is gone, whose
   * relay dropped, or whose TTL lapsed.
   */
  function prunePlanDiscovery() {
    const sessionNow = currentPlanSessionIdentity();
    const knownSession = discoveredPlanNonceSession || discoveredPlanSessionIdentity;
    if (!knownSession) return;
    const target = planSessionTarget();
    if (!target || knownSession !== sessionNow) { clearPlanDiscovery(); return; }
    if (discoveredPlanRefs && !isPlanReferenceLive(discoveredPlanRefs)) {
      clearPlanDiscovery();
      discoveredPlanNotice = '历史计划引用已过期，请重新查找';
    }
  }

  function armPlanDiscoveryExpiry(refs) {
    if (discoveredPlanExpiryTimer) clearTimeout(discoveredPlanExpiryTimer);
    const delay = Math.max(0, Math.min(refs.expiresAt - Date.now(), 2147483647)) + 200;
    const timer = setTimeout(() => {
      discoveredPlanExpiryTimer = 0;
      if (discoveredPlanRefs && !isPlanReferenceLive(discoveredPlanRefs)) {
        clearPlanDiscovery();
        discoveredPlanNotice = '历史计划引用已过期，请重新查找';
        renderSessionPlans();
        syncPlanModalFromState();
      }
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    discoveredPlanExpiryTimer = timer;
  }

  /**
   * Accept only a bounded, partial scan for the requested session whose plans
   * carry server-issued reading references ('plan-ref:' ids) plus the real
   * toolCallId. The client never invents ids or lists anything off-disk.
   */
  function validatePlanDiscoveryResult(data, target) {
    if (!data || typeof data !== 'object') return { ok: false, error: '历史计划查找结果无效' };
    if (data.windowId !== target.windowId || data.composerId !== target.composerId) {
      return { ok: false, error: '历史计划查找结果与当前窗口/会话不一致' };
    }
    if (data.completeness !== 'partial') return { ok: false, error: '历史计划查找范围标识非法' };
    if (typeof data.reachedStart !== 'boolean') return { ok: false, error: '历史计划查找范围标识非法' };
    if (!isValidPlanTime(data.observedAt) || !isValidPlanTime(data.expiresAt)) {
      return { ok: false, error: '历史计划引用有效期非法' };
    }
    if (data.expiresAt <= Date.now()) return { ok: false, error: '历史计划引用已过期，请重新查找' };
    if (!Array.isArray(data.plans)) return { ok: false, error: '历史计划列表格式非法' };
    const plans = [];
    for (const plan of data.plans) {
      if (!plan || typeof plan !== 'object') return { ok: false, error: '历史计划引用格式非法' };
      if (typeof plan.id !== 'string' || !plan.id.startsWith('plan-ref:')) {
        return { ok: false, error: '历史计划引用标识非法' };
      }
      if (typeof plan.toolCallId !== 'string' || !plan.toolCallId) {
        return { ok: false, error: '历史计划引用缺少真实工具调用标识' };
      }
      plans.push({
        type: 'plan',
        id: plan.id,
        toolCallId: plan.toolCallId,
        label: typeof plan.label === 'string' && plan.label ? plan.label : '历史计划',
        title: typeof plan.title === 'string' && plan.title ? plan.title : '历史计划',
        description: typeof plan.description === 'string' ? plan.description : '',
        flatIndex: typeof plan.flatIndex === 'number' ? plan.flatIndex : -1,
        todosTotal: 0,
        todosCompleted: 0,
        reference: true,
      });
    }
    return {
      ok: true,
      data: {
        windowId: data.windowId,
        composerId: data.composerId,
        observedAt: data.observedAt,
        expiresAt: data.expiresAt,
        completeness: 'partial',
        reachedStart: data.reachedStart,
        plans,
      },
    };
  }

  async function startPlanDiscovery() {
    if (discoveredPlanScanInFlight) return;
    const target = planSessionTarget();
    if (!target) {
      showToast('无法确认当前窗口或会话，未执行历史计划查找', 'error');
      return;
    }
    if (hasComposerDraft()) {
      showToast('请先处理输入框中的草稿，再查找历史计划', 'error');
      return;
    }
    // 新发现使服务端上一批引用失效，前端同步清除，失败时也不恢复旧引用。
    clearPlanDiscoveryRefs();
    syncPlanModalFromState();
    const nonce = newPlanDiscoveryNonce();
    const sessionIdentity = currentPlanSessionIdentity();
    discoveredPlanNonce = nonce;
    discoveredPlanNonceSession = sessionIdentity;
    discoveredPlanScanInFlight = true;
    discoveredPlanError = '';
    discoveredPlanNotice = '';
    renderSessionPlans();
    const result = await sendCommandAwaitResult('command:discover_plans', {
      commandId: newCommandId(),
      type: 'discover_plans',
      windowId: target.windowId,
      composerId: target.composerId,
    });
    // A session switch, disconnect, revert, or newer scan invalidates this response.
    if (discoveredPlanNonce !== nonce) return;
    if (sessionIdentity !== currentPlanSessionIdentity()) { clearPlanDiscovery(); renderSessionPlans(); return; }
    if (!planSessionTarget()) {
      discoveredPlanScanInFlight = false;
      clearPlanDiscovery();
      renderSessionPlans();
      return;
    }
    discoveredPlanScanInFlight = false;
    if (!result.ok || !result.data) {
      const rawError = typeof result.error === 'string' && result.error.trim() ? result.error.trim() : '';
      const failure = sanitizeClientPlanFailure(result.failure, result.commandId);
      discoveredPlanError = formatPlanDiagnosticError(rawError || '历史计划查找失败', failure, target);
      renderSessionPlans();
      return;
    }
    const parsed = validatePlanDiscoveryResult(result.data, target);
    if (!parsed.ok) {
      clearPlanDiscoveryRefs();
      discoveredPlanError = parsed.error;
      renderSessionPlans();
      return;
    }
    discoveredPlanRefs = parsed.data;
    discoveredPlanSessionIdentity = sessionIdentity;
    discoveredPlanNonceSession = sessionIdentity;
    discoveredPlanError = '';
    armPlanDiscoveryExpiry(parsed.data);
    renderSessionPlans();
  }

  function clearPlanDiscoveryRefs() {
    if (discoveredPlanExpiryTimer) {
      clearTimeout(discoveredPlanExpiryTimer);
      discoveredPlanExpiryTimer = 0;
    }
    discoveredPlanRefs = null;
    discoveredPlanSessionIdentity = '';
    discoveredPlanNonceSession = '';
    if (activePlanModal && activePlanModal.fromReference) closePlanModal();
  }

  function buildPlanDiscoverySection() {
    const wrap = document.createElement('div');
    wrap.className = 'session-plans-discovery';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'plan-discovery-btn';
    btn.className = 'context-plans-btn';
    btn.textContent = discoveredPlanScanInFlight ? '正在查找当前会话历史计划…' : '查找当前会话历史计划';
    btn.disabled = discoveredPlanScanInFlight;
    btn.addEventListener('click', () => { void startPlanDiscovery(); });
    wrap.appendChild(btn);

    const hint = document.createElement('div');
    hint.className = 'session-plan-chip-status';
    hint.id = 'plan-discovery-hint';
    hint.textContent = '将在 Cursor 内临时滚动当前会话；历史扫描有界，可能不完整。';
    wrap.appendChild(hint);

    const currentTarget = planSessionTarget();
    const currentText = formatPlanTargetIds(currentTarget);
    if (currentText) {
      appendPlanStatus(wrap, 'plan-discovery-current-target', `当前目标：${currentText}`);
    }

    if (discoveredPlanRefs) {
      const resultText = formatPlanTargetIds(discoveredPlanRefs);
      if (resultText) {
        appendPlanStatus(wrap, 'plan-discovery-result-target', `结果目标：${resultText}`);
      }
      const reached = discoveredPlanRefs.reachedStart
        ? '到当前滚动容器顶部'
        : '未到当前滚动容器顶部';
      appendPlanStatus(
        wrap,
        'plan-discovery-meta',
        `发现时间：${formatPlanTime(discoveredPlanRefs.observedAt)}；范围：partial（${reached}）`,
      );
      if (discoveredPlanRefs.plans.length === 0) {
        appendPlanStatus(wrap, 'plan-discovery-empty', '本次有界扫描未发现计划，这不代表当前会话没有计划。');
      }
    }
    if (discoveredPlanError) {
      appendPlanStatus(wrap, 'plan-discovery-error', discoveredPlanError, 'plan-modal-status-error');
    } else if (discoveredPlanNotice) {
      appendPlanStatus(wrap, '', discoveredPlanNotice);
    }
    return wrap;
  }

  function syncQueueTrigger(hasItems) {
    if (!$headerRight) return;
    if (hasItems) {
      $headerRight.setAttribute('role', 'button');
      $headerRight.setAttribute('aria-controls', 'composer-queue-bar');
      $headerRight.setAttribute('aria-expanded', queueDetailsOpen ? 'true' : 'false');
      $headerRight.tabIndex = 0;
    } else {
      $headerRight.removeAttribute('role');
      $headerRight.removeAttribute('aria-controls');
      $headerRight.removeAttribute('aria-expanded');
      $headerRight.removeAttribute('tabindex');
    }
  }

  function renderComposerQueue() {
    const bar = document.getElementById('composer-queue-bar');
    const labelEl = document.getElementById('composer-queue-label');
    const itemsEl = document.getElementById('composer-queue-items');
    if (!bar || !labelEl || !itemsEl) return;
    const q = queueItems();
    if (q.items.length === 0) {
      bar.classList.add('hidden');
      itemsEl.innerHTML = '';
      queueDetailsOpen = false;
      if ($queueToggle) $queueToggle.setAttribute('aria-expanded', 'false');
      itemsEl.hidden = true;
      syncQueueTrigger(false);
      return;
    }
    if (queueDetailsOpen) bar.classList.remove('hidden');
    else bar.classList.add('hidden');
    labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
    itemsEl.innerHTML = '';
    q.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'composer-queue-row';
      const dot = document.createElement('span');
      dot.className = 'composer-queue-dot';
      const tx = document.createElement('span');
      tx.className = 'composer-queue-text';
      tx.textContent = it.text || '';
      row.appendChild(dot);
      row.appendChild(tx);
      itemsEl.appendChild(row);
    });
    itemsEl.hidden = !queueDetailsOpen;
    if ($queueToggle) $queueToggle.setAttribute('aria-expanded', queueDetailsOpen ? 'true' : 'false');
    syncQueueTrigger(true);
  }

  function planDisplayStatus(plan) {
    const todos = Array.isArray(plan.todos) ? plan.todos : [];
    if (todos.some((todo) => todo && todo.status === 'in_progress')) return 'Executing';
    if (plan.todosTotal > 0 && plan.todosCompleted >= plan.todosTotal) return 'Completed';
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (actions.some((action) => action && (action.type === 'build' || action.type === 'view_plan'))) {
      return 'Ready';
    }
    return 'Available';
  }

  function sessionPlanMessages() {
    prunePlanDiscovery();
    if (messagesSessionIdentity !== currentPlanSessionIdentity()) return [];
    const plans = [];
    const indices = new Map();
    const seenToolCalls = new Set();
    const put = (msg) => {
      const key = msg.fileName ? `file:${msg.fileName}` : `tool:${msg.toolCallId || msg.id}`;
      if (indices.has(key)) {
        plans[indices.get(key)] = msg;
      } else {
        indices.set(key, plans.length);
        plans.push(msg);
      }
    };
    for (const msg of state.messages || []) {
      if (!msg || msg.type !== 'plan') continue;
      if (msg.toolCallId) seenToolCalls.add(msg.toolCallId);
      put(msg);
    }
    // Discovered references fill in history the DOM no longer mounts. A real
    // card for the same tool call always wins, so refs never duplicate it.
    for (const ref of activePlanReferences()) {
      if (ref.toolCallId && seenToolCalls.has(ref.toolCallId)) continue;
      if (ref.toolCallId) seenToolCalls.add(ref.toolCallId);
      put(ref);
    }
    return plans;
  }

  function renderSessionPlans() {
    const bar = document.getElementById('session-plans-bar');
    const itemsEl = document.getElementById('session-plans-items');
    if (!bar || !itemsEl) return;
    prunePlanDiscovery();
    const discoverable = plansEntryAvailable();
    const plans = sessionPlanMessages();
    if (!discoverable && plans.length === 0) {
      if (planStatusBasisExpiryTimer) {
        clearTimeout(planStatusBasisExpiryTimer);
        planStatusBasisExpiryTimer = 0;
      }
      bar.classList.add('hidden');
      itemsEl.innerHTML = '';
      sessionPlansOpen = false;
      if ($sessionPlansToggle) {
        $sessionPlansToggle.classList.add('hidden');
        $sessionPlansToggle.setAttribute('aria-expanded', 'false');
        $sessionPlansToggle.textContent = 'Plans';
      }
      return;
    }
    if ($sessionPlansToggle) {
      $sessionPlansToggle.classList.remove('hidden');
      const executing = plans.some((plan) => planDisplayStatus(plan) === 'Executing');
      $sessionPlansToggle.textContent = plans.length === 0
        ? 'Plans'
        : executing
          ? `Plans · ${plans.length} · Executing`
          : `Plans · ${plans.length}`;
      $sessionPlansToggle.setAttribute('aria-expanded', sessionPlansOpen ? 'true' : 'false');
    }
    if (!sessionPlansOpen) {
      bar.classList.add('hidden');
    } else {
      bar.classList.remove('hidden');
    }
    itemsEl.innerHTML = '';
    itemsEl.appendChild(buildPlanStatusBasisSection());
    if (discoverable) itemsEl.appendChild(buildPlanDiscoverySection());
    plans.forEach((plan) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-plan-chip';
      const title = document.createElement('span');
      title.className = 'session-plan-chip-title';
      title.textContent = plan.title || plan.label || 'Plan';
      const status = document.createElement('span');
      status.className = 'session-plan-chip-status';
      status.textContent = planDisplayStatus(plan);
      btn.appendChild(title);
      btn.appendChild(status);
      btn.setAttribute('aria-label', `${title.textContent}: ${status.textContent}`);
      btn.addEventListener('click', () => openPlanModal(plan));
      itemsEl.appendChild(btn);
    });
  }

  // --- Message rendering ---

  function renderMessages() {
    if (state.messages.length === 0) {
      const ui = getConnectionUiState();
      $emptyState.style.display = '';
      $messages.querySelectorAll('.chat-el').forEach(el => el.remove());
      $emptyPrimary.textContent = ui.emptyPrimary;
      $emptyHint.innerHTML = ui.emptyHint;
      return;
    }

    $emptyState.style.display = 'none';

    const existingEls = $messages.querySelectorAll('.chat-el');
    const existingIds = new Map();
    existingEls.forEach(el => existingIds.set(el.dataset.id, el));

    const newIds = new Set(state.messages.map(m => m.id));

    existingEls.forEach(el => {
      if (!newIds.has(el.dataset.id)) el.remove();
    });

    state.messages.forEach((msg, index) => {
      let el = existingIds.get(msg.id);

      if (!el) {
        el = createElement(msg);
        const allEls = $messages.querySelectorAll('.chat-el');
        if (index < allEls.length) {
          $messages.insertBefore(el, allEls[index]);
        } else {
          $messages.appendChild(el);
        }
      } else if (el.dataset.msgType !== msg.type) {
        const replacement = createElement(msg);
        el.replaceWith(replacement);
        el = replacement;
      } else {
        updateElement(el, msg);
      }
    });

    if (!userScrolledUp) scheduleMessagesAutoScroll();
    checkMessagesForNotifications();
  }

  function createElement(msg) {
    let el;
    switch (msg.type) {
      case 'human': el = createHumanEl(msg); break;
      case 'assistant': el = createAssistantEl(msg); break;
      case 'tool': el = createToolEl(msg); break;
      case 'thought': el = createThoughtEl(msg); break;
      case 'plan': el = createPlanEl(msg); break;
      case 'todo_list': el = createTodoListEl(msg); break;
      case 'run_command': el = createRunCommandEl(msg); break;
      case 'loading': el = createLoadingEl(msg); break;
      default: el = createFallbackEl(msg); break;
    }
    el.dataset.msgType = msg.type;
    return el;
  }

  function updateElement(el, msg) {
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'tool': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      case 'plan': updatePlanEl(el, msg); break;
      case 'todo_list': updateTodoListEl(el, msg); break;
      case 'run_command': updateRunCommandEl(el, msg); break;
      case 'loading': break;
    }
  }

  // --- Human message ---

  function createQuotedWidget(text) {
    const wrap = document.createElement('div');
    wrap.className = 'quoted-widget';
    const lab = document.createElement('div');
    lab.className = 'quoted-label';
    lab.textContent = 'Quoted';
    const body = document.createElement('div');
    body.className = 'quoted-text';
    body.textContent = text;
    wrap.appendChild(lab);
    wrap.appendChild(body);
    return wrap;
  }

  function createHumanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-human';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'human-bubble';

    if (msg.quoted && msg.quoted.text) {
      bubble.appendChild(createQuotedWidget(msg.quoted.text));
    }

    if (msg.mentions && msg.mentions.length > 0) {
      const mentionsRow = document.createElement('div');
      mentionsRow.className = 'mentions-row';
      msg.mentions.forEach(m => {
        const badge = document.createElement('span');
        badge.className = 'mention-badge';
        badge.textContent = m.name;
        mentionsRow.appendChild(badge);
      });
      bubble.appendChild(mentionsRow);
    }

    const text = document.createElement('div');
    text.className = 'human-text';
    text.textContent = msg.text;
    bubble.appendChild(text);
    el.appendChild(bubble);
    return el;
  }

  function updateHumanEl(el, msg) {
    const bubble = el.querySelector('.human-bubble');
    let qw = el.querySelector('.quoted-widget');
    if (msg.quoted && msg.quoted.text) {
      if (!qw && bubble) {
        qw = createQuotedWidget(msg.quoted.text);
        bubble.insertBefore(qw, bubble.firstChild);
      } else if (qw) {
        const body = qw.querySelector('.quoted-text');
        if (body) body.textContent = msg.quoted.text;
      }
    } else if (qw) {
      qw.remove();
    }
    const text = el.querySelector('.human-text');
    if (text) text.textContent = msg.text;
  }

  // --- Assistant message ---

  let codeBlockFsOverlay = null;

  function closeCodeBlockFullscreen() {
    if (!codeBlockFsOverlay) return;
    codeBlockFsOverlay.remove();
    codeBlockFsOverlay = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onCodeBlockFsKeydown);
  }

  function onCodeBlockFsKeydown(e) {
    if (e.key === 'Escape') closeCodeBlockFullscreen();
  }

  /** Full-screen overlay for long code/diff (mobile-friendly scroll + safe areas). */
  function openCodeBlockFullscreen(wrapper) {
    closeCodeBlockFullscreen();
    const viewport = wrapper.querySelector('.code-block-viewport');
    const headerEl = wrapper.querySelector('.code-block-header');
    const title = (headerEl && headerEl.textContent.trim()) || 'Code';

    const overlay = document.createElement('div');
    overlay.className = 'code-block-fs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const backdrop = document.createElement('div');
    backdrop.className = 'code-block-fs-backdrop';
    backdrop.addEventListener('click', closeCodeBlockFullscreen);

    const panel = document.createElement('div');
    panel.className = 'code-block-fs-panel';

    const panelHead = document.createElement('div');
    panelHead.className = 'code-block-fs-panel-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'code-block-fs-title';
    titleSpan.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'code-block-fs-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCodeBlockFullscreen();
    });
    panelHead.appendChild(titleSpan);
    panelHead.appendChild(closeBtn);

    const scroll = document.createElement('div');
    scroll.className = 'code-block-fs-scroll';
    if (viewport && viewport.firstElementChild) {
      scroll.appendChild(viewport.firstElementChild.cloneNode(true));
    }

    panel.appendChild(panelHead);
    panel.appendChild(scroll);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    codeBlockFsOverlay = overlay;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onCodeBlockFsKeydown);
    closeBtn.focus();
  }

  /** Native code/diff from server `CodeBlockItem` (no mirrored Monaco HTML). */
  function createNativeBlockFromItem(item, filenameFallback) {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block native-code-block';

    const title = (item.filename || item.language || filenameFallback || '').trim();
    const toolbar = document.createElement('div');
    toolbar.className =
      'code-block-toolbar' + (title ? '' : ' code-block-toolbar--actions-only');
    if (title) {
      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.textContent = title;
      toolbar.appendChild(header);
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'code-block-fullscreen-btn';
    expandBtn.setAttribute('aria-label', 'View full screen');
    expandBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCodeBlockFullscreen(wrapper);
    });
    toolbar.appendChild(expandBtn);
    wrapper.appendChild(toolbar);

    const viewport = document.createElement('div');
    viewport.className = 'code-block-viewport';

    const body = document.createElement('div');
    body.className = 'code-block-diff-plain';
    if (item.blockKind === 'diff' && item.diffLines && item.diffLines.length > 0) {
      for (const line of item.diffLines) {
        const row = document.createElement('div');
        const k = ['add', 'rem', 'ctx', 'meta', 'hunk'].includes(line.kind) ? line.kind : 'ctx';
        row.className = 'code-block-diff-line code-block-diff-line--' + k;
        row.textContent = line.text;
        body.appendChild(row);
      }
    } else {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = item.code || '';
      pre.appendChild(code);
      body.appendChild(pre);
      body.classList.add('code-block-diff-plain--raw');
    }
    viewport.appendChild(body);
    wrapper.appendChild(viewport);
    return wrapper;
  }

  function appendAssistantNativeBlocks(bubble, msg) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > .native-code-block').forEach((n) => n.remove());
    if (!msg.codeBlocks?.length) return;
    for (const item of msg.codeBlocks) {
      if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) continue;
      bubble.appendChild(createNativeBlockFromItem(item));
    }
  }

  function createAssistantEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-assistant';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';

    if (msg.html) {
      const content = document.createElement('div');
      content.className = 'assistant-content markdown-body';
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      bubble.appendChild(content);
    } else {
      const content = document.createElement('div');
      content.className = 'assistant-content';
      content.textContent = msg.text;
      bubble.appendChild(content);
    }

    appendAssistantNativeBlocks(bubble, msg);

    el.appendChild(bubble);
    el.dataset.contentKey = assistantContentKey(msg);
    return el;
  }

  function assistantContentKey(msg) {
    return JSON.stringify({
      html: msg.html || '',
      text: msg.text || '',
      codeBlocks: msg.codeBlocks || [],
    });
  }

  function updateAssistantEl(el, msg) {
    const nextKey = assistantContentKey(msg);
    if (el.dataset.contentKey === nextKey) return;
    el.dataset.contentKey = nextKey;
    const bubble = el.querySelector('.assistant-bubble');
    const content = el.querySelector('.assistant-content');
    if (!content) return;
    if (msg.html) {
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      content.classList.add('markdown-body');
    } else {
      content.textContent = msg.text;
      content.classList.remove('markdown-body');
    }
    appendAssistantNativeBlocks(bubble, msg);
  }

  // --- Tool call ---

  function normalizeRepeatedStatusText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const compact = text.replace(/\s+/g, '').toLowerCase();
    for (const status of ['cancelled', 'canceled', 'completed', 'failed', 'stopped']) {
      if (compact === status + status) {
        return text.slice(0, status.length);
      }
    }
    return text;
  }

  function toolDistinctSummary(msg) {
    const action = normalizeRepeatedStatusText(msg.action);
    const filename = (msg.filename || '').trim();
    const details = normalizeRepeatedStatusText(msg.details);
    const summary = normalizeRepeatedStatusText(msg.summaryText);
    const texts = [];
    if (details) texts.push(details);
    if (summary && summary !== details) texts.push(summary);
    for (const text of texts) {
      if (!text) continue;
      if (action && text === action) continue;
      if (filename && (text === filename || text === `${action} ${filename}`.trim())) continue;
      let rest = text;
      if (action && rest.startsWith(action + ' ')) rest = rest.slice(action.length).trim();
      if (filename && rest === filename) continue;
      if (rest) return rest;
    }
    return '';
  }

  function createToolEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-tool';
    el.dataset.id = msg.id;
    if (msg.toolCallId) el.dataset.toolCallId = msg.toolCallId;

    const line = document.createElement('div');
    line.className = 'tool-line ' + msg.status;

    const header = document.createElement('div');
    header.className = 'tool-header';

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
    header.appendChild(icon);

    const action = document.createElement('span');
    action.className = 'tool-action';
    action.textContent = normalizeRepeatedStatusText(msg.action) || 'Tool';
    header.appendChild(action);

    const filename = (msg.filename || '').trim();
    if (filename) {
      const fn = document.createElement('span');
      fn.className = 'tool-filename';
      fn.textContent = filename;
      fn.title = filename;
      header.appendChild(fn);
    }

    if (msg.additions != null || msg.deletions != null) {
      const fileInfo = document.createElement('span');
      fileInfo.className = 'tool-file-info';
      if (msg.additions != null) {
        const add = document.createElement('span');
        add.className = 'tool-additions';
        add.textContent = '+' + msg.additions;
        fileInfo.appendChild(add);
      }
      if (msg.deletions != null) {
        const del = document.createElement('span');
        del.className = 'tool-deletions';
        del.textContent = '-' + msg.deletions;
        fileInfo.appendChild(del);
      }
      header.appendChild(fileInfo);
    }
    line.appendChild(header);

    const summary = toolDistinctSummary(msg);
    if (summary) {
      const body = document.createElement('div');
      body.className = 'tool-summary-row';
      body.textContent = summary;
      body.title = summary;
      line.appendChild(body);
    }

    el.appendChild(line);

    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'tool-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      el.appendChild(actionsRow);
    }

    syncToolDiffHost(el, msg);
    return el;
  }

  /** Tool edit diff: native block from `diffBlock` (structured lines). */
  function syncToolDiffHost(el, msg) {
    const db = msg.diffBlock;
    const hasBody =
      db &&
      ((db.diffLines && db.diffLines.length > 0) || (db.code && String(db.code).trim().length > 0));
    let host = el.querySelector('.tool-diff-host');

    if (!hasBody) {
      if (host) {
        delete host._nativeDiffKey;
        host.remove();
      }
      return;
    }

    const key = JSON.stringify({
      bk: db.blockKind,
      c: db.code,
      d: db.diffLines,
      f: db.filename || msg.filename,
    });
    if (!host) {
      host = document.createElement('div');
      host.className = 'tool-diff-host';
      el.appendChild(host);
    }
    if (host._nativeDiffKey === key) return;
    host._nativeDiffKey = key;
    host.innerHTML = '';
    host.appendChild(createNativeBlockFromItem(db, msg.filename));
  }

  function updateToolEl(el, msg) {
    const fresh = createToolEl(msg);
    const newLine = fresh.querySelector('.tool-line');
    const oldLine = el.querySelector('.tool-line');
    if (newLine && oldLine) el.replaceChild(newLine, oldLine);

    const newActions = fresh.querySelector('.tool-actions-row');
    const oldActions = el.querySelector('.tool-actions-row');
    if (newActions && oldActions) {
      el.replaceChild(newActions, oldActions);
    } else if (newActions && !oldActions) {
      const diffHost = el.querySelector('.tool-diff-host');
      if (diffHost) el.insertBefore(newActions, diffHost);
      else el.appendChild(newActions);
    } else if (!newActions && oldActions) {
      oldActions.remove();
    }

    syncToolDiffHost(el, msg);
  }

  // --- Thought block ---

  function formatThoughtLine(msg) {
    const dur = (msg.duration || '').trim();
    const detail = (msg.detail || '').trim();
    const action = (msg.action || '').trim();

    function withDetail(base) {
      if (!detail || detail === action || (base && base.indexOf(detail) !== -1)) return base;
      return base ? `${base} — ${detail}` : detail;
    }

    function formatActionLabel(raw) {
      if (!raw) return '';
      if (/^thought$/i.test(raw)) return 'Thought';
      if (/ing$/i.test(raw)) return `${raw.replace(/\.+$/, '')}…`;
      return raw;
    }

    if (msg.thoughtKind === 'step_summary') {
      return withDetail(action || 'Steps') || 'Steps';
    }
    if (msg.thoughtKind === 'thinking_step') {
      let label = formatActionLabel(action) || 'Thinking…';
      if (dur) label = `${label} · ${dur}`;
      return withDetail(label);
    }
    if (action) {
      let label = formatActionLabel(action);
      if (dur) label = `${label} · ${dur}`;
      return withDetail(label);
    }
    if (dur) return withDetail(`Thought for ${dur}`);
    return withDetail('Thinking…') || 'Thinking…';
  }

  function syncThoughtLineClasses(inner, msg) {
    inner.classList.remove('thought-line-summary', 'thought-line-step');
    if (msg.thoughtKind === 'step_summary') inner.classList.add('thought-line-summary');
    else if (msg.thoughtKind === 'thinking_step') inner.classList.add('thought-line-step');
  }

  function createThoughtEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-thought';
    el.dataset.id = msg.id;

    const inner = document.createElement('div');
    inner.className = 'thought-line';
    syncThoughtLineClasses(inner, msg);
    inner.textContent = formatThoughtLine(msg);
    el.appendChild(inner);
    return el;
  }

  function updateThoughtEl(el, msg) {
    const inner = el.querySelector('.thought-line');
    if (inner) {
      syncThoughtLineClasses(inner, msg);
      inner.textContent = formatThoughtLine(msg);
    }
  }

  // --- Plan block ---

  async function emitClickAction(actionType, actionId) {
    if (!hasOpaqueActionId(actionId) || typeof actionType !== 'string' || actionType.length === 0) return false;
    if (!isSocketLive()) {
      showToast('Relay disconnected', 'error');
      return false;
    }
    if (genericActionInFlight.has(actionId)) return false;
    const payload = { actionId, actionType };
    const blocked = cursorMutationBlockedReason('command:click_action', payload);
    if (blocked) {
      showToast(blocked, 'error');
      return false;
    }
    const envelope = reuseEnvelope(
      'command:click_action',
      payload,
      genericActionEnvelopes.get(actionId),
    );
    genericActionEnvelopes.set(actionId, envelope);
    genericActionInFlight.add(actionId);
    renderMessages();
    syncPlanModalFromState();
    const result = await sendCommandAwaitResult('command:click_action', envelope);
    genericActionInFlight.delete(actionId);
    if (result.ok || !mutationOutcomeUncertain(result)) genericActionEnvelopes.delete(actionId);
    renderMessages();
    syncPlanModalFromState();
    if (!result.ok) {
      showToast(commandErrorMessage(result, `${actionType} failed`), 'error');
      return false;
    }
    showToast(`${actionType} submitted`, 'success');
    return true;
  }

  function buildPlanFullContent(planData) {
    const content = document.createElement('div');
    content.className = 'plan-card plan-card-modal';

    if (Array.isArray(planData.todos) && planData.todos.length > 0) {
      const completed = planData.todos.filter((todo) => todo.status === 'completed').length;
      const summary = document.createElement('div');
      summary.className = 'plan-progress';
      summary.textContent = `To-dos ${completed}/${planData.todos.length}`;
      content.appendChild(summary);

      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      planData.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      content.appendChild(todoList);
    }

    if (planData.bodyHtml) {
      const body = document.createElement('div');
      body.className = 'plan-description markdown-body';
      body.innerHTML = sanitizeHtml(planData.bodyHtml);
      normalizeMarkdownCodeBlocks(body);
      content.appendChild(body);
    }

    return content;
  }

  function currentPlanSessionIdentity() {
    return `${state.activeWindowId || ''}\n${state.activeComposerId || ''}`;
  }

  function planModalIdentity(msg) {
    return `${currentPlanSessionIdentity()}\n${msg.id || ''}\n${(msg.label || '').trim()}`;
  }

  /**
   * Fingerprint of the plan summary shown in the widget. Any change means the
   * visible summary no longer matches the loaded file snapshot, so the old
   * body must be dropped and re-read explicitly.
   */
  function planBodyIdentity(msg) {
    return JSON.stringify({
      id: msg.id || '',
      label: (msg.label || '').trim(),
      title: msg.title || '',
      toolCallId: msg.toolCallId || '',
      fileName: msg.fileName || '',
      description: msg.description || '',
      model: msg.model || '',
      todosCompleted: msg.todosCompleted ?? null,
      todosTotal: msg.todosTotal ?? null,
      todos: Array.isArray(msg.todos) ? msg.todos.map((todo) => [todo.text || '', todo.status || '']) : null,
    });
  }

  /** The exact plan file target. A request is only sent when all three are known. */
  function planFileTarget(msg) {
    const planId = typeof msg.id === 'string' ? msg.id : '';
    const windowId = typeof state.activeWindowId === 'string' ? state.activeWindowId : '';
    const composerId = typeof state.activeComposerId === 'string' ? state.activeComposerId : '';
    if (!planId || !windowId || !composerId) return null;
    return { planId, windowId, composerId };
  }

  function newPlanModalInstanceId() {
    planModalInstanceCounter += 1;
    return `plan-modal-${planModalInstanceCounter}-${Date.now()}`;
  }

  const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
  const PLAN_TODO_STATUSES = new Set(['pending', 'completed', 'in_progress']);

  /** A finite number that still maps to a real Date (beyond the JS range it would not). */
  function isValidPlanTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    return !Number.isNaN(new Date(value).getTime());
  }

  function formatPlanTime(value) {
    if (!isValidPlanTime(value)) return '未知';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  /** Reject absolute paths, traversal, and separators — only a plain file name is accepted. */
  function isSafePlanFileName(value) {
    if (typeof value !== 'string') return false;
    const name = value.trim();
    if (!name || name !== value) return false;
    if (name.startsWith('/') || name.startsWith('\\')) return false;
    if (/^[A-Za-z]:/.test(name)) return false;
    if (name.includes('/') || name.includes('\\')) return false;
    if (name.includes('\0')) return false;
    return true;
  }

  function isPlanTodoList(value) {
    if (!Array.isArray(value)) return false;
    return value.every((todo) => (
      todo
      && typeof todo === 'object'
      && typeof todo.text === 'string'
      && todo.text.trim().length > 0
      && PLAN_TODO_STATUSES.has(todo.status)
    ));
  }

  /**
   * Only accept a full plan result whose metadata proves it is the exact
   * snapshot for the requested plan/window/session, and whose body is a real
   * non-empty document. Missing, malformed, or mismatched data is a failure
   * and the body must never be shown.
   */
  function validatePlanFullResult(data, target) {
    const metadata = data && data.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return { ok: false, error: '计划文件元信息缺失，无法显示全文' };
    }
    if (metadata.source !== 'cursor_plan_file') {
      return { ok: false, error: '计划文件来源未通过校验，无法显示全文' };
    }
    if (metadata.completeness !== 'complete') {
      return { ok: false, error: '计划文件快照不完整，无法显示全文' };
    }
    if (
      metadata.windowId !== target.windowId
      || metadata.composerId !== target.composerId
      || metadata.planId !== target.planId
    ) {
      return { ok: false, error: '计划文件身份与请求的窗口/会话/计划不一致，无法显示全文' };
    }
    if (
      !isSafePlanFileName(metadata.fileName)
      || typeof metadata.version !== 'string' || !SHA256_HEX_RE.test(metadata.version)
      || !isValidPlanTime(metadata.observedAt) || !isValidPlanTime(metadata.updatedAt)
    ) {
      return { ok: false, error: '计划文件元信息格式非法，无法显示全文' };
    }
    if (!isPlanTodoList(data.todos)) {
      return { ok: false, error: '计划文件待办列表缺失或格式非法，无法显示全文' };
    }
    if (typeof data.body !== 'string' || data.body.trim().length === 0) {
      return { ok: false, error: '计划文件正文为空，无法显示全文' };
    }
    if (typeof data.bodyHtml !== 'string' || data.bodyHtml.trim().length === 0) {
      return { ok: false, error: '计划文件正文为空，无法显示全文' };
    }
    return {
      ok: true,
      data: {
        todos: data.todos.map((todo) => ({ text: todo.text, status: todo.status })),
        body: data.body,
        bodyHtml: data.bodyHtml,
        metadata: {
          windowId: metadata.windowId,
          composerId: metadata.composerId,
          planId: metadata.planId,
          version: metadata.version,
          source: metadata.source,
          fileName: metadata.fileName,
          observedAt: metadata.observedAt,
          updatedAt: metadata.updatedAt,
          completeness: metadata.completeness,
        },
      },
    };
  }

  function buildPlanMetadataSection(metadata) {
    const box = document.createElement('div');
    box.className = 'plan-modal-status';
    const rows = [
      ['来源文件', metadata.fileName],
      ['窗口', metadata.windowId],
      ['会话', metadata.composerId],
      ['计划', metadata.planId],
      ['内容版本', metadata.version],
      ['读取时间', formatPlanTime(metadata.observedAt)],
      ['文件修改时间（非批准时间）', formatPlanTime(metadata.updatedAt)],
      ['完整性', '读取时完整快照，非持续实时，不是完整任务或会话，也不代表用户授权'],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.textContent = `${label}：${String(value)}`;
      box.appendChild(row);
    });
    return box;
  }

  function buildPlanReReadButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plan-btn plan-btn-view';
    btn.textContent = '重新读取';
    btn.addEventListener('click', () => { void reReadFullPlan(); });
    return btn;
  }

  function buildPlanSummaryContent(msg, noteText) {
    const wrap = document.createElement('div');
    const note = document.createElement('div');
    note.className = 'plan-modal-status';
    note.textContent = noteText;
    wrap.appendChild(note);
    const summaryMsg = {
      ...msg,
      actions: Array.isArray(msg.actions)
        ? msg.actions.filter((action) => action.type !== 'view_plan' && action.type !== 'build')
        : msg.actions,
      modelActionId: undefined,
      model: '',
    };
    const content = buildPlanCard(summaryMsg, { hideView: true });
    content.classList.add('plan-card-modal');
    wrap.appendChild(content);
    return wrap;
  }

  function buildPlanModalContent(msg) {
    const modal = activePlanModal;
    const wrap = document.createElement('div');
    if (modal && modal.fullData) {
      wrap.appendChild(buildPlanMetadataSection(modal.fullData.metadata));
      wrap.appendChild(buildPlanTaskBasisSection(modal.fullData));
      wrap.appendChild(buildPlanReReadButton());
      wrap.appendChild(buildPlanFullContent(modal.fullData));
      return wrap;
    }
    if (modal && modal.loading) {
      const loading = document.createElement('div');
      loading.className = 'plan-modal-status';
      loading.textContent = '正在读取计划文件…';
      wrap.appendChild(loading);
    } else if (modal && modal.error) {
      const err = document.createElement('div');
      err.className = 'plan-modal-status plan-modal-status-error';
      err.textContent = `${modal.error}。以下仅为会话摘要。`;
      wrap.appendChild(err);
    } else if (modal && modal.requireReRead) {
      const stale = document.createElement('div');
      stale.className = 'plan-modal-status';
      stale.textContent = '计划摘要已变化，旧全文已清除。请重新读取以载入当前快照。';
      wrap.appendChild(stale);
    }
    wrap.appendChild(buildPlanTaskBasisSection(null));
    if (modal && !modal.loading) wrap.appendChild(buildPlanReReadButton());
    wrap.appendChild(buildPlanSummaryContent(msg, '会话摘要（并非计划文件全文）。'));
    return wrap;
  }

  function renderPlanModal(msg) {
    if (!msg) return;
    $planModalLabel.textContent = msg.label || '';
    $planModalLabel.style.display = msg.label ? '' : 'none';
    $planModalTitle.textContent = msg.title || 'Plan';
    $planModalBody.innerHTML = '';
    $planModalBody.appendChild(buildPlanModalContent(msg));
  }

  async function loadFullPlanIntoModal(msg) {
    const modal = activePlanModal;
    if (!modal) return;
    const target = planFileTarget(msg);
    if (!target) {
      modal.loading = false;
      modal.attempted = false;
      modal.fullData = null;
      modal.requireReRead = false;
      modal.error = '无法确认计划目标（缺少计划、窗口或会话标识），未发送读取请求';
      renderPlanModal(msg);
      return;
    }
    modal.target = target;
    modal.loading = true;
    modal.attempted = true;
    modal.requireReRead = false;
    modal.fullData = null;
    modal.error = '';
    renderPlanModal(msg);
    const instanceId = modal.instanceId;
    const requestSeq = ++modal.requestSeq;
    const result = await sendCommandAwaitResult('command:get_plan_full', {
      commandId: newCommandId(),
      type: 'get_plan_full',
      planId: target.planId,
      windowId: target.windowId,
      composerId: target.composerId,
    });
    if (!activePlanModal || activePlanModal.instanceId !== instanceId || activePlanModal.requestSeq !== requestSeq) {
      return;
    }
    modal.loading = false;
    if (!result.ok || !result.data) {
      modal.attempted = !result.outcomeUnknown;
      const rawError = typeof result.error === 'string' && result.error.trim() ? result.error.trim() : '';
      const failure = sanitizeClientPlanFailure(result.failure, result.commandId);
      modal.error = formatPlanDiagnosticError(rawError || '读取计划文件失败', failure, target);
      renderPlanModal(msg);
      return;
    }
    const validated = validatePlanFullResult(result.data, target);
    if (!validated.ok) {
      modal.attempted = !result.outcomeUnknown;
      modal.error = validated.error;
      modal.fullData = null;
      renderPlanModal(msg);
      return;
    }
    modal.fullData = validated.data;
    modal.error = '';
    renderPlanModal(msg);
  }

  /**
   * A plan modal may be backed by a live DOM card or by a short-lived reading
   * reference whose card is no longer mounted. Both are readable; neither may
   * be confused with a fabricated id.
   */
  function resolvePlanMessage(id) {
    const inState = (state.messages || []).find((msg) => msg.type === 'plan' && msg.id === id);
    if (inState) return inState;
    return activePlanReferences().find((ref) => ref.id === id) || null;
  }

  function reReadFullPlan() {
    const modal = activePlanModal;
    if (!modal) return;
    const current = resolvePlanMessage(modal.id);
    if (!current) {
      closePlanModal();
      return;
    }
    modal.fullData = null;
    modal.error = '';
    void loadFullPlanIntoModal(current);
  }

  function openPlanModal(msg) {
    closeTransientUi('plan');
    activePlanModal = {
      id: msg.id,
      fromReference: !!msg.reference,
      instanceId: newPlanModalInstanceId(),
      requestSeq: 0,
      identity: planModalIdentity(msg),
      bodyIdentity: planBodyIdentity(msg),
      sessionIdentity: currentPlanSessionIdentity(),
      label: msg.label || '',
      target: null,
      fullData: null,
      loading: false,
      attempted: false,
      requireReRead: false,
      error: '',
    };
    renderPlanModal(msg);
    planLayer.open(document.activeElement);
    loadFullPlanIntoModal(msg);
  }

  function closePlanModal() {
    planLayer.close();
  }

  function syncPlanModalFromState() {
    if (!activePlanModal) return;
    if (activePlanModal.sessionIdentity !== currentPlanSessionIdentity()) {
      closePlanModal();
      return;
    }
    // Falls back to valid references so a reference-backed modal stays readable
    // after its source card leaves the DOM; expiry/target change still closes it.
    const current = resolvePlanMessage(activePlanModal.id);
    if (!current) {
      closePlanModal();
      return;
    }

    const nextBodyIdentity = planBodyIdentity(current);
    if (nextBodyIdentity !== activePlanModal.bodyIdentity) {
      activePlanModal.requestSeq += 1;
      activePlanModal.bodyIdentity = nextBodyIdentity;
      activePlanModal.identity = planModalIdentity(current);
      activePlanModal.label = current.label || '';
      activePlanModal.fullData = null;
      activePlanModal.loading = false;
      activePlanModal.attempted = false;
      activePlanModal.requireReRead = true;
      activePlanModal.error = '';
    }
    renderPlanModal(current);
  }

  async function openPlanModelPicker(msg) {
    if (mutationSubmitInFlight.has('get_plan_model_options')) return;
    if (!hasOpaqueActionId(msg.modelActionId)) {
      if (msg.model) showToast(`Plan model: ${msg.model}`, 'success');
      else showToast('Plan model capability is unavailable; refresh CursorRemote', 'error');
      return;
    }
    const blocked = cursorMutationBlockedReason('command:get_plan_model_options', {
      actionId: msg.modelActionId,
    }) || supervisionWriteDisabledReason({
      actionType: 'set_plan_model',
      actionId: msg.modelActionId,
    });
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }

    mutationSubmitInFlight.add('get_plan_model_options');
    try {
      const commandId = newCommandId();
      const result = await sendCommandAwaitResult('command:get_plan_model_options', {
        commandId,
        type: 'get_plan_model_options',
        actionId: msg.modelActionId,
      });

      const options = Array.isArray(result.data?.options) ? result.data.options : [];
      if (!result.ok || options.length === 0) {
        if (!result.ok) showToast(result.error || 'Could not load plan models', 'error');
        return;
      }

      activePlanModelContext = {
        actionId: msg.modelActionId,
        title: msg.title || 'Plan',
        options,
      };
      openSheet('plan-model');
    } finally {
      mutationSubmitInFlight.delete('get_plan_model_options');
    }
  }

  function buildPlanCard(msg, opts) {
    const hideView = !!(opts && opts.hideView);
    const card = document.createElement('div');
    card.className = 'plan-card plan-card-widget';

    if (msg.label) {
      const header = document.createElement('div');
      header.className = 'plan-widget-header';
      const icon = document.createElement('span');
      icon.className = 'plan-widget-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\u2712';
      const fn = document.createElement('span');
      fn.className = 'plan-widget-filename';
      fn.textContent = msg.label;
      header.appendChild(icon);
      header.appendChild(fn);
      card.appendChild(header);
    }

    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = msg.title;
    card.appendChild(title);

    const status = document.createElement('div');
    status.className = 'plan-state plan-state-' + planDisplayStatus(msg).toLowerCase();
    status.textContent = planDisplayStatus(msg);
    card.appendChild(status);

    if (msg.descriptionHtml) {
      const desc = document.createElement('div');
      desc.className = 'plan-description markdown-body';
      desc.innerHTML = sanitizeHtml(msg.descriptionHtml);
      normalizeMarkdownCodeBlocks(desc);
      card.appendChild(desc);
    } else if (msg.description) {
      const desc = document.createElement('div');
      desc.className = 'plan-description';
      desc.textContent = msg.description;
      card.appendChild(desc);
    }

    if (msg.todos && msg.todos.length > 0) {
      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      msg.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      card.appendChild(todoList);
    }

    if (msg.todosMoreCount && msg.todosMoreCount > 0) {
      const more = document.createElement('div');
      more.className = 'plan-todos-more';
      more.textContent = `${msg.todosMoreCount} more`;
      card.appendChild(more);
    }

    if (msg.todosTotal > 0) {
      const progress = document.createElement('div');
      progress.className = 'plan-progress';
      const track = document.createElement('div');
      track.className = 'plan-progress-track';
      const bar = document.createElement('div');
      bar.className = 'plan-progress-bar';
      const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
      bar.style.width = pct + '%';
      track.appendChild(bar);
      progress.appendChild(track);
      const progressText = document.createElement('span');
      progressText.className = 'plan-progress-text';
      progressText.textContent = msg.todosCompleted + '/' + msg.todosTotal;
      progress.appendChild(progressText);
      card.appendChild(progress);
    }

    const canBrowsePlan = !hideView && !!(msg.title || msg.label || msg.description || (msg.todos && msg.todos.length));
    const hasActions = canBrowsePlan || (msg.actions && msg.actions.length > 0) || hasOpaqueActionId(msg.modelActionId) || msg.model;
    if (hasActions) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plan-actions-toolbar';

      const left = document.createElement('div');
      left.className = 'plan-actions-left';
      const viewAct = msg.actions && msg.actions.find((a) => a.type === 'view_plan');
      if (canBrowsePlan) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'plan-btn plan-btn-view';
        btn.textContent = (viewAct && viewAct.label) || 'View Plan';
        btn.addEventListener('click', () => openPlanModal(msg));
        left.appendChild(btn);
      }
      toolbar.appendChild(left);

      const center = document.createElement('div');
      center.className = 'plan-actions-center';
      if (hasOpaqueActionId(msg.modelActionId)) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'plan-model-pill';
        const lab = document.createElement('span');
        lab.className = 'plan-model-pill-text';
        lab.textContent = msg.model || 'Model';
        const chev = document.createElement('span');
        chev.className = 'plan-model-pill-chev';
        chev.textContent = '\u25BE';
        pill.appendChild(lab);
        pill.appendChild(chev);
        const planModelReason = supervisionWriteDisabledReason({
          actionType: 'set_plan_model',
          actionId: msg.modelActionId,
        }) || cursorMutationBlockedReason('command:get_plan_model_options', {
          actionId: msg.modelActionId,
        });
        if (planModelReason) {
          pill.disabled = true;
          pill.title = planModelReason;
        } else {
          pill.addEventListener('click', () => { void openPlanModelPicker(msg); });
        }
        center.appendChild(pill);
      } else if (msg.model) {
        const badge = document.createElement('span');
        badge.className = 'plan-model-badge-inline';
        badge.textContent = msg.model;
        center.appendChild(badge);
      }
      toolbar.appendChild(center);

      const right = document.createElement('div');
      right.className = 'plan-actions-right';
      if (msg.actions) {
        const buildAct = msg.actions.find((a) => a.type === 'build');
        if (buildAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-build';
          btn.textContent = buildAct.label || 'Build';
          const supervisionReason = supervisionWriteDisabledReason({
            actionType: 'build',
            actionId: buildAct.actionId,
          });
          if (!hasOpaqueActionId(buildAct.actionId)) {
            btn.disabled = true;
            btn.title = 'Action authorization is unavailable; refresh CursorRemote';
          } else if (supervisionReason) {
            btn.disabled = true;
            btn.title = supervisionReason;
          } else if (genericActionInFlight.has(buildAct.actionId) || !isSocketLive()) {
            btn.disabled = true;
          } else {
            btn.addEventListener('click', () => { void emitClickAction('build', buildAct.actionId); });
          }
          right.appendChild(btn);
        }
      }
      toolbar.appendChild(right);
      card.appendChild(toolbar);
    }

    return card;
  }

  function createPlanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-plan';
    el.dataset.id = msg.id;
    el.appendChild(buildPlanCard(msg));
    return el;
  }

  function updatePlanEl(el, msg) {
    const oldCard = el.querySelector('.plan-card');
    if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
  }

  // --- Standalone todo list (matches Telegram §3.9) ---

  function createTodoListEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-todo-list';
    el.dataset.id = msg.id;
    const card = document.createElement('div');
    card.className = 'todo-list-card';
    const head = document.createElement('div');
    head.className = 'todo-list-card-title';
    head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'todo-list-card-items';
    msg.todos.forEach((todo) => {
      const row = document.createElement('div');
      row.className = 'todo-list-card-row';
      const icon = document.createElement('span');
      icon.className = 'todo-list-card-icon';
      icon.textContent = todo.status === 'completed' ? '✅'
        : todo.status === 'in_progress' ? '🔵' : '⚪';
      const tx = document.createElement('span');
      tx.className = 'todo-list-card-text';
      tx.textContent = todo.text;
      row.appendChild(icon);
      row.appendChild(tx);
      list.appendChild(row);
    });
    card.appendChild(list);
    el.appendChild(card);
    return el;
  }

  function updateTodoListEl(el, msg) {
    const fresh = createTodoListEl(msg);
    const newCard = fresh.querySelector('.todo-list-card');
    const oldCard = el.querySelector('.todo-list-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Run command / tool inline actions (Skip, Run, Allow) ---

  function appendRunStyleActionButtons(container, actions) {
    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.type === 'run' ? 'run-btn run-btn-run'
        : action.type === 'allow' ? 'run-btn run-btn-allow'
        : 'run-btn run-btn-skip';
      btn.textContent = action.label;
      const supervisionReason = supervisionWriteDisabledReason({
        actionType: action.type,
        actionId: action.actionId,
      });
      if (!hasOpaqueActionId(action.actionId)) {
        btn.disabled = true;
        btn.title = 'Action authorization is unavailable; refresh CursorRemote';
      } else if (supervisionReason) {
        btn.disabled = true;
        btn.title = supervisionReason;
      } else if (genericActionInFlight.has(action.actionId) || !isSocketLive()) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () {
          void emitClickAction(action.type, action.actionId);
        });
      }
      container.appendChild(btn);
    });
  }

  function createRunCommandEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-run-command';
    el.dataset.id = msg.id;
    if (msg.toolCallId) el.dataset.toolCallId = msg.toolCallId;

    const card = document.createElement('div');
    card.className = 'run-card';

    const header = document.createElement('div');
    header.className = 'run-header';
    const desc = document.createElement('span');
    desc.className = 'run-description';
    desc.textContent = msg.description;
    header.appendChild(desc);
    if (msg.candidates) {
      const cand = document.createElement('span');
      cand.className = 'run-candidates';
      cand.textContent = ' ' + msg.candidates;
      header.appendChild(cand);
    }
    card.appendChild(header);

    const cmdBlock = document.createElement('div');
    cmdBlock.className = 'run-command-block';
    const prompt = document.createElement('span');
    prompt.className = 'run-prompt';
    prompt.textContent = '$ ';
    cmdBlock.appendChild(prompt);
    const cmdText = document.createElement('span');
    cmdText.className = 'run-command-text';
    cmdText.textContent = msg.command;
    cmdBlock.appendChild(cmdText);
    card.appendChild(cmdBlock);

    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'run-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      card.appendChild(actionsRow);
    }

    el.appendChild(card);
    return el;
  }

  function updateRunCommandEl(el, msg) {
    const oldCommand = (el.querySelector('.run-command-text')?.textContent || '').trim();
    const nextMsg = (!msg.command || !msg.command.trim()) && oldCommand
      ? { ...msg, command: oldCommand }
      : msg;
    const fresh = createRunCommandEl(nextMsg);
    const newCard = fresh.querySelector('.run-card');
    const oldCard = el.querySelector('.run-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Loading indicator ---

  function createLoadingEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-loading';
    el.dataset.id = msg.id;

    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot-anim';
      dots.appendChild(dot);
    }
    el.appendChild(dots);
    return el;
  }

  // --- Fallback ---

  function createFallbackEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-fallback';
    el.dataset.id = msg.id;
    el.textContent = msg.text || msg.type || '...';
    return el;
  }

  // --- Sanitize HTML (strip scripts, event handlers, dangerous URLs) ---

  const URL_ATTRS = {
    href: true, src: true, poster: true, action: true, formaction: true,
    cite: true, background: true, data: true, xmlns: true, ping: true,
    dynsrc: true, lowsrc: true,
  };

  function isUnsafeUrl(value, allowSafeDataImage) {
    const stripped = String(value || '')
      .replace(/[\u0000-\u0020\u007F\u00A0\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F\u2060-\u206F\u3000\uFEFF\uFFA0]+/g, '')
      .toLowerCase();
    if (/^(?:javascript|vbscript|livescript|mocha):/.test(stripped)) {
      return true;
    }
    if (stripped.startsWith('data:')) {
      if (
        allowSafeDataImage &&
        /^data:image\/(png|gif|jpeg|jpg|webp|bmp|x-icon|avif)[;,]/i.test(stripped)
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  function sanitizeHtml(html) {
    if (html == null || html === '') return '';
    let root;
    try {
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      root = doc.body;
    } catch {
      return '';
    }
    if (!root) return '';
    root.querySelectorAll(
      'script, iframe, object, embed, form, svg, style, base, link, meta, math, template, applet'
    ).forEach(el => el.remove());
    root
      .querySelectorAll('.composer-message-codeblock, .composer-code-block-container, .ui-code-block')
      .forEach((el) => el.remove());
    root.querySelectorAll('*').forEach(el => {
      const tag = (el.tagName || '').toLowerCase();
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (
          name.startsWith('on') ||
          name === 'srcdoc' ||
          name === 'srcset' ||
          name === 'style' ||
          name === 'xlink:href' ||
          name.startsWith('xmlns:')
        ) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (URL_ATTRS[name] || name === 'href' || name === 'src') {
          const allowDataImage = tag === 'img' && name === 'src';
          if (isUnsafeUrl(attr.value, allowDataImage)) {
            el.removeAttribute(attr.name);
          }
        }
      }
      if (tag === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return root.innerHTML;
  }

  function normalizeMarkdownCodeBlocks(root) {
    if (!root) return;
    function extractStructuredCodeText(el) {
      let out = '';
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent || '';
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          out += '\n';
          return;
        }
        const before = out.length;
        node.childNodes.forEach(walk);
        const isLineLike =
          tag === 'div' ||
          tag === 'p' ||
          tag === 'li' ||
          node.matches?.('[data-line], .line');
        if (isLineLike && out.length > before && !out.endsWith('\n')) {
          out += '\n';
        }
      }
      walk(el);
      return out.replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n').trimEnd();
    }

    root.querySelectorAll('code').forEach((codeEl) => {
      if (codeEl.closest('pre')) return;
      if (
        codeEl.className.includes('md-inline-') ||
        codeEl.closest('p, li, a, h1, h2, h3, h4, h5, h6')
      ) {
        return;
      }

      const text = extractStructuredCodeText(codeEl);
      const looksBlockLike =
        text.includes('\n') ||
        !!codeEl.querySelector('br,[data-line],.line,div,p') ||
        /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
      if (!looksBlockLike) return;

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = codeEl.className || '';
      code.textContent = text;
      pre.appendChild(code);
      codeEl.replaceWith(pre);
    });
  }

  // --- Approvals ---

  function isActionCardMessage(msg) {
    if (!msg) return false;
    if (msg.type !== 'run_command' && msg.type !== 'tool') return false;
    const actions = Array.isArray(msg.actions) ? msg.actions : [];
    return actions.some((action) =>
      action
      && typeof action.type === 'string'
      && action.type
      && hasOpaqueActionId(action.actionId)
    );
  }

  function findApprovalCard(approval) {
    if (!approval) return null;
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const approvalId = String(approval.id || '');
    const toolCallId = approvalId.indexOf('tool:') === 0 ? approvalId.slice(5) : '';
    let msg = null;
    if (toolCallId) {
      msg = messages.find((item) => item && item.toolCallId === toolCallId && isActionCardMessage(item));
    }
    if (!msg && approvalId) {
      msg = messages.find((item) => item && item.id === approvalId && isActionCardMessage(item));
    }
    if (!msg && toolCallId) {
      msg = messages.find((item) => item && item.id === toolCallId && isActionCardMessage(item));
    }
    if (!msg) return null;
    const el = Array.prototype.find.call(
      $messages.querySelectorAll('.chat-el'),
      (node) => {
        if (node.getAttribute('data-id') === String(msg.id)) return true;
        if (msg.toolCallId && node.getAttribute('data-tool-call-id') === String(msg.toolCallId)) return true;
        return false;
      }
    ) || null;
    if (!el) return null;
    return { msg, el };
  }

  function approvalNeedsFallback(approval, card) {
    if (!approval) return true;
    const actions = Array.isArray(approval.actions) ? approval.actions : [];
    if (actions.some((action) => action && action.type === 'approve_all')) return true;
    if (!card || !card.el || !card.msg) return true;
    if (!isActionCardMessage(card.msg)) return true;
    const operable = card.el.querySelector(
      '.run-btn:not([disabled]), .run-actions-row button:not([disabled]), .tool-actions-row button:not([disabled])'
    );
    if (!operable) return true;
    return false;
  }

  function scrollToApprovalCard(card) {
    if (!card || !card.el) return false;
    if (!card.el.isConnected) return false;
    userScrolledUp = true;
    if (typeof card.el.scrollIntoView === 'function') {
      card.el.scrollIntoView({ block: 'center' });
    }
    card.el.classList.add('approval-target-highlight');
    if (approvalHighlightTimer) clearTimeout(approvalHighlightTimer);
    approvalHighlightTimer = setTimeout(function () {
      card.el.classList.remove('approval-target-highlight');
      approvalHighlightTimer = 0;
    }, 1600);
    return true;
  }

  function renderApprovals() {
    if (state.pendingApprovals.length > 0) {
      $approvalBar.classList.remove('hidden');
      const approval = state.pendingApprovals[0];
      $approvalDesc.textContent = approval.description || 'Action needs approval';

      const approveAction = approval.actions.find(a => (a.type === 'approve' || a.type === 'approve_all') && hasOpaqueActionId(a.actionId));
      const rejectAction = approval.actions.find(a => a.type === 'reject' && hasOpaqueActionId(a.actionId));
      const live = isSocketLive();
      const approveReason = approveAction
        ? supervisionWriteDisabledReason({
          actionType: approveAction.type === 'approve_all' ? 'approve_all' : 'approve',
          actionId: approveAction.actionId,
        })
        : supervisionWriteDisabledReason({ actionType: 'approve' });
      const rejectReason = rejectAction
        ? supervisionWriteDisabledReason({ actionType: 'reject', actionId: rejectAction.actionId })
        : supervisionWriteDisabledReason({ actionType: 'reject' });
      const card = findApprovalCard(approval);
      const fallback = approvalNeedsFallback(approval, card);

      if ($btnApprovalView) {
        $btnApprovalView.classList.toggle('hidden', fallback);
        $btnApprovalView.disabled = fallback;
      }
      $approvalBar.dataset.mode = fallback ? 'fallback' : 'reminder';
      $btnApprove.classList.toggle('hidden', !fallback);
      $btnReject.classList.toggle('hidden', !fallback);

      $btnApprove.disabled = !live || !!approveReason || approvalInFlight || rejectInFlight || !approveAction || !fallback;
      $btnReject.disabled = !live || !!rejectReason || approvalInFlight || rejectInFlight || !rejectAction || !fallback;
      $btnApprove.title = approveReason;
      $btnReject.title = rejectReason;
      if (approveAction) $btnApprove.textContent = approveAction.label || 'Accept';
      if (rejectAction) $btnReject.textContent = rejectAction.label || 'Reject';

      fireNotification(
        approval.description || 'Agent needs approval',
        'cursor-approval:' + (approval.id || 'pending')
      );
    } else {
      $approvalBar.classList.add('hidden');
      $approvalBar.dataset.mode = '';
      if ($btnApprovalView) $btnApprovalView.classList.add('hidden');
      $btnApprove.classList.remove('hidden');
      $btnReject.classList.remove('hidden');
      forgetNotificationKeys('cursor-approval:');
    }
  }

  function renderQuestionnaire() {
    var q = state.questionnaire;
    if (!q || !q.questions || q.questions.length === 0) {
      var sheetWasOpen = questionnaireLayer && questionnaireLayer.isOpen();
      if (sheetWasOpen) questionnaireLayer.close();
      $questionnaireBar.classList.add('hidden');
      questionnaireOptimistic = {};
      forgetNotificationKeys('cursor-questionnaire');
      if (!isUsableFocusTarget(document.activeElement)) {
        if (isUsableFocusTarget($input)) $input.focus();
        else if (isUsableFocusTarget($btnSystem)) $btnSystem.focus();
      }
      return;
    }
    $questionnaireBar.classList.remove('hidden');
    var refreshing = !!questionnaireNullHoldTimer || questionnaireAwaitingSnapshot;
    var stepperText = refreshing
      ? ((q.totalLabel ? q.totalLabel + ' · ' : '') + 'Syncing…')
      : (q.totalLabel || '');
    $questionnaireStepper.textContent = stepperText;
    if ($questionnaireTriggerLabel) $questionnaireTriggerLabel.textContent = stepperText;
    var live = isSocketLive();
    var skipReason = supervisionWriteDisabledReason({
      actionType: 'skip',
      actionId: q.skipActionId,
    });
    var continueReason = supervisionWriteDisabledReason({
      actionType: 'continue',
      actionId: q.continueActionId,
    });
    var qBusy = qActionInFlight || !live || refreshing;
    $btnQSkip.disabled = qBusy || !!skipReason || !hasOpaqueActionId(q.skipActionId);
    $btnQContinue.disabled = qBusy || !!continueReason || q.continueDisabled || !hasOpaqueActionId(q.continueActionId);
    $btnQSkip.title = skipReason;
    $btnQContinue.title = continueReason;

    var activeQuestionNumber = '';
    var focusedLetter = '';
    var scrollTop = $questionnaireQuestions.scrollTop;
    if (document.activeElement && $questionnaireQuestions.contains(document.activeElement)) {
      focusedLetter = document.activeElement.dataset.letter || '';
      activeQuestionNumber = document.activeElement.dataset.questionNumber || '';
    }

    $questionnaireQuestions.innerHTML = '';
    for (var i = 0; i < q.questions.length; i++) {
      var question = q.questions[i];
      var qDiv = document.createElement('div');
      qDiv.className = 'questionnaire-question' + (question.isActive ? ' questionnaire-question-active' : '');

      var labelDiv = document.createElement('div');
      labelDiv.className = 'questionnaire-question-label';
      var numSpan = document.createElement('span');
      numSpan.className = 'questionnaire-question-number';
      numSpan.textContent = question.number;
      var textSpan = document.createElement('span');
      textSpan.textContent = question.text;
      labelDiv.appendChild(numSpan);
      labelDiv.appendChild(textSpan);
      qDiv.appendChild(labelDiv);

      var optionsDiv = document.createElement('div');
      optionsDiv.className = 'questionnaire-options';
      optionsDiv.setAttribute('role', 'radiogroup');
      optionsDiv.setAttribute('aria-label', question.text || ('Question ' + question.number));
      var serverSelectedLetter = '';
      for (var s = 0; s < question.options.length; s++) {
        if (question.options[s].selected === true) {
          serverSelectedLetter = question.options[s].letter;
          break;
        }
      }
      if (serverSelectedLetter) delete questionnaireOptimistic[question.number];
      for (var j = 0; j < question.options.length; j++) {
        var opt = question.options[j];
        var optBtn = document.createElement('button');
        var isSelected = opt.selected === true
          || (!serverSelectedLetter && questionnaireOptimistic[question.number] === opt.letter);
        optBtn.type = 'button';
        optBtn.setAttribute('role', 'radio');
        optBtn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        optBtn.className = 'questionnaire-option' + (isSelected ? ' questionnaire-option-selected' : '');
        var letterSpan = document.createElement('span');
        letterSpan.className = 'questionnaire-option-letter';
        letterSpan.textContent = opt.letter + ')';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = ' ' + opt.label;
        optBtn.appendChild(letterSpan);
        optBtn.appendChild(labelSpan);
        if (hasOpaqueActionId(opt.actionId)) {
          optBtn.dataset.actionId = opt.actionId;
        } else {
          optBtn.disabled = true;
          optBtn.title = 'Action authorization is unavailable; refresh CursorRemote';
        }
        var optReason = supervisionWriteDisabledReason({
          actionType: 'questionnaire_option',
          actionId: opt.actionId,
        });
        if (optReason) {
          optBtn.disabled = true;
          optBtn.title = optReason;
        }
        if (qBusy) optBtn.disabled = true;
        optBtn.dataset.questionNumber = question.number;
        optBtn.dataset.letter = opt.letter;
        optBtn.dataset.label = opt.label;
        optBtn.addEventListener('click', function() {
          if (!hasOpaqueActionId(this.dataset.actionId)) return;
          if (!isSocketLive() || qActionInFlight || questionnaireNullHoldTimer || questionnaireAwaitingSnapshot) return;
          if (supervisionWriteDisabledReason({
            actionType: 'questionnaire_option',
            actionId: this.dataset.actionId,
          })) return;
          questionnaireOptimistic[this.dataset.questionNumber] = this.dataset.letter;
          var siblings = this.parentNode.querySelectorAll('.questionnaire-option');
          for (var sib = 0; sib < siblings.length; sib++) {
            siblings[sib].classList.remove('questionnaire-option-selected');
            siblings[sib].setAttribute('aria-checked', 'false');
          }
          this.classList.add('questionnaire-option-selected');
          this.setAttribute('aria-checked', 'true');
          void submitQuestionnaireAction('questionnaire_option', this.dataset.actionId, this.dataset.questionNumber);
        });
        optionsDiv.appendChild(optBtn);
      }
      qDiv.appendChild(optionsDiv);
      $questionnaireQuestions.appendChild(qDiv);
    }

    $questionnaireQuestions.scrollTop = scrollTop;
    if (activeQuestionNumber && focusedLetter) {
      var restore = $questionnaireQuestions.querySelector(
        '.questionnaire-option[data-question-number="' + activeQuestionNumber + '"][data-letter="' + focusedLetter + '"]'
      );
      if (restore && typeof restore.focus === 'function') restore.focus();
    }

    fireNotification('Agent has questions for you', 'cursor-questionnaire');
  }

  function findMatchingApprovedIssue(composerId, actionType, actionId) {
    if (!supervisionState || !Array.isArray(supervisionState.issues) || !actionType) return null;
    return supervisionState.issues.find((issue) => {
      if (!issue || issue.status !== 'pending' || issue.decision !== 'approved') return false;
      if (issue.composerId !== composerId) return false;
      if (issue.actionType !== actionType) return false;
      if (actionId && issue.actionId !== actionId) return false;
      return true;
    }) || null;
  }

  function isCursorWriteRoute(route) {
    return SUPERVISED_WRITE_ROUTES.has(route) || SUPERVISOR_DENIED_ROUTES.has(route);
  }

  function cursorMutationBlockedReason(eventName, payload) {
    const route = socketRoute(eventName);
    if (supervisionContextPending && isCursorWriteRoute(route)) {
      return 'Waiting to confirm supervision context.';
    }
    if (!supervisionState) return '';
    if (SUPERVISOR_DENIED_ROUTES.has(route)) {
      return 'This action is outside this supervision grant';
    }
    if (SUPERVISED_WRITE_ROUTES.has(route)) {
      return supervisionWriteDisabledReason({
        actionType: route === 'click_action' ? (payload && payload.actionType) : route,
        actionId: payload && payload.actionId,
        composerId: (payload && payload.composerId) || state.activeComposerId,
      });
    }
    return '';
  }

  function supervisionWriteDisabledReason(context) {
    if (supervisionContextPending) return 'Waiting to confirm supervision context.';
    const snapshot = supervisionState;
    const grant = snapshot && snapshot.grant;
    if (!grant) return '';
    if (grant.status !== 'active') return 'Supervision is awaiting recovery or no longer active.';
    if (snapshot.workspaceMatches === false) return 'The observed workspace no longer matches this authorization.';
    const reasons = Array.isArray(grant.pauseReasons) ? grant.pauseReasons : [];
    const blocking = reasons.filter((reason) => reason !== 'pending_issue');
    if (blocking.length > 0) return 'Supervision is paused: ' + blocking.join(', ');
    if (reasons.includes('pending_issue')) {
      const actionType = context && context.actionType;
      if (!actionType) return 'An issue is waiting for a bound human decision.';
      const composerId = (context && context.composerId) || state.activeComposerId;
      const approved = findMatchingApprovedIssue(composerId, actionType, context && context.actionId);
      if (!approved) return 'An issue is waiting for a bound human decision.';
    }
    return '';
  }

  function renderInputState() {
    const supervisionReason = supervisionWriteDisabledReason({ actionType: 'send_message' });
    $input.disabled = isSocketLive() ? (!state.inputAvailable || !!supervisionReason) : false;
    $input.title = supervisionReason;
    $btnSend.title = supervisionReason;
    $btnSend.disabled = !isSocketLive() || sendInFlight || !$input.value.trim() || $input.disabled;
    applySupervisionChrome();
  }

  function isClientForeground() {
    if (typeof document.hidden === 'boolean' && document.hidden) return false;
    if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') {
      return false;
    }
    return true;
  }

  function forgetNotificationKeys(prefix) {
    notifiedKeys.forEach(function (key) {
      if (key === prefix || key.indexOf(prefix) === 0) notifiedKeys.delete(key);
    });
  }

  function fireNotification(text, tag) {
    if (isClientForeground()) return;
    if (typeof Notification === 'undefined') return;
    var ntag = tag || 'cursor-agent';
    if (notifiedKeys.has(ntag)) return;
    notifiedKeys.add(ntag);
    if (notificationPermission === 'default') {
      Notification.requestPermission().then(function (perm) {
        notificationPermission = perm;
        if (perm === 'granted') new Notification('CursorRemote', { body: text, tag: ntag });
      });
    } else if (notificationPermission === 'granted') {
      new Notification('CursorRemote', { body: text, tag: ntag });
    }
  }

  function checkMessagesForNotifications() {
    if (isClientForeground()) return;
    var liveIds = new Set(state.messages.map(function (m) { return m.id; }));
    notifiedMessageIds.forEach(function (id) {
      if (!liveIds.has(id)) {
        notifiedMessageIds.delete(id);
        notifiedKeys.delete('cursor-action-' + id);
      }
    });
    state.messages.forEach(function (msg) {
      if (notifiedMessageIds.has(msg.id)) return;
      var text = null;

      if (msg.type === 'run_command' && msg.actions && msg.actions.length > 0) {
        text = (msg.description || 'Run command') + ': ' + (msg.command || '').substring(0, 80);
      } else if (msg.type === 'tool' && msg.actions && msg.actions.length > 0) {
        var detail = msg.details || msg.filename || '';
        text = (msg.action || 'Tool') + (detail ? ' ' + detail : '') + ' needs approval';
      }

      if (text) {
        notifiedMessageIds.add(msg.id);
        fireNotification(text, 'cursor-action-' + msg.id);
      }
    });
  }

  // --- Window rendering ---

  function renderContextBar() {
    const windows = state.windows || [];
    const tabs = state.chatTabs || [];
    const currentWindow = windows.find(w => w.id === state.activeWindowId);
    const currentTab = tabs.find(t => t.isActive);

    // Always show context bar when we have windows
    if (windows.length === 0) {
      $contextBar.classList.add('hidden');
      return;
    }
    $contextBar.classList.remove('hidden');

    // Render current window indicator
    const windowTitle = currentWindow ? (currentWindow.title || 'Cursor') : 'Cursor';
    $contextWindow.innerHTML = `<span style="font-size:11px;opacity:0.85">▣</span>${escapeHtml(windowTitle)}`;

    // Render window count
    if (windows.length > 1) {
      $contextCount.textContent = windows.length;
      $contextCount.style.display = '';
    } else {
      $contextCount.style.display = 'none';
    }

    // Render current session
    if (currentTab && currentTab.title) {
      const statusDot = getStatusDot(currentTab.status);
      $contextSession.innerHTML = `${statusDot}<span>${escapeHtml(currentTab.title)}</span>`;
      $contextSession.style.display = '';
    } else {
      $contextSession.innerHTML = '<span>No chat session</span>';
    }
  }

  function orderedSessionTabs(tabs) {
    return (tabs || [])
      .map((tab, index) => ({ tab, index }))
      .sort((a, b) => {
        const aOpen = a.tab.isOpen === true || a.tab.isActive;
        const bOpen = b.tab.isOpen === true || b.tab.isActive;
        return Number(bOpen) - Number(aOpen) || a.index - b.index;
      })
      .map((entry) => entry.tab);
  }

  function renderDrawer() {
    const windows = state.windows || [];
    const tabs = orderedSessionTabs(state.chatTabs || []);
    
    // Update hint
    const sessionCount = tabs.length;
    $drawerHint.textContent = `${windows.length} window${windows.length !== 1 ? 's' : ''} · sessions ordered as in Cursor`;

    // Clear existing content
    $drawerBody.innerHTML = '';

    windows.forEach((win) => {
      const isActive = win.id === state.activeWindowId;
      const card = document.createElement('div');
      card.className = 'window-card' + (isActive ? ' is-active' : '');

      // Window header
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'window-head';
      head.setAttribute('aria-label', (isActive ? 'Current window: ' : 'Switch to ') + (win.title || 'Cursor'));
      head.innerHTML = `
        <span class="window-icon">${isActive ? '▣' : '▢'}</span>
        <div class="window-meta">
          <div class="window-name">${escapeHtml(win.title || 'Cursor')}</div>
          ${win.workingDirectory ? `<div class="window-path">${escapeHtml(shortenPath(win.workingDirectory))}</div>` : ''}
        </div>
        <span class="window-badge ${isActive ? 'current' : 'switch'}">${isActive ? 'Current' : 'Switch'}</span>
      `;

      // Click to switch window (only for non-active windows)
      if (!isActive) {
        head.disabled = supervisionContextPending || !!supervisionState;
        head.addEventListener('click', () => {
          if (mutationSubmitInFlight.has('switch_window')) return;
          const blocked = cursorMutationBlockedReason('command:switch_window', { windowId: win.id });
          if (blocked) {
            showToast(blocked, 'error');
            return;
          }
          mutationSubmitInFlight.add('switch_window');
          try {
            const body = emitCommand('command:switch_window', {
              windowId: win.id,
            });
            if (body) {
              showToast('Switching window...', 'success');
              closeDrawer();
            }
          } finally {
            mutationSubmitInFlight.delete('switch_window');
          }
        });
      }

      card.appendChild(head);

      // Sessions list (only for current window)
      if (isActive && tabs.length > 0) {
        const sessHdr = document.createElement('div');
        sessHdr.className = 'sessions-header';
        sessHdr.innerHTML = `<span>Sessions · ${tabs.length}</span><span>Open first</span>`;
        card.appendChild(sessHdr);

        const sessList = document.createElement('div');
        sessList.className = 'sessions-list';

        tabs.forEach((tab) => {
          const row = document.createElement('button');
          row.type = 'button';
          const isOpen = tab.isOpen === true || tab.isActive;
          row.className = 'session-row'
            + (isOpen ? ' is-open' : ' is-closed')
            + (tab.isActive ? ' is-active' : '');
          row.dataset.sessionOpen = String(isOpen);
          row.dataset.sessionActive = String(Boolean(tab.isActive));
          
          const statusDot = getStatusDot(tab.status);
          const statusText = getStatusText(tab.status);
          const availabilityLabel = tab.isActive ? 'Current' : (isOpen ? 'Open' : 'History');
          row.setAttribute('aria-label', `${tab.title || 'Untitled Chat'}, ${availabilityLabel}`);
          row.disabled = supervisionContextPending || !!supervisionState;
          
          row.innerHTML = `
            ${statusDot}
            <div class="session-body">
              <div class="session-title">${escapeHtml(tab.title || 'Untitled Chat')}</div>
              <div class="session-sub">
                <span class="session-availability">${availabilityLabel}</span>
                <span class="sep">·</span>
                <span class="session-state ${statusText.class}">${statusText.label}</span>
              </div>
            </div>
          `;

          row.addEventListener('click', () => {
            if (mutationSubmitInFlight.has('switch_tab')) return;
            const blocked = cursorMutationBlockedReason('command:switch_tab', { tabTitle: tab.title });
            if (blocked) {
              showToast(blocked, 'error');
              return;
            }
            mutationSubmitInFlight.add('switch_tab');
            try {
              const body = emitCommand('command:switch_tab', {
                tabTitle: tab.title,
              });
              if (body) closeDrawer();
            } finally {
              mutationSubmitInFlight.delete('switch_tab');
            }
          });

          sessList.appendChild(row);
        });

        card.appendChild(sessList);
      } else if (!isActive) {
        // Collapsed state for non-current windows
        const collapsed = document.createElement('div');
        collapsed.className = 'window-collapsed';
        collapsed.innerHTML = '<span class="dot" style="width:6px;height:6px;background:var(--text-quaternary)"></span>Tap to switch — sessions load after switching';
        card.appendChild(collapsed);
      }

      $drawerBody.appendChild(card);
    });
  }

  function getStatusDot(status) {
    const colors = {
      active: 'var(--accent-blue)',
      running: 'var(--accent-yellow)',
      completed: 'var(--accent-green)',
      error: 'var(--accent-red)',
      idle: 'var(--text-quaternary)'
    };
    const color = colors[status] || colors.idle;
    return `<span class="dot" style="width:8px;height:8px;background:${color}"></span>`;
  }

  function getStatusText(status) {
    const map = {
      active: { label: 'Active', class: 'active' },
      running: { label: 'Running', class: 'running' },
      completed: { label: 'Completed', class: 'done' },
      error: { label: 'Error', class: 'error' },
      idle: { label: 'Idle', class: 'idle' }
    };
    return map[status] || map.idle;
  }

  function shortenPath(path) {
    if (!path) return '';
    const home = '/Users/';
    const homeIdx = path.indexOf(home);
    if (homeIdx !== -1) {
      const after = path.substring(homeIdx + home.length);
      const nextSlash = after.indexOf('/');
      if (nextSlash !== -1) {
        return '~/' + after.substring(nextSlash + 1);
      }
    }
    return path;
  }

  function closeTransientUi(except) {
    if (except !== 'system' && systemLayer && systemLayer.isOpen()) systemLayer.close();
    if (except !== 'drawer' && drawerLayer && drawerLayer.isOpen()) drawerLayer.close();
    if (except !== 'questionnaire' && questionnaireLayer && questionnaireLayer.isOpen()) questionnaireLayer.close();
    if (except !== 'sheet') closeSheet();
    if (except !== 'plan') closePlanModal();
  }

  function openSystemPanel() {
    closeTransientUi('system');
    systemLayer.open($btnSystem);
  }

  function closeSystemPanel() {
    systemLayer.close();
  }

  function openDrawer() {
    renderDrawer();
    closeTransientUi('drawer');
    drawerLayer.open($contextMain);
  }

  function closeDrawer() {
    drawerLayer.close();
  }

  function openQuestionnaireSheet() {
    if ($questionnaireBar.classList.contains('hidden')) return;
    closeTransientUi('questionnaire');
    questionnaireLayer.open($questionnaireTrigger);
  }

  function closeQuestionnaireSheet() {
    questionnaireLayer.close();
  }

  // Unified render function (replaces renderWindows + renderTabs)
  function renderWindowsAndSessions() {
    renderContextBar();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Mode / Model rendering ---

  // Cursor exposes mode icons as either displayable glyphs (for example, "∞")
  // or Codicon CSS class names. The web client does not load Cursor's private
  // Codicon font, so class names must not be rendered as visible text.
  function displayableModeIcon(icon) {
    const value = String(icon || '').trim();
    if (!value) return '';
    if (/^(?:codicon(?:-[\w-]+)?\s*)+$/i.test(value)) return '';
    if (/^[a-z][a-z0-9_-]*$/i.test(value)) return '';
    return value;
  }

  const CAPABILITY_PILL_STATES = ['ok', 'changed', 'stale', 'degraded', 'unknown', 'unavailable', 'partial', 'awaiting'];

  function applyPillPresentation(el, kind, enabled, stateLabel, completeness) {
    const catalogCount = kind === 'mode' ? observedModes().length : observedModels().length;
    const visualState = !capabilityLive
      ? 'stale'
      : (awaitingCapabilityFull ? 'awaiting' : stateLabel);
    el.disabled = !enabled;
    el.classList.toggle('disabled', !enabled);
    el.setAttribute('aria-disabled', String(!enabled));
    el.dataset.capabilityKind = kind;
    el.dataset.capabilityState = visualState;
    el.dataset.completeness = completeness;
    el.dataset.mutation = enabled ? 'enabled' : 'locked';
    el.dataset.catalog = catalogCount > 0 ? 'present' : 'empty';
    el.dataset.awaitingFull = awaitingCapabilityFull ? 'true' : 'false';
    for (const name of CAPABILITY_PILL_STATES) el.classList.remove('pill-' + name);
    el.classList.add('pill-' + visualState);
    if (kind === 'model' && completeness === 'partial' && visualState !== 'partial') {
      el.classList.add('pill-partial');
    }
  }

  function renderModeModel() {
    const statusLabel = capabilityStatusState();
    const completeness = capabilityModelCompleteness();
    const modeSupervisionReason = supervisionWriteDisabledReason({ actionType: 'set_mode' });
    const modelSupervisionReason = supervisionWriteDisabledReason({ actionType: 'set_model' });
    const modeEnabled = isModeMutationEnabled() && !modeSupervisionReason;
    const modelEnabled = isModelMutationEnabled() && !modelSupervisionReason;

    const currentMode = observedModes().find((mode) => mode.current)
      || observedModes().find((mode) => mode.id === state.mode?.current);
    const modeLabel = currentMode?.label || currentMode?.id || state.mode?.current || 'Mode unavailable';
    const modeIcon = displayableModeIcon(currentMode?.icon);

    const currentModel = observedModels().find((model) => model.selected && model.scope === 'composer');
    const modelLabel = currentModel?.label || currentModel?.id || state.model?.current || 'Model unavailable';

    applyPillPresentation($pillMode, 'mode', modeEnabled, statusLabel, completeness);
    applyPillPresentation($pillModel, 'model', modelEnabled, statusLabel, completeness);
    $pillMode.setAttribute('aria-label', modeEnabled ? 'Select mode' : `Mode ${statusLabel}`);
    $pillModel.setAttribute('aria-label', modelEnabled ? 'Select model' : `Model ${statusLabel}, completeness ${completeness}`);

    $pillMode.title = modeSupervisionReason || (modeEnabled
      ? `Mode capability: ${statusLabel}`
      : `Mode capability: ${statusLabel} — unavailable`);
    $pillModel.title = modelSupervisionReason || (modelEnabled
      ? `Model capability: ${statusLabel}`
      : `Model capability: ${statusLabel}/${completeness} — unavailable`);
    $pillModeIcon.textContent = modeIcon;
    $pillModeText.textContent = modeLabel;
    $pillModelText.textContent = modelLabel;

    if ($modeModelStatus && $modeModelStatusText && $btnModeModelRefresh) {
      const waiting = !capabilityLive || awaitingCapabilityFull || !capabilityState;
      const unavailable = !modeEnabled || !modelEnabled;
      $modeModelStatus.hidden = !unavailable;
      if (unavailable) {
        if (waiting) {
          $modeModelStatusText.textContent = capabilityLive
            ? 'Waiting for this window’s verified capabilities.'
            : 'Mode and model controls are locked while the relay reconnects.';
        } else if (statusLabel === 'stale') {
          $modeModelStatusText.textContent = 'This window changed or reconnected. Refresh its capabilities to unlock Mode and Model.';
        } else if (statusLabel === 'ok' || statusLabel === 'changed') {
          $modeModelStatusText.textContent = completeness !== 'complete'
            ? 'The model list is not fully verified. Refresh capabilities to unlock Model.'
            : 'No verified selectable Mode or Model is available for this window.';
        } else {
          $modeModelStatusText.textContent = `Capabilities are ${statusLabel}. Refresh them before changing Mode or Model.`;
        }
        $btnModeModelRefresh.hidden = waiting;
      } else {
        $modeModelStatusText.textContent = '';
        $btnModeModelRefresh.hidden = true;
      }
    }

    if (activeSheet === 'mode' && !modeEnabled) closeSheet();
    else if (activeSheet === 'model' && !modelEnabled) closeSheet();
    applySupervisionChrome();
  }

  renderAll();

  // --- Bottom sheet logic ---

  function openSheet(type) {
    if (type === 'mode' && supervisionWriteDisabledReason({ actionType: 'set_mode' })) return;
    if (type === 'model' && supervisionWriteDisabledReason({ actionType: 'set_model' })) return;
    if (type === 'plan-model' && supervisionWriteDisabledReason({ actionType: 'set_plan_model' })) return;
    if (type === 'mode' && !isModeMutationEnabled()) return;
    if (type === 'model' && !isModelMutationEnabled()) return;
    closeTransientUi('sheet');
    closeSheet();
    activeSheet = type;

    if (type === 'mode') {
      renderModeSheet();
      modeLayer.open($pillMode);
    } else if (type === 'model') {
      if (cachedModelOptions) {
        renderModelSheet(cachedModelOptions);
      } else {
        renderModelSheetLoading();
      }
      modelLayer.open($pillModel);
      fetchModelOptions().then(options => {
        if (activeSheet !== 'model') return;
        if (options) {
          renderModelSheet(options);
        } else if (!cachedModelOptions) {
          renderModelSheet(null);
        }
      });
    } else if (type === 'plan-model') {
      renderPlanModelSheet();
      planModelLayer.open();
    }
  }

  function closeSheet() {
    if (modeLayer && modeLayer.isOpen()) modeLayer.close();
    if (modelLayer && modelLayer.isOpen()) modelLayer.close();
    if (planModelLayer && planModelLayer.isOpen()) planModelLayer.close();
    activeSheet = null;
  }

  function renderModeSheet() {
    $sheetModeList.innerHTML = '';
    const modes = Array.isArray(state.mode?.available) ? state.mode.available : [];
    const current = (state.mode || {}).current || '';

    if (modes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'Modes unavailable';
      $sheetModeList.appendChild(empty);
      return;
    }

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-item' + (m.id === current ? ' selected' : '');
      btn.setAttribute('aria-selected', String(m.id === current));

      const icon = displayableModeIcon(m.icon);
      if (icon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'sheet-item-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = icon;
        btn.appendChild(iconEl);
      }

      const label = document.createElement('span');
      label.className = 'sheet-item-label';
      label.textContent = m.label || m.id;
      btn.appendChild(label);

      const right = document.createElement('span');
      right.className = 'sheet-item-right';
      if (m.id === current) {
        const check = document.createElement('span');
        check.className = 'sheet-item-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';
        right.appendChild(check);
      }
      btn.appendChild(right);

      btn.addEventListener('click', () => {
        if (mutationSubmitInFlight.has('set_mode')) return;
        if (!isModeMutationEnabled()) return;
        const blocked = cursorMutationBlockedReason('command:set_mode', { modeId: m.id });
        if (blocked) {
          showToast(blocked, 'error');
          return;
        }
        mutationSubmitInFlight.add('set_mode');
        try {
          const body = emitCommand('command:set_mode', { modeId: m.id });
          if (body) {
            closeSheet();
            showToast(`Mode: ${m.label || m.id}`, 'success');
          }
        } finally {
          mutationSubmitInFlight.delete('set_mode');
        }
      });
      $sheetModeList.appendChild(btn);
    });
  }

  async function fetchModelOptions() {
    if (!isModelMutationEnabled()) return null;
    if (supervisionContextPending || supervisionState) {
      const observed = selectableComposerModels().map((model) => ({
        id: model.id,
        label: model.label || model.id,
        selected: !!model.selected,
      }));
      if (observed.length > 0) {
        cachedModelOptions = observed;
        return observed;
      }
      return cachedModelOptions;
    }
    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_model_options', {
      commandId,
      type: 'get_model_options',
    });
    if (!isModelMutationEnabled()) return null;
    if (result.ok && Array.isArray(result.data?.options)) {
      cachedModelOptions = result.data.options;
      return result.data.options;
    }
    return null;
  }

  function renderModelSheet(options) {
    $sheetModelList.innerHTML = '';

    if (!options || options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      const completeness = capabilityState?.models?.completeness || 'unknown';
      empty.textContent = completeness === 'unknown'
        ? 'Model list unavailable — refresh after opening the model menu'
        : completeness === 'partial' ? 'Model list is partial — scroll or refresh in Cursor' : 'No models available';
      $sheetModelList.appendChild(empty);
      return;
    }

    const currentId = ((state.model || {}).currentId || '');
    const currentName = ((state.model || {}).current || '').toLowerCase();

    options.forEach(opt => {
      const isSelected = (currentId && opt.id === currentId) || opt.selected ||
        currentName === opt.label.toLowerCase();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-item' + (isSelected ? ' selected' : '');

      let inner = '<span class="sheet-item-label">' + escapeHtml(opt.label) + '</span>';
      const right = [];
      if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
      inner += '<span class="sheet-item-right">' + right.join('') + '</span>';

      btn.innerHTML = inner;
      btn.addEventListener('click', () => {
        if (mutationSubmitInFlight.has('set_model')) return;
        if (!isModelMutationEnabled()) return;
        const blocked = cursorMutationBlockedReason('command:set_model', { modelId: opt.id });
        if (blocked) {
          showToast(blocked, 'error');
          return;
        }
        mutationSubmitInFlight.add('set_model');
        try {
          const body = emitCommand('command:set_model', { modelId: opt.id });
          if (body) {
            closeSheet();
            showToast(`Model: ${opt.label}`, 'success');
          }
        } finally {
          mutationSubmitInFlight.delete('set_model');
        }
      });
      $sheetModelList.appendChild(btn);
    });
  }

  function renderModelSheetLoading() {
    $sheetModelList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sheet-loading';
    loading.textContent = 'Loading models…';
    $sheetModelList.appendChild(loading);
  }

  function renderPlanModelSheet() {
    $sheetPlanModelList.innerHTML = '';
    const ctx = activePlanModelContext;
    $sheetPlanModelHeader.textContent = ctx && ctx.title ? `Plan Model · ${ctx.title}` : 'Plan Model';
    if (!ctx || !Array.isArray(ctx.options) || ctx.options.length === 0) return;

    ctx.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-item' + (opt.selected ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-label">${escapeHtml(opt.label)}</span>` +
        `<span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ''}</span>`;
      btn.addEventListener('click', async () => {
        if (mutationSubmitInFlight.has('set_plan_model')) return;
        if (!hasOpaqueActionId(ctx.actionId) || !opt.id) return;
        const blocked = cursorMutationBlockedReason('command:set_plan_model', {
          actionId: ctx.actionId,
          planModelId: opt.id,
        });
        if (blocked) {
          showToast(blocked, 'error');
          return;
        }
        mutationSubmitInFlight.add('set_plan_model');
        try {
          const result = await sendCommandAwaitResult('command:set_plan_model', {
            commandId: newCommandId(),
            type: 'set_plan_model',
            actionId: ctx.actionId,
            planModelId: opt.id,
          });
          if (!result.ok) {
            showToast(result.error || 'Could not set plan model', 'error');
            return;
          }
          closeSheet();
          showToast(`Plan model: ${opt.label}`, 'success');
        } finally {
          mutationSubmitInFlight.delete('set_plan_model');
        }
      });
      $sheetPlanModelList.appendChild(btn);
    });
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    $toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  } // end bootstrap

  init();
})();
