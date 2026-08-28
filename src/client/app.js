/* global io */

(function () {
  'use strict';

  const AUTH_TOKEN_KEY = 'cursor-remote-token';
  const THEME_KEY = 'cursor-remote-theme';
  const THEME_COLOR_LIGHT = '#f7f8fa';
  const THEME_COLOR_DARK = '#141414';

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
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
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

  async function checkAuth() {
    try {
      const res = await fetch('/health', {
        credentials: 'same-origin',
        headers: getAuthHeaders(),
      });
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
    if (!await checkAuth()) return;
    bootstrap();
  }

  function bootstrap() {

  let state = { ...defaultState };

  let userScrolledUp = false;
  let autoScrollJob = 0;
  let notificationPermission =
    typeof Notification !== 'undefined' && Notification.permission
      ? Notification.permission
      : 'default';
  const notifiedMessageIds = new Set();
  const notifiedKeys = new Set();
  let activePlanModal = null;
  let activePlanModelContext = null;
  const pendingCommandResults = new Map();

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
  const $headerRight = document.querySelector('#header .header-right');
  const $approvalBar = document.getElementById('approval-bar');
  const $approvalDesc = document.getElementById('approval-desc');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnReject = document.getElementById('btn-reject');
  var questionnaireSelections = {};
  const $questionnaireBar = document.getElementById('questionnaire-bar');
  const $questionnaireStepper = document.getElementById('questionnaire-stepper');
  const $questionnaireQuestions = document.getElementById('questionnaire-questions');
  const $btnQSkip = document.getElementById('btn-q-skip');
  const $btnQContinue = document.getElementById('btn-q-continue');
  const $input = document.getElementById('message-input');
  const $btnSend = document.getElementById('btn-send');
  const $toastContainer = document.getElementById('toast-container');

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

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    withCredentials: true,
    auth: (cb) => {
      try {
        cb({ token: getAuthToken() || '' });
      } catch {
        cb({ token: '' });
      }
    },
  });

  function sendCommandAwaitResult(eventName, payload) {
    return new Promise((resolve) => {
      const commandId = payload.commandId;
      const timer = setTimeout(() => {
        pendingCommandResults.delete(commandId);
        resolve({ commandId, ok: false, error: 'Command timed out' });
      }, 12000);

      pendingCommandResults.set(commandId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      socket.emit(eventName, payload);
    });
  }

  socket.on('connect', () => {
    renderConnectionStatus();
    renderInputState();
  });
  socket.on('disconnect', () => {
    renderConnectionStatus();
    renderInputState();
  });

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
    state = { ...defaultState, ...newState };
    renderAll();
  });

  socket.on('state:patch', (patch) => {
    Object.assign(state, patch);
    applyStatePatch(patch);
  });

  socket.on('connection:status', (data) => {
    state.connected = data.connected;
    renderConnectionStatus();
    renderInputState();
  });

  socket.on('command:result', (result) => {
    const pending = pendingCommandResults.get(result.commandId);
    if (pending) {
      pendingCommandResults.delete(result.commandId);
      pending(result);
      return;
    }
    if (!result.ok) showToast(result.error || 'Command failed', 'error');
  });

  $messages.addEventListener('scroll', () => {
    autoScrollJob++;
    userScrolledUp = !isNearMessagesBottom();
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    $btnSend.disabled = !$input.value.trim();
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

  $btnApprove.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
    if (!action) return;
    socket.emit('command:approve', {
      commandId: newCommandId(),
      approvalId: approval.id,
      selectorPath: action.selectorPath,
    });
    showToast('Approve sent', 'success');
  });

  $btnReject.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'reject');
    if (!action) return;
    socket.emit('command:reject', {
      commandId: newCommandId(),
      approvalId: approval.id,
      selectorPath: action.selectorPath,
    });
    showToast('Reject sent', 'success');
  });

  $btnQSkip.addEventListener('click', () => {
    if (!state.questionnaire) return;
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath: state.questionnaire.skipSelectorPath,
      actionLabel: 'Skip',
    });
    showToast('Skip sent', 'success');
  });

  $btnQContinue.addEventListener('click', () => {
    if (!state.questionnaire || state.questionnaire.continueDisabled) return;
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath: state.questionnaire.continueSelectorPath,
      actionLabel: 'Continue',
    });
    showToast('Continue sent', 'success');
  });

  $btnNewChat.addEventListener('click', () => {
    socket.emit('command:new_chat', { commandId: newCommandId() });
    showToast('Creating new chat...', 'success');
  });

  $contextMain.addEventListener('click', openDrawer);
  $drawerClose.addEventListener('click', closeDrawer);
  $drawerOverlay.addEventListener('click', closeDrawer);

  $pillMode.addEventListener('click', () => openSheet('mode'));
  $pillModel.addEventListener('click', () => openSheet('model'));
  $sheetOverlay.addEventListener('click', closeSheet);
  $planModalClose.addEventListener('click', closePlanModal);
  $planModalOverlay.addEventListener('click', (e) => {
    if (e.target === $planModalOverlay) closePlanModal();
  });

  function sendMessage() {
    const text = $input.value.trim();
    if (!text) return;
    socket.emit('command:send_message', { commandId: newCommandId(), text });
    $input.value = '';
    $input.style.height = 'auto';
    $btnSend.disabled = true;
    showToast('Message sent', 'success');
  }

  function renderAll() {
    renderConnectionStatus();
    renderAgentStatus();
    renderComposerQueue();
    renderWindowsAndSessions();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderInputState();
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
    if (
      has('agentStatus') ||
      has('agentActivityText') ||
      has('agentActivityLive') ||
      has('agentActivitySource')
    ) {
      renderAgentStatus();
    }
    if (has('composerQueue')) renderComposerQueue();
    if (has('windows') || has('activeWindowId') || has('chatTabs')) renderWindowsAndSessions();
    if (has('messages')) renderMessages();
    if (has('pendingApprovals')) renderApprovals();
    if (has('questionnaire')) renderQuestionnaire();
    if (has('mode') || has('model')) renderModeModel();
    if (has('messages') || has('mode') || has('model')) syncPlanModalFromState();
  }

  function renderConnectionStatus() {
    const ui = getConnectionUiState();
    updateConnectionUI(ui.status, ui.label);
    if (state.messages.length === 0) {
      $emptyState.style.display = '';
      $emptyPrimary.textContent = ui.emptyPrimary;
      $emptyHint.innerHTML = ui.emptyHint;
    }
  }

  function updateConnectionUI(status, label) {
    $connDot.className = 'dot ' + status;
    const labels = { connected: 'Connected', disconnected: 'Disconnected', reconnecting: 'Connecting...' };
    $connText.textContent = label || labels[status] || status;
  }

  function getConnectionUiState() {
    const lastError = (state.lastExtractionError || '').trim();
    const timeoutLike = /timeout/i.test(lastError);

    if (!socket.connected) {
      return {
        status: 'disconnected',
        label: 'Relay disconnected',
        emptyPrimary: 'Waiting for relay connection...',
        emptyHint: 'Check that this page can reach the CursorRemote server.',
      };
    }

    if (!state.connected) {
      return {
        status: 'reconnecting',
        label: 'Waiting for Cursor',
        emptyPrimary: 'Connecting to Cursor IDE...',
        emptyHint: 'Make sure Cursor is running with<br><code>--remote-debugging-port=9222</code>',
      };
    }

    if (state.extractorStatus === 'stale') {
      return {
        status: 'reconnecting',
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
        label: 'Waiting for snapshot',
        emptyPrimary: 'Connected to Cursor, waiting for the first snapshot...',
        emptyHint: lastError
          ? ('Last extractor error:<br><code>' + escapeHtml(lastError) + '</code>')
          : 'The relay is connected to Cursor but has not captured a fresh DOM snapshot yet.',
      };
    }

    return {
      status: 'connected',
      label: 'Connected',
      emptyPrimary: 'No messages in this chat yet.',
      emptyHint: 'Send a message below or switch chat tab / window in Cursor.',
    };
  }

  function renderAgentStatus() {
    const icons = {
      idle: '',
      thinking: '',
      generating: '',
      running_tool: '',
      waiting_approval: '!',
      error: '\u2715',
    };
    const labels = {
      idle: 'Idle', thinking: 'Thinking...', generating: 'Generating...',
      running_tool: 'Running tool...', waiting_approval: 'Needs approval', error: 'Error',
    };
    $statusIcon.textContent = icons[state.agentStatus] || '';
    const activity = (state.agentActivityText || '').trim();
    const activityLive = !!state.agentActivityLive;
    const baseLabel = labels[state.agentStatus] || state.agentStatus;
    if ($headerRight) {
      if (state.agentStatus !== 'idle') $headerRight.classList.remove('header-right-hidden');
      else $headerRight.classList.add('header-right-hidden');
    }
    if (activityLive && activity && state.agentStatus !== 'idle') {
      const max = 56;
      $statusText.textContent = activity.length > max ? activity.slice(0, max - 1) + '…' : activity;
      $statusText.classList.add('agent-status-shimmer');
    } else {
      $statusText.textContent = baseLabel;
      $statusText.classList.remove('agent-status-shimmer');
    }

    if (state.agentStatus === 'waiting_approval') $statusText.style.color = 'var(--accent-yellow)';
    else if (state.agentStatus === 'error') $statusText.style.color = 'var(--accent-red)';
    else $statusText.style.color = '';
  }

  function renderComposerQueue() {
    const bar = document.getElementById('composer-queue-bar');
    const labelEl = document.getElementById('composer-queue-label');
    const itemsEl = document.getElementById('composer-queue-items');
    if (!bar || !labelEl || !itemsEl) return;
    const q = state.composerQueue && Array.isArray(state.composerQueue.items)
      ? state.composerQueue
      : { items: [] };
    if (q.items.length === 0) {
      bar.classList.add('hidden');
      itemsEl.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
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

  function createToolEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-tool';
    el.dataset.id = msg.id;

    const line = document.createElement('div');
    line.className = 'tool-line ' + msg.status;

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
    line.appendChild(icon);

    if (msg.summaryText) {
      const summary = document.createElement('span');
      summary.className = 'tool-summary';
      summary.textContent = msg.summaryText;
      line.appendChild(summary);
    } else {
      if (msg.action) {
        const action = document.createElement('span');
        action.className = 'tool-action';
        action.textContent = msg.action;
        line.appendChild(action);
      }
      if (msg.details) {
        const details = document.createElement('span');
        details.className = 'tool-details';
        details.textContent = msg.details;
        line.appendChild(details);
      }
    }

    if (msg.filename || msg.additions != null || msg.deletions != null) {
      const fileInfo = document.createElement('span');
      fileInfo.className = 'tool-file-info';

      if (msg.filename) {
        const fn = document.createElement('span');
        fn.className = 'tool-filename';
        fn.textContent = msg.filename;
        fileInfo.appendChild(fn);
      }
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

      line.appendChild(fileInfo);
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
    if (msg.thoughtKind === 'step_summary') {
      const a = (msg.action || '').trim();
      return detail ? `${a || 'Steps'} — ${detail}` : (a || 'Steps');
    }
    if (msg.thoughtKind === 'thinking_step') {
      const a = (msg.action || '').trim();
      if (dur) return `${a || 'Step'} · ${dur}`;
      if (a) {
        if (/^thought$/i.test(a)) return 'Thought';
        if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, '')}…`;
        return a;
      }
      return 'Thinking…';
    }
    if (dur) return `Thought for ${dur}`;
    const action = (msg.action || '').trim();
    if (action) {
      if (/^thought$/i.test(action)) return 'Thought';
      if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
      return action;
    }
    return 'Thinking…';
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

  function emitClickAction(selectorPath, actionLabel) {
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath,
      actionLabel,
    });
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

  function buildPlanModalContent(msg, planData) {
    if (planData) return buildPlanFullContent(planData);
    const modalMsg = {
      ...msg,
      actions: Array.isArray(msg.actions)
        ? msg.actions.filter((action) => action.type !== 'view_plan')
        : msg.actions,
    };
    const content = buildPlanCard(modalMsg);
    content.classList.add('plan-card-modal');
    return content;
  }

  function renderPlanModal(msg) {
    if (!msg) return;
    $planModalLabel.textContent = msg.label || '';
    $planModalLabel.style.display = msg.label ? '' : 'none';
    $planModalTitle.textContent = msg.title || 'Plan';
    $planModalBody.innerHTML = '';
    $planModalBody.appendChild(buildPlanModalContent(msg, activePlanModal && activePlanModal.fullData));
  }

  async function loadFullPlanIntoModal(msg) {
    if (!msg.label || !activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = true;
    const result = await sendCommandAwaitResult('command:get_plan_full', {
      commandId: newCommandId(),
      type: 'get_plan_full',
      planLabel: msg.label,
    });
    if (!activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = false;
    if (!result.ok || !result.data) return;
    activePlanModal.fullData = result.data;
    renderPlanModal(msg);
  }

  function openPlanModal(msg) {
    activePlanModal = { id: msg.id, label: msg.label || '', fullData: null, loading: false };
    renderPlanModal(msg);
    $planModalOverlay.classList.remove('hidden');
    loadFullPlanIntoModal(msg);
  }

  function closePlanModal() {
    activePlanModal = null;
    $planModalOverlay.classList.add('hidden');
  }

  function syncPlanModalFromState() {
    if (!activePlanModal) return;
    const current = (state.messages || []).find((msg) => msg.type === 'plan' && msg.id === activePlanModal.id);
    if (current) {
      renderPlanModal(current);
      if (current.label && !activePlanModal.fullData && !activePlanModal.loading) {
        loadFullPlanIntoModal(current);
      }
    }
  }

  async function openPlanModelPicker(msg) {
    if (!msg.modelDropdownSelectorPath) {
      if (msg.model) showToast(`Plan model: ${msg.model}`, 'success');
      return;
    }

    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_plan_model_options', {
      commandId,
      type: 'get_plan_model_options',
      selectorPath: msg.modelDropdownSelectorPath,
    });

    const options = Array.isArray(result.data?.options) ? result.data.options : [];
    if (!result.ok || options.length === 0) {
      emitClickAction(msg.modelDropdownSelectorPath);
      if (!result.ok) showToast(result.error || 'Could not load plan models', 'error');
      return;
    }

    activePlanModelContext = {
      selectorPath: msg.modelDropdownSelectorPath,
      title: msg.title || 'Plan',
      options,
    };
    openSheet('plan-model');
  }

  function buildPlanCard(msg) {
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

    const hasActions = (msg.actions && msg.actions.length > 0) || msg.modelDropdownSelectorPath || msg.model;
    if (hasActions) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plan-actions-toolbar';

      const left = document.createElement('div');
      left.className = 'plan-actions-left';
      if (msg.actions) {
        const viewAct = msg.actions.find((a) => a.type === 'view_plan');
        if (viewAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-view';
          btn.textContent = viewAct.label || 'View Plan';
          btn.addEventListener('click', () => openPlanModal(msg));
          left.appendChild(btn);
        }
      }
      toolbar.appendChild(left);

      const center = document.createElement('div');
      center.className = 'plan-actions-center';
      if (msg.modelDropdownSelectorPath) {
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
        pill.addEventListener('click', () => { void openPlanModelPicker(msg); });
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
          btn.addEventListener('click', () => emitClickAction(buildAct.selectorPath, buildAct.label || 'Build'));
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
      btn.addEventListener('click', function () {
        socket.emit('command:click_action', {
          commandId: newCommandId(),
          selectorPath: action.selectorPath,
          actionLabel: action.label,
        });
      });
      container.appendChild(btn);
    });
  }

  function createRunCommandEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-run-command';
    el.dataset.id = msg.id;

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

  function renderApprovals() {
    if (state.pendingApprovals.length > 0) {
      $approvalBar.classList.remove('hidden');
      const approval = state.pendingApprovals[0];
      $approvalDesc.textContent = approval.description || 'Action needs approval';

      const approveAction = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
      const rejectAction = approval.actions.find(a => a.type === 'reject');

      $btnApprove.disabled = !approveAction;
      $btnReject.disabled = !rejectAction;
      if (approveAction) $btnApprove.textContent = approveAction.label || 'Accept';
      if (rejectAction) $btnReject.textContent = rejectAction.label || 'Reject';

      fireNotification(
        approval.description || 'Agent needs approval',
        'cursor-approval:' + (approval.id || 'pending')
      );
    } else {
      $approvalBar.classList.add('hidden');
      forgetNotificationKeys('cursor-approval:');
    }
  }

  function renderQuestionnaire() {
    var q = state.questionnaire;
    if (!q || !q.questions || q.questions.length === 0) {
      $questionnaireBar.classList.add('hidden');
      questionnaireSelections = {};
      forgetNotificationKeys('cursor-questionnaire');
      return;
    }
    $questionnaireBar.classList.remove('hidden');
    $questionnaireStepper.textContent = q.totalLabel || '';
    $btnQContinue.disabled = q.continueDisabled;

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
      for (var j = 0; j < question.options.length; j++) {
        var opt = question.options[j];
        var optBtn = document.createElement('button');
        var isSelected = questionnaireSelections[question.number] === opt.letter;
        optBtn.className = 'questionnaire-option' + (isSelected ? ' questionnaire-option-selected' : '');
        var letterSpan = document.createElement('span');
        letterSpan.className = 'questionnaire-option-letter';
        letterSpan.textContent = opt.letter + ')';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = ' ' + opt.label;
        optBtn.appendChild(letterSpan);
        optBtn.appendChild(labelSpan);
        optBtn.dataset.selectorPath = opt.selectorPath;
        optBtn.dataset.questionNumber = question.number;
        optBtn.dataset.letter = opt.letter;
        optBtn.dataset.label = opt.label;
        optBtn.addEventListener('click', function() {
          questionnaireSelections[this.dataset.questionNumber] = this.dataset.letter;
          var siblings = this.parentNode.querySelectorAll('.questionnaire-option');
          for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('questionnaire-option-selected');
          this.classList.add('questionnaire-option-selected');
          socket.emit('command:click_action', {
            commandId: newCommandId(),
            selectorPath: this.dataset.selectorPath,
            actionLabel: this.dataset.label,
          });
          showToast('Answer sent', 'success');
        });
        optionsDiv.appendChild(optBtn);
      }
      qDiv.appendChild(optionsDiv);
      $questionnaireQuestions.appendChild(qDiv);
    }

    fireNotification('Agent has questions for you', 'cursor-questionnaire');
  }

  function renderInputState() {
    $input.disabled = !state.inputAvailable && !state.connected;
    $btnSend.disabled = !$input.value.trim() || $input.disabled;
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

  function renderDrawer() {
    const windows = state.windows || [];
    const tabs = state.chatTabs || [];
    
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
      const head = document.createElement('div');
      head.className = 'window-head';
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
        head.addEventListener('click', () => {
          socket.emit('command:switch_window', {
            commandId: newCommandId(),
            windowId: win.id,
          });
          showToast('Switching window...', 'success');
          closeDrawer();
        });
      }

      card.appendChild(head);

      // Sessions list (only for current window)
      if (isActive && tabs.length > 0) {
        const sessHdr = document.createElement('div');
        sessHdr.className = 'sessions-header';
        sessHdr.innerHTML = `<span>Sessions · ${tabs.length}</span><span>Array order</span>`;
        card.appendChild(sessHdr);

        const sessList = document.createElement('div');
        sessList.className = 'sessions-list';

        tabs.forEach((tab) => {
          const row = document.createElement('div');
          row.className = 'session-row' + (tab.isActive ? ' is-active' : '');
          
          const statusDot = getStatusDot(tab.status);
          const statusText = getStatusText(tab.status);
          
          row.innerHTML = `
            ${statusDot}
            <div class="session-body">
              <div class="session-title">${escapeHtml(tab.title || 'Untitled Chat')}</div>
              <div class="session-sub">
                <span class="session-state ${statusText.class}">${statusText.label}</span>
              </div>
            </div>
          `;

          row.addEventListener('click', () => {
            socket.emit('command:switch_tab', {
              commandId: newCommandId(),
              tabTitle: tab.title,
              selectorPath: tab.selectorPath,
            });
            closeDrawer();
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

  function openDrawer() {
    renderDrawer();
    $drawer.classList.remove('hidden');
    $drawerOverlay.classList.remove('hidden');
  }

  function closeDrawer() {
    $drawer.classList.add('hidden');
    $drawerOverlay.classList.add('hidden');
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

  const MODE_ICONS = {
    agent: '\u221E',
    plan: '\u2611',
    debug: '\uD83D\uDC1B',
    chat: '\uD83D\uDCAC',
  };

  const MODE_LABELS = {
    agent: 'Agent',
    plan: 'Plan',
    debug: 'Debug',
    chat: 'Ask',
  };

  function renderModeModel() {
    const mode = state.mode || { current: 'agent', available: [] };
    const model = state.model || { current: 'Auto', currentId: '' };

    $pillModeIcon.textContent = MODE_ICONS[mode.current] || '';
    $pillModeText.textContent = MODE_LABELS[mode.current] || mode.current;
    $pillModelText.textContent = model.current || 'Auto';
  }

  renderAll();

  // --- Bottom sheet logic ---

  let activeSheet = null;

  function openSheet(type) {
    closeSheet();
    activeSheet = type;
    $sheetOverlay.classList.remove('hidden');

    if (type === 'mode') {
      $sheetMode.classList.remove('hidden');
      renderModeSheet();
    } else if (type === 'model') {
      $sheetModel.classList.remove('hidden');
      if (cachedModelOptions) {
        renderModelSheet(cachedModelOptions);
      } else {
        renderModelSheetLoading();
      }
      fetchModelOptions().then(options => {
        if (activeSheet !== 'model') return;
        if (options) {
          renderModelSheet(options);
        } else if (!cachedModelOptions) {
          renderModelSheet(null);
        }
      });
    } else if (type === 'plan-model') {
      $sheetPlanModel.classList.remove('hidden');
      renderPlanModelSheet();
    }
  }

  function closeSheet() {
    $sheetOverlay.classList.add('hidden');
    $sheetMode.classList.add('hidden');
    $sheetModel.classList.add('hidden');
    $sheetPlanModel.classList.add('hidden');
    activeSheet = null;
  }

  function renderModeSheet() {
    $sheetModeList.innerHTML = '';
    const modes = [
      { id: 'agent', label: 'Agent', icon: '\u221E' },
      { id: 'plan', label: 'Plan', icon: '\u2611' },
      { id: 'debug', label: 'Debug', icon: '\uD83D\uDC1B' },
      { id: 'chat', label: 'Ask', icon: '\uD83D\uDCAC' },
    ];
    const current = (state.mode || {}).current || 'agent';

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (m.id === current ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-icon">${m.icon}</span>` +
        `<span>${escapeHtml(m.label)}</span>` +
        (m.id === current ? '<span class="sheet-item-check">\u2713</span>' : '');
      btn.addEventListener('click', () => {
        socket.emit('command:set_mode', { commandId: newCommandId(), modeId: m.id });
        closeSheet();
        showToast(`Mode: ${m.label}`, 'success');
      });
      $sheetModeList.appendChild(btn);
    });
  }

  let cachedModelOptions = null;

  async function fetchModelOptions() {
    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_model_options', {
      commandId,
      type: 'get_model_options',
    });
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
      empty.textContent = 'No models available';
      $sheetModelList.appendChild(empty);
      return;
    }

    const currentId = ((state.model || {}).currentId || '');
    const currentName = ((state.model || {}).current || '').toLowerCase();

    options.forEach(opt => {
      const isSelected = (currentId && opt.id === currentId) || opt.selected ||
        currentName === opt.label.toLowerCase();
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (isSelected ? ' selected' : '');

      let inner = '<span class="sheet-item-label">' + escapeHtml(opt.label) + '</span>';
      const right = [];
      if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
      inner += '<span class="sheet-item-right">' + right.join('') + '</span>';

      btn.innerHTML = inner;
      btn.addEventListener('click', () => {
        socket.emit('command:set_model', { commandId: newCommandId(), modelId: opt.id });
        closeSheet();
        showToast(`Model: ${opt.label}`, 'success');
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
      btn.className = 'sheet-item' + (opt.selected ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-label">${escapeHtml(opt.label)}</span>` +
        `<span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ''}</span>`;
      btn.addEventListener('click', async () => {
        const result = await sendCommandAwaitResult('command:set_plan_model', {
          commandId: newCommandId(),
          type: 'set_plan_model',
          selectorPath: ctx.selectorPath,
          planModelId: opt.id,
        });
        if (!result.ok) {
          showToast(result.error || 'Could not set plan model', 'error');
          return;
        }
        closeSheet();
        showToast(`Plan model: ${opt.label}`, 'success');
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
