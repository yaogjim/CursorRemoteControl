import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, copyFile, open, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { validateSelectorMap, selectorFingerprint } from './selector-validation.js';
import type { CapabilityKind } from './types.js';

export type AdapterStatus = 'pending_confirmation' | 'active' | 'rejected' | 'rejected_runtime' | 'rolled_back';
export interface AdapterStrategy { id: string; kind: string; selector: string; scope: string; operationClass: 'passive_read' | 'interactive_read' | 'executable'; validation?: { requiresUniqueVisible?: boolean }; }
export interface AdapterRecord {
  id: string;
  status: AdapterStatus;
  cursorVersionRange: string;
  endpointFingerprint?: string;
  domSignature: string;
  capabilityKinds: CapabilityKind[];
  strategies: Record<string, AdapterStrategy[]>;
  evidence: Array<{ source: string; summary: string; confidence?: number }>;
  createdAt: number;
  verifiedAt: number | null;
  activatedAt?: number;
  contentHash?: string;
}
export interface ActiveBinding { cursorVersionRange: string; endpointFingerprint: string; domSignature: string; capabilityKind: CapabilityKind; adapterId: string; }
export interface AdapterStoreData {
  schemaVersion: 1;
  revision: number;
  activeBindings: ActiveBinding[];
  previousBindings: ActiveBinding[];
  adapters: AdapterRecord[];
  history: Array<{ revision: number; action: string; adapterId?: string; createdAt: number; contentHash: string }>;
}

export const ADAPTER_STORE_MAX = 100;

const EMPTY: AdapterStoreData = { schemaVersion: 1, revision: 0, activeBindings: [], previousBindings: [], adapters: [], history: [] };

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24); }

function sameBindingTuple(a: Pick<ActiveBinding, 'cursorVersionRange' | 'endpointFingerprint' | 'domSignature' | 'capabilityKind'>, b: Pick<ActiveBinding, 'cursorVersionRange' | 'endpointFingerprint' | 'domSignature' | 'capabilityKind'>): boolean {
  return a.capabilityKind === b.capabilityKind && a.cursorVersionRange === b.cursorVersionRange
    && a.endpointFingerprint === b.endpointFingerprint && a.domSignature === b.domSignature;
}

function isBinding(value: unknown): value is ActiveBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as ActiveBinding;
  return typeof b.cursorVersionRange === 'string' && typeof b.endpointFingerprint === 'string'
    && typeof b.domSignature === 'string'
    && (b.capabilityKind === 'mode' || b.capabilityKind === 'model' || b.capabilityKind === 'tool')
    && typeof b.adapterId === 'string';
}

export class AdapterStore {
  readonly filePath: string;
  private data: AdapterStoreData = clone(EMPTY);
  private loaded = false;
  private backupCount: number;
  private mutex: Promise<void> = Promise.resolve();

  constructor(filePath: string, opts: { backupCount?: number } = {}) { this.filePath = filePath; this.backupCount = opts.backupCount ?? 5; }

