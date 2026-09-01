import { EventEmitter } from 'events';
import { compareCapabilities, isCompleteUnfiltered, mergeModeCatalog, mergeModelCatalog } from './capability-diff.js';
import type {
  CapabilityKind,
  CapabilityPatch,
  CapabilityState,
  CapabilityStatus,
  CapabilitySummary,
  CompatibleModeModelProjection,
  MenuCompleteness,
  ModeCapability,
  ModelCapabilitySnapshot,
  ModeInfo,
  ModelInfo,
  ToolCapability,
} from './types.js';

interface TargetCapabilityRecord {
  targetId: string;
  targetGeneration: number;
  revision: number;
  snapshot: CapabilitySummary;
  lastSuccess: CapabilitySummary | null;
}

export interface CapabilityObservedUpdate {
  targetId: string;
  targetGeneration: number;
  modes?: ModeCapability[];
  models?: ModelCapabilitySnapshot;
  tools?: ToolCapability[];
  state?: CapabilityState;
  completeness?: MenuCompleteness;
  adapterBindings?: Partial<Record<CapabilityKind, string>>;
  confidence?: number;
}

export interface CapabilityPublicState {
  activeTargetId: string;
  snapshots: CapabilitySummary[];
}

/** Normalize live or connect payloads to the public `capabilities:full` envelope. */
export function toPublicCapabilityFull(
  payload: unknown,
  activeTargetId = '',
): CapabilityPublicState {
  if (payload && typeof payload === 'object') {
    const rec = payload as { activeTargetId?: unknown; snapshots?: unknown; targetId?: unknown };
    if (Array.isArray(rec.snapshots)) {
      const snapshots = rec.snapshots.filter((item): item is CapabilitySummary => (
        !!item && typeof item === 'object' && typeof (item as CapabilitySummary).targetId === 'string'
      ));
      const id = typeof rec.activeTargetId === 'string' && rec.activeTargetId
        ? rec.activeTargetId
        : activeTargetId;
      return { activeTargetId: id, snapshots };
    }
    if (typeof rec.targetId === 'string' && rec.targetId) {
      return {
        activeTargetId: activeTargetId || rec.targetId,
        snapshots: [payload as CapabilitySummary],
      };
    }
  }
  return { activeTargetId, snapshots: [] };
}

function emptyBindings(): Record<CapabilityKind, string> {
  return { mode: '', model: '', tool: '' };
}

function emptyModels(observedAt = 0): ModelCapabilitySnapshot {
  return { items: [], completeness: 'unknown', filterActive: false, observedAt };
}

function statusOf(
  state: CapabilityState,
  revision: number,
  targetGeneration: number,
  completeness: MenuCompleteness,
  confidence: number,
): CapabilityStatus {
  return { state, confidence, completeness, revision, targetGeneration };
}

function emptySnapshot(targetId: string, targetGeneration: number, state: CapabilityState = 'unknown'): CapabilitySummary {
  return {
    targetId,
    targetGeneration,
    revision: 0,
    modes: [],
    models: emptyModels(),
    tools: [],
    status: statusOf(state, 0, targetGeneration, 'unknown', 0),
    adapterBindings: emptyBindings(),
    observedAt: 0,
  };
}

function catalogToPreserve(rec: TargetCapabilityRecord): CapabilitySummary | null {
  const candidates = [rec.lastSuccess, rec.snapshot];
  for (const candidate of candidates) {
    if (candidate && (candidate.modes.length > 0 || candidate.models.items.length > 0)) {
      return candidate;
    }
  }
  return null;
}

function cloneSnapshot(snapshot: CapabilitySummary): CapabilitySummary {
  return {
    ...snapshot,
    modes: snapshot.modes.map((m) => ({ ...m })),
    models: {
      ...snapshot.models,
      items: snapshot.models.items.map((m) => ({ ...m })),
    },
    tools: snapshot.tools.map((t) => ({
      ...t,
      actions: t.actions.map((a) => ({ ...a })),
    })),
    status: { ...snapshot.status },
    adapterBindings: { ...snapshot.adapterBindings },
  };
}

/**
 * Dynamic capability owner. Independent of StateManager / DOM CursorState.
 * Per-target revision is monotonic within a generation; older revisions and
 * older generations never overwrite newer state.
 */
export class CapabilityStateManager extends EventEmitter {
  private records = new Map<string, TargetCapabilityRecord>();
  private _activeTargetId = '';

  get activeTargetId(): string {
    return this._activeTargetId;
  }

  setActiveTarget(targetId: string, targetGeneration: number): void {
    this._activeTargetId = targetId;
    let rec = this.records.get(targetId);
    if (!rec) {
      rec = this.createRecord(targetId, targetGeneration, 'unknown');
      this.emitFull();
      return;
    }
    if (rec.targetGeneration !== targetGeneration) {
      this.transitionGeneration(rec, targetGeneration);
      this.emit('capabilities:stale', this.stalePayload(rec));
    }
    this.emitFull();
  }

