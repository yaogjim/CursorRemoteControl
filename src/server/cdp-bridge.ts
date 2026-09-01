import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import type {
  ServerConfig,
  CursorWindow,
  DiscoveryDiagnostic,
  DiscoveryDiagnosticCode,
  EndpointIdentity,
  SanitizedDiscoveryStatus,
} from './types.js';
import {
  createDiscoveryDiagnostic,
  probeCursorEndpoint,
  selectCursorTarget,
  scoreCursorTargets,
  toPublicDiscoveryStatus,
} from './target-discovery.js';

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

export function isUsableWorkspaceIdentity(name: string | null | undefined): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (/^cursor$/i.test(trimmed)) return false;
  return true;
}

/**
 * Conservative candidate match: eligible page/workbench targets whose parsed
 * CDP title equals the previously verified workspace identity/name exactly.
 */
export function matchEligibleTargetsByWorkspace<T extends {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}>(targets: T[], workspaceName: string): T[] {
  if (!isUsableWorkspaceIdentity(workspaceName)) return [];
  const wanted = workspaceName.trim();
  const eligibleIds = new Set(
    scoreCursorTargets(targets)
      .filter((item) => item.eligible)
      .map((item) => item.target.id),
  );
  return targets.filter((target) => {
    if (!eligibleIds.has(target.id)) return false;
    return parseCdpTitle(target.title ?? '') === wanted;
  });
}

class TargetResolutionError extends Error {
  readonly code: DiscoveryDiagnosticCode;
  constructor(code: DiscoveryDiagnosticCode, message: string) {
    super(message);
    this.name = 'TargetResolutionError';
    this.code = code;
  }
}

