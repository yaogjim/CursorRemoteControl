import { randomBytes } from 'crypto';
import type { RegisteredActionTarget, ToolActionCapability } from './types.js';
import { validateSelector } from './selector-validation.js';

export type ActionFailure = 'action_expired' | 'action_scope_changed' | 'action_consumed' | 'action_not_found';

export class ActionRegistryError extends Error {
  readonly code: ActionFailure;
  constructor(code: ActionFailure) {
    super(code);
    this.name = 'ActionRegistryError';
    this.code = code;
  }
}

/** Dangerous one-shot actions that may be marked executable and clicked. */
export const EXECUTABLE_ACTION_TYPES = new Set([
  'approve',
  'reject',
  'approve_all',
  'run',
  'skip',
  'allow',
  'view_plan',
  'build',
  'continue',
  'questionnaire_option',
  'plan_model',
]);

export function isExecutableActionType(actionType: string): boolean {
  return EXECUTABLE_ACTION_TYPES.has(actionType);
}

/**
 * Only structurally recognized Tool families may mint executable actions.
 * Arbitrary DOM text remains a display-only generic_tool capability.
 */
export function classifyObservedToolType(message: {
  type: string;
  action?: string;
}): 'shell' | 'edit' | 'fetch' | null {
  if (message.type === 'run_command') return 'shell';
  if (message.type !== 'tool') return null;
  const action = message.action?.trim() ?? '';
  if (/^(?:edit|write)(?:\b|\s|:)/i.test(action)) return 'edit';
  if (/^(?:fetch|read\s+url|web\s+(?:fetch|search))(?:\b|\s|:)/i.test(action)) return 'fetch';
  return null;
}

export interface RegisterActionInput {
  windowId: string;
  targetId: string;
  targetGeneration: number;
  composerId: string;
  toolCallId: string;
  adapterId: string;
  actionType: string;
  expectedLabel: string;
  selectorStrategyId: string;
  selectorPath: string;
  ttlMs?: number;
}

type ActionScope = Partial<Pick<
  RegisteredActionTarget,
  'windowId' | 'targetId' | 'targetGeneration' | 'composerId' | 'toolCallId' | 'adapterId' | 'actionType'
>>;

export class ActionRegistry {
  private actions = new Map<string, RegisteredActionTarget>();
  private reserved = new Set<string>();

  constructor(private readonly opts: { ttlMs?: number; maxActions?: number; maxActionsPerTarget?: number } = {}) {}

  register(input: RegisterActionInput): ToolActionCapability {
    const ttlMs = input.ttlMs ?? this.opts.ttlMs ?? 30_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('invalid action TTL');
    if (typeof input.expectedLabel !== 'string' || !input.expectedLabel.trim() || input.expectedLabel.length > 160) {
      throw new Error('action label is required');
    }
    if (typeof input.actionType !== 'string' || !/^[a-z][a-z0-9_:-]{0,63}$/.test(input.actionType)) {
      throw new Error('invalid action type');
    }
    if (typeof input.selectorStrategyId !== 'string' || !input.selectorStrategyId.trim() || input.selectorStrategyId.length > 160) {
      throw new Error('selector strategy id is required');
    }
    const selectorCheck = validateSelector(input.selectorPath);
    if (!selectorCheck.ok || !input.windowId || !input.targetId || !input.composerId || !input.toolCallId) {
      throw new Error(selectorCheck.error ?? 'action scope is incomplete');
    }
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const actionId = `act_${randomBytes(24).toString('base64url')}`;
    const target: RegisteredActionTarget = { ...input, actionId, createdAt: now, expiresAt, consumed: false };
    this.actions.set(actionId, target);
    this.prune(now);
    return this.toPublic(target);
  }

  registerObserved(input: RegisterActionInput): ToolActionCapability {
    const existing = [...this.actions.values()].find((a) =>
      !a.consumed
      && a.windowId === input.windowId
      && a.targetId === input.targetId
      && a.targetGeneration === input.targetGeneration
      && a.composerId === input.composerId
      && a.toolCallId === input.toolCallId
      && a.adapterId === input.adapterId
      && a.actionType === input.actionType
      && a.expectedLabel === input.expectedLabel
      && a.selectorStrategyId === input.selectorStrategyId
      && a.selectorPath === input.selectorPath
    );
    if (existing) {
      existing.expiresAt = Date.now() + (input.ttlMs ?? this.opts.ttlMs ?? 30_000);
      return this.toPublic(existing);
    }
    return this.register(input);
  }

