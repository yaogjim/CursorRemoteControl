import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './persist.js';

export const OPERATION_JOURNAL_FILE = 'operation-journal.json';
export const OPERATION_JOURNAL_MAX_RECORDS = 256;

const STORE_VERSION = 1;
const MAX_ID_LENGTH = 128;

/** Public statuses required by the durable journal contract. */
export type OperationJournalStatus =
  | 'recorded'
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

const STATUSES = new Set<OperationJournalStatus>([
  'recorded',
  'pending',
  'dispatching',
  'dispatched',
  'confirmed',
  'failed',
  'unknown',
  'cancelled',
]);

const PROTECTED_STATUSES = new Set<OperationJournalStatus>([
  'recorded',
  'pending',
  'dispatching',
  'dispatched',
  'unknown',
]);

const RECOVER_TO_UNKNOWN = new Set<OperationJournalStatus>(['pending', 'dispatching', 'dispatched']);

const DISPATCHED_FROM = new Set<OperationJournalStatus>(['dispatching']);
const SETTLE_FROM = new Set<OperationJournalStatus>(['dispatching', 'dispatched', 'unknown']);
const CANCEL_FROM = new Set<OperationJournalStatus>(['recorded', 'pending']);
const DISPATCH_FROM = new Set<OperationJournalStatus>(['recorded', 'pending']);

export class OperationJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationJournalError';
  }
}

/** Target identifiers only — never message bodies or credentials. */
export interface OperationTarget {
  workspaceId?: string;
  composerId?: string;
  windowId?: string;
  targetId?: string;
  targetGeneration?: number;
  grantId?: string;
  actionType?: string;
  planVersion?: string;
  authorizationVersion?: string;
  controlVersion?: string;
}

export interface OperationRecord {
  operationId: string;
  payloadDigest: string;
  target: OperationTarget;
  status: OperationJournalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOperationInput {
  operationId: string;
  payloadDigest: string;
  target: OperationTarget;
}

export interface OperationJournalOptions {
  dataDir: string;
  now?: () => number;
}

interface StoreState {
  version: 1;
  records: OperationRecord[];
}

export class OperationJournal {
  private readonly filePath: string;
  private readonly now: () => number;
  private state: StoreState;

  constructor(options: OperationJournalOptions) {
    this.filePath = join(options.dataDir, OPERATION_JOURNAL_FILE);
    this.now = options.now ?? Date.now;
    this.state = this.load();
  }

  list(): OperationRecord[] {
    return this.state.records.map(clone);
  }

  get(operationId: string): OperationRecord | undefined {
    const id = requireId(operationId, 'operationId');
    const found = this.state.records.find((item) => item.operationId === id);
    return found ? clone(found) : undefined;
  }