type ConnectSelectionReason = 'preferred_exact' | 'preferred_remapped' | 'initial_ranked' | 'manual';

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
  /** Last requested or successfully connected target. Remapped ids are written only after handshake. */
  private _preferredTargetId = '';
  /** Target id that produced `_verifiedWorkspaceIdentity`. Remap is allowed only for this id. */
  private _lastConnectedTargetId = '';
  private connectGen = 0;
  private _windows: CursorWindow[] = [];
  private _activeWorkspaceName: string | null = null;
  private _verifiedWorkspaceIdentity: string | null = null;
  private _endpointIdentity: EndpointIdentity | null = null;
  private _targetGenerations = new Map<string, number>();
  private _discoveryLastRunAt: number | null = null;
  private _lastDiscoveryError: { code: DiscoveryDiagnosticCode; message: string } | null = null;
  private _diagnostics: DiscoveryDiagnostic[] = [];

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

  isEndpointVerified(): boolean {
    return this._endpointIdentity?.verified === true;
  }

  getEndpointIdentity(): EndpointIdentity | null {
    return this._endpointIdentity ? { ...this._endpointIdentity } : null;
  }

  getTargetGeneration(targetId?: string): number {
    const id = targetId || this._activeTargetId;
    if (!id) return 0;
    return this._targetGenerations.get(id) ?? 0;
  }

  getDiscoveryStatus(): SanitizedDiscoveryStatus {
    const verified = this.isEndpointVerified();
    const preferred = this._preferredTargetId;
    let preferredTargetPresent: boolean | null = null;
    if (preferred) {
      preferredTargetPresent = this._windows.some((w) => w.id === preferred);
    }
    let status: SanitizedDiscoveryStatus['status'] = 'idle';
    if (this._endpointIdentity) {
      if (!verified) status = 'endpoint_unverified';
      else if (this.isConnected()) status = 'ok';
      else if (
        this._lastDiscoveryError?.code === 'preferred_target_ambiguous'
        || this._lastDiscoveryError?.code === 'target_unverified'
      ) status = 'target_unverified';
      else status = 'degraded';
    }
    return toPublicDiscoveryStatus({
      status,
      identity: this._endpointIdentity,
      activeTargetId: verified ? this._activeTargetId : '',
      targetGeneration: verified ? this.getTargetGeneration() : 0,
      preferredTargetPresent,
      windowCount: verified ? this._windows.length : 0,
      lastRunAt: this._discoveryLastRunAt,
      lastError: this._lastDiscoveryError,
      diagnostics: this._diagnostics.slice(-20),
    });
  }

  /**
   * Discover and connect to a workbench target.
   * A specific `targetId` or remembered `_preferredTargetId` is kept while it
   * still exists. Automatic reconnect may uniquely remap by workspace identity
   * only after that id disappears; explicit `required` switches never remap.
   * Scoring picks a window only when no target has been requested yet.
   * When `required` is set, failures are rethrown to the caller (switchWindow);
   * otherwise they schedule reconnect with backoff.
   */
  async connect(targetId?: string, opts?: { required?: boolean }): Promise<void> {
    const required = opts?.required === true;
    const gen = ++this.connectGen;
    // Remember an explicit request so reconnect retries it. Workspace remap
    // does not write _preferredTargetId until handshake succeeds below.
    if (targetId) this._preferredTargetId = targetId;
    this.cancelReconnect();
    this.detachClient();

    try {
      const identity = await probeCursorEndpoint(this.config.cdpUrl);
      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      this._endpointIdentity = identity;
      this._discoveryLastRunAt = Date.now();
      this.pushDiagnostic(
        identity.diagnosticCode,
        identity.diagnosticMessage,
        identity.verified ? 'info' : 'error',
      );

      if (!identity.verified) {
        this._windows = [];
        this._activeTargetId = '';
        this._lastDiscoveryError = {
          code: identity.diagnosticCode,
          message: identity.diagnosticMessage,
        };
        const err = new Error(
          `CDP endpoint identity failed: ${identity.diagnosticMessage}`,
        );
        console.error(`[cdp-bridge] ${err.message}`);
        this.emit('error', err);
        this.scheduleReconnect();
        if (required) throw err;
        return;
      }

      this._lastDiscoveryError = null;

      const targets = await this.fetchTargets(true);
      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      this._windows = this.targetsToWindows(targets);

      const wantedId = targetId || this._preferredTargetId;
      const { target, reason } = this.resolveConnectTarget(targets, wantedId, required);

      console.log(`[cdp-bridge] Connecting to target: "${target.title}" (${target.url}) [${reason}]`);

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
      const debuggerUrl = target.webSocketDebuggerUrl;
      if (!debuggerUrl) {
        throw new TargetResolutionError('target_unverified', `CDP target has no debugger URL: ${target.id}`);
      }
      await this.client.connect(debuggerUrl);
      if (gen !== this.connectGen) {
        this.detachClient();
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      this._activeTargetId = target.id;
      this._preferredTargetId = target.id;
      this._lastConnectedTargetId = target.id;
      const prevGen = this._targetGenerations.get(target.id) ?? 0;
      this._targetGenerations.set(target.id, prevGen + 1);

      this._activeWorkspaceName = await extractWorkspaceName(this.client, this.config.windowTitleQualifier);
      if (gen !== this.connectGen) {
        if (required) throw new Error('CDP connect superseded');
        return;
      }
      const titleIdentity = parseCdpTitle(target.title);
      this._verifiedWorkspaceIdentity = isUsableWorkspaceIdentity(this._activeWorkspaceName)
        ? this._activeWorkspaceName
        : (isUsableWorkspaceIdentity(titleIdentity) ? titleIdentity : null);
      if (this._activeWorkspaceName) {
        const win = this._windows.find(w => w.id === target.id);
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
      if (err instanceof TargetResolutionError) {
        this._lastDiscoveryError = { code: err.code, message: err.message };
        this.pushDiagnostic(err.code, err.message, 'error', {
          targetId: this._preferredTargetId || undefined,
        });
      }
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
    if (!this.isEndpointVerified()) {
      this._windows = [];
      return this._windows;
    }
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
    this._lastConnectedTargetId = '';
    this._activeWorkspaceName = null;
    this._verifiedWorkspaceIdentity = null;
  }

  getClient(): CdpClient | null {
    if (!this.isEndpointVerified()) return null;
    return this.client;
  }

  isConnected(): boolean {
    return this.isEndpointVerified() && this.client !== null && this.client.isConnected();
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

  private resolveConnectTarget(
    targets: CDPTarget[],
    wantedId: string,
    required: boolean,
  ): { target: CDPTarget; reason: ConnectSelectionReason } {
    if (!wantedId) {
      const selected = selectCursorTarget(targets);
      const target = selected ? targets.find((candidate) => candidate.id === selected.id) : undefined;
      if (!target?.webSocketDebuggerUrl) {
        const ranked = scoreCursorTargets(targets);
        const details = ranked.slice(0, 5).map((item) => `${item.target.type}:${item.score}`).join(', ');
        throw new TargetResolutionError(
          'target_unverified',
          `No verified Cursor workbench target found${details ? ` (scores: ${details})` : ''}`,
        );
      }
      return { target, reason: 'initial_ranked' };
    }

    const existing = targets.find((candidate) => candidate.id === wantedId);
    if (existing) {
      const eligible = existing.type === 'page'
        && /workbench/i.test(`${existing.url} ${existing.title}`)
        && !!existing.webSocketDebuggerUrl;
      if (eligible) {
        return { target: existing, reason: required ? 'manual' : 'preferred_exact' };
      }
      if (!existing.webSocketDebuggerUrl && existing.type === 'page' && /workbench/i.test(`${existing.url} ${existing.title}`)) {
        throw new TargetResolutionError('target_unverified', `CDP target has no debugger URL: ${wantedId}`);
      }
      throw new TargetResolutionError('target_unverified', `CDP target not found: ${wantedId}`);
    }

    const allowRemap = !required && wantedId === this._lastConnectedTargetId;
    const identity = this._verifiedWorkspaceIdentity;
    if (allowRemap && isUsableWorkspaceIdentity(identity)) {
      const matches = matchEligibleTargetsByWorkspace(targets, identity);
      if (matches.length === 1) {
        const remapped = matches[0];
        this.pushDiagnostic(
          'identity_ok',
          'Preferred target remapped uniquely by workspace identity',
          'info',
          {
            targetId: remapped.id,
            evidence: { reason: 'preferred_remapped', previousTargetId: wantedId },
          },
        );
        return { target: remapped, reason: 'preferred_remapped' };
      }
      if (matches.length > 1) {
        throw new TargetResolutionError(
          'preferred_target_ambiguous',
          `Preferred target ${wantedId} is gone and workspace identity matches ${matches.length} windows`,
        );
      }
      throw new TargetResolutionError(
        'target_unverified',
        `Preferred target ${wantedId} is gone and no unique workspace match was found`,
      );
    }

    throw new TargetResolutionError('target_unverified', `CDP target not found: ${wantedId}`);
  }

  private pushDiagnostic(
    code: DiscoveryDiagnosticCode,
    message: string,
    severity: 'info' | 'warning' | 'error' = 'error',
    extras: { targetId?: string; evidence?: DiscoveryDiagnostic['evidence'] } = {},
  ): void {
    this._diagnostics.push(createDiscoveryDiagnostic(code, message, { severity, ...extras }));
    if (this._diagnostics.length > 50) {
      this._diagnostics.splice(0, this._diagnostics.length - 50);
    }
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