  public(actionId: string): ToolActionCapability | null {
    const a = this.actions.get(actionId);
    if (!a) return null;
    return this.toPublic(a);
  }

  reserve(actionId: string, scope: ActionScope = {}): RegisteredActionTarget {
    const a = this.requireLive(actionId);
    if (a.consumed || this.reserved.has(actionId)) throw new ActionRegistryError('action_consumed');
    this.assertScope(a, scope);
    this.reserved.add(actionId);
    return { ...a };
  }

  consume(actionId: string, scope?: ActionScope): RegisteredActionTarget {
    const a = this.actions.get(actionId);
    if (!a) throw new ActionRegistryError('action_not_found');
    const reserved = this.reserved.has(actionId);
    if (!reserved && a.expiresAt <= Date.now()) {
      this.actions.delete(actionId);
      this.reserved.delete(actionId);
      throw new ActionRegistryError('action_expired');
    }
    if (a.consumed) throw new ActionRegistryError('action_consumed');
    this.assertScope(a, scope ?? {});
    a.consumed = true;
    this.reserved.delete(actionId);
    return { ...a, consumed: true };
  }

  /** Undo a reservation when the action was never dispatched. */
  release(actionId: string): void {
    this.reserved.delete(actionId);
  }

  invalidateTarget(targetId: string): number {
    return this.removeWhere((a) => a.targetId === targetId);
  }

  invalidateGeneration(targetId: string, generation: number): number {
    return this.removeWhere((a) => a.targetId === targetId && a.targetGeneration !== generation);
  }

  invalidateAdapter(adapterId: string): number {
    return this.removeWhere((a) => a.adapterId === adapterId);
  }

  clear(): void {
    this.actions.clear();
    this.reserved.clear();
  }

  get size(): number {
    return this.actions.size;
  }

  private toPublic(a: RegisteredActionTarget): ToolActionCapability {
    return {
      actionId: a.actionId,
      label: a.expectedLabel,
      kind: a.actionType,
      executable: isExecutableActionType(a.actionType) && !a.consumed && a.expiresAt > Date.now(),
      requiresConfirmation: true,
      expiresAt: a.expiresAt,
    };
  }

  private requireLive(actionId: string): RegisteredActionTarget {
    const a = this.actions.get(actionId);
    if (!a) throw new ActionRegistryError('action_not_found');
    if (a.expiresAt <= Date.now()) {
      this.actions.delete(actionId);
      this.reserved.delete(actionId);
      throw new ActionRegistryError('action_expired');
    }
    return a;
  }

  private assertScope(a: RegisteredActionTarget, scope: ActionScope): void {
    for (const [key, value] of Object.entries(scope)) {
      if (value !== undefined && a[key as keyof RegisteredActionTarget] !== value) {
        throw new ActionRegistryError('action_scope_changed');
      }
    }
  }

  private removeWhere(predicate: (a: RegisteredActionTarget) => boolean): number {
    let count = 0;
    for (const [id, a] of this.actions) {
      if (predicate(a)) {
        this.actions.delete(id);
        this.reserved.delete(id);
        count++;
      }
    }
    return count;
  }

  private prune(now: number): void {
    this.removeWhere((a) => a.expiresAt <= now && !this.reserved.has(a.actionId));

    const maxPerTarget = this.opts.maxActionsPerTarget ?? 200;
    const targetCounts = new Map<string, number>();
    for (const action of this.actions.values()) {
      targetCounts.set(action.targetId, (targetCounts.get(action.targetId) ?? 0) + 1);
    }
    for (const [targetId, initialCount] of targetCounts) {
      let count = initialCount;
      if (count <= maxPerTarget) continue;
      for (const [id, action] of this.actions) {
        if (count <= maxPerTarget) break;
        if (action.targetId !== targetId || this.reserved.has(id)) continue;
        this.actions.delete(id);
        this.reserved.delete(id);
        count--;
      }
    }

    const max = this.opts.maxActions ?? 1000;
    while (this.actions.size > max) {
      let evict: string | undefined;
      for (const id of this.actions.keys()) {
        if (!this.reserved.has(id)) {
          evict = id;
          break;
        }
      }
      if (!evict) break;
      this.actions.delete(evict);
      this.reserved.delete(evict);
    }
  }
}