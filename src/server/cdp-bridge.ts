import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import type { ServerConfig, CursorWindow } from './types.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Extract the workspace folder name from a connected Cursor renderer page.
 * Uses vscode.context.configuration().workspace.uri which is available in every
 * Cursor/VS Code Electron renderer — stable across platforms and not affected
 * by the volatile document.title / CDP target title.
 */
export async function extractWorkspaceName(client: CdpClient, includeQualifier = true): Promise<string | null> {
  try {
    const raw = await client.evaluate(`
      (() => {
        try {
          const ws = vscode.context.configuration().workspace;
          if (!ws || !ws.uri) return null;
          return JSON.stringify({ path: ws.uri.path, authority: ws.uri.authority || '' });
        } catch { return null; }
      })()
    `, 3000);
    if (!raw || typeof raw !== 'string') return null;
    const { path, authority } = JSON.parse(raw) as { path: string; authority: string };
    if (!path) return null;
    const basename = path.split('/').filter(Boolean).pop() || path;
    if (!includeQualifier) return basename;
    const qualifier = authorityToQualifier(authority);
    return qualifier ? `${basename} ${qualifier}` : basename;
  } catch {
    return null;
  }
}

/** Fallback title parsing for non-connected windows (before Runtime.evaluate is available). */
export function parseCdpTitle(raw: string): string {
  let title = raw;
  const cursorSuffix = ' - Cursor';
  if (title.endsWith(cursorSuffix)) {
    title = title.slice(0, -cursorSuffix.length);
  }
  const dashParts = title.split(' - ');
  if (dashParts.length >= 3) {
    title = dashParts[dashParts.length - 2];
  } else if (dashParts.length === 2) {
    title = dashParts[dashParts.length - 1];
  }
  return title.trim();
}

function authorityToQualifier(authority: string): string {
  if (!authority) return '';
  if (authority.startsWith('wsl+')) {
    return `[WSL: ${authority.slice(4)}]`;
  }
  if (authority.startsWith('ssh-remote+')) {
    const hex = authority.slice('ssh-remote+'.length);
    try {
      const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: string };
      return decoded.hostName ? `[SSH: ${decoded.hostName}]` : `[SSH]`;
    } catch {
      return `[SSH: ${hex.substring(0, 16)}]`;
    }
  }
  return `[${authority}]`;
}

export class CDPBridge extends EventEmitter {
  private config: ServerConfig;
  private client: CdpClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private intentionalDisconnect = false;
  private _activeTargetId = '';
  /** Last requested / successfully connected target — used after switch/disconnect so reconnect does not fall back to the first window. */
  private _preferredTargetId = '';
  private connectGen = 0;
  private _windows: CursorWindow[] = [];
  private _activeWorkspaceName: string | null = null;

  constructor(config: ServerConfig) {
    super();
    this.config = config;
  }

  get activeTargetId(): string {
    return this._activeTargetId;
  }

  get windows(): CursorWindow[] {
    return this._windows;
  }

