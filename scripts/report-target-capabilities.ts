/**
 * Strictly passive, read-only capability reporter for Cursor CDP targets.
 *
 * Verifies /json/version is Cursor, lists /json, scores page Workbench targets,
 * then independently connects each eligible target and runs only
 * probePassiveCapabilities plus a read-only workspace identity query.
 *
 * Never clicks, focuses, scrolls, switches windows, runs InteractiveProbe,
 * or writes adapters. Output is redacted JSON (no websocket URLs, tokens,
 * chat text, titles, raw URLs, or full local paths).
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient } from '../src/server/cdp-client.js';
import { probePassiveCapabilities } from '../src/server/passive-capability-probe.js';
import {
  fetchCdpJson,
  probeCursorEndpoint,
  redactDiscoveryText,
  scoreCursorTargets,
  type TargetDescriptor,
  type TargetScore,
} from '../src/server/target-discovery.js';
import type {
  DiscoveryDiagnosticCode,
  EndpointIdentity,
  MenuCompleteness,
  ModeCapability,
  ModelCapabilitySnapshot,
  ToolCapability,
} from '../src/server/types.js';

export const PASSIVE_CURRENT_VALUE_LIMITATION =
  'Passive/current-value only: this report reads currently visible Mode, Model, and Tool signals. It does not open menus, click, focus, scroll, or switch windows, so lists are not a complete selectable inventory. Model completeness cannot be proven complete and is reported as unknown/partial. Tools are never marked executable.';

export const WORKSPACE_IDENTITY_EXPRESSION = `(() => {
  try {
    const ws = vscode.context.configuration().workspace;
    if (!ws || !ws.uri) return null;
    return JSON.stringify({ path: ws.uri.path || '' });
  } catch { return null; }
})()`;

const FORBIDDEN_OUTPUT_RE = /\bws[s]?:\/\/|webSocketDebuggerUrl|Bearer\s+[A-Za-z0-9._-]+|\/(?:Users|home|root)\/[^\s"]+|[A-Za-z]:\\[^\s"]+/i;

export interface CdpClientLike {
  connect(wsUrl: string, timeoutMs?: number): Promise<void>;
  disconnect(): void;
  evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
}

export interface ReportTargetCapabilitiesDeps {
  probeEndpoint: (cdpUrl: string) => Promise<EndpointIdentity>;
  listTargets: (cdpUrl: string) => Promise<TargetDescriptor[]>;
  scoreTargets: (targets: TargetDescriptor[]) => TargetScore[];
  createClient: () => CdpClientLike;
  probePassive: (
    client: CdpClientLike,
    modeSelectors?: string[],
    modelSelectors?: string[],
  ) => Promise<{
    composerReady: boolean;
    modes: ModeCapability[];
    models: ModelCapabilitySnapshot;
    tools: ToolCapability[];
    observedAt: number;
  }>;
  queryWorkspacePath: (client: CdpClientLike) => Promise<string | null>;
  now: () => number;
}

export interface WorkspaceIdentity {
  token: string;
  basename: string;
}

export interface TargetListEntry {
  id: string;
  type: string;
  eligible: boolean;
  score: number;
  reasons: string[];
}

export interface SanitizedMode {
  id: string;
  label: string;
  current: boolean;
  source: string;
}

export interface SanitizedModels {
  completeness: Exclude<MenuCompleteness, 'complete'> | 'unknown';
  filterActive: boolean;
  observedAt: number;
  items: Array<{ id: string; label: string; selected: boolean; scope: string }>;
}

export interface SanitizedTool {
  id: string;
  type: string;
  executable: false;
  actions: [];
}

export interface TargetProbeResult {
  targetId: string;
  workspace: WorkspaceIdentity | null;
  composerReady: boolean;
  modes: SanitizedMode[];
  models: SanitizedModels;
  tools: SanitizedTool[];
  observedAt: number;
  error?: { code: DiscoveryDiagnosticCode; message: string };
}

export interface TargetCapabilityReport {
  limitationKind: 'passive_current_value_only';
  limitation: string;
  endpoint: {
    verified: boolean;
    browserFamily: EndpointIdentity['browserFamily'];
    protocolVersion: string;
    product: string;
    diagnosticCode: DiscoveryDiagnosticCode;
    diagnosticMessage: string;
  };
  targets: TargetListEntry[];
  probes: TargetProbeResult[];
  observedAt: number;
  error?: { code: DiscoveryDiagnosticCode; message: string };
}

export function defaultReportDeps(): ReportTargetCapabilitiesDeps {
  return {
    probeEndpoint: probeCursorEndpoint,
    listTargets: async (cdpUrl) => {
      const base = cdpUrl.replace(/\/$/, '');
      return fetchCdpJson<TargetDescriptor[]>(`${base}/json`);
    },
    scoreTargets: scoreCursorTargets,
    createClient: () => new CdpClient(),
    probePassive: probePassiveCapabilities as ReportTargetCapabilitiesDeps['probePassive'],
    queryWorkspacePath,
    now: () => Date.now(),
  };
}

/** Extra safety net on top of scoreCursorTargets: never probe webview/worker/about:blank. */
export function applyTargetExclusions(ranked: TargetScore[]): TargetScore[] {
  return ranked.map((item) => {
    const reasons = [...item.reasons];
    let eligible = item.eligible;
    const type = item.target.type ?? '';
    const url = (item.target.url ?? '').trim();

    if (/webview/i.test(type)) {
      eligible = false;
      if (!reasons.includes('excluded_webview')) reasons.push('excluded_webview');
    }
    if (/worker/i.test(type)) {
      eligible = false;
      if (!reasons.includes('excluded_worker')) reasons.push('excluded_worker');
    }
    if (/^about:blank/i.test(url)) {
      eligible = false;
      if (!reasons.includes('excluded_about_blank')) reasons.push('excluded_about_blank');
    }
    if (type !== 'page') eligible = false;
    return { ...item, eligible, reasons };
  });
}

