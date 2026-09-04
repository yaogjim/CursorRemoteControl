import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult, PlanBlock, SanitizedDiscoveryStatus } from './types.js';
import { AdapterStore } from './adapter-store.js';
import { ActionRegistry } from './action-registry.js';
import { capabilityAllows } from './capability-guard.js';
import { toPublicCapabilityFull } from './capability-state-manager.js';
import { normalizeModel } from './capability-normalize.js';
import { RuntimeValidator } from './runtime-validator.js';
import type { RuntimeSelectorProvider, RuntimeAdapterContext } from './runtime-selector-provider.js';
import { toPublicPatch, toPublicState, type StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CdpClient } from './cdp-client.js';
import type { CDPBridge } from './cdp-bridge.js';
import type { CapabilityStateManager } from './capability-state-manager.js';
import { TargetUiCoordinator } from './target-ui-coordinator.js';
import { moveHomeWindow, type WindowMonitor } from './window-monitor.js';
import { markdownToWebHtml, readPlanFileResult, type PlanFileReadError } from './plan-files.js';
import {
  WEBAPP_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SEC,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';

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
const API_JSON_LIMIT = '64kb';

/** Dedicated socket events that mutate Cursor and require a bounded operationId. */
export const DANGEROUS_SOCKET_COMMANDS = new Set([
  'send_message',
  'approve',
  'approve_all',
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

function csrfSetCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`;
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
  private rateLimiter = new BoundedRateLimiter(MAX_RATE_LIMIT_KEYS);
  private operationCache = new Map<string, OperationCacheEntry>();
  private socketOperationCache = new Map<string, OperationCacheEntry>();

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
    this.io.emit('adapter:pending', { id: adapter.id, status: adapter.status, capabilityKinds: adapter.capabilityKinds, createdAt: adapter.createdAt });
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
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.sessionStore.flush();
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
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      res.append('Set-Cookie', csrfSetCookie(csrf));
      return res.json({ token });
    });

    this.app.get('/health', (req, res) => {
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      const publicBody = {
        ok: true as const,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
      };
      // Full details: no password (localhost), valid session, or loopback observer
      // (extension health poll from 127.0.0.1). Unauthenticated LAN gets public min.
      const revealDetails =
        !this.authEnabled ||
        sessionOk ||
        isLoopbackRemoteAddress(req.socket.remoteAddress);
      if (!revealDetails) {
        res.json(publicBody);
        return;
      }
      const state = this.stateManager.getCurrentState();
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
      });
    });

    this.app.get('/debug/state', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
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

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        if (!req.readableEnded) req.resume();
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);

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
      if (typeof token !== 'string' || !/^[A-Za-z0-9]+$/.test(token) || token.length < 24) {
        token = randomBytes(24).toString('hex');
        res.append('Set-Cookie', csrfSetCookie(token));
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
        this.io.emit('adapter:changed', { adapterId: adapter.id, action:'reject' });
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
        this.io.emit('adapter:changed',{action:'rollback',capabilityKind:body.capabilityKind});
      }
      catch (err) { res.status(422).json({ok:false,error:err instanceof Error?err.message:String(err)}); }
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

  private socketSessionKey(socket: Socket): string {
    return this.resolveSocketSession(socket) ?? `anon:${socket.id}`;
  }

  private emitCommandResult(
    socket: Socket,
    commandId: string,
    result: { ok: boolean; error?: string; data?: unknown },
  ): void {
    const body: CommandResult = { commandId, ok: result.ok };
    if (result.error !== undefined) body.error = result.error;
    if (result.data !== undefined) body.data = result.data;
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

  private cachedCommandResult(result: CommandResult): { ok: boolean; error?: string; data?: unknown } {
    return {
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
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
    const validationError = validate?.(payload, commandId);
    if (validationError) {
      this.emitCommandResult(socket, commandId, { ok: false, error: validationError });
      return;
    }

    if (!socketCommandRequiresOperationId(route, payload.actionType)) {
      try {
        const result = await execute(payload, commandId);
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
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
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
      });
    }

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      socket.emit('state:full', toPublicState(this.stateManager.getCurrentState()));
      if (this.capabilityStateManager) {
        socket.emit('capabilities:full', this.capabilityStateManager.getPublicState());
      }

      socket.on('state:request', () => {
        socket.emit('state:full', toPublicState(this.stateManager.getCurrentState()));
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
        return this.commandExecutor.sendMessage(commandId, payload.text!);
      }, (payload) => (!payload.text ? 'Missing commandId or text' : null));

      onCommand('approve', (payload, commandId) => {
        console.log(`[relay] Command: approve from ${socket.id}`);
        return this.commandExecutor.clickRegisteredAction(commandId, payload.actionId!, this.actionTarget('approve'));
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized actionId' : null));

      onCommand('approve_all', (payload, commandId) => {
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        return this.commandExecutor.clickRegisteredAction(commandId, payload.actionId!, this.actionTarget('approve_all'));
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized actionId' : null));

      onCommand('reject', (payload, commandId) => {
        console.log(`[relay] Command: reject from ${socket.id}`);
        return this.commandExecutor.clickRegisteredAction(commandId, payload.actionId!, this.actionTarget('reject'));
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
        return this.commandExecutor.setMode(commandId, payload.modeId!);
      }, (payload) => {
        if (!payload.modeId) return 'Missing commandId or modeId';
        return this.capabilityAllows('mode', payload.modeId);
      });

      onCommand('set_model', (payload, commandId) => {
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        return this.commandExecutor.setModel(commandId, payload.modelId!);
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

      onCommand('get_plan_full', async (payload, commandId) => {
        const planLabel = currentPlanLabel(this.stateManager.getCurrentState(), payload.planId);
        if (!planLabel) {
          return { commandId, ok: false, error: 'Plan is not available in the current session' };
        }
        console.log(`[relay] Command: get_plan_full for current plan ${payload.planId} from ${socket.id}`);
        const result = readPlanFileResult(planLabel);
        if (!result.ok) {
          return { commandId, ok: false, error: planFileErrorMessage(result.error) };
        }
        return {
          commandId,
          ok: true,
          data: {
            todos: result.data.todos,
            body: result.data.body,
            bodyHtml: markdownToWebHtml(result.data.body),
          },
        };
      }, (payload) => (!payload.planId ? 'Missing commandId or planId' : null));

      onCommand('get_plan_model_options', (payload, commandId) => {
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        return this.commandExecutor.getRegisteredPlanModelOptions(commandId, payload.actionId!);
      }, (payload) => (!payload.actionId ? 'Missing commandId or authorized plan model actionId' : null));

      onCommand('set_plan_model', (payload, commandId) => {
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        return this.commandExecutor.setRegisteredPlanModel(commandId, payload.actionId!, payload.planModelId!);
      }, (payload) => (
        !payload.actionId || !payload.planModelId
          ? 'Missing commandId, authorized plan model actionId, or planModelId'
          : null
      ));

      onCommand('click_action', (payload, commandId) => {
        console.log(`[relay] Command: click_action from ${socket.id}`);
        return this.commandExecutor.clickRegisteredAction(
          commandId,
          payload.actionId!,
          this.actionTarget(payload.actionType!),
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
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      const publicPatch = toPublicPatch(patch);
      if (Object.keys(publicPatch).length === 0) return;
      this.io.emit('state:patch', publicPatch);
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });

    if (this.capabilityStateManager) {
      this.capabilityStateManager.on('capabilities:full', (snapshot: unknown) => {
        this.io.emit(
          'capabilities:full',
          toPublicCapabilityFull(snapshot, this.capabilityStateManager?.activeTargetId ?? ''),
        );
      });
      this.capabilityStateManager.on('capabilities:patch', (patch: unknown) => {
        this.io.emit('capabilities:patch', patch);
      });
      this.capabilityStateManager.on('capabilities:stale', (patch: unknown) => {
        this.io.emit('capabilities:stale', patch);
      });
    }
  }
}