  /**
   * Discover and connect to a workbench target.
   * A specific `targetId` or remembered `_preferredTargetId` must exist and
   * handshake — never silently replaced with the first window. The first
   * workbench/page is used only when no target has been requested yet.
   * When `required` is set, failures are rethrown to the caller (switchWindow);
   * otherwise they schedule reconnect with backoff.
   */
  async connect(targetId?: string, opts?: { required?: boolean }): Promise<void> {
    const required = opts?.required === true;
    const gen = ++this.connectGen;
    if (targetId) this._preferredTargetId = targetId;
    this.cancelReconnect();
    this.detachClient();

    try {
      const targets = await this.fetchTargets(true);
      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      this._windows = this.targetsToWindows(targets);

      const wantedId = targetId || this._preferredTargetId;
      let target: CDPTarget | undefined;
      if (wantedId) {
        target = targets.find(t => t.id === wantedId);
        if (!target) {
          throw new Error(`CDP target not found: ${wantedId}`);
        }
        if (!target.webSocketDebuggerUrl) {
          throw new Error(`CDP target has no debugger URL: ${wantedId}`);
        }
      } else {
        target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
        if (!target) {
          target = targets.find(t => t.type === 'page');
        }
        if (!target?.webSocketDebuggerUrl) {
          throw new Error('No suitable CDP target found');
        }
      }

      console.log(`[cdp-bridge] Connecting to target: "${target.title}" (${target.url})`);

      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }

      this.client = new CdpClient();
      this.client.on('disconnected', () => {
        if (!this.intentionalDisconnect) {
          console.warn('[cdp-bridge] CDP connection lost unexpectedly');
          this.handleDisconnect();
        }
      });
      await this.client.connect(target.webSocketDebuggerUrl);
      if (gen !== this.connectGen) {
        this.detachClient();
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      this._activeTargetId = target.id;
      this._preferredTargetId = target.id;

      this._activeWorkspaceName = await extractWorkspaceName(this.client, this.config.windowTitleQualifier);
      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      if (this._activeWorkspaceName) {
        const win = this._windows.find(w => w.id === target!.id);
        if (win) win.title = this._activeWorkspaceName;
        console.log(`[cdp-bridge] Workspace name: "${this._activeWorkspaceName}"`);
      }

      this.reconnectDelay = 1000;
      console.log('[cdp-bridge] Connected successfully');
      this.emit('connected');
    } catch (err) {
      if (gen !== this.connectGen) {
        if (required) throw err;
        return;
      }
      this.detachClient();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cdp-bridge] Connection failed: ${message}`);
      this.emit('error', err);
      this.scheduleReconnect();
      if (required) throw err;
    }
  }

  async switchWindow(targetId: string): Promise<void> {
    if (targetId === this._activeTargetId && this.isConnected()) return;

    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.reconnectDelay = 1000;
    this.detachClient();
    this._activeTargetId = '';
    this._preferredTargetId = targetId;
    this.emit('disconnected');

    this.intentionalDisconnect = false;
    await this.connect(targetId, { required: true });
    if (!this.isConnected() || this._activeTargetId !== targetId) {
      throw new Error(`Failed to switch to CDP target ${targetId}`);
    }
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    try {
      const targets = await this.fetchTargets();
      this._windows = this.targetsToWindows(targets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cdp-bridge] Failed to refresh windows: ${message}`);
    }
    return this._windows;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.connectGen++;
    this.cancelReconnect();
    this.detachClient();
    this._activeTargetId = '';
    this._preferredTargetId = '';
  }

  getClient(): CdpClient | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isConnected();
  }

  private async fetchTargets(verbose = false): Promise<CDPTarget[]> {
    const url = `${this.config.cdpUrl}/json`;
    if (verbose) console.log(`[cdp-bridge] Discovering targets at ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
    }

    const targets: CDPTarget[] = await response.json() as CDPTarget[];
    if (verbose) {
      const pages = targets.filter(t => t.type === 'page');
      const rest = targets.filter(t => t.type !== 'page');
      const summary = Object.entries(
        rest.reduce<Record<string, number>>((acc, t) => { acc[t.type] = (acc[t.type] ?? 0) + 1; return acc; }, {})
      ).map(([type, count]) => `${count} ${type}`).join(', ');
      console.log(`[cdp-bridge] Found ${pages.length} page(s)${summary ? ` (+${summary})` : ''}:`);
      for (const t of pages) {
        console.log(`  [page] "${t.title}" — ${t.url}`);
      }
    }
    return targets;
  }

  private targetsToWindows(targets: CDPTarget[]): CursorWindow[] {
    return targets
      .filter(t => t.type === 'page' && t.url.includes('workbench'))
      .map(t => {
        // For the connected window, prefer the workspace name extracted via Runtime.evaluate
        if (t.id === this._activeTargetId && this._activeWorkspaceName) {
          return { id: t.id, title: this._activeWorkspaceName, url: t.url, wsUrl: t.webSocketDebuggerUrl };
        }
        // Fallback: parse the CDP target title (used for non-connected windows
        // until they get polled with their own temporary CDP connection)
        return { id: t.id, title: parseCdpTitle(t.title), url: t.url, wsUrl: t.webSocketDebuggerUrl };
      });
  }

  private detachClient(): void {
    if (!this.client) return;
    this.client.removeAllListeners();
    this.client.disconnect();
    this.client = null;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleDisconnect(): void {
    this.detachClient();
    this._activeTargetId = '';
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    console.log(`[cdp-bridge] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      await this.connect(this._preferredTargetId || undefined);
    }, this.reconnectDelay);
  }
}