export function workspaceIdentityFromPath(path: string): WorkspaceIdentity | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const token = createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
  const basename = trimmed.split(/[\\/]/).filter(Boolean).pop() || '';
  if (!basename || /[\\/]/.test(basename)) return { token, basename: '[redacted]' };
  return { token, basename };
}

export async function queryWorkspacePath(client: CdpClientLike): Promise<string | null> {
  const raw = await client.evaluate(WORKSPACE_IDENTITY_EXPRESSION, 3000);
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as { path?: unknown };
      return typeof parsed.path === 'string' && parsed.path.trim() ? parsed.path : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && raw !== null && 'path' in raw) {
    const path = (raw as { path?: unknown }).path;
    return typeof path === 'string' && path.trim() ? path : null;
  }
  return null;
}

function sanitizeEndpoint(identity: EndpointIdentity): TargetCapabilityReport['endpoint'] {
  return {
    verified: identity.verified,
    browserFamily: identity.browserFamily,
    protocolVersion: identity.protocolVersion,
    product: identity.product,
    diagnosticCode: identity.diagnosticCode,
    diagnosticMessage: redactDiscoveryText(identity.diagnosticMessage),
  };
}

function forceUnknownCompleteness(value: MenuCompleteness): SanitizedModels['completeness'] {
  return value === 'partial' ? 'partial' : 'unknown';
}

function sanitizeModes(modes: ModeCapability[]): SanitizedMode[] {
  return modes.map((mode) => ({
    id: mode.id,
    label: mode.label,
    current: mode.current === true,
    source: mode.source,
  }));
}

function sanitizeModels(models: ModelCapabilitySnapshot): SanitizedModels {
  return {
    completeness: forceUnknownCompleteness(models.completeness),
    filterActive: models.filterActive === true,
    observedAt: models.observedAt,
    items: models.items.map((item) => ({
      id: item.id,
      label: item.label,
      selected: item.selected === true,
      scope: item.scope,
    })),
  };
}

