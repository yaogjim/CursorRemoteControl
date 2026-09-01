import type { CapabilityState, CapabilitySummary } from './types.js';

export interface CapabilityAllowContext {
  snapshot: CapabilitySummary | null | undefined;
  activeTargetId: string;
  getTargetGeneration: (targetId: string) => number;
}

const MUTATION_STATES: ReadonlySet<CapabilityState> = new Set(['ok', 'changed']);

/**
 * Runtime allowlist for production mode/model mutations. Same error strings as
 * the historical web relay check so socket clients keep their existing
 * semantics. Transports must not bypass this by calling CommandExecutor
 * directly.
 */
export function capabilityAllows(
  kind: 'mode' | 'model',
  id: string,
  ctx: CapabilityAllowContext,
): string | null {
  const snapshot = ctx.snapshot;
  if (!snapshot) return 'Capability state is not verified';
  if (snapshot.targetId !== ctx.activeTargetId) return 'Capability target is not active';
  if (snapshot.targetGeneration !== ctx.getTargetGeneration(snapshot.targetId)) {
    return 'Capability target generation changed';
  }
  if (!MUTATION_STATES.has(snapshot.status.state)) {
    return `Capability ${kind} is ${snapshot.status.state}`;
  }
  if (kind === 'model' && snapshot.models.completeness !== 'complete') {
    return 'Capability model is degraded';
  }
  if (typeof id !== 'string' || id.length === 0) {
    return `${kind} is not an observed selectable capability`;
  }
  const found = kind === 'mode'
    ? snapshot.modes.find((item) => item.id === id && item.selectable)
    : snapshot.models.items.find((item) => item.id === id && item.scope === 'composer' && item.selectable);
  return found ? null : `${kind} is not an observed selectable capability`;
}