  /**
   * Apply an observed capability update. The manager assigns the next revision.
   * Updates for an older generation are discarded.
   */
  applyObserved(update: CapabilityObservedUpdate): CapabilitySummary | null {
    let rec = this.records.get(update.targetId);
    if (!rec) {
      rec = this.createRecord(update.targetId, update.targetGeneration, 'unknown');
    }

    if (update.targetGeneration < rec.targetGeneration) return null;

    if (update.targetGeneration > rec.targetGeneration) {
      this.transitionGeneration(rec, update.targetGeneration);
    }

    rec.revision += 1;
    const state = update.state ?? 'ok';
    const modes = update.modes !== undefined
      ? mergeModeCatalog(rec.snapshot.modes, update.modes)
      : rec.snapshot.modes;
    const models = update.models !== undefined
      ? mergeModelCatalog(rec.snapshot.models, update.models)
      : rec.snapshot.models;
    const completeness = models.completeness;
    const tools = (state !== 'ok' && update.tools?.length === 0)
      ? rec.snapshot.tools
      : (update.tools ?? rec.snapshot.tools);
    const diff = compareCapabilities(rec.snapshot, { modes, models, tools }, rec.snapshot);
    const replacedModels = update.models !== undefined && isCompleteUnfiltered(update.models);
    let effectiveState: CapabilityState = state === 'ok' && diff.state !== 'ok' ? diff.state : state;
    // Model completeness is independent of snapshot state. An ok/changed
    // observation must not become degraded just because the menu is partial.
    if (
      (state === 'ok' || state === 'changed')
      && effectiveState === 'degraded'
      && (completeness === 'partial' || completeness === 'unknown')
    ) {
      effectiveState = diff.state === 'changed' || state === 'changed' ? 'changed' : 'ok';
    }
    // A preserved last-known catalog after reconnect is not writable until a
    // complete unfiltered observation re-verifies this generation.
    if (rec.snapshot.status.state === 'stale' && !replacedModels && !isCompleteUnfiltered(models)) {
      effectiveState = 'stale';
    }
    const nextStatus = statusOf(
      effectiveState,
      rec.revision,
      rec.targetGeneration,
      completeness,
      update.confidence ?? (state === 'ok' ? 1 : rec.snapshot.status.confidence),
    );
    nextStatus.added = diff.added;
    nextStatus.missing = diff.removed;
    nextStatus.changed = diff.changed;
    nextStatus.conflicts = diff.conflicts;
    const next: CapabilitySummary = {
      targetId: rec.targetId,
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      modes,
      models,
      tools,
      adapterBindings: {
        ...rec.snapshot.adapterBindings,
        ...update.adapterBindings,
      },
      status: nextStatus,
      observedAt: Date.now(),
    };
    rec.snapshot = next;
    if (effectiveState === 'ok' || effectiveState === 'changed') rec.lastSuccess = cloneSnapshot(next);

    const patch: CapabilityPatch = {
      targetId: rec.targetId,
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      status: next.status,
      ...(update.modes ? { modes: next.modes } : {}),
      ...(update.models ? { models: next.models } : {}),
      ...(update.tools ? { tools: next.tools } : {}),
      ...(update.adapterBindings ? { adapterBindings: next.adapterBindings } : {}),
    };
    this.emit('capabilities:patch', patch);
    return cloneSnapshot(next);
  }

  /**
   * Apply a fully-formed snapshot. Same-generation snapshots with a lower
   * revision are discarded. Used by tests and future probe wiring.
   */
  applySnapshot(snapshot: CapabilitySummary): CapabilitySummary | null {
    let rec = this.records.get(snapshot.targetId);
    if (!rec) {
      rec = this.createRecord(snapshot.targetId, snapshot.targetGeneration, snapshot.status.state);
    }

    if (snapshot.targetGeneration < rec.targetGeneration) return null;
    if (
      snapshot.targetGeneration === rec.targetGeneration
      && snapshot.revision <= rec.revision
      && rec.revision > 0
    ) {
      return null;
    }

    if (snapshot.targetGeneration > rec.targetGeneration) {
      this.transitionGeneration(rec, snapshot.targetGeneration);
    }

    rec.revision = snapshot.revision;
    rec.snapshot = {
      ...cloneSnapshot(snapshot),
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      status: {
        ...snapshot.status,
        revision: rec.revision,
        targetGeneration: rec.targetGeneration,
      },
    };
    if (rec.snapshot.status.state === 'ok') {
      rec.lastSuccess = cloneSnapshot(rec.snapshot);
    }

    this.emit('capabilities:patch', {
      targetId: rec.targetId,
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      status: rec.snapshot.status,
      modes: rec.snapshot.modes,
      models: rec.snapshot.models,
      tools: rec.snapshot.tools,
      adapterBindings: rec.snapshot.adapterBindings,
    } satisfies CapabilityPatch);
    return cloneSnapshot(rec.snapshot);
  }

