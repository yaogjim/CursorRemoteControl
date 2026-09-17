import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  OPERATION_JOURNAL_FILE,
  OPERATION_JOURNAL_MAX_RECORDS,
  OperationJournal,
  OperationJournalError,
  type CreateOperationInput,
  type OperationJournalStatus,
  type OperationRecord,
} from '../src/server/operation-journal.js';

const START = 1_000_000;
const DIGEST_A = 'digest-aaaa-0001';
const DIGEST_B = 'digest-bbbb-0002';

function input(over: Partial<CreateOperationInput> = {}): CreateOperationInput {
  return {
    operationId: 'op-00000001',
    payloadDigest: DIGEST_A,
    target: { workspaceId: 'ws-1', composerId: 'c-1' },
    ...over,
  };
}

describe('OperationJournal', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-journal-'));
    now = START;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): OperationJournal {
    return new OperationJournal({ dataDir: dir, now: () => now });
  }

  function storePath(): string {
    return join(dir, OPERATION_JOURNAL_FILE);
  }

  function readStore(): { version: number; records: OperationRecord[] } {
    return JSON.parse(readFileSync(storePath(), 'utf-8')) as { version: number; records: OperationRecord[] };
  }

  function writeStore(records: Array<Partial<OperationRecord> & Pick<OperationRecord, 'operationId' | 'status'>>): void {
    const payload = {
      version: 1,
      records: records.map((item, index) => ({
        operationId: item.operationId,
        payloadDigest: item.payloadDigest ?? DIGEST_A,
        target: item.target ?? { workspaceId: 'ws-1', composerId: 'c-1' },
        status: item.status,
        createdAt: item.createdAt ?? START + index,
        updatedAt: item.updatedAt ?? START + index,
      })),
    };
    writeFileSync(storePath(), `${JSON.stringify(payload)}\n`, 'utf-8');
  }

  it('create persists recorded digest and target ids without raw body or credentials', () => {
    const journal = open();
    const created = journal.create({
      ...input(),
      ...({ text: 'SECRET-BODY', token: 'cred-1' } as unknown as CreateOperationInput),
    });
    assert.equal(created.status, 'recorded');
    assert.equal(created.payloadDigest, DIGEST_A);
    assert.deepEqual(created.target, { workspaceId: 'ws-1', composerId: 'c-1' });
    assert.equal('text' in created, false);
    const raw = readFileSync(storePath(), 'utf-8');
    assert.equal(raw.includes('SECRET-BODY'), false);
    assert.equal(raw.includes('cred-1'), false);
    assert.equal(raw.includes(DIGEST_A), true);
    assert.deepEqual(journal.list().map((item) => item.operationId), ['op-00000001']);
  });

  it('does not change memory when writeJsonAtomic fails', () => {
    const journal = open();
    journal.create(input());
    const before = journal.get('op-00000001');
    assert.equal(before?.status, 'recorded');
    unlinkSync(storePath());
    mkdirSync(storePath());
    assert.throws(() => journal.markDispatching('op-00000001'), Error);
    const after = journal.get('op-00000001');
    assert.deepEqual(after, before);
    assert.equal(journal.list().length, 1);
    assert.equal(journal.list()[0]?.status, 'recorded');
  });

  it('does not keep a new record in memory when the first persist fails', () => {
    const journal = open();
    mkdirSync(storePath());
    assert.throws(() => journal.create(input()), Error);
    assert.deepEqual(journal.list(), []);
    assert.equal(journal.get('op-00000001'), undefined);
  });

  it('reloads recorded as cancelled and pending, dispatching, and dispatched as unknown without replay', () => {
    writeStore([
      { operationId: 'op-pending', status: 'pending', payloadDigest: 'digest-pending-0001' },
      { operationId: 'op-dispatching', status: 'dispatching', payloadDigest: DIGEST_A },
      { operationId: 'op-dispatched', status: 'dispatched', payloadDigest: DIGEST_B },
      { operationId: 'op-recorded', status: 'recorded', payloadDigest: 'digest-cccc-0003' },
    ]);
    now = START + 50;
    const journal = open();
    const pending = journal.get('op-pending');
    const dispatching = journal.get('op-dispatching');
    const dispatched = journal.get('op-dispatched');
    const recorded = journal.get('op-recorded');
    assert.equal(pending?.status, 'unknown');
    assert.equal(dispatching?.status, 'unknown');
    assert.equal(dispatched?.status, 'unknown');
    assert.equal(recorded?.status, 'cancelled');
    assert.equal(pending?.updatedAt, START + 50);
    assert.equal(dispatching?.updatedAt, START + 50);
    assert.equal(dispatched?.updatedAt, START + 50);
    const persisted = readStore();
    assert.deepEqual(
      persisted.records.map((item) => [item.operationId, item.status]),
      [
        ['op-pending', 'unknown'],
        ['op-dispatching', 'unknown'],
        ['op-dispatched', 'unknown'],
        ['op-recorded', 'cancelled'],
      ],
    );
    assert.throws(() => journal.markDispatching('op-pending'), OperationJournalError);
    assert.throws(() => journal.markDispatching('op-dispatching'), OperationJournalError);
    assert.throws(() => journal.markDispatching('op-dispatched'), OperationJournalError);
    assert.equal(journal.get('op-pending')?.status, 'unknown');
    assert.equal(journal.get('op-dispatching')?.status, 'unknown');
    assert.equal(journal.get('op-dispatched')?.status, 'unknown');
    const replayed = journal.create(input({ operationId: 'op-dispatching', payloadDigest: DIGEST_A }));
    assert.equal(replayed.status, 'unknown');
    assert.equal(journal.get('op-dispatching')?.status, 'unknown');
  });

  it('returns the existing record for the same operationId and digest, and rejects a different digest', () => {
    const journal = open();
    const first = journal.create(input());
    now = START + 10;
    const again = journal.create(input());
    assert.equal(again.operationId, first.operationId);
    assert.equal(again.payloadDigest, first.payloadDigest);
    assert.equal(again.createdAt, first.createdAt);
    assert.equal(again.status, 'recorded');
    assert.equal(journal.list().length, 1);
    assert.throws(
      () => journal.create(input({ payloadDigest: DIGEST_B })),
      OperationJournalError,
    );
    assert.equal(journal.list().length, 1);
    assert.equal(journal.get('op-00000001')?.payloadDigest, DIGEST_A);
    assert.equal(readStore().records.length, 1);
    assert.equal(readStore().records[0]?.payloadDigest, DIGEST_A);
  });

  it('prunes terminal records at capacity but never drops pending, dispatching, dispatched, or unknown', () => {
    const confirmed: Array<Partial<OperationRecord> & Pick<OperationRecord, 'operationId' | 'status'>> = [];
    for (let i = 0; i < OPERATION_JOURNAL_MAX_RECORDS - 4; i++) {
      confirmed.push({
        operationId: `op-done-${String(i).padStart(3, '0')}`,
        status: 'confirmed',
        payloadDigest: `digest-done-${String(i).padStart(3, '0')}`,
        createdAt: START + i,
        updatedAt: START + i,
      });
    }
    writeStore([
      ...confirmed,
      { operationId: 'op-pending-keep', status: 'pending', createdAt: START + 900, updatedAt: START + 900 },
      { operationId: 'op-dispatching-keep', status: 'dispatching', createdAt: START + 901, updatedAt: START + 901 },
      { operationId: 'op-dispatched-keep', status: 'dispatched', createdAt: START + 902, updatedAt: START + 902 },
      { operationId: 'op-unknown-keep', status: 'unknown', createdAt: START + 903, updatedAt: START + 903 },
    ]);
    const journal = open();
    assert.equal(journal.get('op-dispatching-keep')?.status, 'unknown');
    assert.equal(journal.get('op-dispatched-keep')?.status, 'unknown');
    const created = journal.create(input({ operationId: 'op-new-pending', payloadDigest: 'digest-new-pending' }));
    assert.equal(created.status, 'recorded');
    const ids = new Set(journal.list().map((item) => item.operationId));
    assert.equal(ids.size, OPERATION_JOURNAL_MAX_RECORDS);
    assert.equal(ids.has('op-pending-keep'), true);
    assert.equal(ids.has('op-dispatching-keep'), true);
    assert.equal(ids.has('op-dispatched-keep'), true);
    assert.equal(ids.has('op-unknown-keep'), true);
    assert.equal(ids.has('op-new-pending'), true);
    assert.equal(ids.has('op-done-000'), false);
    assert.equal(journal.get('op-pending-keep')?.status, 'unknown');
    assert.equal(journal.get('op-dispatching-keep')?.status, 'unknown');
    assert.equal(journal.get('op-dispatched-keep')?.status, 'unknown');
    assert.equal(journal.get('op-unknown-keep')?.status, 'unknown');
  });

  it('fail-closes when capacity is full of unresolved records', () => {
    const pending = Array.from({ length: OPERATION_JOURNAL_MAX_RECORDS }, (_, i) => ({
      operationId: `op-open-${String(i).padStart(3, '0')}`,
      status: (i % 2 === 0 ? 'unknown' : 'pending') as OperationJournalStatus,
      payloadDigest: `digest-open-${String(i).padStart(3, '0')}`,
      createdAt: START + i,
      updatedAt: START + i,
    }));
    writeStore(pending);
    const journal = open();
    assert.throws(
      () => journal.create(input({ operationId: 'op-overflow', payloadDigest: 'digest-overflow' })),
      OperationJournalError,
    );
    assert.equal(journal.list().length, OPERATION_JOURNAL_MAX_RECORDS);
    assert.equal(journal.get('op-overflow'), undefined);
    assert.equal(journal.get('op-open-000')?.status, 'unknown');
    assert.equal(journal.get('op-open-001')?.status, 'unknown');
    assert.equal(readStore().records.length, OPERATION_JOURNAL_MAX_RECORDS);
  });

  it('fail-closes illegal status transitions and allows cancel of pending only', () => {
    const journal = open();
    journal.create(input());
    assert.throws(() => journal.settle('op-00000001', 'confirmed'), OperationJournalError);
    assert.equal(journal.get('op-00000001')?.status, 'recorded');
    const cancelled = journal.cancelPending('op-00000001');
    assert.equal(cancelled.status, 'cancelled');
    assert.throws(() => journal.markDispatching('op-00000001'), OperationJournalError);
    assert.throws(() => journal.cancelPending('op-00000001'), OperationJournalError);

    journal.create(input({ operationId: 'op-00000002', payloadDigest: DIGEST_B }));
    const dispatching = journal.markDispatching('op-00000002');
    assert.equal(dispatching.status, 'dispatching');
    assert.equal(journal.markDispatching('op-00000002').status, 'dispatching');
    assert.throws(() => journal.cancelPending('op-00000002'), OperationJournalError);
    const failed = journal.settle('op-00000002', 'failed');
    assert.equal(failed.status, 'failed');
    assert.throws(() => journal.settle('op-00000002', 'confirmed'), OperationJournalError);
  });
});