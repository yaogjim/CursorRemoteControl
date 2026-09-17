import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { readFileSync } from 'fs';
import type {
  ServerConfig,
  CursorState,
  CommandPayload,
  CommandResult,
  PlanBlock,
  PlanFullData,
  PlanDiscoveryData,
  SanitizedDiscoveryStatus,
  PlanFailureCode,
  PlanFailureStage,
  SupervisionGrant,
  WorkspaceIdentity,
} from './types.js';
import { AdapterStore } from './adapter-store.js';
import { ActionRegistry } from './action-registry.js';
import { capabilityAllows } from './capability-guard.js';
import { toPublicCapabilityFull } from './capability-state-manager.js';
import { normalizeModel } from './capability-normalize.js';
import { RuntimeValidator } from './runtime-validator.js';
import type { RuntimeSelectorProvider, RuntimeAdapterContext } from './runtime-selector-provider.js';
import { toPublicPatch, toPublicState, type StateManager } from './state-manager.js';
import type { CommandExecutor, CommandDispatchOptions } from './command-executor.js';
import type { CdpClient } from './cdp-client.js';
import type { CDPBridge } from './cdp-bridge.js';
import type { CapabilityStateManager } from './capability-state-manager.js';
import { TargetUiCoordinator } from './target-ui-coordinator.js';
import { moveHomeWindow, type WindowMonitor } from './window-monitor.js';
import { markdownToWebHtml, readPlanFileResult, type PlanFileReadError } from './plan-files.js';
import {
  attachPlanFailure,
  diagnosePlanGuardFailure,
  planFailResult,
  planRequestedTarget,
  sanitizePlanFailure,
  type PlanGuardSnapshot,
} from './plan-command-failure.js';
import {
  WEBAPP_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SEC,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';
import { getRuntimeIdentity } from './runtime-identity.js';
import { SupervisionError, SupervisionManager } from './supervision-manager.js';
import { canReadUnderSupervision } from './supervision-policy.js';
import { OperationJournal } from './operation-journal.js';
import { ScopedCommandService, type ScopedCommandRequest } from './scoped-command-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const CSRF_COOKIE = 'cursor_remote_csrf';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const ACTION_TYPE_RE = /^[a-z][a-z0-9_:-]{0,63}$/;
export const SENSITIVE_PROBE_RATE_MAX = 5;
export const SENSITIVE_ADAPTER_RATE_MAX = 20;
export const SENSITIVE_RATE_WINDOW_MS = 60_000;
export const SOCKET_DANGEROUS_RATE_MAX = 20;
export const SOCKET_DANGEROUS_RATE_WINDOW_MS = 60_000;
export const API_JSON_LIMIT_BYTES = 64 * 1024;
export const SOCKET_MAX_HTTP_BUFFER_SIZE = API_JSON_LIMIT_BYTES;
const LOGIN_RATE_MAX = 10;
const LOGIN_RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 2048;
const MAX_OPERATION_CACHE = 1024;
const OPERATION_CACHE_TTL_MS = 5 * 60_000;
const PLAN_REFERENCE_TTL_MS = 5 * 60_000;
const SUPERVISION_IDENTITY_FRESH_MS = 15_000;
const API_JSON_LIMIT = '64kb';

/** Dedicated socket events that mutate Cursor and require a bounded operationId. */
export const DANGEROUS_SOCKET_COMMANDS = new Set([
  'send_message',
  'approve',
  'approve_all',
  'reject',
  'new_chat',
  'set_mode',
  'set_model',
  'set_plan_model',
]);

/** click_action types that share the dangerous-command operation/rate contract. */
export const DANGEROUS_ACTION_TYPES = new Set([
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

export function isValidActionType(value: unknown): value is string {
  return typeof value === 'string' && ACTION_TYPE_RE.test(value);
}

export function socketCommandRequiresOperationId(command: string, actionType?: string): boolean {
  if (DANGEROUS_SOCKET_COMMANDS.has(command)) return true;
  return command === 'click_action' && typeof actionType === 'string' && DANGEROUS_ACTION_TYPES.has(actionType);
}

export function currentPlanLabel(state: CursorState, planId: unknown): string | null {
  if (typeof planId !== 'string' || planId.length === 0) return null;
  const plan = state.messages.find((message): message is PlanBlock => message.type === 'plan' && message.id === planId);
  const label = plan && typeof plan.label === 'string' ? plan.label.trim() : '';
  return label || null;
}

function planFileErrorMessage(error: PlanFileReadError): string {
  if (error === 'not_found') return 'Plan file not found';
  if (error === 'too_large') return 'Plan file is too large';
  if (error === 'invalid_path' || error === 'not_regular_file') return 'Plan file is not safe to read';
  return 'Plan file could not be read';
}

function commandIdOf(payload: { commandId?: unknown } | undefined): string {
  return typeof payload?.commandId === 'string' && payload.commandId.length > 0 ? payload.commandId : 'unknown';
}

function parseCookieMap(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index >= 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ['', ''];
  }).filter(([key]) => key));
}

