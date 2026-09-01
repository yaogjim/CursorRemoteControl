import type {
  CapabilityEvidenceSource,
  ModeCapability,
  ModelCapability,
  ToolCapability,
  ToolActionCapability,
} from './types.js';

export function normalizeLabel(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeId(value: unknown, label = ''): string {
  const raw = normalizeLabel(value);
  if (raw && !/^_r_[a-z0-9]+_$/.test(raw)) return raw;
  const normalizedLabel = normalizeLabel(label);
  return normalizedLabel ? `label::${normalizedLabel}` : '';
}

export function clampConfidence(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeMode(input: Partial<ModeCapability> & { id?: unknown; label?: unknown }): ModeCapability | null {
  const label = normalizeLabel(input.label ?? input.id);
  const id = normalizeId(input.id, label);
  if (!id || !label) return null;
  return {
    id,
    label,
    ...(input.icon ? { icon: normalizeLabel(input.icon) } : {}),
    current: input.current === true,
    source: (input.source ?? 'inferred') as CapabilityEvidenceSource,
    confidence: clampConfidence(input.confidence, 0.5),
    scope: 'composer',
    selectable: input.selectable !== false,
    observedAt: typeof input.observedAt === 'number' ? input.observedAt : Date.now(),
  };
}

export function normalizeModel(input: Partial<ModelCapability> & { id?: unknown; label?: unknown }): ModelCapability | null {
  const label = normalizeLabel(input.label ?? input.id);
  const id = normalizeId(input.id, label);
  if (!id || !label) return null;
  const scope = input.scope === 'plan' ? 'plan' : 'composer';
  const stability = input.idStability === 'stable' || input.idStability === 'runtime_only'
    ? input.idStability : (id.startsWith('label::') ? 'label' : 'label');
  return {
    id,
    label,
    selected: input.selected === true,
    scope,
    idStability: stability,
    source: (input.source ?? 'inferred') as CapabilityEvidenceSource,
    confidence: clampConfidence(input.confidence, 0.5),
    selectable: input.selectable !== false,
    observedAt: typeof input.observedAt === 'number' ? input.observedAt : Date.now(),
  };
}

export function normalizeAction(input: Partial<ToolActionCapability> & { actionId?: unknown; label?: unknown }): ToolActionCapability | null {
  const actionId = normalizeLabel(input.actionId);
  const label = normalizeLabel(input.label);
  if (!actionId || !label) return null;
  return {
    actionId,
    label,
    kind: normalizeLabel(input.kind) || 'unknown',
    expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : Date.now() + 30_000,
    executable: input.executable === true,
    requiresConfirmation: input.requiresConfirmation !== false,
  };
}

export function normalizeTool(input: Partial<ToolCapability> & { id?: unknown; type?: unknown }): ToolCapability | null {
  const id = normalizeLabel(input.id);
  const type = normalizeLabel(input.type) || 'generic_tool';
  if (!id) return null;
  const actions = (input.actions ?? []).map((a) => normalizeAction(a)).filter((a): a is ToolActionCapability => !!a);
  return {
    id,
    type,
    source: (input.source ?? 'inferred') as CapabilityEvidenceSource,
    executable: input.executable === true && actions.some((a) => a.executable),
    actions,
  };
}

export function dedupeCapabilities<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || JSON.stringify(item).length > JSON.stringify(previous).length) byId.set(item.id, item);
  }
  return [...byId.values()];
}