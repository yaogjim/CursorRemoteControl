import type { CapabilityState, MenuCompleteness, ModeCapability, ModelCapabilitySnapshot, ToolCapability } from './types.js';

function emptyModels(observedAt = 0): ModelCapabilitySnapshot {
  return { items: [], completeness: 'unknown', filterActive: false, observedAt };
}

/** A catalog may replace a previous one only when it is complete and unfiltered. */
export function isCompleteUnfiltered(models?: ModelCapabilitySnapshot | null): boolean {
  return !!models && models.completeness === 'complete' && models.filterActive !== true;
}

/**
 * Current-only / fallback mode rows must not shrink a larger catalog.
 * A multi-item `source: 'menu'` read is treated as an authoritative inventory.
 */
export function mergeModeCatalog(
  previous: ModeCapability[] | undefined,
  observed: ModeCapability[] | undefined,
): ModeCapability[] {
  const prev = previous ?? [];
  const next = observed ?? [];
  if (prev.length === 0) return next;
  if (next.length === 0) return prev;
  const menuRead = next.length > 1 && next.every((mode) => mode.source === 'menu');
  if (menuRead || next.length > prev.length) return next;
  const currentIds = new Set(next.filter((mode) => mode.current).map((mode) => mode.id));
  const byId = new Map(prev.map((mode) => [mode.id, { ...mode, current: currentIds.has(mode.id) }]));
  for (const mode of next) {
    if (!byId.has(mode.id)) byId.set(mode.id, { ...mode });
  }
  return [...byId.values()];
}

/**
 * Unknown/partial observations may add rows and refresh selection, but they
 * never delete items from a previously complete unfiltered snapshot and never
 * downgrade that snapshot's completeness.
 */
export function mergeModelCatalog(
  previous: ModelCapabilitySnapshot | undefined,
  observed: ModelCapabilitySnapshot | undefined,
): ModelCapabilitySnapshot {
  if (!observed) return previous ?? emptyModels();
  if (!previous || previous.items.length === 0) return observed;
  if (isCompleteUnfiltered(observed)) return observed;

  const selectedIds = new Set(observed.items.filter((model) => model.selected).map((model) => model.id));
  const byId = new Map(previous.items.map((model) => [model.id, { ...model, selected: selectedIds.has(model.id) }]));
  for (const item of observed.items) {
    if (!byId.has(item.id)) byId.set(item.id, { ...item });
  }
  const previousHasStrongerCompleteness = previous.completeness === 'complete'
    || (previous.completeness === 'partial' && observed.completeness === 'unknown');
  return {
    items: [...byId.values()],
    completeness: previousHasStrongerCompleteness ? previous.completeness : observed.completeness,
    filterActive: previousHasStrongerCompleteness ? previous.filterActive : observed.filterActive,
    observedAt: observed.observedAt,
  };
}

export interface CapabilityDiff {
  state: CapabilityState;
  completeness: MenuCompleteness;
  added: string[];
  removed: string[];
  changed: string[];
  conflicts: string[];
  canReportRemoval: boolean;
}

function comparable(item: Record<string, unknown>): string {
  const stable = JSON.parse(JSON.stringify(item, (key, value) => (key === 'observedAt' || key === 'expiresAt' ? undefined : value))) as unknown;
  return JSON.stringify(stable);
}

function ids(items: Array<{ id: string }>): Set<string> { return new Set(items.map((x) => x.id)); }
function diffIds(previous: Array<{ id: string }>, next: Array<{ id: string }>): Pick<CapabilityDiff, 'added' | 'removed'> {
  const before = ids(previous); const after = ids(next);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  };
}

export function compareCapabilities(
  expected: { modes?: ModeCapability[]; models?: ModelCapabilitySnapshot; tools?: ToolCapability[] } | null,
  observed: { modes?: ModeCapability[]; models?: ModelCapabilitySnapshot; tools?: ToolCapability[] } | null,
  lastKnown: { modes?: ModeCapability[]; models?: ModelCapabilitySnapshot; tools?: ToolCapability[] } | null = null,
): CapabilityDiff {
  if (!observed) return { state: 'unknown', completeness: 'unknown', added: [], removed: [], changed: [], conflicts: [], canReportRemoval: false };
  const completeness = observed.models?.completeness ?? 'unknown';
  const before = lastKnown ?? expected;
  const added: string[] = []; const removed: string[] = []; const changed: string[] = []; const conflicts: string[] = [];
  const compare = (kind: string, a: Array<{ id: string }> | undefined, b: Array<{ id: string }> | undefined) => {
    if (!a || !b) return;
    const d = diffIds(a, b);
    added.push(...d.added.map((id) => `${kind}:${id}`));
    if (completeness === 'complete') removed.push(...d.removed.map((id) => `${kind}:${id}`));
    for (const oldItem of a) {
      const next = b.find((item) => item.id === oldItem.id);
      if (next && comparable(oldItem as Record<string, unknown>) !== comparable(next as Record<string, unknown>)) changed.push(`${kind}:${oldItem.id}`);
    }
  };
  compare('mode', before?.modes, observed.modes);
  compare('model', before?.models?.items, observed.models?.items);
  compare('tool', before?.tools, observed.tools);
  if (expected?.models && observed.models && expected.models.completeness === 'complete' && observed.models.completeness === 'complete') {
    const expectedIds = ids(expected.models.items); const observedIds = ids(observed.models.items);
    for (const id of expectedIds) if (!observedIds.has(id)) conflicts.push(`expected-model-missing:${id}`);
  }
  // Completeness is a Model-menu property. Partial/unknown must not elevate the
  // whole capability snapshot to degraded — Mode can stay verified independently.
  let state: CapabilityState = 'ok';
  if (removed.length || added.length || changed.length) state = 'changed';
  return { state, completeness, added, removed, changed, conflicts, canReportRemoval: completeness === 'complete' };
}