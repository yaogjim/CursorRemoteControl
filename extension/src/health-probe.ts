/**
 * Extension-side health probing.
 *
 * Loopback fetches look like local observers to Relay and get full /health.
 * A concrete LAN/Tailscale bind does not accept 127.0.0.1/::1, and an
 * unauthenticated fetch of that bind host only returns the public body
 * (no `connected`). In that case the probe logs in with the configured
 * web password (POST body, never in the URL) and retries with Bearer.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface PublicHealthBody {
  ok: boolean;
  authRequired?: boolean;
  sessionValid?: boolean;
}

export interface DetailedHealthBody extends PublicHealthBody {
  connected: boolean;
  extractorStatus?: string;
  lastExtractionAt?: number | null;
  consecutiveExtractionFailures?: number;
  lastExtractionError?: string | null;
  agentStatus?: string;
  clients?: number;
  uptime?: number;
  windows?: { id: string; title: string }[];
  activeWindowId?: string;
  mode?: string | null;
  model?: string | null;
  chatTabCount?: number;
  pendingApprovalCount?: number;
  generation?: number;
}

export interface HealthProbeResult {
  url: string;
  body: PublicHealthBody | DetailedHealthBody;
  detailed: boolean;
}

export function formatHostForUrl(host: string): string {
  const h = stripBrackets(host).trim();
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

export function stripBrackets(host: string): string {
  const h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return h;
}

function isIPv6Host(host: string): boolean {
  const h = stripBrackets(host).trim().toLowerCase();
  if (h === 'localhost') return false;
  return h.includes(':');
}

export function isLoopbackProbeHost(host: string): boolean {
  const h = stripBrackets(host).trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

export function isWildcardBindHost(host: string): boolean {
  const h = stripBrackets(host).trim().toLowerCase();
  return h === '0.0.0.0' || h === '::' || h === '::0' || h === '0:0:0:0:0:0:0:0';
}

/** Loopback hosts to try, preferred family first. */
export function localHealthProbeHosts(bindHost: string): string[] {
  const ipv4 = '127.0.0.1';
  const ipv6 = '::1';
  if (isIPv6Host(bindHost)) return [ipv6, ipv4];
  return [ipv4, ipv6];
}

export function localHealthProbeUrls(bindHost: string, port: string | number): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const host of localHealthProbeHosts(bindHost)) {
    const url = `http://${formatHostForUrl(host)}:${port}/health`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Probe URLs: loopback first, then the configured bind host when it is a
 * concrete address (LAN / Tailscale). Wildcards are not connectable.
 */
export function healthProbeUrls(bindHost: string, port: string | number): string[] {
  const urls = localHealthProbeUrls(bindHost, port);
  const raw = stripBrackets(bindHost).trim();
  if (!raw || isWildcardBindHost(raw) || isLoopbackProbeHost(raw)) return urls;
  const extra = `http://${formatHostForUrl(raw)}:${port}/health`;
  if (!urls.includes(extra)) urls.push(extra);
  return urls;
}

export function isDetailedHealth(body: unknown): body is DetailedHealthBody {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return rec.ok === true && typeof rec.connected === 'boolean';
}

export function isPublicHealth(body: unknown): body is PublicHealthBody {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return rec.ok === true && typeof rec.connected !== 'boolean';
}

export function loginUrlFromHealth(healthUrl: string): string {
  return healthUrl.replace(/\/health\/?(\?.*)?$/, '/api/login$1');
}

export function probeUrlLooksLoopback(healthUrl: string): boolean {
  try {
    return isLoopbackProbeHost(new URL(healthUrl).hostname);
  } catch {
    return false;
  }
}

export interface HealthProbeClientOptions {
  password?: string;
  fetch?: FetchLike;
}

export class HealthProbeClient {
  private token: string | null = null;
  private password = '';
  private readonly fetchImpl: FetchLike;

  constructor(options?: HealthProbeClientOptions) {
    this.password = options?.password ?? '';
    this.fetchImpl = options?.fetch ?? fetch;
  }

  setPassword(password: string): void {
    if (password !== this.password) {
      this.token = null;
    }
    this.password = password;
  }

  clearToken(): void {
    this.token = null;
  }

  getToken(): string | null {
    return this.token;
  }

  async probe(urls: string[], timeoutMs: number): Promise<HealthProbeResult | null> {
    let publicAlive: HealthProbeResult | null = null;
    for (const url of urls) {
      const result = await this.probeOne(url, timeoutMs);
      if (!result) continue;
      if (result.detailed) return result;
      publicAlive ??= result;
    }
    return publicAlive;
  }

  private async probeOne(healthUrl: string, timeoutMs: number): Promise<HealthProbeResult | null> {
    let body = await this.getHealth(healthUrl, timeoutMs, this.token);
    if (body === 'network') return null;
    if (isDetailedHealth(body)) {
      return { url: healthUrl, body, detailed: true };
    }

    // LAN/Tailscale bind: public body is not loopback-safe. Authenticate.
    if (this.password && (body === 'unauthorized' || isPublicHealth(body))) {
      const loggedIn = await this.login(healthUrl, timeoutMs);
      if (loggedIn) {
        body = await this.getHealth(healthUrl, timeoutMs, this.token);
        if (body === 'network') return null;
        if (isDetailedHealth(body)) {
          return { url: healthUrl, body, detailed: true };
        }
      }
    }

    if (isPublicHealth(body)) {
      return { url: healthUrl, body, detailed: false };
    }
    return null;
  }

  private async getHealth(
    healthUrl: string,
    timeoutMs: number,
    token: string | null
  ): Promise<unknown | 'network' | 'unauthorized'> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });
    } catch {
      this.clearToken();
      return 'network';
    }
    if (resp.status === 401) {
      this.clearToken();
      return 'unauthorized';
    }
    const parsed = await readJson(resp);
    return parsed;
  }

  private async login(healthUrl: string, timeoutMs: number): Promise<boolean> {
    const loginUrl = loginUrlFromHealth(healthUrl);
    let resp: Response;
    try {
      resp = await this.fetchImpl(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      this.clearToken();
      return false;
    }
    if (!resp.ok) {
      this.clearToken();
      return false;
    }
    const data = await readJson(resp);
    const token =
      data && typeof data === 'object' && typeof (data as { token?: unknown }).token === 'string'
        ? (data as { token: string }).token.trim()
        : '';
    if (!token) {
      this.clearToken();
      return false;
    }
    this.token = token;
    return true;
  }
}

async function readJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}