  create(input: CreateOperationInput): OperationRecord {
    const operationId = requireId(input.operationId, 'operationId');
    const payloadDigest = requireId(input.payloadDigest, 'payloadDigest');
    const target = sanitizeTarget(input.target);
    const existing = this.state.records.find((item) => item.operationId === operationId);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) {
        throw new OperationJournalError('operation payload digest mismatch');
      }
      return clone(existing);
    }
    const ts = this.now();
    const record: OperationRecord = {
      operationId,
      payloadDigest,
      target,
      status: 'recorded',
      createdAt: ts,
      updatedAt: ts,
    };
    this.commit((next) => {
      ensureCapacityForInsert(next.records);
      next.records.push(record);
    });
    return clone(record);
  }

  markPending(operationId: string): OperationRecord {
    const id = requireId(operationId, 'operationId');
    let result: OperationRecord | undefined;
    this.commit((next) => {
      const record = findRecord(next.records, id);
      if (record.status === 'pending') {
        result = record;
        return;
      }
      if (record.status !== 'recorded') {
        throw new OperationJournalError(`invalid status transition ${record.status} -> pending`);
      }
      record.status = 'pending';
      record.updatedAt = this.now();
      result = record;
    });
    if (!result) throw new OperationJournalError('operation not found');
    return clone(result);
  }

  markDispatching(operationId: string): OperationRecord {
    const id = requireId(operationId, 'operationId');
    let result: OperationRecord | undefined;
    this.commit((next) => {
      const record = findRecord(next.records, id);
      if (record.status === 'dispatching') {
        result = record;
        return;
      }
      if (!DISPATCH_FROM.has(record.status)) {
        throw new OperationJournalError(`invalid status transition ${record.status} -> dispatching`);
      }
      record.status = 'dispatching';
      record.updatedAt = this.now();
      result = record;
    });
    if (!result) throw new OperationJournalError('operation not found');
    return clone(result);
  }

  markDispatched(operationId: string): OperationRecord {
    const id = requireId(operationId, 'operationId');
    let result: OperationRecord | undefined;
    this.commit((next) => {
      const record = findRecord(next.records, id);
      if (record.status === 'dispatched') {
        result = record;
        return;
      }
      if (!DISPATCHED_FROM.has(record.status)) {
        throw new OperationJournalError(`invalid status transition ${record.status} -> dispatched`);
      }
      record.status = 'dispatched';
      record.updatedAt = this.now();
      result = record;
    });
    if (!result) throw new OperationJournalError('operation not found');
    return clone(result);
  }

  settle(operationId: string, outcome: 'confirmed' | 'failed' | 'unknown'): OperationRecord {
    if (outcome !== 'confirmed' && outcome !== 'failed' && outcome !== 'unknown') {
      throw new OperationJournalError('invalid settle outcome');
    }
    const id = requireId(operationId, 'operationId');
    let result: OperationRecord | undefined;
    this.commit((next) => {
      const record = findRecord(next.records, id);
      const allowed = SETTLE_FROM.has(record.status)
        || (outcome === 'failed' && CANCEL_FROM.has(record.status));
      if (!allowed) {
        throw new OperationJournalError(`invalid status transition ${record.status} -> ${outcome}`);
      }
      record.status = outcome;
      record.updatedAt = this.now();
      result = record;
    });
    if (!result) throw new OperationJournalError('operation not found');
    return clone(result);
  }

  cancelPending(operationId: string): OperationRecord {
    const id = requireId(operationId, 'operationId');
    let result: OperationRecord | undefined;
    this.commit((next) => {
      const record = findRecord(next.records, id);
      if (!CANCEL_FROM.has(record.status)) {
        throw new OperationJournalError(`invalid status transition ${record.status} -> cancelled`);
      }
      record.status = 'cancelled';
      record.updatedAt = this.now();
      result = record;
    });
    if (!result) throw new OperationJournalError('operation not found');
    return clone(result);
  }

  private commit(mutator: (next: StoreState) => void): void {
    const next = clone(this.state);
    mutator(next);
    writeJsonAtomic(this.filePath, next, undefined, { requireFsync: true });
    this.state = next;
  }

  private load(): StoreState {
    if (!existsSync(this.filePath)) return emptyStore();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperationJournalError('invalid operation journal');
    }
    const state = validateStore(parsed);
    const ts = this.now();
    let dirty = false;
    for (const record of state.records) {
      if (record.status === 'recorded') {
        record.status = 'cancelled';
        record.updatedAt = ts;
        dirty = true;
        continue;
      }
      if (!RECOVER_TO_UNKNOWN.has(record.status)) continue;
      record.status = 'unknown';
      record.updatedAt = ts;
      dirty = true;
    }
    if (dirty) writeJsonAtomic(this.filePath, state, undefined, { requireFsync: true });
    return state;
  }
}

