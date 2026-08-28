import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync, watch, type FSWatcher } from 'fs';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { buildEnvFromConfig } from './config-bridge.js';
import { appendLogLine, type UnifiedOutputChannel } from './output-channel.js';
import { updateStatusBar, type HealthData, type ServerState } from './status-bar.js';
import { LifecycleLock, MANUAL_STOP_FILE, OWNER_LOCK_FILE } from './lifecycle-lock.js';
import { formatHostForUrl, HealthProbeClient, healthProbeUrls } from './health-probe.js';

const HEALTH_POLL_INTERVAL_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const MAX_TAKEOVER_JITTER_MS = 3000;
const RESTART_WAIT_DOWN_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ServerManager extends EventEmitter {
  private context: vscode.ExtensionContext;
  private outputChannel: UnifiedOutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private child: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealth: HealthData | null = null;
  private _serverState: ServerState = 'stopped';
  private _isOwner = false;
  private _takingOver = false;
  private _reactingToFlag = false;
  private _restarting = false;
  private opChain: Promise<void> = Promise.resolve();
  private readonly windowName: string;
  private readonly lifecycle: LifecycleLock;
  private dirWatcher: FSWatcher | null = null;
  private readonly healthProbe = new HealthProbeClient();

  get serverState(): ServerState {
    return this._serverState;
  }

  get health(): HealthData | null {
    return this.lastHealth;
  }

  get isOwner(): boolean {
    return this._isOwner;
  }

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: UnifiedOutputChannel,
    statusBarItem: vscode.StatusBarItem
  ) {
    super();
    this.context = context;
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.windowName = vscode.workspace.name
      ?? vscode.workspace.workspaceFolders?.[0]?.name
      ?? 'unknown';

    const dataDir = context.globalStorageUri.fsPath;
    const instanceId = randomBytes(4).toString('hex');
    this.lifecycle = new LifecycleLock(dataDir, `${this.windowName}:${instanceId}`);
  }

  private enqueueOp(fn: () => Promise<void>): Promise<void> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(() => undefined, () => undefined);
    return run;
  }

  startDirWatcher(): void {
    const dataDir = this.context.globalStorageUri.fsPath;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    try {
      this.dirWatcher = watch(dataDir, (eventType, filename) => {
        if (filename !== MANUAL_STOP_FILE && filename !== OWNER_LOCK_FILE) return;
        if (this._reactingToFlag || this._restarting) return;

        if (filename === MANUAL_STOP_FILE) {
          const flagExists = this.lifecycle.isManualStopped();
          if (flagExists && this._serverState !== 'stopped') {
            this.outputChannel.info(`[${this.windowName}] Manual-stop flag detected — stopping.`);
            this.stop().catch(err => {
              this.outputChannel.warn(`[${this.windowName}] Flag-triggered stop failed: ${err}`);
            });
          } else if (!flagExists && this._serverState === 'stopped') {
            this.outputChannel.info(`[${this.windowName}] Manual-stop flag removed — starting.`);
            this.start({ fromWatcher: true }).catch(err => {
              this.outputChannel.warn(`[${this.windowName}] Flag-triggered start failed: ${err}`);
            });
          }
          return;
        }

        if (filename === OWNER_LOCK_FILE) {
          const state = this.lifecycle.read();
          if (state?.intent === 'restarting' && this.child) {
            this.outputChannel.info(`[${this.windowName}] Restart requested by another window — stopping owned server.`);
            this.stop().catch(err => {
              this.outputChannel.warn(`[${this.windowName}] Restart-triggered stop failed: ${err}`);
            });
          }
        }
      });
    } catch (err) {
      this.outputChannel.warn(`[${this.windowName}] Could not watch data dir: ${err instanceof Error ? err.message : err}`);
    }
  }

  private getBind(): { port: string; host: string } {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = String(config.get<number>('serverPort', 3000));
    const host = config.get<string>('serverHost', '127.0.0.1');
    return { port, host };
  }

  private getWebappPassword(): string {
    return vscode.workspace.getConfiguration('cursorRemote').get<string>('webappPassword', '') ?? '';
  }

  private async probeHealth(timeoutMs: number) {
    const { port, host } = this.getBind();
    this.healthProbe.setPassword(this.getWebappPassword());
    return this.healthProbe.probe(healthProbeUrls(host, port), timeoutMs);
  }

  private applyDetailedHealth(data: HealthData): void {
    this.lastHealth = data;
  }

  private async probeExistingServer(): Promise<boolean> {
    const result = await this.probeHealth(2000);
    if (!result) return false;
    if (result.detailed) this.applyDetailedHealth(result.body as HealthData);
    return true;
  }

  async start(opts?: { fromWatcher?: boolean }): Promise<void> {
    return this.enqueueOp(() => this.doStart(opts));
  }

  private attachAsObserver(port: string, host: string): void {
    this._isOwner = false;
    this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
    this.startHealthPolling(port, host);
    this.emit('started');
  }

  private async doStart(opts?: { fromWatcher?: boolean }): Promise<void> {
    this._reactingToFlag = true;
    this.lifecycle.setManualStop(false);
    this._reactingToFlag = false;

    if (this.child) {
      if (!opts?.fromWatcher) {
        vscode.window.showInformationMessage('Server is already running (owned by this window).');
      }
      return;
    }

    const { port, host } = this.getBind();
    const alreadyRunning = await this.probeExistingServer();
    if (alreadyRunning) {
      this.outputChannel.info(`[${this.windowName}] Server already running — attaching as observer.`);
      this.attachAsObserver(port, host);
      return;
    }

    if (this.lifecycle.isManualStopped()) {
      this.outputChannel.info(`[${this.windowName}] Manual stop is active — not starting.`);
      this.setState('stopped');
      return;
    }

    if (this.lifecycle.isRestarting() && !this.lifecycle.isOwnedByUs() && !this._restarting) {
      this.outputChannel.info(`[${this.windowName}] Another window is restarting — waiting to attach as observer.`);
      await sleep(1500);
      if (await this.probeExistingServer()) {
        this.attachAsObserver(port, host);
        return;
      }
    }

    if (!this.lifecycle.tryClaimOwner()) {
      this.outputChannel.info(`[${this.windowName}] Another window holds ownership — waiting to attach as observer.`);
      await sleep(1500);
      if (await this.probeExistingServer()) {
        this.attachAsObserver(port, host);
        return;
      }
      this._isOwner = false;
      this.setState('disconnected');
      this.startHealthPolling(port, host);
      return;
    }

    const env = await buildEnvFromConfig(this.context);

    const dataDir = env.DATA_DIR;
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const tempDir = join(this.context.extensionPath, 'temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const serverScript = join(this.context.extensionPath, 'dist', 'server', 'bundle.mjs');

    this.outputChannel.info(`[${this.windowName}] Starting server: ${serverScript}`);

    this.child = spawn(process.execPath, ['--no-deprecation', '--disable-warning=DEP0040', serverScript], {
      cwd: this.context.extensionPath,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._isOwner = true;

    this.child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        appendLogLine(this.outputChannel, line);
        this.detectStatusFromLog(line);
      }
    });

    let stderrBuffer = '';
    this.child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.includes('DEP0040') || (line.includes('punycode') && line.includes('deprecated'))) continue;
        appendLogLine(this.outputChannel, line);
      }
    });

    this.child.on('exit', (code, signal) => {
      this.outputChannel.info(`[${this.windowName}] Server exited (code=${code}, signal=${signal})`);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();

      if (!this._restarting && !this.lifecycle.isRestarting()) {
        this.lifecycle.releaseOwner();
      }

      const portTaken = stderrBuffer.includes('EADDRINUSE');
      if (portTaken) {
        this.outputChannel.info(`[${this.windowName}] Port already in use — falling back to observer.`);
        this.lifecycle.releaseOwner();
        this.fallbackToObserver();
        return;
      }

      if (code !== 0 && code !== null) {
        this.outputChannel.show(true);
        this.setState('error');
      } else {
        this.setState('stopped');
      }
      this.emit('stopped');
    });

    this.child.on('error', (err) => {
      this.outputChannel.error(`[${this.windowName}] Server spawn error: ${err.message}`);
      this.outputChannel.show(true);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();
      if (!this._restarting) this.lifecycle.releaseOwner();
      this.setState('error');
    });

    this.outputChannel.show(true);
    this.setState('disconnected');
    this.startHealthPolling(env.SERVER_PORT, env.SERVER_HOST);
    this.emit('started');
  }

  async stop(manual = false): Promise<void> {
    return this.enqueueOp(() => this.doStop(manual));
  }

  private async doStop(manual = false): Promise<void> {
    if (manual) {
      this._reactingToFlag = true;
      this.lifecycle.setManualStop(true);
      this._reactingToFlag = false;
    }

    this.stopHealthPolling();

    if (!this.child) {
      if (this._serverState !== 'stopped') {
        this.outputChannel.info(`[${this.windowName}] Detaching from server (owned by another window).`);
        this.setState('stopped');
      }
      if (manual && this.lifecycle.isOwnedByUs()) {
        this.lifecycle.releaseOwner();
      }
      return;
    }

    this.outputChannel.info(`[${this.windowName}] Stopping server...`);
    await this.killChild();

    const keepLock = this._restarting || this.lifecycle.isRestarting();
    if (!keepLock) {
      this.lifecycle.releaseOwner();
    }
  }

  private killChild(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.child = null;
    this._isOwner = false;

    return new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }

  async restart(): Promise<void> {
    return this.enqueueOp(() => this.doRestart());
  }

  /**
   * Restart without toggling the manual-stop flag (that flag is a global
   * "user stopped the server" signal and previously caused every observer
   * window to spawn on flag removal). Ownership is transferred via the
   * generation lock; other windows wait or attach as observers.
   */
  private async doRestart(): Promise<void> {
    this._restarting = true;
    this._reactingToFlag = true;
    try {
      this.lifecycle.beginRestart();
      if (this.child) {
        await this.doStop(false);
      } else {
        this.stopHealthPolling();
      }

      const deadline = Date.now() + RESTART_WAIT_DOWN_MS;
      while (Date.now() < deadline) {
        if (!(await this.probeExistingServer())) break;
        await sleep(150);
      }

      await this.doStart({ fromWatcher: true });
      if (this.child) {
        this.lifecycle.endRestart();
      } else if (this.lifecycle.isOwnedByUs()) {
        this.lifecycle.endRestart();
        this.lifecycle.releaseOwner();
      }
    } finally {
      this._reactingToFlag = false;
      this._restarting = false;
    }
  }

  async openWebClient(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = config.get<number>('serverPort', 3000);
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : formatHostForUrl(host);
    const url = `http://${displayHost}:${port}`;
    this.outputChannel.info(`[${this.windowName}] Opening web client: ${url}`);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private setState(state: ServerState): void {
    this._serverState = state;
    updateStatusBar(this.statusBarItem, state, this.lastHealth ?? undefined);
    this.emit('stateChanged', state);
  }

  private detectStatusFromLog(raw: string): void {
    try {
      const parsed = JSON.parse(raw);
      const msg: string = parsed.msg ?? '';
      if (msg.includes('[cdp-bridge] Connected to')) {
        this.setState('running');
      } else if (msg.includes('[cdp-bridge] Disconnected') || msg.includes('[cdp-bridge] Connection lost')) {
        this.setState('disconnected');
      } else if (msg.includes('[CRASH]')) {
        this.setState('error');
      }
    } catch {
      // non-JSON line, ignore
    }
  }

  private async fallbackToObserver(): Promise<void> {
    const { port, host } = this.getBind();
    const alive = await this.probeExistingServer();
    if (alive) {
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
    } else {
      this.setState('error');
    }
  }

  private async attemptTakeover(): Promise<void> {
    if (this._takingOver || this.child || this._restarting) return;

    if (this.lifecycle.isManualStopped()) {
      this.outputChannel.info(`[${this.windowName}] Manual stop active — not taking over.`);
      this.setState('stopped');
      return;
    }

    if (this.lifecycle.isRestarting()) {
      this.outputChannel.info(`[${this.windowName}] Restart in progress — not taking over.`);
      return;
    }

    this._takingOver = true;

    const jitter = Math.floor(Math.random() * MAX_TAKEOVER_JITTER_MS);
    this.outputChannel.info(`[${this.windowName}] Owner window closed — will attempt takeover in ${jitter}ms.`);

    await new Promise(r => setTimeout(r, jitter));

    if (this.lifecycle.isManualStopped() || this.lifecycle.isRestarting()) {
      this._takingOver = false;
      if (this.lifecycle.isManualStopped()) this.setState('stopped');
      return;
    }

    const stillDown = !(await this.probeExistingServer());
    if (stillDown) {
      this.outputChannel.info(`[${this.windowName}] Server still down — taking over.`);
      this._takingOver = false;
      await this.start({ fromWatcher: true });
    } else {
      this.outputChannel.info(`[${this.windowName}] Another window took over — staying as observer.`);
      this._takingOver = false;
      const { port, host } = this.getBind();
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
    }
  }

  private startHealthPolling(_port: string, _host: string): void {
    this.stopHealthPolling();
    let pinnedUrl: string | null = null;

    let failCount = 0;
    const poll = async () => {
      const { port, host } = this.getBind();
      const urls = healthProbeUrls(host, port);
      const ordered = pinnedUrl
        ? [pinnedUrl, ...urls.filter((u) => u !== pinnedUrl)]
        : urls;
      this.healthProbe.setPassword(this.getWebappPassword());
      const result = await this.healthProbe.probe(ordered, 3000);
      if (result?.detailed) {
        pinnedUrl = result.url;
        failCount = 0;
        const data = result.body as HealthData;
        this.applyDetailedHealth(data);
        this.setState(data.connected ? 'running' : 'disconnected');
        this.emit('health', data);
        return;
      }
      if (result) {
        // Reachable but public-only (LAN without a usable session). Do not
        // treat that as loopback-safe detailed health, and do not take over.
        failCount = 0;
        this.setState('disconnected');
        return;
      }
      failCount++;
      if (!this.child && failCount >= 3) {
        this.outputChannel.info(`[${this.windowName}] External server no longer reachable.`);
        this.stopHealthPolling();
        this.attemptTakeover().catch(() => this.setState('error'));
      }
    };

    this.healthTimer = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    setTimeout(poll, 2000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  dispose(): void {
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.stopHealthPolling();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}