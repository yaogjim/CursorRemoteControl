import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult } from './types.js';
import { toPublicPatch, toPublicState, type StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CDPBridge } from './cdp-bridge.js';
import { moveHomeWindow, type WindowMonitor } from './window-monitor.js';
import { markdownToWebHtml, readPlanFile } from './plan-files.js';
import {
  WEBAPP_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SEC,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RateLimitEntry {
  count: number;
  resetAt: number;
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

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;
  private windowMonitor: WindowMonitor | undefined;

  private sessionStore: WebappSessionStore;
  private loginAttempts = new Map<string, RateLimitEntry>();

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
    windowMonitor?: WindowMonitor
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.windowMonitor = windowMonitor;
    this.sessionStore = createWebappSessionStore(config.dataDir);

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
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

  private checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }

    if (entry.count >= 10) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true, retryAfter: 0 };
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

    this.app.use(express.json());

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
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
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);
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

      socket.on('command:send_message', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.text) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or text',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          payload.text
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve from ${socket.id}`);
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: reject from ${socket.id}`);
        const result = await this.commandExecutor.reject(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle ?? payload.selectorPath}" from ${socket.id}`);
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_full for ${payload.planLabel} from ${socket.id}`);
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_action from ${socket.id}`);
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath,
          payload.actionLabel
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        try {
          // Same sequence as Telegram inbound: switch CDP home, then sync
          // WindowMonitor home/generation so the new active window is not
          // treated as a non-home parallel poll target.
          await moveHomeWindow(this.cdpBridge, this.windowMonitor, payload.windowId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

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
  }
}
