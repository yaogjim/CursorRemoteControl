import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canReadUnderSupervision,
  canWriteUnderSupervision,
} from '../src/server/supervision-policy.js';
import type { SupervisionGrant, WorkspaceIdentity } from '../src/server/types.js';

const NOW = 1_500_000;

const WS: WorkspaceIdentity = {
  id: 'ws-1',
  uri: { scheme: 'file', authority: '', path: '/tmp/proj' },
};

function grant(over: Partial<SupervisionGrant> = {}): SupervisionGrant {
  return {
    grantId: 'g1',
    workspace: WS,
    readComposerIds: ['read-1'],
    writeComposerIds: ['write-1'],
    goal: 'ship',
    constraints: 'no prod',
    acceptanceCriteria: 'tests pass',
    planVersion: 'plan-1',
    authorizationVersion: 'auth-1',
    controlVersion: 'ctrl-1',
    expiresAt: 2_000_000,
    operationLimit: 10,
    operationsUsed: 0,
    allowedActionTypes: ['send_message'],
    allowedModes: ['agent'],
    allowedModels: ['gpt'],
    pauseReasons: [],
    status: 'active',
    createdAt: 1_000_000,
    ...over,
  };
}

function writeReq(over: Partial<Parameters<typeof canWriteUnderSupervision>[1]> = {}) {
  return {
    composerId: 'write-1',
    actionType: 'send_message',
    planVersion: 'plan-1',
    authorizationVersion: 'auth-1',
    controlVersion: 'ctrl-1',
    mode: 'agent',
    model: 'gpt',
    now: NOW,
    ...over,
  };
}

describe('canReadUnderSupervision', () => {
  it('allows read when active, unexpired, and composer is in the read set', () => {
    assert.equal(canReadUnderSupervision(grant(), 'read-1', NOW), true);
  });

  it('allows read while paused', () => {
    const paused = grant({ pauseReasons: ['human_takeover', 'pending_issue'] });
    assert.equal(canReadUnderSupervision(paused, 'read-1', NOW), true);
  });

  it('denies read when composer is only in the write set', () => {
    assert.equal(canReadUnderSupervision(grant(), 'write-1', NOW), false);
  });

  it('denies read when the read set is empty', () => {
    assert.equal(canReadUnderSupervision(grant({ readComposerIds: [] }), 'read-1', NOW), false);
  });

  it('denies read when expired or not active', () => {
    assert.equal(canReadUnderSupervision(grant({ expiresAt: NOW }), 'read-1', NOW), false);
    assert.equal(canReadUnderSupervision(grant({ status: 'revoked' }), 'read-1', NOW), false);
    assert.equal(canReadUnderSupervision(grant({ status: 'expired' }), 'read-1', NOW), false);
    assert.equal(canReadUnderSupervision(grant({ status: 'pending_recovery' }), 'read-1', NOW), false);
  });
});

describe('canWriteUnderSupervision', () => {
  it('allows write only when every write predicate matches', () => {
    assert.equal(canWriteUnderSupervision(grant(), writeReq()), true);
  });

  it('denies write when any pause reason is present', () => {
    for (const reason of [
      'human_takeover',
      'pending_issue',
      'supervisor_lost',
      'result_unknown',
      'revoked',
      'expired',
    ] as const) {
      assert.equal(
        canWriteUnderSupervision(grant({ pauseReasons: [reason] }), writeReq()),
        false,
        reason,
      );
    }
  });

  it('denies write when composer is only in the read set', () => {
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ composerId: 'read-1' })), false);
  });

  it('denies write when versions, action, mode, or model do not match', () => {
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ actionType: 'approve' })), false);
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ planVersion: 'other' })), false);
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ authorizationVersion: 'other' })), false);
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ controlVersion: 'other' })), false);
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ mode: 'ask' })), false);
    assert.equal(canWriteUnderSupervision(grant(), writeReq({ model: 'other' })), false);
  });

  it('denies write when empty allowlists cannot match', () => {
    assert.equal(canWriteUnderSupervision(grant({ allowedActionTypes: [] }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ allowedModes: [] }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ allowedModels: [] }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ writeComposerIds: [] }), writeReq()), false);
  });

  it('denies write when the operation limit is reached or not finite', () => {
    assert.equal(canWriteUnderSupervision(grant({ operationsUsed: 10 }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ operationLimit: 0 }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ operationLimit: Number.POSITIVE_INFINITY }), writeReq()), false);
  });

  it('denies write when expired or not active', () => {
    assert.equal(canWriteUnderSupervision(grant({ expiresAt: NOW }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ status: 'revoked' }), writeReq()), false);
    assert.equal(canWriteUnderSupervision(grant({ status: 'pending_recovery' }), writeReq()), false);
  });
});