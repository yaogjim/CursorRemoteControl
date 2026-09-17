import type {
  CommandResult,
  PlanCommandFailure,
  PlanFailureCode,
  PlanFailureStage,
  PlanRequestedTarget,
} from './types.js';

export const PLAN_FAILURE_CODES = [
  'session',
  'window',
  'connection',
  'expired',
  'extraction',
  'auth',
  'busy',
  'invalid',
  'plan',
  'file',
  'unknown',
] as const satisfies readonly PlanFailureCode[];

export const PLAN_FAILURE_STAGES = [
  'validate',
  'guard',
  'discover',
  'resolve',
  'read',
  'emit',
] as const satisfies readonly PlanFailureStage[];

export const PLAN_GUARD_STALE_MS = 15_000;
/** Same upper bound as OPERATION_ID_RE; diagnostic copies never truncate into another id. */
export const PLAN_DIAGNOSTIC_ID_MAX = 128;
const PLAN_DIAGNOSTIC_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface PlanGuardSnapshot {
  socketConnected: boolean;
  authEnabled: boolean;
  hasAuthSession: boolean;
  connected: boolean;
  extractorStatus: string;
  lastExtractionAt: number | null | undefined;
  activeWindowId?: string | null;
  activeComposerId?: string | null;
  activeTargetId?: string | null;
  requestedWindowId?: string;
  requestedComposerId?: string;
  now?: number;
  invalidated?: boolean;
  epochMatch?: boolean;
}

function isSafePlanDiagnosticId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PLAN_DIAGNOSTIC_ID_MAX) {
    return false;
  }
  if (value !== value.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return false;
  return PLAN_DIAGNOSTIC_ID_RE.test(value);
}

/** Copy only the caller-requested identifiers. Drop paths, secrets, and other targets. */
export function planRequestedTarget(payload: {
  windowId?: unknown;
  composerId?: unknown;
  planId?: unknown;
} | null | undefined): PlanRequestedTarget | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const requested: PlanRequestedTarget = {};
  if (isSafePlanDiagnosticId(payload.windowId)) requested.windowId = payload.windowId;
  if (isSafePlanDiagnosticId(payload.composerId)) requested.composerId = payload.composerId;
  if (isSafePlanDiagnosticId(payload.planId)) requested.planId = payload.planId;
  return Object.keys(requested).length > 0 ? requested : undefined;
}

export function planCommandFailure(input: {
  code: PlanFailureCode;
  stage: PlanFailureStage;
  commandId: string;
  requested?: PlanRequestedTarget;
}): PlanCommandFailure {
  const failure: PlanCommandFailure = {
    code: input.code,
    stage: input.stage,
    commandId: input.commandId,
  };
  const requested = planRequestedTarget(input.requested ?? {});
  if (requested) failure.requested = requested;
  return failure;
}

export function sanitizePlanFailure(value: unknown): PlanCommandFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isSafePlanDiagnosticId(raw.commandId)) return undefined;
  if (!(PLAN_FAILURE_CODES as readonly string[]).includes(raw.code as string)) return undefined;
  if (!(PLAN_FAILURE_STAGES as readonly string[]).includes(raw.stage as string)) return undefined;
  const requested = raw.requested == null ? undefined : planRequestedTarget(raw.requested as PlanRequestedTarget);
  return planCommandFailure({
    code: raw.code as PlanFailureCode,
    stage: raw.stage as PlanFailureStage,
    commandId: raw.commandId,
    requested,
  });
}

/**
 * Map observable local guard conditions to a stable code.
 * Compares against the requested ids internally; the returned code never
 * embeds the other window/session identity, a path, or a secret.
 */
export function diagnosePlanGuardFailure(snapshot: PlanGuardSnapshot): PlanFailureCode | null {
  if (!snapshot.socketConnected || (snapshot.authEnabled && !snapshot.hasAuthSession)) return 'auth';
  if (!snapshot.connected) return 'connection';
  if (snapshot.extractorStatus !== 'ok') return 'extraction';
  const now = snapshot.now ?? Date.now();
  const extractedAt = snapshot.lastExtractionAt;
  if (
    typeof extractedAt !== 'number'
    || !Number.isFinite(extractedAt)
    || extractedAt > now
    || now - extractedAt > PLAN_GUARD_STALE_MS
  ) {
    return 'expired';
  }
  if (
    snapshot.activeWindowId !== snapshot.requestedWindowId
    || snapshot.activeTargetId !== snapshot.requestedWindowId
  ) {
    return 'window';
  }
  if (snapshot.activeComposerId !== snapshot.requestedComposerId) return 'session';
  if (snapshot.invalidated || snapshot.epochMatch === false) return 'expired';
  return null;
}

export function planFailResult(input: {
  commandId: string;
  error: string;
  code: PlanFailureCode;
  stage: PlanFailureStage;
  requested?: PlanRequestedTarget;
}): CommandResult {
  return {
    commandId: input.commandId,
    ok: false,
    error: input.error,
    failure: planCommandFailure(input),
  };
}

export function attachPlanFailure(result: CommandResult, fallback: {
  code: PlanFailureCode;
  stage: PlanFailureStage;
  commandId: string;
  requested?: PlanRequestedTarget;
}): CommandResult {
  if (result.ok) return result;
  const existing = sanitizePlanFailure(result.failure);
  return {
    ...result,
    failure: planCommandFailure({
      code: existing?.code ?? fallback.code,
      stage: existing?.stage ?? fallback.stage,
      commandId: fallback.commandId,
      requested: fallback.requested,
    }),
  };
}