function csrfSetCookie(token: string, maxAgeSec = SESSION_COOKIE_MAX_AGE_SEC): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function sessionSetCookie(token: string, maxAgeSec: number): string {
  return [
    `${WEBAPP_SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

type OwnerPrincipal = { role: 'owner'; token?: string };
type SupervisorPrincipal = { role: 'supervisor'; token: string; grant: SupervisionGrant; expiresAt: number };
type RelayPrincipal = OwnerPrincipal | SupervisorPrincipal;

function workspaceIdentitiesEqual(
  a: WorkspaceIdentity | null | undefined,
  b: WorkspaceIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.id === b.id
    && a.uri.scheme === b.uri.scheme
    && a.uri.authority === b.uri.authority
    && a.uri.path === b.uri.path;
}

function isSupervisorForbiddenApi(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/api/capabilities')) return true;
  if (path.startsWith('/api/discovery')) return true;
  if (path.startsWith('/api/adapters')) return true;
  if (path.startsWith('/api/supervision/grants')) return true;
  return false;
}

function uniqueStringIds(values: unknown): string[] | null {
  if (!Array.isArray(values)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0) return null;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function isIdSubset(write: string[], read: string[]): boolean {
  const allowed = new Set(read);
  return write.every((id) => allowed.has(id));
}

function sendApiError(req: express.Request, res: express.Response, status: number, error: string): void {
  if (!req.readableEnded) req.resume();
  res.status(status).json({ error });
}

function jsonBodyErrorHandler(
  err: unknown,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const rec = err && typeof err === 'object'
    ? err as { type?: string; status?: number; statusCode?: number }
    : null;
  const type = rec?.type;
  const status = rec?.status ?? rec?.statusCode;
  if (type === 'entity.too.large' || status === 413) {
    sendApiError(req, res, 413, 'Payload too large');
    return;
  }
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && status === 400)) {
    sendApiError(req, res, 400, 'Invalid JSON');
    return;
  }
  next(err);
}

function csrfTokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function requestPathname(req: express.Request): string {
  const raw = req.originalUrl || req.url || req.path || '';
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

/** Discovery/validate are probes; apply/reject/rollback mutate adapter state. Login is excluded. */
export function sensitiveWriteKind(method: string, pathname: string): 'probe' | 'adapter' | null {
  if (method !== 'POST') return null;
  const path = pathname.replace(/\/+$/, '') || '/';
  const rel = path.startsWith('/api/') ? path.slice(4) : path;
  if (rel === '/discovery/run') return 'probe';
  if (/^\/adapters\/[^/]+\/validate$/.test(rel)) return 'probe';
  if (rel === '/adapters/rollback') return 'adapter';
  if (/^\/adapters\/[^/]+\/(?:apply|reject)$/.test(rel)) return 'adapter';
  return null;
}

function sensitiveRouteKey(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  const rel = path.startsWith('/api/') ? path.slice(4) : path;
  if (rel === '/discovery/run') return 'POST /api/discovery/run';
  if (rel === '/adapters/rollback') return 'POST /api/adapters/rollback';
  if (/^\/adapters\/[^/]+\/validate$/.test(rel)) return 'POST /api/adapters/validate';
  if (/^\/adapters\/[^/]+\/apply$/.test(rel)) return 'POST /api/adapters/apply';
  if (/^\/adapters\/[^/]+\/reject$/.test(rel)) return 'POST /api/adapters/reject';
  return `POST ${path}`;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Fixed-size sliding-window limiter. Expired keys are pruned; overflow evicts the soonest reset. */
class BoundedRateLimiter {
  private readonly buckets = new Map<string, RateLimitEntry>();

  constructor(private readonly maxKeys: number) {}

  check(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfter: number } {
    this.prune(now);
    const entry = this.buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      this.evictIfNeeded(now);
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (entry.count >= limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true, retryAfter: 0 };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(key);
    }
  }

  private evictIfNeeded(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    this.prune(now);
    if (this.buckets.size < this.maxKeys) return;
    let oldestKey: string | undefined;
    let oldestReset = Infinity;
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt < oldestReset) {
        oldestReset = entry.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

interface OperationCacheEntry {
  fingerprint: string;
  settled: boolean;
  status: number;
  body: unknown;
  expiresAt: number;
  done: Promise<{ status: number; body: unknown }>;
}

/** Replay protection for HTTP mutations. The operation id is client-generated,
 * while the request fingerprint prevents reusing it for another operation. */
export function operationFingerprint(method: string, path: string, body: unknown): string {
  const normalized = body && typeof body === 'object' ? { ...(body as Record<string, unknown>), operationId: undefined } : body;
  return createHash('sha256').update(`${method} ${path}\n${JSON.stringify(normalized)}`).digest('hex');
}

/** Bind hosts that only accept local connections — password-optional. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

/** Direct peer address (do not use X-Forwarded-For — it is attacker-controlled). */
export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export function isAllowedSocketOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined
): boolean {
  if (typeof originHeader !== 'string' || originHeader.length === 0) return true;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  try {
    const origin = new URL(originHeader);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    return origin.host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

export function isAllowedHttpOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): boolean {
  return isAllowedSocketOrigin(originHeader, hostHeader);
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en" class="login-html" data-theme="system">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#f7f8fa">
  <title>CursorRemote - Login</title>
  <script>
    (function () {
      var KEY = 'cursor-remote-theme';
      var t = 'system';
      try {
        var s = localStorage.getItem(KEY);
        if (s === 'light' || s === 'dark' || s === 'system') t = s;
      } catch (e) {}
      document.documentElement.dataset.theme = t;
      function syncThemeColor() {
        var pref = document.documentElement.dataset.theme;
        var dark = pref === 'dark';
        if (!dark && pref === 'system') {
          try {
            dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
          } catch (e2) {}
        }
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', dark ? '#141414' : '#f7f8fa');
      }
      syncThemeColor();
      try {
        var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', syncThemeColor);
        else if (mq && typeof mq.addListener === 'function') mq.addListener(syncThemeColor);
      } catch (e3) {}
    })();
  </script>
  <link rel="stylesheet" href="styles.css">
</head>
<body class="login-page">
  <form class="login-card" id="form">
    <h1>CursorRemote</h1>
    <p class="subtitle">Enter password to continue</p>
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
    <button type="submit" id="btn">Sign in</button>
    <p class="error" id="err"></p>
  </form>
  <script>
    const form = document.getElementById('form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-remote-token', data.token);
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Invalid password';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

function adapterScopeSelector(scope: string | undefined): string | undefined {
  switch (scope) {
    case 'composer': return '.composer-bar, [data-composer-id]';
    case 'plan': return '.composer-create-plan-container, .plan-execution-message-content';
    case 'tool': return '[data-tool-call-id], .ui-tool-call-card';
    case 'approval': return '.ui-shell-tool-call__approval-row, .ui-shell-tool-call';
    default: return undefined;
  }
}

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;
  private windowMonitor: WindowMonitor | undefined;
  private capabilityStateManager: CapabilityStateManager | undefined;
  private targetUiCoordinator: TargetUiCoordinator | undefined;
  private adapterStore: AdapterStore;
  private runtimeSelectors: RuntimeSelectorProvider | undefined;
  private actionRegistry: ActionRegistry;
  private discoveryRunner: (() => Promise<unknown>) | null = null;
  private runtimeValidator = new RuntimeValidator();

  private sessionStore: WebappSessionStore;
  private supervisionManager: SupervisionManager;
  private operationJournal: OperationJournal;
  private scopedCommandService: ScopedCommandService;
  private rateLimiter = new BoundedRateLimiter(MAX_RATE_LIMIT_KEYS);
  private operationCache = new Map<string, OperationCacheEntry>();
  private socketOperationCache = new Map<string, OperationCacheEntry>();
  // 仅跨越 await 到最终响应发送的校验；不缓存计划正文或结果。
  private readonly planResultGuards = new WeakMap<CommandResult, () => boolean>();
  private readonly runtimeIdentity = getRuntimeIdentity();
  private supervisionCheckTimer: ReturnType<typeof setInterval> | null = null;

  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  /** Bound TCP port after `start()`, or the configured port before listen. */
  get port(): number {
    const addr = this.httpServer.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.serverPort;
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge,
    windowMonitor?: WindowMonitor,
    capabilityStateManager?: CapabilityStateManager,
    actionRegistry?: ActionRegistry,
    adapterStore?: AdapterStore,
    targetUiCoordinator?: TargetUiCoordinator,
    runtimeSelectors?: RuntimeSelectorProvider
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.windowMonitor = windowMonitor;
    this.capabilityStateManager = capabilityStateManager;
    this.targetUiCoordinator = targetUiCoordinator;
    this.adapterStore = adapterStore ?? new AdapterStore(config.adapterStorePath, { backupCount: config.adapterBackupCount });
    this.runtimeSelectors = runtimeSelectors;
    this.actionRegistry = actionRegistry ?? new ActionRegistry({ ttlMs: config.actionTtlMs });
    this.sessionStore = createWebappSessionStore(config.dataDir);
    this.supervisionManager = new SupervisionManager({ dataDir: config.dataDir });
    this.operationJournal = new OperationJournal({ dataDir: config.dataDir });
    this.scopedCommandService = new ScopedCommandService({
      journal: this.operationJournal,
      supervisionManager: this.supervisionManager,
      getContext: () => {
        const state = this.stateManager.getCurrentState();
        const targetId = this.cdpBridge.activeTargetId;
        return {
          workspace: this.getObservedWorkspaceIdentity(state),
          state,
          activeTargetId: targetId,
          targetGeneration: targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0,
          getDraftPresent: () => this.commandExecutor.hasComposerDraftNow(),
          hasAction: (actionId: string) => this.stateContainsAction(this.stateManager.getCurrentState(), actionId),
        };
      },
    });
    const setHumanTakeoverHandler = (this.commandExecutor as {
      setHumanTakeoverHandler?: (handler: (() => void | Promise<void>) | null) => void;
    }).setHumanTakeoverHandler;
    if (typeof setHumanTakeoverHandler === 'function') {
      setHumanTakeoverHandler.call(this.commandExecutor, () => this.ownerTakeover());
    }
    const bridgeEvents = this.cdpBridge as unknown as {
      on?: (event: string, listener: (workspace: WorkspaceIdentity | null) => void) => void;
    };
    bridgeEvents.on?.('willSwitchWindow', (workspace) => this.ownerTakeover(workspace));

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
      // Same-origin only: do not reflect arbitrary Origin (credentials + origin:true
      // would allow any site to read Socket.IO responses). Cross-origin WS is
      // rejected in allowRequest via Origin vs Host.
      cors: {
        origin: false,
        methods: ['GET', 'POST'],
      },
      allowRequest: (req: IncomingMessage, cb) => {
        const origin = req.headers.origin;
        const host = req.headers.host;
        cb(
          null,
          isAllowedSocketOrigin(
            typeof origin === 'string' ? origin : undefined,
            typeof host === 'string' ? host : undefined
          )
        );
      },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.authEnabled) {
      console.log('[relay] Web app password protection enabled');
    }
  }

  setDiscoveryRunner(runner: (() => Promise<unknown>) | null): void {
    this.discoveryRunner = runner;
  }

  getActionRegistry(): ActionRegistry { return this.actionRegistry; }

  private requireAdapterContext(body: Record<string, unknown>): RuntimeAdapterContext {
    const context = this.runtimeSelectors?.getContext();
    const targetId = this.cdpBridge.activeTargetId;
    const generation = targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0;
    if (!context || !targetId || !generation
      || context.targetId !== targetId || context.targetGeneration !== generation) {
      throw new Error('verified runtime adapter context required');
    }
    if (body.cursorVersionRange !== context.cursorBuild
      || body.endpointFingerprint !== context.endpointFingerprint
      || body.domSignature !== context.domSignature) {
      throw new Error('adapter context does not match the active Cursor build and DOM fingerprint');
    }
    return context;
  }

  private async validateAdapterRuntime(adapter: Awaited<ReturnType<AdapterStore['get']>>): Promise<Array<{ key:string; ok:boolean; visibleCount:number; error?:string }>> {
    if (!adapter) throw new Error('adapter not found');
    const runtime: Array<{ key:string; ok:boolean; visibleCount:number; error?:string }> = [];
    for (const [key, strategies] of Object.entries(adapter.strategies)) {
      const scope = adapterScopeSelector(strategies[0]?.scope);
      const checked = await this.withActiveTargetUi('adapter:validate', (client) =>
        this.runtimeValidator.validateCandidate(client, strategies.map((strategy) => strategy.selector), scope));
      runtime.push({ key, ok:checked.ok, visibleCount:checked.visibleCount, ...(checked.error ? {error:checked.error} : {}) });
    }
    return runtime;
  }

  private async withActiveTargetUi<T>(
    label: string,
    operation: (client: CdpClient) => Promise<T>,
  ): Promise<T> {
    const client = this.cdpBridge.getClient();
    const targetId = this.cdpBridge.activeTargetId;
    const generation = targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0;
    if (!client || !targetId || !generation || !client.isConnected()) {
      throw new Error('verified Cursor target required');
    }
    if (!this.targetUiCoordinator) throw new Error('Target UI coordinator unavailable');
    return this.targetUiCoordinator.enqueue(
      targetId,
      async () => {
        const result = await operation(client);
        if (targetId !== this.cdpBridge.activeTargetId || generation !== this.cdpBridge.getTargetGeneration(targetId)) {
          throw new Error('Target generation changed');
        }
        return result;
      },
      { generation, timeoutMs: 10_000, label },
    );
  }

  notifyAdapterPending(adapter: { id: string; status: string; capabilityKinds: string[]; createdAt: number }): void {
    this.emitOwnerEvent('adapter:pending', {
      id: adapter.id,
      status: adapter.status,
      capabilityKinds: adapter.capabilityKinds,
      createdAt: adapter.createdAt,
    });
  }

  start(): Promise<void> {
    if (!this.authEnabled && !isLoopbackBindHost(this.config.serverHost)) {
      const msg =
        `Refusing to listen on ${this.config.serverHost}:${this.config.serverPort} without a web app password. ` +
        `Set WEBAPP_PASSWORD (or cursorRemote.webappPassword) or bind to 127.0.0.1.`;
      console.error(`[relay] ${msg}`);
      return Promise.reject(new Error(msg));
    }

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        this.httpServer.off('error', onError);
        console.log(
          `[relay] Server listening on http://${this.config.serverHost}:${this.port}`
        );
        if (!this.supervisionCheckTimer) {
          this.supervisionCheckTimer = setInterval(() => {
            try {
              const overdue = this.supervisionManager.markOverdueChecks();
              if (overdue.length > 0) this.emitOwnerSupervisionState();
            } catch (err) {
              console.warn(`[relay] Supervision check expiry failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }, 1_000);
          this.supervisionCheckTimer.unref?.();
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.sessionStore.flush();
    if (this.supervisionCheckTimer) {
      clearInterval(this.supervisionCheckTimer);
      this.supervisionCheckTimer = null;
    }
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getClientIp(req: express.Request): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  private pruneOperationCache(now: number, cache: Map<string, OperationCacheEntry> = this.operationCache): void {
    for (const [key, value] of cache) {
      if (value.settled && value.expiresAt <= now) cache.delete(key);
    }
    while (cache.size >= MAX_OPERATION_CACHE) {
      let oldestKey: string | undefined;
      let oldestExp = Infinity;
      for (const [key, value] of cache) {
        if (!value.settled) continue;
        if (value.expiresAt < oldestExp) {
          oldestExp = value.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  /** First matching credential that exists in the persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.touch(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.touch(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.touch(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.touch(fromCookie)) return fromCookie;
    return undefined;
  }

  private extractCredentialTokens(authHeader: unknown, cookieHeader: unknown): string[] {
    const tokens: string[] = [];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (t) tokens.push(t);
    }
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE,
    );
    if (fromCookie) tokens.push(fromCookie);
    return tokens;
  }

  private classifyCredential(token: string): RelayPrincipal | null {
    if (this.sessionStore.touch(token)) return { role: 'owner', token };
    const ctx = this.supervisionManager.authenticate(token);
    if (!ctx) return null;
    return { role: 'supervisor', token, grant: ctx.grant, expiresAt: ctx.expiresAt };
  }

  private resolvePrincipalFromTokens(tokens: string[]): RelayPrincipal | null {
    let supervisor: SupervisorPrincipal | null = null;
    for (const token of tokens) {
      const classified = this.classifyCredential(token);
      if (classified?.role === 'owner') return classified;
      if (classified?.role === 'supervisor' && !supervisor) supervisor = classified;
    }
    if (supervisor) return supervisor;
    if (!this.authEnabled) return { role: 'owner' };
    return null;
  }

  private resolveHttpPrincipal(req: express.Request): RelayPrincipal | null {
    return this.resolvePrincipalFromTokens(this.extractCredentialTokens(req.headers.authorization, req.headers.cookie));
  }

  private resolveSocketPrincipal(socket: Socket): RelayPrincipal | null {
    const raw = socket.handshake.auth?.token;
    const stored = typeof socket.data?.supervisorToken === 'string' ? socket.data.supervisorToken : undefined;
    const tokens = this.extractCredentialTokens(
      typeof raw === 'string' && raw.trim() ? `Bearer ${raw.trim()}` : undefined,
      socket.handshake.headers.cookie,
    );
    if (stored && !tokens.includes(stored)) tokens.push(stored);
    return this.resolvePrincipalFromTokens(tokens);
  }

  private liveSocketPrincipal(socket: Socket): RelayPrincipal | null {
    if (socket.data?.principalRole === 'supervisor') {
      const token = typeof socket.data.supervisorToken === 'string' ? socket.data.supervisorToken : '';
      if (!token) return this.resolveSocketPrincipal(socket);
      const ctx = this.supervisionManager.authenticate(token);
      if (!ctx) return null;
      return { role: 'supervisor', token, grant: ctx.grant, expiresAt: ctx.expiresAt };
    }
    return this.resolveSocketPrincipal(socket);
  }

  private rememberSocketPrincipal(socket: Socket, principal: RelayPrincipal): void {
    socket.data.principalRole = principal.role;
    if (principal.role === 'supervisor') {
      socket.data.supervisorToken = principal.token;
      socket.data.supervisionGrantId = principal.grant.grantId;
      return;
    }
    socket.data.supervisorToken = undefined;
    socket.data.supervisionGrantId = undefined;
  }

  private cookieMaxAgeSec(principal: RelayPrincipal | null | undefined): number {
    if (principal?.role === 'supervisor') {
      return Math.max(0, Math.floor((Math.min(principal.expiresAt, principal.grant.expiresAt) - Date.now()) / 1000));
    }
    return SESSION_COOKIE_MAX_AGE_SEC;
  }

  /** Identity observed with the latest DOM state; never fall back to a stale target title or connect-time value. */
  private getObservedWorkspaceIdentity(state = this.stateManager.getCurrentState()): WorkspaceIdentity | null {
    const observedAt = state.lastExtractionAt;
    if (typeof observedAt !== 'number' || Date.now() - observedAt > SUPERVISION_IDENTITY_FRESH_MS) return null;
    const identity = state._workspaceIdentity;
    if (!identity || typeof identity.id !== 'string' || !identity.uri) return null;
    return identity;
  }

  private listedComposerIds(): Set<string> {
    const state = this.stateManager.getCurrentState();
    const ids = new Set<string>();
    for (const tab of state.chatTabs ?? []) {
      if (typeof tab.composerId === 'string' && tab.composerId.length > 0) ids.add(tab.composerId);
    }
    if (state.activeComposerId) ids.add(state.activeComposerId);
    return ids;
  }

  private filterStateForSupervisor(state: CursorState, grant: SupervisionGrant): CursorState {
    const publicState = toPublicState(state);
    const emptyState: CursorState = {
      connected: false,
      extractorStatus: 'idle',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      chatTabs: [],
      windows: [],
      messages: [],
      pendingApprovals: [],
      composerQueue: { items: [] },
      questionnaire: null,
      activeComposerId: '',
      activeWindowId: '',
      inputAvailable: false,
      mode: { current: '', available: [] },
      model: { current: '', currentId: '' },
    };
    const identity = this.getObservedWorkspaceIdentity(state);
    if (!workspaceIdentitiesEqual(identity, grant.workspace)) return emptyState;

    const scopedEmpty: CursorState = {
      ...emptyState,
      connected: publicState.connected,
      extractorStatus: publicState.extractorStatus,
      lastExtractionAt: publicState.lastExtractionAt,
      consecutiveExtractionFailures: publicState.consecutiveExtractionFailures,
    };
    const chatTabs = publicState.chatTabs.filter((tab) => canReadUnderSupervision(grant, tab.composerId));
    const current = publicState.windows.find((window) => window.id === publicState.activeWindowId);
    const windows = current
      ? [{ id: current.id, title: current.title } as CursorState['windows'][number]]
      : [];
    const activeReadable = canReadUnderSupervision(grant, publicState.activeComposerId);
    if (!activeReadable) {
      return { ...scopedEmpty, chatTabs, windows };
    }
    return { ...publicState, lastExtractionError: null, chatTabs, windows };
  }

  private emitSupervisorState(socket: Socket, grant: SupervisionGrant): void {
    socket.emit('state:full', this.filterStateForSupervisor(this.stateManager.getCurrentState(), grant));
  }

  private emitOwnerEvent(event: string, payload: unknown): void {
    for (const socket of this.io.sockets.sockets.values()) {
      if (this.liveSocketPrincipal(socket)?.role === 'owner') socket.emit(event, payload);
    }
  }

  private disconnectGrantSockets(grantId: string): void {
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.data?.supervisionGrantId === grantId) socket.disconnect(true);
    }
  }

  private publicGrant(grant: SupervisionGrant): SupervisionGrant {
    return {
      ...grant,
      workspace: {
        id: grant.workspace.id,
        uri: {
          scheme: grant.workspace.uri.scheme,
          authority: grant.workspace.uri.authority,
          path: '',
        },
      },
    };
  }

  private supervisionSnapshot(grantId: string): Record<string, unknown> {
    const grant = this.supervisionManager.getGrant(grantId);
    if (!grant) return { grant: null, issues: [], checks: [], operations: [], observedAt: Date.now() };
    const issues = this.supervisionManager.listIssues(grantId).map((issue) => ({
      ...issue,
      workspace: this.publicGrant(grant).workspace,
    }));
    const checks = this.supervisionManager.listChecks(grantId);
    const operations = this.operationJournal.list()
      .filter((record) => record.target.grantId === grantId)
      .map((record) => ({
        operationId: record.operationId,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        target: {
          workspaceId: record.target.workspaceId,
          composerId: record.target.composerId,
          windowId: record.target.windowId,
          actionType: record.target.actionType,
          planVersion: record.target.planVersion,
          authorizationVersion: record.target.authorizationVersion,
          controlVersion: record.target.controlVersion,
        },
      }));
    const latestCheckAt = checks.reduce((value, item) => Math.max(value, item.checkedAt), grant.createdAt);
    return {
      grant: this.publicGrant(grant),
      issues,
      checks,
      operations,
      observedAt: Date.now(),
      workspaceMatches: workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(), grant.workspace),
      checkDueAt: grant.checkTtlMs > 0 ? latestCheckAt + grant.checkTtlMs : null,
    };
  }

  private emitSupervisionState(socket: Socket, grantId: string): void {
    try {
      socket.emit('supervision:state', this.supervisionSnapshot(grantId));
    } catch (err) {
      socket.emit('supervision:state', {
        grant: null,
        issues: [],
        checks: [],
        operations: [],
        observedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emitOwnerSupervisionState(): void {
    const grants = this.supervisionManager.listGrants().map((grant) => this.supervisionSnapshot(grant.grantId));
    this.emitOwnerEvent('supervision:overview', { grants, observedAt: Date.now() });
  }

  private emitAllSupervisionStates(): void {
    this.emitOwnerSupervisionState();
    for (const socket of this.io.sockets.sockets.values()) {
      const principal = this.liveSocketPrincipal(socket);
      if (principal?.role === 'supervisor') this.emitSupervisionState(socket, principal.grant.grantId);
    }
  }

  private requireOwnerPrincipal(req: express.Request, res: express.Response): boolean {
    const principal = this.resolveHttpPrincipal(req);
    if (principal?.role === 'supervisor') {
      sendApiError(req, res, 403, 'Forbidden');
      return false;
    }
    if (!this.authEnabled || principal?.role === 'owner') return true;
    if (!principal) {
      sendApiError(req, res, 401, 'Unauthorized');
      return false;
    }
    sendApiError(req, res, 403, 'Forbidden');
    return false;
  }

  private supervisionCommandDenied(socket: Socket, route: string, payload: CommandPayload): string | null {
    const principal = this.liveSocketPrincipal(socket);
    if (socket.data?.principalRole === 'supervisor' && !principal) {
      socket.disconnect(true);
      return 'Supervision scope denied';
    }
    if (!principal || principal.role === 'owner') return null;
    if (SUPERVISED_WRITE_ROUTES.has(route)) return null;
    if (route !== 'discover_plans' && route !== 'get_plan_full') return 'Supervision scope denied';
    if (!workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(), principal.grant.workspace)) {
      return 'Supervision scope denied';
    }
    const composerId = payload.composerId;
    if (typeof composerId !== 'string' || !canReadUnderSupervision(principal.grant, composerId)) {
      return 'Supervision scope denied';
    }
    if (payload.windowId !== this.stateManager.getCurrentState().activeWindowId) {
      return 'Supervision scope denied';
    }
    return null;
  }

  private ownerTakeover(workspace: WorkspaceIdentity | null = this.getObservedWorkspaceIdentity()): void {
    if (workspace) {
      this.supervisionManager.pauseWorkspace(workspace, 'human_takeover', { role: 'owner' });
    } else {
      // When the latest observed identity is stale, fail closed across all active
      // grants rather than letting supervision resume after the next extraction.
      for (const grant of this.supervisionManager.listGrants()) {
        if (grant.status === 'active') {
          this.supervisionManager.addPause(grant.grantId, 'human_takeover', { role: 'owner' });
        }
      }
    }
    // A human action wins even when the latest workspace observation is stale:
    // cancelling all definitely-unmutated records is safer than leaving an old
    // supervised operation queued for a later retry.
    this.scopedCommandService.cancelPendingForWorkspace(workspace);
    this.emitAllSupervisionStates();
  }

  private scopedWriteRequest(
    principal: SupervisorPrincipal,
    route: string,
    payload: CommandPayload,
  ): ScopedCommandRequest | null {
    const state = this.stateManager.getCurrentState();
    const operationId = payload.operationId;
    const composerId = payload.composerId;
    const windowId = payload.windowId;
    const planVersion = payload.planVersion;
    const authorizationVersion = payload.authorizationVersion;
    const controlVersion = payload.controlVersion;
    const targetId = this.cdpBridge.activeTargetId;
    const targetGeneration = targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0;
    if (
      typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)
      || typeof composerId !== 'string' || composerId.length === 0
      || typeof windowId !== 'string' || windowId.length === 0
      || typeof planVersion !== 'string' || planVersion.length === 0
      || typeof authorizationVersion !== 'string' || authorizationVersion.length === 0
      || typeof controlVersion !== 'string' || controlVersion.length === 0
      || !targetId || !targetGeneration
    ) return null;
    const actionType = route === 'click_action'
      ? payload.actionType ?? ''
      : route;
    const mode = route === 'set_mode' ? payload.modeId ?? '' : state.mode.current;
    const model = route === 'set_model'
      ? payload.modelId ?? ''
      : route === 'set_plan_model'
        ? payload.planModelId ?? ''
        : state.model.currentId || state.model.current;
    return {
      operationId,
      payloadDigest: this.socketOperationFingerprint(route, payload),
      grantId: principal.grant.grantId,
      composerId,
      windowId,
      targetId,
      targetGeneration,
      actionType,
      mode,
      model,
      planVersion,
      authorizationVersion,
      controlVersion,
      ...(typeof payload.issueId === 'string' && payload.issueId ? { issueId: payload.issueId } : {}),
      ...(typeof payload.actionId === 'string' && payload.actionId ? { actionId: payload.actionId } : {}),
      ...(typeof payload.contentDigest === 'string' && payload.contentDigest ? { contentDigest: payload.contentDigest } : {}),
    };
  }

  private async runScopedWrite(
    socket: Socket,
    route: string,
    payload: CommandPayload,
    commandId: string,
    dispatch: (options: CommandDispatchOptions) => Promise<CommandResult>,
    confirm: () => boolean | Promise<boolean>,
  ): Promise<CommandResult> {
    const principal = this.liveSocketPrincipal(socket);
    if (socket.data?.principalRole === 'supervisor' && !principal) {
      socket.disconnect(true);
      return { commandId, ok: false, error: 'Supervision scope denied' };
    }
    if (!principal || principal.role === 'owner') {
      this.ownerTakeover();
      return dispatch({});
    }
    const request = this.scopedWriteRequest(principal, route, payload);
    if (!request) return { commandId, ok: false, error: 'Supervision write scope is incomplete' };
    const result = await this.scopedCommandService.execute(request, dispatch, confirm);
    this.emitSupervisionState(socket, principal.grant.grantId);
    this.emitOwnerSupervisionState();
    return { ...result, commandId };
  }

  private async waitForState(
    predicate: (state: CursorState) => boolean,
    timeoutMs = 3_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.stateManager.getCurrentState())) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate(this.stateManager.getCurrentState());
  }

  private stateContainsAction(state: CursorState, actionId: string): boolean {
    if (!actionId) return false;
    for (const approval of state.pendingApprovals) {
      if (approval.actions.some((action) => action.actionId === actionId)) return true;
    }
    for (const message of state.messages) {
      if ('actions' in message && message.actions?.some((action) => action.actionId === actionId)) return true;
      if (message.type === 'plan' && message.modelActionId === actionId) return true;
    }
    const questionnaire = state.questionnaire;
    if (questionnaire?.skipActionId === actionId || questionnaire?.continueActionId === actionId) return true;
    return questionnaire?.questions.some((question) =>
      question.options.some((option) => option.actionId === actionId)
    ) ?? false;
  }

  /** Bind a human decision to the currently observed opaque action and target versions. */
  private currentActionDigest(
    composerId: string,
    actionType: string,
    actionId: string,
    planVersion: string,
    authorizationVersion: string,
  ): string | null {
    const state = this.stateManager.getCurrentState();
    if (state.activeComposerId !== composerId || !this.stateContainsAction(state, actionId)) return null;
    const action = this.actionRegistry.public(actionId);
    if (!action || !action.executable || action.kind !== actionType) return null;
    const targetId = this.cdpBridge.activeTargetId;
    const targetGeneration = targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0;
    if (!targetId || !targetGeneration) return null;
    return createHash('sha256').update(JSON.stringify([
      state.activeWindowId,
      composerId,
      targetId,
      targetGeneration,
      actionId,
      actionType,
      action.label,
      planVersion,
      authorizationVersion,
    ])).digest('hex');
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');
    const apiJson = express.json({ limit: API_JSON_LIMIT });

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    this.app.post('/api/login', (req, res, next) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
      if (!isAllowedHttpOrigin(origin, host)) {
        sendApiError(req, res, 403, 'Forbidden origin');
        return;
      }
      next();
    }, apiJson, (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.rateLimiter.check(
        `login:${ip}`,
        LOGIN_RATE_MAX,
        LOGIN_RATE_WINDOW_MS,
      );
      if (!allowed) {
        console.warn(`[relay] Rate limited login from ${ip}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        console.warn(`[relay] Failed login attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = randomBytes(32).toString('hex');
      const csrf = randomBytes(24).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful login from ${ip}`);
      res.setHeader('Set-Cookie', sessionSetCookie(token, SESSION_COOKIE_MAX_AGE_SEC));
      res.append('Set-Cookie', csrfSetCookie(csrf));
      return res.json({ token });
    });

    this.app.post('/api/supervision/redeem', (req, res, next) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
      if (!isAllowedHttpOrigin(origin, host)) {
        sendApiError(req, res, 403, 'Forbidden origin');
        return;
      }
      next();
    }, apiJson, (req, res) => {
      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.rateLimiter.check(
        `login:${ip}`,
        LOGIN_RATE_MAX,
        LOGIN_RATE_WINDOW_MS,
      );
      if (!allowed) {
        console.warn(`[relay] Rate limited login from ${ip}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const code = req.body?.code ?? req.body?.redeemCode;
      if (typeof code !== 'string' || code.length === 0) {
        return res.status(400).json({ error: 'Redeem code required' });
      }

      try {
        const redeemed = this.supervisionManager.redeem(code);
        const maxAgeSec = Math.max(0, Math.floor(
          (Math.min(redeemed.expiresAt, redeemed.grant.expiresAt) - Date.now()) / 1000,
        ));
        const csrf = randomBytes(24).toString('hex');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie', sessionSetCookie(redeemed.token, maxAgeSec));
        res.append('Set-Cookie', csrfSetCookie(csrf, maxAgeSec));
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof SupervisionError) {
          console.warn(`[relay] Failed supervisor redeem from ${ip}`);
          return res.status(401).json({ error: 'Invalid redeem code' });
        }
        throw err;
      }
    });

    this.app.get('/health', (req, res) => {
      const tokens = this.extractCredentialTokens(req.headers.authorization, req.headers.cookie);
      const principal = this.resolveHttpPrincipal(req);
      const sessionOk = !this.authEnabled || principal !== null;
      const failedCredentials = this.authEnabled && tokens.length > 0 && principal === null;
      const publicBody = {
        ok: true as const,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
      };
      const revealDetails =
        !failedCredentials && (
          !this.authEnabled ||
          sessionOk ||
          isLoopbackRemoteAddress(req.socket.remoteAddress)
        );
      if (!revealDetails) {
        res.json(publicBody);
        return;
      }
      const state = this.stateManager.getCurrentState();
      if (principal?.role === 'supervisor') {
        const workspaceOk = workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(state), principal.grant.workspace);
        const runtimeBody: Record<string, unknown> = {
          ...publicBody,
          version: this.runtimeIdentity.version,
          instanceId: this.runtimeIdentity.instanceId,
          startedAt: this.runtimeIdentity.startedAt,
          build: this.runtimeIdentity.build,
        };
        if (!workspaceOk) {
          res.json(runtimeBody);
          return;
        }
        const body: Record<string, unknown> = {
          ...runtimeBody,
          connected: state.connected,
          extractorStatus: state.extractorStatus,
          lastExtractionAt: state.lastExtractionAt,
          consecutiveExtractionFailures: state.consecutiveExtractionFailures,
        };
        if (canReadUnderSupervision(principal.grant, state.activeComposerId)) {
          body.activeWindowId = state.activeWindowId;
          body.activeComposerId = state.activeComposerId;
        }
        res.json(body);
        return;
      }
      res.json({
        ...publicBody,
        connected: state.connected,
        extractorStatus: state.extractorStatus,
        lastExtractionAt: state.lastExtractionAt,
        consecutiveExtractionFailures: state.consecutiveExtractionFailures,
        lastExtractionError: state.lastExtractionError,
        agentStatus: state.agentStatus,
        clients: this.io.engine.clientsCount,
        uptime: process.uptime(),
        windows: state.windows,
        activeWindowId: state.activeWindowId,
        mode: state.mode?.current ?? null,
        model: state.model?.current ?? null,
        chatTabCount: state.chatTabs?.length ?? 0,
        pendingApprovalCount: state.pendingApprovals?.length ?? 0,
        generation: this.stateManager.generation,
        version: this.runtimeIdentity.version,
        instanceId: this.runtimeIdentity.instanceId,
        startedAt: this.runtimeIdentity.startedAt,
        build: this.runtimeIdentity.build,
        activeComposerId: state.activeComposerId,
      });
    });

    this.app.get('/debug/state', (req, res) => {
      const principal = this.resolveHttpPrincipal(req);
      if (principal?.role === 'supervisor') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (this.authEnabled && !principal) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
        _rawSignals: state._rawSignals ?? null,
      });
    });

    const cacheBust = Date.now().toString(36);
    this.app.get('/', (_req, res) => {
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (err) {
        console.error(`[relay] Failed to serve index.html: ${err}`);
        res.status(500).send('Client files not found');
      }
    });

    this.app.use(express.static(clientDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));

    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpPrincipal(req)) return next();

      if (req.path.startsWith('/api/')) {
        if (!req.readableEnded) req.resume();
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);

    this.app.use('/api', (req, res, next) => {
      const principal = this.resolveHttpPrincipal(req);
      if (principal?.role === 'supervisor' && isSupervisorForbiddenApi(requestPathname(req))) {
        sendApiError(req, res, 403, 'Forbidden');
        return;
      }
      next();
    });

    // Protected writes: auth (above) → Host/Origin/CSRF/Bearer → body/size →
    // rate limit → operation reservation → handler. Cookie sessions must be
    // same-origin and send CSRF; Bearer CLI clients may omit Origin and CSRF.
    this.app.use('/api', (req, res, next) => {
      if (!WRITE_METHODS.has(req.method)) return next();
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
      const authHeader = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim() : '';
      const bearer = authHeader.length > 0 && this.sessionStore.touch(authHeader) ? authHeader : '';

      if (this.authEnabled && !bearer) {
        if (!origin || !isAllowedHttpOrigin(origin, host)) {
          sendApiError(req, res, 403, 'Forbidden origin');
          return;
        }
      } else if (!isAllowedHttpOrigin(origin, host)) {
        sendApiError(req, res, 403, 'Forbidden origin');
        return;
      }

      if (!this.authEnabled || bearer) return next();
      const cookies = parseCookieMap(req.headers.cookie);
      const csrfHeader = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
      const csrfCookie = cookies[CSRF_COOKIE] ?? '';
      if (!csrfHeader || !csrfCookie || !csrfTokensEqual(csrfHeader, csrfCookie)) {
        sendApiError(req, res, 403, 'CSRF token required');
        return;
      }
      next();
    });

    this.app.use('/api', (req, res, next) => {
      if (!WRITE_METHODS.has(req.method)) return next();
      apiJson(req, res, next);
    });

    this.app.use('/api', (req, res, next) => {
      const kind = sensitiveWriteKind(req.method, requestPathname(req));
      if (!kind) return next();
      const clientId = this.resolveHttpSession(req) ?? this.getClientIp(req);
      const limit = kind === 'probe' ? SENSITIVE_PROBE_RATE_MAX : SENSITIVE_ADAPTER_RATE_MAX;
      const { allowed, retryAfter } = this.rateLimiter.check(
        `api:${clientId}:${sensitiveRouteKey(requestPathname(req))}`,
        limit,
        SENSITIVE_RATE_WINDOW_MS,
      );
      if (!allowed) {
        console.warn(`[relay] Rate limited ${req.method} ${requestPathname(req)} from ${this.getClientIp(req)}`);
        res.set('Retry-After', String(retryAfter));
        sendApiError(req, res, 429, `Too many requests. Retry in ${retryAfter}s.`);
        return;
      }
      next();
    });

    // Sensitive POSTs require a bounded operation id. Same id + fingerprint
    // replays the first result; a different fingerprint is a conflict.
    this.app.use('/api', (req, res, next) => {
      if (!sensitiveWriteKind(req.method, requestPathname(req))) return next();
      const headerId = req.headers['x-operation-id'];
      if (typeof headerId !== 'string' || headerId.length === 0) {
        sendApiError(req, res, 400, 'X-Operation-Id header required');
        return;
      }
      if (!OPERATION_ID_RE.test(headerId)) {
        sendApiError(req, res, 400, 'Invalid operation id');
        return;
      }
      const operationId = headerId;
      const now = Date.now();
      this.pruneOperationCache(now);
      const fingerprint = operationFingerprint(req.method, req.path, req.body);
      const existing = this.operationCache.get(operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          sendApiError(req, res, 409, 'Operation id was already used for different input');
          return;
        }
        void existing.done.then((result) => {
          res.status(result.status).json(result.body);
        });
        return;
      }
      if (this.operationCache.size >= MAX_OPERATION_CACHE) {
        this.pruneOperationCache(now);
        if (this.operationCache.size >= MAX_OPERATION_CACHE) {
          res.set('Retry-After', '1');
          sendApiError(req, res, 429, 'Too many in-flight operations. Retry in 1s.');
          return;
        }
      }
      let settle!: (result: { status: number; body: unknown }) => void;
      const done = new Promise<{ status: number; body: unknown }>((resolve) => { settle = resolve; });
      const entry: OperationCacheEntry = {
        fingerprint,
        settled: false,
        status: 0,
        body: undefined,
        expiresAt: now + OPERATION_CACHE_TTL_MS,
        done,
      };
      this.operationCache.set(operationId, entry);
      const finish = (status: number, body: unknown) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.status = status;
        entry.body = body;
        entry.expiresAt = Date.now() + OPERATION_CACHE_TTL_MS;
        settle({ status, body });
      };
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        finish(res.statusCode, body);
        return originalJson(body);
      }) as typeof res.json;
      res.once('finish', () => finish(res.statusCode, undefined));
      next();
    });

    this.app.get('/api/discovery/status', (_req, res) => {
      res.json(this.buildDiscoveryStatus());
    });

    this.app.get('/api/csrf', (req, res) => {
      const cookies = parseCookieMap(req.headers.cookie);
      let token = cookies[CSRF_COOKIE];
      const maxAgeSec = this.cookieMaxAgeSec(this.resolveHttpPrincipal(req));
      if (typeof token !== 'string' || !/^[A-Za-z0-9]+$/.test(token) || token.length < 24) {
        token = randomBytes(24).toString('hex');
        res.append('Set-Cookie', csrfSetCookie(token, maxAgeSec));
      }
      res.json({ csrfToken: token });
    });

    this.app.get('/api/capabilities', (_req, res) => {
      res.json(this.capabilityStateManager?.getPublicState() ?? {
        activeTargetId: '',
        snapshots: [],
      });
    });

    this.app.get('/api/capabilities/diff', (_req, res) => {
      res.json(this.buildCapabilityDiff());
    });

    this.app.post('/api/discovery/run', async (_req, res) => {
      if (!this.discoveryRunner) { res.status(503).json({ error: 'discovery runner unavailable' }); return; }
      try { res.json({ ok: true, data: await this.discoveryRunner() }); }
      catch (err) { res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    });

    this.app.get('/api/adapters/history', async (_req, res) => {
      const data = await this.adapterStore.load();
      res.json({ revision: data.revision, activeBindings: data.activeBindings, runtime: this.runtimeSelectors?.status() ?? null, adapters: data.adapters.map((a) => ({ id:a.id, status:a.status, cursorVersionRange:a.cursorVersionRange, endpointFingerprint:a.endpointFingerprint ?? '', domSignature:a.domSignature, capabilityKinds:a.capabilityKinds, createdAt:a.createdAt, verifiedAt:a.verifiedAt, contentHash:a.contentHash })), history: data.history });
    });

    this.app.post('/api/adapters/:id/validate', async (req, res) => {
      try {
        this.requireAdapterContext(req.body ?? {});
        const adapter = await this.adapterStore.get(req.params.id);
        if (!adapter) { res.status(404).json({ error: 'adapter not found' }); return; }
        if (adapter.cursorVersionRange !== req.body.cursorVersionRange
          || adapter.endpointFingerprint !== req.body.endpointFingerprint
          || adapter.domSignature !== req.body.domSignature) {
          res.status(409).json({ ok:false, error:'candidate was discovered for a different runtime context' });
          return;
        }
        const { validateAdapter } = await import('./adapter-store.js');
        const result = validateAdapter(adapter);
        const runtime = result.ok ? await this.validateAdapterRuntime(adapter) : [];
        const ok = result.ok && runtime.length > 0 && runtime.every((item) => item.ok);
        res.status(ok ? 200 : 422).json({ ok, errors: result.errors, runtime, adapter: { id: adapter.id, status: adapter.status, capabilityKinds: adapter.capabilityKinds } });
      } catch (err) {
        res.status(409).json({ ok:false, error:err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.post('/api/adapters/:id/apply', async (req, res) => {
      const body = req.body ?? {};
      if (body.confirmed !== true) { res.status(400).json({ ok:false, error:'explicit adapter confirmation required' }); return; }
      if (typeof body.capabilityKind !== 'string' || !['mode','model','tool'].includes(body.capabilityKind)
        || typeof body.cursorVersionRange !== 'string' || typeof body.endpointFingerprint !== 'string'
        || typeof body.domSignature !== 'string') {
        res.status(400).json({ error:'binding fields required' });
        return;
      }
      const candidate = await this.adapterStore.get(req.params.id);
      if (!candidate) { res.status(404).json({ error:'adapter not found' }); return; }
      // Fail-closed until production AdapterRegistry is wired to real Cursor
      // build + DOM fingerprint selection. Never activate a pending candidate.
      res.status(503).json({ ok: false, error: 'ADAPTER_ACTIVATION_UNAVAILABLE' });
    });

    this.app.post('/api/adapters/:id/reject', async (req, res) => {
      try {
        const adapter = await this.adapterStore.get(req.params.id);
        if (!adapter) { res.status(404).json({ ok:false, error:'adapter not found' }); return; }
        if (adapter.status !== 'pending_confirmation') { res.status(409).json({ ok:false, error:`adapter is ${adapter.status}` }); return; }
        const changed = await this.adapterStore.reject(req.params.id);
        if (!changed) { res.status(404).json({ ok:false, error:'adapter not found' }); return; }
        res.json({ ok:true, adapter:{ id:adapter.id, status:'rejected' } });
        this.emitOwnerEvent('adapter:changed', { adapterId: adapter.id, action:'reject' });
      } catch (err) { res.status(422).json({ ok:false, error:err instanceof Error ? err.message : String(err) }); }
    });

    this.app.post('/api/adapters/rollback', async (req, res) => {
      const body=req.body ?? {};
      if (!['mode','model','tool'].includes(body.capabilityKind) || typeof body.cursorVersionRange !== 'string'
        || typeof body.endpointFingerprint !== 'string' || typeof body.domSignature !== 'string') {
        res.status(400).json({ error:'binding fields required' });
        return;
      }
      try {
        this.requireAdapterContext(body);
        const binding = {
          capabilityKind:body.capabilityKind as 'mode'|'model'|'tool',
          cursorVersionRange:body.cursorVersionRange,
          endpointFingerprint:body.endpointFingerprint,
          domSignature:body.domSignature,
        };
        await this.adapterStore.rollback(binding, typeof body.adapterId === 'string' ? body.adapterId : undefined);
        this.runtimeSelectors!.updateStore(this.adapterStore.getState());
        const snapshot = this.capabilityStateManager?.getSnapshot();
        if (snapshot) this.capabilityStateManager?.applyObserved({
          targetId:snapshot.targetId,
          targetGeneration:snapshot.targetGeneration,
          state:snapshot.status.state,
          confidence:snapshot.status.confidence,
          adapterBindings:this.runtimeSelectors!.getAdapterBindings(),
        });
        res.json({ok:true, runtime:this.runtimeSelectors!.status()});
        this.emitOwnerEvent('adapter:changed',{action:'rollback',capabilityKind:body.capabilityKind});
      }
      catch (err) { res.status(422).json({ok:false,error:err instanceof Error?err.message:String(err)}); }
    });

    this.app.get('/api/supervision/current', (req, res) => {
      const principal = this.resolveHttpPrincipal(req);
      res.setHeader('Cache-Control', 'no-store');
      if (principal?.role === 'supervisor') {
        res.json(this.supervisionSnapshot(principal.grant.grantId));
        return;
      }
      if (!this.requireOwnerPrincipal(req, res)) return;
      res.json({
        grants: this.supervisionManager.listGrants().map((grant) => this.supervisionSnapshot(grant.grantId)),
        observedAt: Date.now(),
      });
    });

    this.app.post('/api/supervision/checks', (req, res) => {
      const principal = this.resolveHttpPrincipal(req);
      if (!principal || principal.role !== 'supervisor') {
        sendApiError(req, res, 403, 'Supervisor credential required');
        return;
      }
      if (!workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(), principal.grant.workspace)) {
        sendApiError(req, res, 409, 'workspace mismatch');
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const check = this.supervisionManager.recordCheck(
          principal.grant.grantId,
          body.status as 'ok' | 'attention' | 'failed',
          typeof body.summary === 'string' ? body.summary : '',
        );
        this.emitAllSupervisionStates();
        res.json({ check });
      } catch (err) {
        sendApiError(req, res, 400, err instanceof Error ? err.message : String(err));
      }
    });

    this.app.post('/api/supervision/issues', (req, res) => {
      const principal = this.resolveHttpPrincipal(req);
      if (!principal || principal.role !== 'supervisor') {
        sendApiError(req, res, 403, 'Supervisor credential required');
        return;
      }
      const workspace = this.getObservedWorkspaceIdentity();
      if (!workspace || !workspaceIdentitiesEqual(workspace, principal.grant.workspace)) {
        sendApiError(req, res, 409, 'workspace mismatch');
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const composerId = body.composerId as string;
        const actionType = body.actionType as string;
        const actionId = body.actionId as string;
        const planVersion = body.planVersion as string;
        const authorizationVersion = body.authorizationVersion as string;
        const contentDigest = this.currentActionDigest(
          composerId,
          actionType,
          actionId,
          planVersion,
          authorizationVersion,
        );
        if (!contentDigest) {
          sendApiError(req, res, 409, 'issue action is not current');
          return;
        }
        const issue = this.supervisionManager.createIssuePermit({
          grantId: principal.grant.grantId,
          workspace,
          composerId,
          actionType,
          actionId,
          planVersion,
          authorizationVersion,
          contentDigest,
          expiresAt: body.expiresAt as number,
          evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
          recommendation: typeof body.recommendation === 'string' ? body.recommendation : undefined,
          attemptedActions: Array.isArray(body.attemptedActions) ? body.attemptedActions as string[] : undefined,
        });
        const ownerConnected = [...this.io.sockets.sockets.values()]
          .some((socket) => this.liveSocketPrincipal(socket)?.role === 'owner');
        const notifiedIssue = ownerConnected
          ? this.supervisionManager.recordNotificationStatus(issue.issueId, 'delivery_unknown')
          : issue;
        this.emitAllSupervisionStates();
        res.json({ issue: notifiedIssue });
      } catch (err) {
        sendApiError(req, res, 400, err instanceof Error ? err.message : String(err));
      }
    });

    this.app.post('/api/supervision/issues/:id/decision', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      try {
        const decision = req.body?.decision;
        if (decision !== 'approved' && decision !== 'rejected') {
          sendApiError(req, res, 400, 'invalid issue decision');
          return;
        }
        if (decision === 'approved') {
          const pending = this.supervisionManager.getIssue(req.params.id);
          const grant = pending ? this.supervisionManager.getGrant(pending.grantId) : undefined;
          const workspace = this.getObservedWorkspaceIdentity();
          const digest = pending && grant && workspaceIdentitiesEqual(workspace, grant.workspace)
            ? this.currentActionDigest(
                pending.composerId,
                pending.actionType,
                pending.actionId,
                pending.planVersion,
                pending.authorizationVersion,
              )
            : null;
          if (!pending || !grant || !digest || digest !== pending.contentDigest) {
            sendApiError(req, res, 409, 'issue target is no longer current');
            return;
          }
        }
        const issue = this.supervisionManager.decideIssue(req.params.id, decision, { role: 'owner' });
        this.emitAllSupervisionStates();
        res.json({ issue });
      } catch (err) {
        sendApiError(req, res, 400, err instanceof Error ? err.message : String(err));
      }
    });

    this.app.post('/api/supervision/grants/:id/resume-supervision', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      try {
        const pending = this.supervisionManager.getGrant(req.params.id);
        if (
          !pending
          || pending.status !== 'active'
          || Date.now() >= pending.expiresAt
          || !pending.pauseReasons.includes('human_takeover')
          || !workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(), pending.workspace)
        ) {
          sendApiError(req, res, 409, 'supervision resume prerequisites are not satisfied');
          return;
        }
        const grant = this.supervisionManager.clearPause(
          req.params.id,
          'human_takeover',
          { role: 'owner' },
        );
        this.emitAllSupervisionStates();
        res.json({ grant: this.publicGrant(grant) });
      } catch (err) {
        sendApiError(req, res, 400, err instanceof Error ? err.message : String(err));
      }
    });

    this.app.post('/api/supervision/grants/:id/resume-recovery', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      try {
        const pending = this.supervisionManager.getGrant(req.params.id);
        const state = this.stateManager.getCurrentState();
        const targetId = this.cdpBridge.activeTargetId;
        const targetGeneration = targetId ? this.cdpBridge.getTargetGeneration(targetId) : 0;
        const unresolved = this.operationJournal.list().some((record) =>
          record.target.grantId === req.params.id
          && (record.status === 'pending'
            || record.status === 'dispatching'
            || record.status === 'dispatched'
            || record.status === 'unknown')
        );
        if (
          !pending
          || pending.status !== 'pending_recovery'
          || Date.now() >= pending.expiresAt
          || !workspaceIdentitiesEqual(this.getObservedWorkspaceIdentity(state), pending.workspace)
          || !targetId
          || !targetGeneration
          || !state.activeWindowId
          || !canReadUnderSupervision({ ...pending, status: 'active' }, state.activeComposerId)
          || unresolved
        ) {
          sendApiError(req, res, 409, 'recovery prerequisites are not satisfied');
          return;
        }
        const grant = this.supervisionManager.resumeRecovery(req.params.id, { role: 'owner' });
        this.emitAllSupervisionStates();
        res.json({ grant: this.publicGrant(grant) });
      } catch (err) {
        sendApiError(req, res, 400, err instanceof Error ? err.message : String(err));
      }
    });

    this.app.post('/api/supervision/grants', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      const identity = this.getObservedWorkspaceIdentity();
      if (!identity) {
        sendApiError(req, res, 409, 'workspace identity unavailable');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const readComposerIds = uniqueStringIds(body.readComposerIds ?? []);
      const writeComposerIds = uniqueStringIds(body.writeComposerIds ?? []);
      if (!readComposerIds || !writeComposerIds) {
        sendApiError(req, res, 400, 'invalid composer scope');
        return;
      }
      if (!isIdSubset(writeComposerIds, readComposerIds)) {
        sendApiError(req, res, 400, 'write scope must be a subset of read scope');
        return;
      }
      const listed = this.listedComposerIds();
      if ([...readComposerIds, ...writeComposerIds].some((id) => !listed.has(id))) {
        sendApiError(req, res, 400, 'composer is not in current state');
        return;
      }
      try {
        const created = this.supervisionManager.createGrant({
          workspace: identity,
          readComposerIds,
          writeComposerIds,
          goal: body.goal as string,
          constraints: typeof body.constraints === 'string' ? body.constraints : undefined,
          acceptanceCriteria: typeof body.acceptanceCriteria === 'string' ? body.acceptanceCriteria : undefined,
          planVersion: body.planVersion as string,
          authorizationVersion: body.authorizationVersion as string,
          controlVersion: typeof body.controlVersion === 'string' ? body.controlVersion : undefined,
          expiresAt: body.expiresAt as number,
          operationLimit: typeof body.operationLimit === 'number' ? body.operationLimit : undefined,
          checkTtlMs: typeof body.checkTtlMs === 'number' ? body.checkTtlMs : undefined,
          allowedActionTypes: Array.isArray(body.allowedActionTypes) ? body.allowedActionTypes as string[] : undefined,
          allowedModes: Array.isArray(body.allowedModes) ? body.allowedModes as string[] : undefined,
          allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels as string[] : undefined,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ grant: this.publicGrant(created.grant), redeemCode: created.redeemCode });
      } catch (err) {
        if (err instanceof SupervisionError) {
          sendApiError(req, res, 400, err.message);
          return;
        }
        throw err;
      }
    });

    this.app.post('/api/supervision/grants/:id/revoke', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      try {
        const grant = this.supervisionManager.revoke(req.params.id);
        this.disconnectGrantSockets(grant.grantId);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ grant: this.publicGrant(grant) });
      } catch (err) {
        if (err instanceof SupervisionError) {
          sendApiError(req, res, err.message === 'grant not found' ? 404 : 400, err.message);
          return;
        }
        throw err;
      }
    });

    this.app.get('/api/supervision/grants/:id', (req, res) => {
      if (!this.requireOwnerPrincipal(req, res)) return;
      const grant = this.supervisionManager.getGrant(req.params.id);
      if (!grant) {
        sendApiError(req, res, 404, 'grant not found');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ grant: this.publicGrant(grant) });
    });

    this.app.use(jsonBodyErrorHandler);
  }

  private buildCapabilityDiff(): {
    targetId: string;
    targetGeneration: number;
    revision: number;
    state: string;
    completeness: string;
    added: string[];
    removed: string[];
    changed: string[];
    conflicts: string[];
    canReportRemoval: boolean;
  } {
    const snapshot = this.capabilityStateManager?.getSnapshot() ?? null;
    const completeness = snapshot?.status.completeness ?? snapshot?.models.completeness ?? 'unknown';
    return {
      targetId: snapshot?.targetId ?? '',
      targetGeneration: snapshot?.targetGeneration ?? 0,
      revision: snapshot?.revision ?? 0,
      state: snapshot?.status.state ?? 'unknown',
      completeness,
      added: snapshot?.status.added ?? [],
      removed: snapshot?.status.missing ?? [],
      changed: snapshot?.status.changed ?? [],
      conflicts: snapshot?.status.conflicts ?? [],
      canReportRemoval: completeness === 'complete',
    };
  }

  private buildDiscoveryStatus(): SanitizedDiscoveryStatus {
    const status = this.cdpBridge.getDiscoveryStatus();
    const cap = this.capabilityStateManager;
    if (!cap) return status;
    const snapshot = cap.getSnapshot();
    status.capabilities = snapshot
      ? {
          targetId: snapshot.targetId,
          targetGeneration: snapshot.targetGeneration,
          revision: snapshot.revision,
          state: snapshot.status.state,
        }
      : null;
    return status;
  }

  private updateModelCapabilities(result: CommandResult): void {
    const data = result.data as {
      options?: Array<{ id?: string; label?: string; selected?: boolean }>;
      completeness?: 'complete' | 'partial' | 'unknown';
      filterActive?: boolean;
      source?: 'live_menu' | 'capability_snapshot';
    } | undefined;
    const target = this.capabilityStateManager?.getSnapshot();
    if (!target || !data || !Array.isArray(data.options) || data.source === 'capability_snapshot') return;
    const items = data.options.map((item) => normalizeModel({ id:item.id, label:item.label, selected:item.selected, scope:'composer', source:'menu', confidence:1, selectable:true, observedAt:Date.now() })).filter((item): item is NonNullable<ReturnType<typeof normalizeModel>> => !!item);
    const completeness = data.completeness === 'complete'
      ? 'complete'
      : data.completeness === 'unknown' ? 'unknown' : 'partial';
    this.capabilityStateManager!.applyObserved({
      targetId:target.targetId,
      targetGeneration:target.targetGeneration,
      models:{ items, completeness, filterActive:data.filterActive === true, observedAt:Date.now() },
      state:completeness === 'complete' ? 'ok' : 'degraded',
      completeness,
      confidence:1,
    });
  }

  private capabilityAllows(kind: 'mode' | 'model', id: string): string | null {
    return capabilityAllows(kind, id, {
      snapshot: this.capabilityStateManager?.getSnapshot(),
      activeTargetId: this.cdpBridge.activeTargetId,
      getTargetGeneration: (targetId) => this.cdpBridge.getTargetGeneration(targetId),
    });
  }

  private asCommandPayload(raw: unknown): CommandPayload | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return raw as CommandPayload;
  }

  private planGuardSnapshot(socket: Socket, payload: CommandPayload, extra: Partial<PlanGuardSnapshot> = {}): PlanGuardSnapshot {
    const state = this.stateManager.getCurrentState();
    return {
      socketConnected: socket.connected,
      authEnabled: this.authEnabled,
      hasAuthSession: !this.authEnabled || this.liveSocketPrincipal(socket) !== null,
      connected: state.connected,
      extractorStatus: state.extractorStatus,
      lastExtractionAt: state.lastExtractionAt,
      activeWindowId: state.activeWindowId,
      activeComposerId: state.activeComposerId,
      activeTargetId: this.cdpBridge.activeTargetId,
      requestedWindowId: payload.windowId,
      requestedComposerId: payload.composerId,
      ...extra,
    };
  }

  private planRouteFailure(
    socket: Socket,
    payload: CommandPayload,
    commandId: string,
    error: string,
    code?: PlanFailureCode,
    stage: PlanFailureStage = 'guard',
  ): CommandResult {
    const diagnosed = code ?? diagnosePlanGuardFailure(this.planGuardSnapshot(socket, payload)) ?? 'unknown';
    return planFailResult({
      commandId,
      error,
      code: diagnosed,
      stage,
      requested: planRequestedTarget(payload),
    });
  }

  private socketSessionKey(socket: Socket): string {
    return this.resolveSocketSession(socket) ?? `anon:${socket.id}`;
  }

  private emitCommandResult(
    socket: Socket,
    commandId: string,
    result: { ok: boolean; error?: string; data?: unknown; failure?: CommandResult['failure'] },
  ): void {
    const body: CommandResult = { commandId, ok: result.ok };
    if (result.error !== undefined) body.error = result.error;
    if (result.data !== undefined) body.data = result.data;
    const failure = sanitizePlanFailure(result.failure);
    if (failure) body.failure = failure;
    socket.emit('command:result', body);
  }

  private socketOperationFingerprint(route: string, payload: CommandPayload): string {
    const { commandId: _commandId, operationId: _operationId, ...rest } = payload;
    return operationFingerprint('SOCKET', route, rest);
  }

  private lookupSocketOperation(key: string, fingerprint: string):
    | { type: 'conflict' }
    | { type: 'replay'; done: Promise<{ status: number; body: unknown }> }
    | { type: 'miss' } {
    this.pruneOperationCache(Date.now(), this.socketOperationCache);
    const existing = this.socketOperationCache.get(key);
    if (!existing) return { type: 'miss' };
    if (existing.fingerprint !== fingerprint) return { type: 'conflict' };
    return { type: 'replay', done: existing.done };
  }

  private beginSocketOperation(key: string, fingerprint: string):
    | { type: 'overflow' }
    | { type: 'run'; finish: (result: { ok: boolean; error?: string; data?: unknown }) => void } {
    const now = Date.now();
    this.pruneOperationCache(now, this.socketOperationCache);
    if (this.socketOperationCache.size >= MAX_OPERATION_CACHE) {
      this.pruneOperationCache(now, this.socketOperationCache);
      if (this.socketOperationCache.size >= MAX_OPERATION_CACHE) return { type: 'overflow' };
    }
    let settle!: (result: { status: number; body: unknown }) => void;
    const done = new Promise<{ status: number; body: unknown }>((resolve) => { settle = resolve; });
    const entry: OperationCacheEntry = {
      fingerprint,
      settled: false,
      status: 0,
      body: undefined,
      expiresAt: now + OPERATION_CACHE_TTL_MS,
      done,
    };
    this.socketOperationCache.set(key, entry);
    const finish = (result: { ok: boolean; error?: string; data?: unknown }) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.body = result;
      entry.expiresAt = Date.now() + OPERATION_CACHE_TTL_MS;
      settle({ status: 0, body: result });
    };
    return { type: 'run', finish };
  }

  private cachedCommandResult(result: CommandResult): { ok: boolean; error?: string; data?: unknown; failure?: CommandResult['failure'] } {
    const failure = sanitizePlanFailure(result.failure);
    return {
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  private async runSocketCommand(
    socket: Socket,
    route: string,
    raw: unknown,
    execute: (payload: CommandPayload, commandId: string) => Promise<CommandResult>,
    validate?: (payload: CommandPayload, commandId: string) => string | null,
  ): Promise<void> {
    const payload = this.asCommandPayload(raw);
    const commandId = commandIdOf(payload);
    if (!payload || commandId === 'unknown') {
      this.emitCommandResult(socket, commandId, { ok: false, error: 'Missing commandId' });
      return;
    }
    const denied = this.supervisionCommandDenied(socket, route, payload);
    if (denied) {
      this.emitCommandResult(socket, commandId, { ok: false, error: denied });
      return;
    }
    const validationError = validate?.(payload, commandId);
    if (validationError) {
      if (route === 'discover_plans' || route === 'get_plan_full') {
        this.emitCommandResult(socket, commandId, this.planRouteFailure(
          socket, payload, commandId, validationError, 'invalid', 'validate',
        ));
        return;
      }
      this.emitCommandResult(socket, commandId, { ok: false, error: validationError });
      return;
    }

    if (!socketCommandRequiresOperationId(route, payload.actionType)) {
      try {
        const result = await execute(payload, commandId);
        if ((route === 'get_plan_full' || route === 'discover_plans') && result.ok) {
          const valid = this.planResultGuards.get(result);
          this.planResultGuards.delete(result);
          if (!valid?.()) {
            this.emitCommandResult(socket, commandId, this.planRouteFailure(
              socket, payload, commandId, '计划读取目标或权限已失效', undefined, 'emit',
            ));
            return;
          }
        }
        this.emitCommandResult(socket, commandId, this.cachedCommandResult(result));
      } catch (err) {
        this.emitCommandResult(socket, commandId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const operationId = payload.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      this.emitCommandResult(socket, commandId, { ok: false, error: 'operationId required' });
      return;
    }
    if (!OPERATION_ID_RE.test(operationId)) {
      this.emitCommandResult(socket, commandId, { ok: false, error: 'Invalid operation id' });
      return;
    }

    const sessionKey = this.socketSessionKey(socket);
    const cacheKey = `${sessionKey}:${route}:${operationId}`;
    const fingerprint = this.socketOperationFingerprint(route, payload);
    const existing = this.lookupSocketOperation(cacheKey, fingerprint);
    if (existing.type === 'conflict') {
      this.emitCommandResult(socket, commandId, {
        ok: false,
        error: 'Operation id was already used for different input',
      });
      return;
    }
    if (existing.type === 'replay') {
      const replayed = await existing.done;
      const body = replayed.body && typeof replayed.body === 'object'
        ? replayed.body as { ok: boolean; error?: string; data?: unknown }
        : { ok: false, error: 'Operation replay failed' };
      this.emitCommandResult(socket, commandId, body);
      return;
    }

    const { allowed, retryAfter } = this.rateLimiter.check(
      `socket:${sessionKey}:${route}`,
      SOCKET_DANGEROUS_RATE_MAX,
      SOCKET_DANGEROUS_RATE_WINDOW_MS,
    );
    if (!allowed) {
      this.emitCommandResult(socket, commandId, {
        ok: false,
        error: `Too many requests. Retry in ${retryAfter}s.`,
      });
      return;
    }

    const started = this.beginSocketOperation(cacheKey, fingerprint);
    if (started.type === 'overflow') {
      this.emitCommandResult(socket, commandId, {
        ok: false,
        error: 'Too many in-flight operations. Retry in 1s.',
      });
      return;
    }

    try {
      const result = await execute(payload, commandId);
      const cached = this.cachedCommandResult(result);
      started.finish(cached);
      this.emitCommandResult(socket, commandId, cached);
    } catch (err) {
      const cached = { ok: false, error: err instanceof Error ? err.message : String(err) };
      started.finish(cached);
      this.emitCommandResult(socket, commandId, cached);
    }
  }

  private actionTarget(actionType: string): { targetId?: string; targetGeneration: number; actionType: string } {
    return {
      targetId: this.cdpBridge.activeTargetId,
      targetGeneration: this.cdpBridge.getTargetGeneration(),
      actionType,
    };
  }

  private setupSocketHandlers(): void {
    this.io.use((socket, next) => {
      const principal = this.resolveSocketPrincipal(socket);
      if (this.authEnabled && !principal) {
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? 'token-present'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        console.warn(`[relay] Socket.io auth rejected (${socket.id}) — ${hint}`);
        next(new Error('Unauthorized'));
        return;
      }
      this.rememberSocketPrincipal(socket, principal ?? { role: 'owner' });
      next();
    });

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      const principal = this.liveSocketPrincipal(socket);
      if (principal?.role === 'supervisor') {
        this.emitSupervisorState(socket, principal.grant);
        this.emitSupervisionState(socket, principal.grant.grantId);
      } else {
        socket.emit('state:full', toPublicState(this.stateManager.getCurrentState()));
        socket.emit('supervision:overview', {
          grants: this.supervisionManager.listGrants().map((grant) => this.supervisionSnapshot(grant.grantId)),
          observedAt: Date.now(),
        });
        if (this.capabilityStateManager) {
          socket.emit('capabilities:full', this.capabilityStateManager.getPublicState());
        }
      }

      socket.on('state:request', () => {
        const current = this.liveSocketPrincipal(socket);
        if (socket.data?.principalRole === 'supervisor' && !current) {
          socket.disconnect(true);
          return;
        }
        if (current?.role === 'supervisor') {
          this.emitSupervisorState(socket, current.grant);
          this.emitSupervisionState(socket, current.grant.grantId);
          return;
        }
        socket.emit('state:full', toPublicState(this.stateManager.getCurrentState()));
        socket.emit('supervision:overview', {
          grants: this.supervisionManager.listGrants().map((grant) => this.supervisionSnapshot(grant.grantId)),
          observedAt: Date.now(),
        });
      });

      const onCommand = (
        route: string,
        execute: (payload: CommandPayload, commandId: string) => Promise<CommandResult>,
        validate?: (payload: CommandPayload, commandId: string) => string | null,
      ) => {
        socket.on(`command:${route}`, (raw: unknown) => {
          void this.runSocketCommand(socket, route, raw, execute, validate);
        });
      };

      onCommand('send_message', (payload, commandId) => {
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const before = this.stateManager.getCurrentState().messages.filter(
          (message) => message.type === 'human' && message.text.trim() === payload.text!.trim(),
        ).length;
        return this.runScopedWrite(
          socket,
          'send_message',
          payload,
          commandId,
          (options) => this.commandExecutor.sendMessage(commandId, payload.text!, options),
          () => this.waitForState((state) =>
            state.activeComposerId === payload.composerId
            && state.messages.filter(
              (message) => message.type === 'human' && message.text.trim() === payload.text!.trim(),
            ).length > before
          ),
        );
      }, (payload) => (!payload.text ? 'Missing commandId or text' : null));

      onCommand('approve', (payload, commandId) => {
        console.log(`[relay] Command: approve from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'approve',
          payload,
          commandId,
          (options) => this.commandExecutor.clickRegisteredAction(
            commandId,
            payload.actionId!,
            this.actionTarget('approve'),
            options,
          ),
          () => this.waitForState((state) => !this.stateContainsAction(state, payload.actionId!)),
        );
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized actionId' : null));

      onCommand('approve_all', (payload, commandId) => {
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'approve_all',
          payload,
          commandId,
          (options) => this.commandExecutor.clickRegisteredAction(
            commandId,
            payload.actionId!,
            this.actionTarget('approve_all'),
            options,
          ),
          () => this.waitForState((state) => !this.stateContainsAction(state, payload.actionId!)),
        );
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized actionId' : null));

      onCommand('reject', (payload, commandId) => {
        console.log(`[relay] Command: reject from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'reject',
          payload,
          commandId,
          (options) => this.commandExecutor.clickRegisteredAction(
            commandId,
            payload.actionId!,
            this.actionTarget('reject'),
            options,
          ),
          () => this.waitForState((state) => !this.stateContainsAction(state, payload.actionId!)),
        );
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized actionId' : null));

      onCommand('switch_tab', (payload, commandId) => {
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle}" from ${socket.id}`);
        return this.commandExecutor.switchTab(commandId, payload.tabTitle!);
      }, (payload) => (!payload.tabTitle ? 'Missing commandId or tab title' : null));

      onCommand('new_chat', (_payload, commandId) => {
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        return this.commandExecutor.newChat(commandId);
      });

      onCommand('set_mode', (payload, commandId) => {
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'set_mode',
          payload,
          commandId,
          (options) => this.commandExecutor.setMode(commandId, payload.modeId!, options),
          () => this.waitForState((state) => state.activeComposerId === payload.composerId && state.mode.current === payload.modeId),
        );
      }, (payload) => {
        if (!payload.modeId) return 'Missing commandId or modeId';
        return this.capabilityAllows('mode', payload.modeId);
      });

      onCommand('set_model', (payload, commandId) => {
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'set_model',
          payload,
          commandId,
          (options) => this.commandExecutor.setModel(commandId, payload.modelId!, options),
          () => this.waitForState((state) =>
            state.activeComposerId === payload.composerId
            && (state.model.currentId === payload.modelId || state.model.current === payload.modelId)
          ),
        );
      }, (payload) => {
        if (!payload.modelId) return 'Missing commandId or modelId';
        return this.capabilityAllows('model', payload.modelId);
      });

      onCommand('get_model_options', async (_payload, commandId) => {
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(commandId);
        this.updateModelCapabilities(result);
        return result;
      });

      // 单个连接只保留一批短期阅读引用；不进入状态广播、磁盘或正文缓存。
      const planReferences = new Map<string, PlanBlock>();
      let planReferencesExpireAt = 0;
      let planReferenceTimer: ReturnType<typeof setTimeout> | undefined;
      let planEpoch = 0;
      let planDiscoveryBusy = false;
      const clearPlanReferences = () => {
        planReferences.clear();
        planReferencesExpireAt = 0;
        if (planReferenceTimer) clearTimeout(planReferenceTimer);
        planReferenceTimer = undefined;
      };
      const planScopeIdentity = () => {
        const state = this.stateManager.getCurrentState();
        return JSON.stringify([state.activeWindowId, state.activeComposerId, state.connected,
          this.cdpBridge.activeTargetId, this.cdpBridge.getTargetGeneration(),
          this.resolveSocketSession(socket)]);
      };
      let lastPlanScope = planScopeIdentity();
      const updatePlanScope = () => {
        const current = planScopeIdentity();
        if (current !== lastPlanScope) {
          lastPlanScope = current;
          planEpoch += 1;
          clearPlanReferences();
        }
      };
      this.stateManager.on('state:patch', updatePlanScope);
      this.stateManager.on('connection:changed', updatePlanScope);
      const capturePlanGuard = (payload: CommandPayload) => {
        updatePlanScope();
        const epoch = planEpoch;
        let invalidated = false;
        let observedFailure: PlanFailureCode | undefined;
        const isCurrent = () => {
          updatePlanScope();
          const code = diagnosePlanGuardFailure(this.planGuardSnapshot(socket, payload, {
            now: Date.now(),
            invalidated,
            epochMatch: epoch === planEpoch,
          }));
          if (code) {
            invalidated = true;
            observedFailure ??= code;
          }
          return code === null;
        };
        return Object.assign(isCurrent, { observedFailure: () => observedFailure });
      };

      onCommand('discover_plans', async (payload, commandId) => {
        const scopeCurrent = capturePlanGuard(payload);
        const fail = (error?: string, code?: PlanFailureCode, stage: PlanFailureStage = 'guard'): CommandResult =>
          this.planRouteFailure(
            socket,
            payload,
            commandId,
            error ?? '当前会话的目标或读取权限无法确认，请刷新后重试',
            code ?? scopeCurrent.observedFailure(),
            stage,
          );
        if (planDiscoveryBusy) return fail('当前连接正在查找历史计划，请等待完成', 'busy');
        if (!scopeCurrent()) return fail();
        clearPlanReferences();
        planDiscoveryBusy = true;
        try {
          const result = await this.commandExecutor.discoverPlans(commandId, {
            windowId: payload.windowId!, composerId: payload.composerId!,
          }, scopeCurrent);
          if (!scopeCurrent()) return fail();
          if (!result.ok) {
            return attachPlanFailure(result, {
              code: 'unknown',
              stage: 'discover',
              commandId,
              requested: planRequestedTarget(payload),
            });
          }
          const data = result.data as {
            plans?: Array<{ toolCallId?: unknown; title?: unknown; description?: unknown }>;
            observedAt?: unknown; reachedStart?: unknown; completeness?: unknown;
          } | undefined;
          const now = Date.now();
          if (!data || !Array.isArray(data.plans) || data.completeness !== 'partial'
            || typeof data.reachedStart !== 'boolean' || typeof data.observedAt !== 'number'
            || !Number.isFinite(data.observedAt) || data.observedAt <= 0
            || data.observedAt > now || now - data.observedAt > 15_000) return fail();
          const plans: PlanDiscoveryData['plans'] = [];
          const seen = new Set<string>();
          for (const item of data.plans.slice(0, 32)) {
            if (!item || typeof item.toolCallId !== 'string' || !item.toolCallId.trim()
              || item.toolCallId.length > 512 || typeof item.title !== 'string' || !item.title.trim()) return fail();
            if (seen.has(item.toolCallId)) continue;
            seen.add(item.toolCallId);
            const title = item.title.trim().slice(0, 200);
            const plan = {
              id: `plan-ref:${randomBytes(18).toString('hex')}`, toolCallId: item.toolCallId,
              title, label: title,
              ...(typeof item.description === 'string' ? { description: item.description.slice(0, 200) } : {}),
            };
            plans.push(plan);
          }
          if (!scopeCurrent()) return fail();
          for (const plan of plans) {
            planReferences.set(plan.id, { ...plan, type: 'plan', flatIndex: -1, todosCompleted: 0, todosTotal: 0 });
          }
          planReferencesExpireAt = now + PLAN_REFERENCE_TTL_MS;
          const expiresAt = planReferencesExpireAt;
          planReferenceTimer = setTimeout(clearPlanReferences, PLAN_REFERENCE_TTL_MS);
          planReferenceTimer.unref();
          const response: CommandResult = {
            commandId, ok: true,
            data: { plans, windowId: payload.windowId!, composerId: payload.composerId!,
              observedAt: data.observedAt, expiresAt, completeness: 'partial', reachedStart: data.reachedStart,
            } satisfies PlanDiscoveryData,
          };
          this.planResultGuards.set(response, () => scopeCurrent()
            && planReferencesExpireAt === expiresAt && Date.now() < expiresAt);
          return response;
        } finally {
          planDiscoveryBusy = false;
        }
      }, (payload) => (
        [payload.windowId, payload.composerId].every((value) => typeof value === 'string' && value.trim().length > 0)
          ? null : '查找计划需要明确的窗口和会话标识'
      ));

      onCommand('get_plan_full', async (payload, commandId) => {
        const scopeCurrent = capturePlanGuard(payload);
        const initial = this.stateManager.getCurrentState();
        const reference = planReferences.get(payload.planId!);
        const plan = reference ?? initial.messages.find((message): message is PlanBlock =>
          message.type === 'plan' && message.id === payload.planId);
        const fail = (code?: PlanFailureCode): CommandResult => this.planRouteFailure(
          socket,
          payload,
          commandId,
          '当前会话的计划、目标或读取权限无法确认，请刷新后重试',
          code ?? scopeCurrent.observedFailure(),
        );
        if (!plan) return fail('plan');
        const fingerprint = (value: PlanBlock) => JSON.stringify([
          value.id, value.toolCallId, value.fileName, value.label, value.title, value.description,
          value.todos, value.todosCompleted, value.todosTotal,
        ]);
        const initialFingerprint = fingerprint(plan);
        let invalidated = false;
        const referenceLive = () => planReferences.get(plan.id) === reference && Date.now() < planReferencesExpireAt;
        const isCurrent = () => {
          const state = this.stateManager.getCurrentState();
          const current = state.messages.find((message): message is PlanBlock =>
            message.type === 'plan' && message.id === plan.id);
          return !invalidated && scopeCurrent()
            && (reference
              ? referenceLive()
              : !!current && fingerprint(current) === initialFingerprint);
        };
        const failStale = (): CommandResult => fail(scopeCurrent.observedFailure() ?? 'expired');
        if (!isCurrent()) return failStale();
        // 已观察到的目标变化不可被切回同名会话消除。
        const onStateChange = () => { if (!isCurrent()) invalidated = true; };
        this.stateManager.on('state:patch', onStateChange);
        this.stateManager.on('connection:changed', onStateChange);
        try {
          let fileName = plan.fileName;
          let plansRoot: string | undefined;
          if (!fileName) {
            if (typeof plan.toolCallId !== 'string' || !plan.toolCallId.trim()) {
              return planFailResult({
                commandId,
                error: '当前计划卡片缺少可核对的文件关联，无法读取全文；请从创建计划记录打开（不保证一定存在创建记录）。当前会话的计划、目标或读取权限无法确认，请刷新后重试',
                code: 'plan',
                stage: 'resolve',
                requested: planRequestedTarget(payload),
              });
            }
            const resolved = await this.commandExecutor.resolvePlanFile(commandId, {
              windowId: payload.windowId!, composerId: payload.composerId!,
              planId: plan.id, toolCallId: plan.toolCallId,
            }, isCurrent);
            if (!isCurrent()) return failStale();
            if (!resolved.ok) {
              return attachPlanFailure(resolved, {
                code: 'unknown',
                stage: 'resolve',
                commandId,
                requested: planRequestedTarget(payload),
              });
            }
            const data = resolved.data as { fileName?: unknown; plansRoot?: unknown } | undefined;
            if (typeof data?.fileName !== 'string') return fail();
            fileName = data.fileName;
            if (typeof data.plansRoot === 'string') plansRoot = data.plansRoot;
          }
          if (!isCurrent()) return failStale();
          const result = readPlanFileResult(fileName, plansRoot);
          if (!result.ok) {
            return planFailResult({
              commandId,
              error: planFileErrorMessage(result.error),
              code: 'file',
              stage: 'read',
              requested: planRequestedTarget(payload),
            });
          }
          if (!result.data.body) {
            return planFailResult({
              commandId,
              error: '计划文件缺少正文，无法确认全文完整性',
              code: 'file',
              stage: 'read',
              requested: planRequestedTarget(payload),
            });
          }
          if (!isCurrent()) return failStale();
          const response: CommandResult = {
            commandId, ok: true,
            data: {
              todos: result.data.todos,
              body: result.data.body,
              bodyHtml: markdownToWebHtml(result.data.body),
              metadata: {
                windowId: payload.windowId!, composerId: payload.composerId!, planId: plan.id,
                source: 'cursor_plan_file', fileName, version: result.version,
                observedAt: result.observedAt, updatedAt: result.updatedAt, completeness: 'complete',
              },
            } satisfies PlanFullData,
          };
          this.planResultGuards.set(response, isCurrent);
          return response;
        } finally {
          this.stateManager.off('state:patch', onStateChange);
          this.stateManager.off('connection:changed', onStateChange);
        }
      }, (payload) => (
        [payload.planId, payload.windowId, payload.composerId].every((value) => typeof value === 'string' && value.trim().length > 0)
          ? null : '读取计划需要明确的计划、窗口和会话标识'
      ));

      onCommand('get_plan_model_options', (payload, commandId) => {
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        return this.commandExecutor.getRegisteredPlanModelOptions(commandId, payload.actionId!);
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized plan model actionId' : null));

      onCommand('set_plan_model', (payload, commandId) => {
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'set_plan_model',
          payload,
          commandId,
          (options) => this.commandExecutor.setRegisteredPlanModel(
            commandId,
            payload.actionId!,
            payload.planModelId!,
            options,
          ),
          () => this.waitForState((state) => !this.stateContainsAction(state, payload.actionId!)),
        );
      }, (payload) => (
        !payload.actionId || !payload.planModelId
          ? 'Missing commandId, authorized plan model actionId, or planModelId'
          : null
      ));

      onCommand('click_action', (payload, commandId) => {
        console.log(`[relay] Command: click_action from ${socket.id}`);
        return this.runScopedWrite(
          socket,
          'click_action',
          payload,
          commandId,
          (options) => this.commandExecutor.clickRegisteredAction(
            commandId,
            payload.actionId!,
            this.actionTarget(payload.actionType!),
            options,
          ),
          () => this.waitForState((state) => !this.stateContainsAction(state, payload.actionId!)),
        );
      }, (payload) => {
        if (typeof payload.actionId !== 'string' || payload.actionId.length === 0 || !isValidActionType(payload.actionType)) {
          return 'Missing authorized actionId or valid actionType';
        }
        return null;
      });

      onCommand('switch_window', async (payload, commandId) => {
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        await moveHomeWindow(this.cdpBridge, this.windowMonitor, payload.windowId!);
        return { commandId, ok: true };
      }, (payload) => (!payload.windowId ? 'Missing commandId or windowId' : null));

      socket.on('disconnect', (reason) => {
        planEpoch += 1;
        clearPlanReferences();
        this.stateManager.off('state:patch', updatePlanScope);
        this.stateManager.off('connection:changed', updatePlanScope);
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      const publicPatch = toPublicPatch(patch);
      if (Object.keys(publicPatch).length === 0) return;
      for (const socket of this.io.sockets.sockets.values()) {
        const principal = this.liveSocketPrincipal(socket);
        if (socket.data?.principalRole === 'supervisor' && !principal) {
          socket.disconnect(true);
          continue;
        }
        if (principal?.role === 'supervisor') {
          this.emitSupervisorState(socket, principal.grant);
          this.emitSupervisionState(socket, principal.grant.grantId);
          continue;
        }
        socket.emit('state:patch', publicPatch);
      }
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });

    if (this.capabilityStateManager) {
      this.capabilityStateManager.on('capabilities:full', (snapshot: unknown) => {
        this.emitOwnerEvent(
          'capabilities:full',
          toPublicCapabilityFull(snapshot, this.capabilityStateManager?.activeTargetId ?? ''),
        );
      });
      this.capabilityStateManager.on('capabilities:patch', (patch: unknown) => {
        this.emitOwnerEvent('capabilities:patch', patch);
      });
      this.capabilityStateManager.on('capabilities:stale', (patch: unknown) => {
        this.emitOwnerEvent('capabilities:stale', patch);
      });
    }
  }
}