  markStale(targetId?: string): void {
    const id = targetId ?? this._activeTargetId;
    if (!id) return;
    const rec = this.records.get(id);
    if (!rec) return;
    if (rec.snapshot.status.state === 'stale' && rec.revision > 0) {
      this.emit('capabilities:stale', this.stalePayload(rec));
      return;
    }
    rec.revision += 1;
    rec.snapshot = {
      ...rec.snapshot,
      revision: rec.revision,
      status: statusOf(
        'stale',
        rec.revision,
        rec.targetGeneration,
        rec.snapshot.status.completeness,
        rec.snapshot.status.confidence,
      ),
    };
    const payload = this.stalePayload(rec);
    this.emit('capabilities:stale', payload);
    this.emit('capabilities:patch', {
      targetId: rec.targetId,
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      status: rec.snapshot.status,
      stale: true,
    } satisfies CapabilityPatch);
  }

  bumpTargetGeneration(targetId: string): number {
    let rec = this.records.get(targetId);
    if (!rec) {
      rec = this.createRecord(targetId, 1, 'stale');
      this.emit('capabilities:stale', this.stalePayload(rec));
      this.emitFull();
      return rec.targetGeneration;
    }
    this.transitionGeneration(rec, rec.targetGeneration + 1);
    this.emit('capabilities:stale', this.stalePayload(rec));
    this.emitFull();
    return rec.targetGeneration;
  }

  getSnapshot(targetId?: string): CapabilitySummary | null {
    const id = targetId ?? this._activeTargetId;
    if (!id) return null;
    const rec = this.records.get(id);
    return rec ? cloneSnapshot(rec.snapshot) : null;
  }

  getRevision(targetId?: string): number {
    const id = targetId ?? this._activeTargetId;
    if (!id) return 0;
    return this.records.get(id)?.revision ?? 0;
  }

  getTargetGeneration(targetId?: string): number {
    const id = targetId ?? this._activeTargetId;
    if (!id) return 0;
    return this.records.get(id)?.targetGeneration ?? 0;
  }

  getPublicState(): CapabilityPublicState {
    return {
      activeTargetId: this._activeTargetId,
      snapshots: [...this.records.values()].map((rec) => cloneSnapshot(rec.snapshot)),
    };
  }

  private emitFull(): void {
    this.emit('capabilities:full', this.getPublicState());
  }

  /**
   * Read-only projection onto the legacy mode/model fields.
   * Never fabricates Agent/Auto as a live observation.
   */
  projectModeModel(targetId?: string): CompatibleModeModelProjection {
    const snapshot = this.getSnapshot(targetId);
    return projectModeModel(snapshot);
  }

  private createRecord(targetId: string, targetGeneration: number, state: CapabilityState): TargetCapabilityRecord {
    const rec: TargetCapabilityRecord = {
      targetId,
      targetGeneration,
      revision: 0,
      snapshot: emptySnapshot(targetId, targetGeneration, state),
      lastSuccess: null,
    };
    this.records.set(targetId, rec);
    return rec;
  }

  private transitionGeneration(rec: TargetCapabilityRecord, nextGeneration: number): void {
    const keep = catalogToPreserve(rec);
    rec.targetGeneration = nextGeneration;
    rec.revision = 0;
    if (!keep) {
      rec.snapshot = emptySnapshot(rec.targetId, nextGeneration, 'stale');
      return;
    }
    rec.snapshot = {
      ...cloneSnapshot(keep),
      targetGeneration: nextGeneration,
      revision: 0,
      models: {
        ...keep.models,
        items: keep.models.items.map((item) => ({ ...item })),
        completeness: 'unknown',
        filterActive: false,
      },
      status: statusOf('stale', 0, nextGeneration, 'unknown', keep.status.confidence),
    };
  }

  private stalePayload(rec: TargetCapabilityRecord): CapabilityPatch {
    return {
      targetId: rec.targetId,
      targetGeneration: rec.targetGeneration,
      revision: rec.revision,
      status: rec.snapshot.status,
      stale: true,
    };
  }
}

export function projectModeModel(snapshot: CapabilitySummary | null): CompatibleModeModelProjection {
  const emptyMode: ModeInfo = { current: '', available: [] };
  const emptyModel: ModelInfo = { current: '', currentId: '' };
  if (!snapshot) {
    return { mode: emptyMode, model: emptyModel, status: 'unknown' };
  }

  const state = snapshot.status.state;
  if (state === 'unknown' || state === 'stale' || state === 'unavailable') {
    return { mode: emptyMode, model: emptyModel, status: state };
  }

  const currentMode = snapshot.modes.find((m) => m.current);
  const currentModel = snapshot.models.items.find((m) => m.selected && m.scope === 'composer')
    ?? snapshot.models.items.find((m) => m.selected);

  return {
    mode: {
      current: currentMode?.id ?? '',
      available: snapshot.modes.map((m) => ({
        id: m.id,
        label: m.label,
        icon: m.icon ?? '',
      })),
    },
    model: {
      current: currentModel?.label ?? '',
      currentId: currentModel?.id ?? '',
    },
    status: state,
  };
}