function emptyStore(): StoreState {
  return { version: STORE_VERSION, records: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findRecord(records: OperationRecord[], operationId: string): OperationRecord {
  const record = records.find((item) => item.operationId === operationId);
  if (!record) throw new OperationJournalError('operation not found');
  return record;
}

function ensureCapacityForInsert(records: OperationRecord[]): void {
  if (records.length < OPERATION_JOURNAL_MAX_RECORDS) return;
  const drop: number[] = [];
  for (let i = 0; i < records.length && records.length - drop.length >= OPERATION_JOURNAL_MAX_RECORDS; i++) {
    if (!PROTECTED_STATUSES.has(records[i]!.status)) drop.push(i);
  }
  if (records.length - drop.length >= OPERATION_JOURNAL_MAX_RECORDS) {
    throw new OperationJournalError('operation journal full');
  }
  for (let i = drop.length - 1; i >= 0; i--) {
    records.splice(drop[i]!, 1);
  }
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new OperationJournalError(`invalid ${field}`);
  }
  if (value.trim() !== value || value.includes('\0')) throw new OperationJournalError(`invalid ${field}`);
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireId(value, field);
}

function sanitizeTarget(value: unknown): OperationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationJournalError('invalid target');
  }
  const raw = value as Record<string, unknown>;
  const target: OperationTarget = {};
  const workspaceId = optionalId(raw.workspaceId, 'target.workspaceId');
  const composerId = optionalId(raw.composerId, 'target.composerId');
  const windowId = optionalId(raw.windowId, 'target.windowId');
  const targetId = optionalId(raw.targetId, 'target.targetId');
  const targetGeneration = raw.targetGeneration === undefined
    ? undefined
    : requireTimestamp(raw.targetGeneration, 'target.targetGeneration');
  const grantId = optionalId(raw.grantId, 'target.grantId');
  const actionType = optionalId(raw.actionType, 'target.actionType');
  const planVersion = optionalId(raw.planVersion, 'target.planVersion');
  const authorizationVersion = optionalId(raw.authorizationVersion, 'target.authorizationVersion');
  const controlVersion = optionalId(raw.controlVersion, 'target.controlVersion');
  if (workspaceId !== undefined) target.workspaceId = workspaceId;
  if (composerId !== undefined) target.composerId = composerId;
  if (windowId !== undefined) target.windowId = windowId;
  if (targetId !== undefined) target.targetId = targetId;
  if (targetGeneration !== undefined) target.targetGeneration = targetGeneration;
  if (grantId !== undefined) target.grantId = grantId;
  if (actionType !== undefined) target.actionType = actionType;
  if (planVersion !== undefined) target.planVersion = planVersion;
  if (authorizationVersion !== undefined) target.authorizationVersion = authorizationVersion;
  if (controlVersion !== undefined) target.controlVersion = controlVersion;
  if (
    target.workspaceId === undefined
    && target.composerId === undefined
    && target.windowId === undefined
  ) {
    throw new OperationJournalError('invalid target');
  }
  return target;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OperationJournalError(`invalid ${field}`);
  }
  return value;
}

function assertStatus(value: unknown): asserts value is OperationJournalStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as OperationJournalStatus)) {
    throw new OperationJournalError('invalid operation journal');
  }
}

function validateStore(parsed: unknown): StoreState {
  if (!parsed || typeof parsed !== 'object') throw new OperationJournalError('invalid operation journal');
  const raw = parsed as { version?: unknown; records?: unknown };
  if (raw.version !== STORE_VERSION) throw new OperationJournalError('invalid operation journal');
  if (!Array.isArray(raw.records) || raw.records.length > OPERATION_JOURNAL_MAX_RECORDS) {
    throw new OperationJournalError('invalid operation journal');
  }
  const records = raw.records.map(validateRecord);
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.operationId)) throw new OperationJournalError('invalid operation journal');
    seen.add(record.operationId);
  }
  return { version: STORE_VERSION, records };
}

function validateRecord(value: unknown): OperationRecord {
  if (!value || typeof value !== 'object') throw new OperationJournalError('invalid operation journal');
  const raw = value as Record<string, unknown>;
  assertStatus(raw.status);
  return {
    operationId: requireId(raw.operationId, 'operationId'),
    payloadDigest: requireId(raw.payloadDigest, 'payloadDigest'),
    target: sanitizeTarget(raw.target),
    status: raw.status,
    createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
    updatedAt: requireTimestamp(raw.updatedAt, 'updatedAt'),
  };
}