function sanitizeTools(tools: ToolCapability[]): SanitizedTool[] {
  return tools.map((tool) => ({
    id: tool.id,
    type: tool.type,
    executable: false,
    actions: [],
  }));
}

function listEntry(item: TargetScore): TargetListEntry {
  return {
    id: item.target.id,
    type: item.target.type,
    eligible: item.eligible,
    score: item.score,
    reasons: [...item.reasons],
  };
}

function unavailableError(code: DiscoveryDiagnosticCode, err: unknown): { code: DiscoveryDiagnosticCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { code, message: redactDiscoveryText(message) };
}

function assertNoSensitiveOutput(report: TargetCapabilityReport): TargetCapabilityReport {
  const json = JSON.stringify(report);
  if (FORBIDDEN_OUTPUT_RE.test(json) || json.includes('webSocketDebuggerUrl')) {
    throw new Error('Capability report contained forbidden sensitive fields');
  }
  return report;
}

export async function reportTargetCapabilities(
  cdpUrl: string,
  deps: ReportTargetCapabilitiesDeps = defaultReportDeps(),
): Promise<TargetCapabilityReport> {
  const observedAt = deps.now();
  const identity = await deps.probeEndpoint(cdpUrl);
  const base: TargetCapabilityReport = {
    limitationKind: 'passive_current_value_only',
    limitation: PASSIVE_CURRENT_VALUE_LIMITATION,
    endpoint: sanitizeEndpoint(identity),
    targets: [],
    probes: [],
    observedAt,
  };

  if (!identity.verified) {
    return assertNoSensitiveOutput({
      ...base,
      error: {
        code: identity.diagnosticCode,
        message: redactDiscoveryText(identity.diagnosticMessage),
      },
    });
  }

  let rawTargets: TargetDescriptor[];
  try {
    rawTargets = await deps.listTargets(cdpUrl);
  } catch (err) {
    return assertNoSensitiveOutput({
      ...base,
      error: unavailableError('target_list_failed', err),
    });
  }

  const ranked = applyTargetExclusions(deps.scoreTargets(rawTargets));
  base.targets = ranked.map(listEntry);

  const eligible = ranked.filter((item) => item.eligible && item.target.webSocketDebuggerUrl);
  for (const item of eligible) {
    const wsUrl = item.target.webSocketDebuggerUrl!;
    const client = deps.createClient();
    const probe: TargetProbeResult = {
      targetId: item.target.id,
      workspace: null,
      composerReady: false,
      modes: [],
      models: { completeness: 'unknown', filterActive: false, observedAt, items: [] },
      tools: [],
      observedAt,
    };
    try {
      await client.connect(wsUrl);
      try {
        const path = await deps.queryWorkspacePath(client);
        probe.workspace = path ? workspaceIdentityFromPath(path) : null;
      } catch (err) {
        probe.error = unavailableError('runtime_evaluate_failed', err);
      }
      try {
        const observed = await deps.probePassive(client, [], []);
        probe.composerReady = observed.composerReady === true;
        probe.modes = sanitizeModes(observed.modes);
        probe.models = sanitizeModels(observed.models);
        probe.tools = sanitizeTools(observed.tools);
        probe.observedAt = observed.observedAt;
      } catch (err) {
        probe.error = unavailableError('runtime_evaluate_failed', err);
      }
    } catch (err) {
      probe.error = unavailableError('target_unverified', err);
    } finally {
      try { client.disconnect(); } catch { /* ignore teardown */ }
    }
    base.probes.push(probe);
  }

  return assertNoSensitiveOutput(base);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

async function main(): Promise<void> {
  const cdpUrl = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
  const report = await reportTargetCapabilities(cdpUrl);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.endpoint.verified || report.error) process.exitCode = 1;
}

if (invokedDirectly()) {
  main().catch((err) => {
    const message = redactDiscoveryText(err instanceof Error ? err.message : String(err));
    process.stderr.write(`${JSON.stringify({ error: message, limitationKind: 'passive_current_value_only' })}\n`);
    process.exitCode = 1;
  });
}