  private backupPath(index: number): string { return `${this.filePath}.bak.${index}`; }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const wait = this.mutex;
    this.mutex = new Promise<void>((resolve) => { release = resolve; });
    await wait;
    try { return await fn(); } finally { release(); }
  }

  async load(): Promise<AdapterStoreData> {
    if (this.loaded) return clone(this.data);
    return this.withLock(async () => {
      await this.loadUnlocked();
      return clone(this.data);
    });
  }

  private async loadUnlocked(): Promise<void> {
    if (this.loaded) return;
    let restoredFromBackup = false;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AdapterStoreData>;
      this.data = this.validateData(parsed) ? this.hydrate(parsed) : clone(EMPTY);
    } catch {
      this.data = clone(EMPTY);
      for (let i = 1; i <= this.backupCount; i++) {
        try {
          const parsed = JSON.parse(await readFile(this.backupPath(i), 'utf8')) as Partial<AdapterStoreData>;
          if (this.validateData(parsed)) {
            this.data = this.hydrate(parsed);
            restoredFromBackup = true;
            break;
          }
        } catch { /* try next backup */ }
      }
    }
    this.loaded = true;
    if (restoredFromBackup) await this.commitUnlocked('restore');
  }

  getState(): AdapterStoreData { return clone(this.data); }
  async list(status?: AdapterStatus): Promise<AdapterRecord[]> {
    await this.load();
    return this.data.adapters.filter((a) => !status || a.status === status).map(clone);
  }
  async get(id: string): Promise<AdapterRecord | null> {
    await this.load();
    const a = this.data.adapters.find((item) => item.id === id);
    return a ? clone(a) : null;
  }

  async savePending(candidate: Omit<AdapterRecord, 'id' | 'status' | 'createdAt' | 'verifiedAt' | 'contentHash'> & Partial<Pick<AdapterRecord, 'id'>>): Promise<AdapterRecord> {
    return this.withLock(async () => {
      await this.loadUnlocked();
      const id = candidate.id ?? `candidate-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const existing = this.data.adapters.find((item) => item.id === id);
      // Re-discovery is observational. It must never silently demote an
      // explicitly activated adapter back to pending.
      if (existing?.status === 'active') return clone(existing);
      const adapter: AdapterRecord = { ...candidate, id, status: 'pending_confirmation', createdAt: Date.now(), verifiedAt: null };
      const validation = validateAdapter(adapter);
      if (!validation.ok) throw new Error(validation.errors.join('; '));
      adapter.contentHash = hash(adapter);
      this.data.adapters = [adapter, ...this.data.adapters.filter((a) => a.id !== id)];
      this.trimAdapters();
      await this.commitUnlocked('pending', id);
      return clone(adapter);
    });
  }

  async apply(id: string, binding: Omit<ActiveBinding, 'adapterId'>): Promise<AdapterRecord> {
    return this.withLock(async () => {
      await this.loadUnlocked();
      const adapter = this.data.adapters.find((a) => a.id === id);
      if (!adapter) throw new Error('adapter not found');
      if (adapter.status !== 'pending_confirmation' && adapter.status !== 'active') throw new Error(`adapter is ${adapter.status}`);
      if (!adapter.capabilityKinds.includes(binding.capabilityKind)) throw new Error('binding capability kind is not provided by adapter');
      if (adapter.cursorVersionRange !== binding.cursorVersionRange) throw new Error('binding cursor version range does not match adapter');
      if (!adapter.endpointFingerprint || adapter.endpointFingerprint !== binding.endpointFingerprint) throw new Error('binding endpoint fingerprint does not match adapter');
      if (adapter.domSignature !== binding.domSignature) throw new Error('binding DOM signature does not match adapter');
      const validation = validateAdapter(adapter);
      if (!validation.ok) throw new Error(validation.errors.join('; '));
      adapter.status = 'active'; adapter.verifiedAt = Date.now(); adapter.activatedAt = Date.now(); adapter.contentHash = hash(adapter);
      this.data.adapters = this.data.adapters.map((a) => a.id === id ? adapter : a);
      const current = this.data.activeBindings.find((b) => sameBindingTuple(b, binding));
      if (current && current.adapterId !== id) {
        this.data.previousBindings = [
          current,
          ...this.data.previousBindings.filter((b) => !(sameBindingTuple(b, current) && b.adapterId === current.adapterId)),
        ].slice(0, ADAPTER_STORE_MAX);
      }
      this.data.activeBindings = this.data.activeBindings.filter((b) => !sameBindingTuple(b, binding));
      this.data.activeBindings.push({ ...binding, adapterId: id });
      this.trimAdapters();
      await this.commitUnlocked('apply', id);
      return clone(adapter);
    });
  }

  async reject(id: string): Promise<boolean> {
    return this.withLock(async () => {
      await this.loadUnlocked();
      const a = this.data.adapters.find((x) => x.id === id);
      if (!a) return false;
      a.status = 'rejected';
      await this.commitUnlocked('reject', id);
      return true;
    });
  }

  async rollback(binding: Pick<ActiveBinding, 'cursorVersionRange' | 'endpointFingerprint' | 'domSignature' | 'capabilityKind'>, adapterId?: string): Promise<void> {
    await this.withLock(async () => {
      await this.loadUnlocked();
      const current = this.data.activeBindings.find((b) => sameBindingTuple(b, binding));
      if (adapterId && current && current.adapterId !== adapterId) {
        throw new Error('adapter is not the active binding for this target');
      }
      const failedId = adapterId ?? current?.adapterId;
      const previous = this.data.previousBindings.find((b) => {
        if (!sameBindingTuple(b, binding)) return false;
        if (failedId && b.adapterId === failedId) return false;
        const adapter = this.data.adapters.find((a) => a.id === b.adapterId);
        return !!adapter && adapter.status !== 'rolled_back' && adapter.status !== 'rejected' && adapter.status !== 'rejected_runtime'
          && adapter.capabilityKinds.includes(binding.capabilityKind);
      });
      this.data.activeBindings = this.data.activeBindings.filter((b) => !sameBindingTuple(b, binding));
      if (previous) {
        this.data.activeBindings.push({ ...binding, adapterId: previous.adapterId });
        this.data.previousBindings = this.data.previousBindings.filter((b) => !(sameBindingTuple(b, previous) && b.adapterId === previous.adapterId));
      }
      const failed = failedId ? this.data.adapters.find((a) => a.id === failedId) : undefined;
      if (failed) failed.status = 'rolled_back';
      await this.commitUnlocked('rollback', failedId);
    });
  }

  async history(): Promise<AdapterStoreData['history']> { await this.load(); return clone(this.data.history); }

  private hydrate(parsed: Partial<AdapterStoreData>): AdapterStoreData {
    const adapters = (parsed.adapters ?? []).filter((item) => validateAdapter(item).ok);
    const adapterById = new Map(adapters.map((a) => [a.id, a]));
    const keepBinding = (b: unknown): b is ActiveBinding => {
      if (!isBinding(b)) return false;
      const adapter = adapterById.get(b.adapterId);
      return !!adapter && adapter.capabilityKinds.includes(b.capabilityKind);
    };
    const activeBindings = (parsed.activeBindings ?? []).filter(keepBinding);
    const previousBindings = (parsed.previousBindings ?? []).filter(keepBinding);
    return {
      schemaVersion: 1,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      activeBindings,
      previousBindings,
      adapters,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  }

  private trimAdapters(): void {
    const bound = new Set(this.data.activeBindings.map((b) => b.adapterId));
    for (const b of this.data.previousBindings) bound.add(b.adapterId);
    const protectedId = (a: AdapterRecord) => a.status === 'active' || bound.has(a.id);
    const kept: AdapterRecord[] = [];
    let others = 0;
    const protectedCount = this.data.adapters.filter(protectedId).length;
    const room = Math.max(0, ADAPTER_STORE_MAX - protectedCount);
    for (const adapter of this.data.adapters) {
      if (protectedId(adapter)) kept.push(adapter);
      else if (others < room) { kept.push(adapter); others += 1; }
    }
    this.data.adapters = kept;
  }

  private validateData(input: Partial<AdapterStoreData>): boolean {
    const supportedSchema = input.schemaVersion === 1 || input.schemaVersion === undefined;
    return supportedSchema && Array.isArray(input.activeBindings) && Array.isArray(input.adapters) && Array.isArray(input.history);
  }

  private async commitUnlocked(action: string, adapterId?: string): Promise<void> {
    this.data.revision += 1;
    const contentHash = hash(this.data);
    this.data.history = [{ revision: this.data.revision, action, ...(adapterId ? { adapterId } : {}), createdAt: Date.now(), contentHash }, ...this.data.history].slice(0, ADAPTER_STORE_MAX);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { const fh = await open(temp, 'r'); await fh.sync(); await fh.close(); } catch { /* fsync is best effort */ }
    try {
      const current = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AdapterStoreData>;
      if (this.validateData(current)) {
        for (let i = this.backupCount; i >= 2; i--) {
          try { await rename(this.backupPath(i - 1), this.backupPath(i)); } catch { /* absent */ }
        }
        await copyFile(this.filePath, this.backupPath(1));
      }
    } catch { /* first write or corrupt primary — do not rotate into backups */ }
    await rename(temp, this.filePath);
  }
}

export function validateAdapter(adapter: AdapterRecord): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['adapter must be an object'] };
  if (!adapter.id || adapter.id.length > 160 || /[\\/\\]/.test(adapter.id)) errors.push('invalid adapter id');
  if (!adapter.cursorVersionRange || adapter.cursorVersionRange.length > 80) errors.push('invalid adapter cursor build');
  if (adapter.endpointFingerprint !== undefined && (!/^[a-f0-9]{24}$/.test(adapter.endpointFingerprint))) errors.push('invalid endpoint fingerprint');
  if (!adapter.domSignature || adapter.domSignature.length > 256) errors.push('invalid DOM signature');
  if (!Array.isArray(adapter.capabilityKinds) || adapter.capabilityKinds.length === 0 || adapter.capabilityKinds.some((k) => !['mode', 'model', 'tool'].includes(k))) errors.push('invalid capability kind');
  if (!adapter.strategies || typeof adapter.strategies !== 'object') errors.push('strategies are required');
  for (const [key, strategies] of Object.entries(adapter.strategies ?? {})) {
    if (!strategies.length) { errors.push(`${key} has no strategies`); continue; }
    const check = validateSelectorMap({ [key]: strategies.map((s) => s.selector) });
    if (!check.ok) errors.push(...check.errors);
    const seenSelectors = new Set<string>();
    const seenIds = new Set<string>();
    for (const strategy of strategies) {
      if (!strategy.id || seenIds.has(strategy.id)) errors.push(`duplicate or missing strategy id: ${key}`);
      seenIds.add(strategy.id);
      if (!strategy.scope || !['composer', 'plan', 'tool', 'approval'].includes(strategy.scope)) errors.push(`invalid strategy scope: ${strategy.id}`);
      if (seenSelectors.has(strategy.selector)) errors.push(`duplicate selector strategy: ${strategy.id}`);
      seenSelectors.add(strategy.selector);
      if (!['passive_read', 'interactive_read', 'executable'].includes(strategy.operationClass)) errors.push(`invalid operation class: ${strategy.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function adapterFingerprint(adapter: AdapterRecord): string { return adapter.contentHash ?? hash(adapter); }
export function selectorsFingerprint(selectors: Record<string, string[]>): string { return selectorFingerprint(selectors); }