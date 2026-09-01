import type {
  BrowserFamily,
  CdpVersionInfo,
  DiscoveryDiagnostic,
  DiscoveryDiagnosticCode,
  DiscoveryStatus,
  EndpointIdentity,
  SanitizedDiscoveryStatus,
} from './types.js';

/** Versioned Cursor product token in Chromium User-Agent strings. */
export const CURSOR_USER_AGENT_RE = /\bCursor\/\d/i;
const VSCODE_USER_AGENT_RE = /\b(?:VSCode|Code)\/\d/i;
const CHROME_USER_AGENT_RE = /\bChrome\/\d/i;

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

export interface TargetDescriptor {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface TargetScore { target: TargetDescriptor; score: number; reasons: string[]; eligible: boolean; }

/** Deterministic pre-connect ranking. It is not an identity substitute. */
export function scoreCursorTargets(targets: TargetDescriptor[]): TargetScore[] {
  return targets.map((target) => {
    const reasons: string[] = [];
    let score = 0;
    if (target.type === 'page') { score += 40; reasons.push('page'); } else reasons.push('non_page');
    if (target.url?.includes('workbench')) { score += 40; reasons.push('workbench_url'); }
    if (target.url?.startsWith('vscode-file:') || target.url?.startsWith('file:')) { score += 10; reasons.push('renderer_url'); }
    if (/cursor|workbench/i.test(target.title ?? '')) { score += 10; reasons.push('workbench_title'); }
    if (target.webSocketDebuggerUrl) { score += 5; reasons.push('debugger_url'); }
    return { target, score, reasons, eligible: target.type === 'page' && !!target.webSocketDebuggerUrl && /workbench/i.test(`${target.url ?? ''} ${target.title ?? ''}`) };
  }).sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
}

export function selectCursorTarget(targets: TargetDescriptor[], preferredTargetId = ''): TargetDescriptor | null {
  const ranked = scoreCursorTargets(targets);
  if (preferredTargetId) return ranked.find((item) => item.target.id === preferredTargetId && item.eligible)?.target ?? null;
  return ranked.find((item) => item.eligible)?.target ?? null;
}


export function cdpVersionUserAgent(version: CdpVersionInfo | null | undefined): string {
  if (!version) return '';
  return (version['User-Agent'] ?? version.UserAgent ?? '').trim();
}

export function extractProductToken(userAgent: string): string {
  const cursor = userAgent.match(/\bCursor\/[\d.]+/i);
  if (cursor) return cursor[0];
  const code = userAgent.match(/\b(?:VSCode|Code)\/[\d.]+/i);
  if (code) return code[0];
  const electron = userAgent.match(/\bElectron\/[\d.]+/i);
  if (electron) return electron[0];
  const chrome = userAgent.match(/\bChrome\/[\d.]+/i);
  if (chrome) return chrome[0];
  return '';
}

export function classifyBrowserFamily(userAgent: string | undefined): BrowserFamily {
  const ua = userAgent ?? '';
  if (CURSOR_USER_AGENT_RE.test(ua)) return 'cursor';
  if (VSCODE_USER_AGENT_RE.test(ua)) return 'vscode';
  if (CHROME_USER_AGENT_RE.test(ua)) return 'chrome';
  return 'unknown';
}

export function verifyEndpointIdentity(version: CdpVersionInfo | null | undefined): EndpointIdentity {
  if (!version) {
    return {
      verified: false,
      browserFamily: 'unknown',
      protocolVersion: '',
      product: '',
      diagnosticCode: 'endpoint_unverified',
      diagnosticMessage: 'No /json/version payload',
    };
  }

  const ua = cdpVersionUserAgent(version);
  const family = classifyBrowserFamily(ua);
  const product = extractProductToken(ua);
  const protocolVersion = version['Protocol-Version'] ?? '';

  if (family === 'cursor') {
    return {
      verified: true,
      browserFamily: 'cursor',
      protocolVersion,
      product,
      diagnosticCode: 'identity_ok',
      diagnosticMessage: 'Cursor endpoint verified',
    };
  }

  const label = family === 'unknown' ? (ua ? 'unknown application' : 'missing User-Agent') : family;
  return {
    verified: false,
    browserFamily: family,
    protocolVersion,
    product,
    diagnosticCode: 'endpoint_unverified',
    diagnosticMessage: `CDP endpoint is ${label}, not Cursor`,
  };
}

export async function fetchCdpJson<T>(url: string, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function diagnosticCodeFromFetchError(err: unknown): DiscoveryDiagnosticCode {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
    return 'cdp_unreachable';
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(message)) {
    return 'cdp_unreachable';
  }
  return 'endpoint_unverified';
}

/**
 * Hard identity gate: GET `${cdpUrl}/json/version` and require a Cursor User-Agent.
 * Scores cannot compensate for a failed identity check.
 */
export async function probeCursorEndpoint(
  cdpUrl: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<EndpointIdentity> {
  const base = cdpUrl.replace(/\/$/, '');
  try {
    const version = await fetchCdpJson<CdpVersionInfo>(`${base}/json/version`, timeoutMs);
    return verifyEndpointIdentity(version);
  } catch (err) {
    const code = diagnosticCodeFromFetchError(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      browserFamily: 'unknown',
      protocolVersion: '',
      product: '',
      diagnosticCode: code,
      diagnosticMessage: `Failed to read /json/version: ${message}`,
    };
  }
}

export function createDiscoveryDiagnostic(
  code: DiscoveryDiagnosticCode,
  message: string,
  extras: Partial<Pick<DiscoveryDiagnostic, 'severity' | 'windowId' | 'targetId' | 'evidence'>> = {},
): DiscoveryDiagnostic {
  const severity = extras.severity ?? (code === 'identity_ok' ? 'info' : 'error');
  return {
    id: `${code}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    severity,
    windowId: extras.windowId,
    targetId: extras.targetId,
    message,
    evidence: extras.evidence ?? {},
    createdAt: Date.now(),
  };
}

export interface DiscoveryStatusInput {
  status: DiscoveryStatus;
  identity: EndpointIdentity | null;
  activeTargetId: string;
  targetGeneration: number;
  preferredTargetPresent: boolean | null;
  windowCount: number;
  lastRunAt: number | null;
  lastError: { code: DiscoveryDiagnosticCode; message: string } | null;
  diagnostics: DiscoveryDiagnostic[];
  capabilities?: SanitizedDiscoveryStatus['capabilities'];
}

/**
 * Strip WS URLs, raw User-Agents, workspace paths, and other sensitive fields.
 */
export function toPublicDiscoveryStatus(input: DiscoveryStatusInput): SanitizedDiscoveryStatus {
  const identity = input.identity;
  return {
    status: input.status,
    endpoint: {
      verified: identity?.verified === true,
      browserFamily: identity?.browserFamily ?? 'unknown',
      protocolVersion: identity?.protocolVersion ?? '',
      product: identity?.product ?? '',
    },
    activeTargetId: identity?.verified ? input.activeTargetId : '',
    targetGeneration: identity?.verified ? input.targetGeneration : 0,
    preferredTargetPresent: input.preferredTargetPresent,
    windowCount: identity?.verified ? input.windowCount : 0,
    lastRunAt: input.lastRunAt,
    lastError: input.lastError
      ? { code: input.lastError.code, message: redactDiscoveryText(input.lastError.message) }
      : null,
    diagnostics: input.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      message: redactDiscoveryText(d.message),
      ...(d.targetId ? { targetId: d.targetId } : {}),
    })),
    capabilities: input.capabilities ?? null,
  };
}

/** Drop websocket URLs, http(s) URLs, and home/drive filesystem paths. */
export function redactDiscoveryText(text: string): string {
  return text
    .replace(/\bws[s]?:\/\/\S+/gi, '[ws]')
    .replace(/\bhttps?:\/\/\S+/gi, '[url]')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/(?:Users|home|root)\/[^\s]+/g, '[path]');
}