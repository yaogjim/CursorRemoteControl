import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SUPERVISION_MAX_CHECKS_PER_GRANT,
  SUPERVISION_MAX_COMPOSER_IDS,
  SUPERVISION_STORE_FILE,
  SupervisionError,
  SupervisionManager,
} from '../src/server/supervision-manager.js';
import type { CreateSupervisionGrantInput, WorkspaceIdentity } from '../src/server/types.js';

const START = 1_000_000;

const WS: WorkspaceIdentity = {
  id: 'ws-stable',
  uri: { scheme: 'file', authority: '', path: '/Users/dev/proj' },
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function input(over: Partial<CreateSupervisionGrantInput> = {}): CreateSupervisionGrantInput {
  return {
    workspace: WS,
    goal: 'complete the task',
    constraints: 'no secrets',
    acceptanceCriteria: 'tests green',
    planVersion: 'plan-1',
    authorizationVersion: 'auth-1',
    controlVersion: 'ctrl-1',
    expiresAt: START + 60_000,
    operationLimit: 5,
    readComposerIds: ['c-read'],
    writeComposerIds: ['c-write'],
    allowedActionTypes: ['send_message', 'approve'],
    allowedModes: ['agent'],
    allowedModels: ['gpt'],
    ...over,
  };
}

describe('SupervisionManager', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'supervision-'));
    now = START;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): SupervisionManager {
    return new SupervisionManager({ dataDir: dir, now: () => now });
  }

  function storePath(): string {
    return join(dir, SUPERVISION_STORE_FILE);
  }

  function readStore(): Record<string, unknown> {
    return JSON.parse(readFileSync(storePath(), 'utf-8')) as Record<string, unknown>;
  }

  it('createGrant returns plaintext redeemCode once and stores only SHA-256', () => {
    const mgr = open();
    const { grant, redeemCode } = mgr.createGrant(input());
    assert.equal(typeof redeemCode, 'string');
    assert.ok(redeemCode.length >= 32);
    assert.equal(grant.status, 'active');
    assert.deepEqual(grant.readComposerIds, ['c-read']);
    assert.deepEqual(grant.writeComposerIds, ['c-write']);
    assert.equal(grant.operationsUsed, 0);
    const raw = readFileSync(storePath(), 'utf-8');
    assert.equal(raw.includes(redeemCode), false);
    const store = readStore();
    const codes = store.redeemCodes as Array<{ codeHash: string }>;
    assert.equal(codes.length, 1);
    assert.equal(codes[0].codeHash, sha256(redeemCode));
  });

  it('defaults empty read/write sets and a non-negative finite operationLimit', () => {
    const { grant } = open().createGrant(input({
      readComposerIds: undefined,
      writeComposerIds: undefined,
      operationLimit: undefined,
      allowedActionTypes: undefined,
      allowedModes: undefined,
      allowedModels: undefined,
      constraints: undefined,
      acceptanceCriteria: undefined,
    }));
    assert.deepEqual(grant.readComposerIds, []);
    assert.deepEqual(grant.writeComposerIds, []);
    assert.deepEqual(grant.allowedActionTypes, []);
    assert.deepEqual(grant.allowedModes, []);
    assert.deepEqual(grant.allowedModels, []);
    assert.equal(grant.constraints, '');
    assert.equal(grant.acceptanceCriteria, '');
    assert.equal(grant.operationLimit, 0);
    assert.equal(Number.isFinite(grant.operationLimit), true);
  });

  it('dedupes bounded arrays and rejects oversize or invalid values', () => {
    const mgr = open();
    const { grant } = mgr.createGrant(input({
      readComposerIds: ['a', 'a', 'b'],
      writeComposerIds: ['b', 'b'],
    }));
    assert.deepEqual(grant.readComposerIds, ['a', 'b']);
    assert.deepEqual(grant.writeComposerIds, ['b']);
    assert.throws(
      () => mgr.createGrant(input({ readComposerIds: Array.from({ length: SUPERVISION_MAX_COMPOSER_IDS + 1 }, (_, i) => `c${i}`) })),
      SupervisionError,
    );
    assert.throws(() => mgr.createGrant(input({ operationLimit: -1 })), SupervisionError);
    assert.throws(() => mgr.createGrant(input({ operationLimit: Number.POSITIVE_INFINITY })), SupervisionError);
    assert.throws(() => mgr.createGrant(input({ expiresAt: START - 1 })), SupervisionError);
    assert.throws(() => mgr.createGrant(input({ goal: '' })), SupervisionError);
  });

  it('redeems a code once, issues a short-lived token, and stores only the token hash', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const first = mgr.redeem(created.redeemCode);
    assert.equal(typeof first.token, 'string');
    assert.ok(first.token.length >= 32);
    assert.equal(first.grant.grantId, created.grant.grantId);
    assert.ok(first.expiresAt > now);
    const raw = readFileSync(storePath(), 'utf-8');
    assert.equal(raw.includes(first.token), false);
    const store = readStore();
    const tokens = store.tokens as Array<{ tokenHash: string }>;
    assert.equal(tokens.some((t) => t.tokenHash === sha256(first.token)), true);
    assert.throws(() => mgr.redeem(created.redeemCode), SupervisionError);
  });

  it('authenticate returns the current grant context and revoke invalidates the token immediately', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const { token } = mgr.redeem(created.redeemCode);
    const ctx = mgr.authenticate(token);
    assert.ok(ctx);
    assert.equal(ctx.grant.grantId, created.grant.grantId);
    assert.equal(ctx.grant.status, 'active');
    mgr.addPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    const paused = mgr.authenticate(token);
    assert.ok(paused);
    assert.deepEqual(paused.grant.pauseReasons, ['human_takeover']);
    mgr.revoke(created.grant.grantId);
    assert.equal(mgr.authenticate(token), null);
    assert.equal(mgr.getGrant(created.grant.grantId)?.status, 'revoked');
  });

  it('expired redeem codes and tokens are not valid', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    now += 11 * 60 * 1000;
    assert.throws(() => mgr.redeem(created.redeemCode), SupervisionError);
    now = START;
    const mgr2 = open();
    const created2 = mgr2.createGrant(input({ workspace: { id: 'ws-2', uri: WS.uri } }));
    const { token } = mgr2.redeem(created2.redeemCode);
    now += 61 * 60 * 1000;
    assert.equal(mgr2.authenticate(token), null);
  });

  it('supervisor cannot expand scopes, renew, or clear human_takeover', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const { token } = mgr.redeem(created.redeemCode);
    mgr.addPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    const supervisor = { role: 'supervisor' as const, token };
    assert.throws(
      () => mgr.updateScopes(created.grant.grantId, { readComposerIds: ['c-read', 'extra'] }, supervisor),
      SupervisionError,
    );
    assert.throws(
      () => mgr.renewGrant(created.grant.grantId, now + 120_000, supervisor),
      SupervisionError,
    );
    assert.throws(
      () => mgr.clearPause(created.grant.grantId, 'human_takeover', supervisor),
      SupervisionError,
    );
    assert.deepEqual(mgr.getGrant(created.grant.grantId)?.readComposerIds, ['c-read']);
    assert.equal(mgr.getGrant(created.grant.grantId)?.expiresAt, created.grant.expiresAt);
    assert.deepEqual(mgr.getGrant(created.grant.grantId)?.pauseReasons, ['human_takeover']);
    mgr.clearPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    mgr.renewGrant(created.grant.grantId, now + 120_000, { role: 'owner' });
    mgr.updateScopes(created.grant.grantId, { readComposerIds: ['c-read', 'extra'] }, { role: 'owner' });
    const after = mgr.getGrant(created.grant.grantId)!;
    assert.deepEqual(after.pauseReasons, []);
    assert.equal(after.expiresAt, now + 120_000);
    assert.deepEqual(after.readComposerIds, ['c-read', 'extra']);
  });

  it('consumeIssuePermit is single-use, strictly bound, and does not clear other pause reasons', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    mgr.addPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    const permit = mgr.createIssuePermit({
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-1',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-1',
      expiresAt: now + 30_000,
    });
    assert.equal(permit.status, 'pending');
    assert.ok(mgr.getGrant(created.grant.grantId)?.pauseReasons.includes('pending_issue'));
    assert.ok(mgr.getGrant(created.grant.grantId)?.pauseReasons.includes('human_takeover'));
    mgr.decideIssue(permit.issueId, 'approved', { role: 'owner' });
    assert.throws(() => mgr.consumeIssuePermit({
      issueId: permit.issueId,
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-1',
      planVersion: 'plan-other',
      authorizationVersion: 'auth-1',
      controlVersion: permit.controlVersion,
      contentDigest: 'digest-1',
    }), SupervisionError);
    const consumed = mgr.consumeIssuePermit({
      issueId: permit.issueId,
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-1',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: permit.controlVersion,
      contentDigest: 'digest-1',
    });
    assert.equal(consumed.status, 'consumed');
    const reasons = mgr.getGrant(created.grant.grantId)!.pauseReasons;
    assert.equal(reasons.includes('human_takeover'), true);
    assert.equal(reasons.includes('pending_issue'), false);
    assert.throws(() => mgr.consumeIssuePermit({
      issueId: permit.issueId,
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-1',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: permit.controlVersion,
      contentDigest: 'digest-1',
    }), SupervisionError);
  });

  it('does not report success or keep the mutation when writeJsonAtomic fails', () => {
    const mgr = open();
    const { grant } = mgr.createGrant(input());
    const before = grant.controlVersion;
    const file = storePath();
    unlinkSync(file);
    mkdirSync(file);
    assert.throws(
      () => mgr.addPause(grant.grantId, 'human_takeover', { role: 'owner' }),
      Error,
    );
    const after = mgr.getGrant(grant.grantId)!;
    assert.deepEqual(after.pauseReasons, []);
    assert.equal(after.controlVersion, before);
  });

  it('loads missing store as empty and fail-closes on corrupt or non-compliant records', () => {
    const empty = open();
    assert.equal(empty.getGrant('missing'), undefined);
    writeFileSync(storePath(), '{not-json', 'utf-8');
    assert.throws(() => open(), Error);
    writeFileSync(storePath(), JSON.stringify({ version: 1, grants: [{ grantId: 1 }], redeemCodes: [], tokens: [], issuePermits: [] }), 'utf-8');
    assert.throws(() => open(), Error);
  });

  it('reloads persisted grants and unused redeem hashes', () => {
    const first = open();
    const created = first.createGrant(input());
    const reloaded = open();
    assert.equal(reloaded.getGrant(created.grant.grantId)?.goal, 'complete the task');
    assert.equal(reloaded.getGrant(created.grant.grantId)?.status, 'pending_recovery');
    reloaded.resumeRecovery(created.grant.grantId, { role: 'owner' });
    const { token } = reloaded.redeem(created.redeemCode);
    assert.ok(reloaded.authenticate(token));
  });

  it('rotates an unpredictable controlVersion on write-permission changes', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const { token } = mgr.redeem(created.redeemCode);
    const owner = { role: 'owner' as const };
    const supervisor = { role: 'supervisor' as const, token };
    const seen = new Set<string>([created.grant.controlVersion]);
    function assertRotated(grantId: string): string {
      const version = mgr.getGrant(grantId)!.controlVersion;
      assert.equal(typeof version, 'string');
      assert.ok(version.length >= 16);
      assert.equal(seen.has(version), false);
      assert.notEqual(version, Number(version).toString());
      seen.add(version);
      return version;
    }

    for (const reason of [
      'human_takeover',
      'pending_issue',
      'supervisor_lost',
      'result_unknown',
      'revoked',
      'expired',
    ] as const) {
      const before = mgr.getGrant(created.grant.grantId)!.controlVersion;
      mgr.addPause(created.grant.grantId, reason, owner);
      assert.notEqual(assertRotated(created.grant.grantId), before);
    }
    const afterAllPauses = mgr.getGrant(created.grant.grantId)!.controlVersion;
    mgr.addPause(created.grant.grantId, 'human_takeover', owner);
    assert.equal(mgr.getGrant(created.grant.grantId)!.controlVersion, afterAllPauses);

    const other = mgr.createGrant(input({ workspace: { id: 'ws-ctrl', uri: WS.uri } }));
    const otherToken = mgr.redeem(other.redeemCode).token;
    const beforeSupervisor = other.grant.controlVersion;
    mgr.addPause(other.grant.grantId, 'supervisor_lost', { role: 'supervisor', token: otherToken });
    assert.notEqual(mgr.getGrant(other.grant.grantId)!.controlVersion, beforeSupervisor);
    assert.throws(() => mgr.clearPause(other.grant.grantId, 'supervisor_lost', { role: 'supervisor', token: otherToken }), SupervisionError);
    assert.throws(() => mgr.renewGrant(other.grant.grantId, now + 120_000, { role: 'supervisor', token: otherToken }), SupervisionError);
    assert.throws(() => mgr.updateScopes(other.grant.grantId, { writeComposerIds: ['c-write', 'extra'] }, { role: 'supervisor', token: otherToken }), SupervisionError);

    const beforeClear = mgr.getGrant(created.grant.grantId)!.controlVersion;
    mgr.clearPause(created.grant.grantId, 'expired', owner);
    assert.notEqual(assertRotated(created.grant.grantId), beforeClear);

    const beforeRenew = mgr.getGrant(created.grant.grantId)!.controlVersion;
    mgr.renewGrant(created.grant.grantId, now + 120_000, owner);
    assert.notEqual(assertRotated(created.grant.grantId), beforeRenew);

    const beforeScopes = mgr.getGrant(created.grant.grantId)!.controlVersion;
    mgr.updateScopes(created.grant.grantId, { writeComposerIds: ['c-write', 'c-extra'] }, owner);
    assert.notEqual(assertRotated(created.grant.grantId), beforeScopes);

    const beforeRevoke = mgr.getGrant(created.grant.grantId)!.controlVersion;
    mgr.revoke(created.grant.grantId);
    assert.notEqual(assertRotated(created.grant.grantId), beforeRevoke);
    assert.equal(mgr.authenticate(token), null);
  });

  it('rotates controlVersion when creating and consuming issue permits without clearing other pauses', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    mgr.addPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    const afterTakeover = mgr.getGrant(created.grant.grantId)!.controlVersion;
    const permit = mgr.createIssuePermit({
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-2',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-2',
      expiresAt: now + 30_000,
    });
    const afterPermit = mgr.getGrant(created.grant.grantId)!;
    assert.notEqual(afterPermit.controlVersion, afterTakeover);
    assert.ok(afterPermit.pauseReasons.includes('human_takeover'));
    assert.ok(afterPermit.pauseReasons.includes('pending_issue'));
    const duplicatePermit = mgr.createIssuePermit({
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-3',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-3',
      expiresAt: now + 30_000,
    });
    assert.equal(mgr.getGrant(created.grant.grantId)!.controlVersion, afterPermit.controlVersion);
    mgr.decideIssue(duplicatePermit.issueId, 'approved', { role: 'owner' });
    mgr.decideIssue(permit.issueId, 'approved', { role: 'owner' });
    mgr.consumeIssuePermit({
      issueId: duplicatePermit.issueId,
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-3',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: duplicatePermit.controlVersion,
      contentDigest: 'digest-3',
    });
    const stillPending = mgr.getGrant(created.grant.grantId)!;
    assert.equal(stillPending.controlVersion, afterPermit.controlVersion);
    assert.ok(stillPending.pauseReasons.includes('pending_issue'));
    mgr.consumeIssuePermit({
      issueId: permit.issueId,
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-2',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: permit.controlVersion,
      contentDigest: 'digest-2',
    });
    const afterConsume = mgr.getGrant(created.grant.grantId)!;
    assert.notEqual(afterConsume.controlVersion, stillPending.controlVersion);
    assert.deepEqual(afterConsume.pauseReasons, ['human_takeover']);
  });

  it('rejects issue permits after control changes or grant revocation', () => {
    const controlMgr = open();
    const controlGrant = controlMgr.createGrant(input({ workspace: { id: 'ws-control-permit', uri: WS.uri } }));
    const controlPermit = controlMgr.createIssuePermit({
      grantId: controlGrant.grant.grantId,
      workspace: controlGrant.grant.workspace,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-control',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-control',
      expiresAt: now + 30_000,
    });
    controlMgr.decideIssue(controlPermit.issueId, 'approved', { role: 'owner' });
    controlMgr.addPause(controlGrant.grant.grantId, 'human_takeover', { role: 'owner' });
    assert.equal(controlMgr.listIssues(controlGrant.grant.grantId)[0]?.status, 'revoked');
    assert.throws(() => controlMgr.consumeIssuePermit({
      issueId: controlPermit.issueId,
      grantId: controlGrant.grant.grantId,
      workspace: controlGrant.grant.workspace,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-control',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: controlPermit.controlVersion,
      contentDigest: 'digest-control',
    }), /issue permit is not pending/);

    const revokedMgr = open();
    const revokedGrant = revokedMgr.createGrant(input({ workspace: { id: 'ws-revoked-permit', uri: WS.uri } }));
    const revokedPermit = revokedMgr.createIssuePermit({
      grantId: revokedGrant.grant.grantId,
      workspace: revokedGrant.grant.workspace,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-revoked',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-revoked',
      expiresAt: now + 30_000,
    });
    revokedMgr.decideIssue(revokedPermit.issueId, 'approved', { role: 'owner' });
    revokedMgr.revoke(revokedGrant.grant.grantId);
    assert.throws(() => revokedMgr.consumeIssuePermit({
      issueId: revokedPermit.issueId,
      grantId: revokedGrant.grant.grantId,
      workspace: revokedGrant.grant.workspace,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-revoked',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: revokedPermit.controlVersion,
      contentDigest: 'digest-revoked',
    }), /grant is not valid/);
  });

  it('dedupes unchanged pending issues, expires them on list, and records notification status', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const payload = {
      grantId: created.grant.grantId,
      workspace: WS,
      composerId: 'c-write',
      actionType: 'approve',
      actionId: 'act-dup',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-dup',
      expiresAt: now + 30_000,
      evidence: 'tool failed',
      recommendation: 'retry with smaller scope',
      attemptedActions: ['approve'],
    };
    const first = mgr.createIssuePermit(payload);
    assert.equal(first.status, 'pending');
    assert.equal(first.evidence, 'tool failed');
    assert.equal(first.recommendation, 'retry with smaller scope');
    assert.deepEqual(first.attemptedActions, ['approve']);
    assert.equal(first.notificationStatus, 'not_configured');
    const duplicate = mgr.createIssuePermit({ ...payload, evidence: 'ignored', recommendation: 'ignored' });
    assert.equal(duplicate.issueId, first.issueId);
    assert.equal(mgr.listIssues(created.grant.grantId).length, 1);
    assert.equal(duplicate.evidence, 'tool failed');
    const sent = mgr.recordNotificationStatus(first.issueId, 'sent');
    assert.equal(sent.notificationStatus, 'sent');
    const confirmed = mgr.recordNotificationStatus(first.issueId, 'confirmed');
    assert.equal(confirmed.notificationStatus, 'confirmed');
    assert.throws(
      () => mgr.recordNotificationStatus(first.issueId, 'nope' as 'pending'),
      SupervisionError,
    );
    assert.equal(mgr.listIssues(created.grant.grantId)[0]?.notificationStatus, 'confirmed');
    const beforeExpiryControlVersion = mgr.getGrant(created.grant.grantId)!.controlVersion;
    now += 30_000;
    const listed = mgr.listIssues(created.grant.grantId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, 'expired');
    const afterExpiryGrant = mgr.getGrant(created.grant.grantId)!;
    assert.equal(afterExpiryGrant.pauseReasons.includes('pending_issue'), false);
    assert.notEqual(afterExpiryGrant.controlVersion, beforeExpiryControlVersion);
    const persisted = (readStore().issuePermits as Array<{ issueId: string; status: string }>).
      find((item) => item.issueId === first.issueId);
    assert.equal(persisted?.status, 'expired');
    listed[0]!.status = 'pending';
    assert.equal(mgr.listIssues(created.grant.grantId)[0]?.status, 'expired');
  });

  it('keeps only the most recent bounded checks per grant', () => {
    const mgr = open();
    const first = mgr.createGrant(input());
    const second = mgr.createGrant(input({ workspace: { id: 'ws-checks', uri: WS.uri } }));
    const keptIds: string[] = [];
    for (let i = 0; i < SUPERVISION_MAX_CHECKS_PER_GRANT + 3; i += 1) {
      now += 1;
      const rec = mgr.recordCheck(first.grant.grantId, i % 2 === 0 ? 'ok' : 'attention', `check-${i}`);
      keptIds.push(rec.checkId);
    }
    mgr.recordCheck(second.grant.grantId, 'failed', 'other-grant');
    const listed = mgr.listChecks(first.grant.grantId);
    assert.equal(listed.length, SUPERVISION_MAX_CHECKS_PER_GRANT);
    assert.deepEqual(listed.map((item) => item.checkId), keptIds.slice(3));
    assert.equal(listed[0]?.summary, 'check-3');
    assert.equal(mgr.listChecks(second.grant.grantId).length, 1);
    assert.equal(mgr.listChecks(second.grant.grantId)[0]?.status, 'failed');
    assert.throws(() => mgr.recordCheck(first.grant.grantId, 'nope' as 'ok', 'bad'), SupervisionError);
    const cloned = mgr.listChecks(first.grant.grantId);
    cloned[0]!.summary = 'mutated';
    assert.equal(mgr.listChecks(first.grant.grantId)[0]?.summary, 'check-3');
  });

  it('pauses overdue configured checks once and keeps unconfigured grants active', () => {
    const mgr = open();
    const watched = mgr.createGrant(input({ checkTtlMs: 1_000 }));
    const unconfigured = mgr.createGrant(input({
      workspace: { id: 'ws-no-checks', uri: WS.uri },
      checkTtlMs: 0,
    }));
    mgr.recordCheck(watched.grant.grantId, 'ok', 'active check');
    now += 1_001;
    const overdue = mgr.markOverdueChecks();
    assert.deepEqual(overdue.map((grant) => grant.grantId), [watched.grant.grantId]);
    assert.ok(mgr.getGrant(watched.grant.grantId)?.pauseReasons.includes('supervisor_lost'));
    assert.deepEqual(mgr.getGrant(unconfigured.grant.grantId)?.pauseReasons, []);
    assert.deepEqual(mgr.markOverdueChecks(), []);
  });

  it('marks loaded active grants pending_recovery without auto-resume or clearing other pauses', () => {
    const first = open();
    const created = first.createGrant(input());
    assert.equal(created.grant.status, 'active');
    first.addPause(created.grant.grantId, 'human_takeover', { role: 'owner' });
    const before = first.getGrant(created.grant.grantId)!;
    const reloaded = open();
    const loaded = reloaded.getGrant(created.grant.grantId)!;
    assert.equal(loaded.status, 'pending_recovery');
    assert.ok(loaded.pauseReasons.includes('human_takeover'));
    assert.ok(loaded.pauseReasons.includes('pending_recovery'));
    assert.notEqual(loaded.controlVersion, before.controlVersion);
    assert.throws(() => reloaded.redeem(created.redeemCode), /grant is not valid/);
    assert.throws(
      () => reloaded.resumeRecovery(created.grant.grantId, { role: 'supervisor', token: 'unused' }),
      SupervisionError,
    );
    assert.equal(reloaded.getGrant(created.grant.grantId)?.status, 'pending_recovery');
    const resumed = reloaded.resumeRecovery(created.grant.grantId, { role: 'owner' });
    assert.equal(resumed.status, 'active');
    assert.deepEqual(resumed.pauseReasons, ['human_takeover']);
    assert.notEqual(resumed.controlVersion, loaded.controlVersion);
    const secondReload = open();
    assert.equal(secondReload.getGrant(created.grant.grantId)?.status, 'pending_recovery');
    assert.ok(secondReload.getGrant(created.grant.grantId)?.pauseReasons.includes('human_takeover'));
    assert.ok(secondReload.getGrant(created.grant.grantId)?.pauseReasons.includes('pending_recovery'));
  });

  it('rejects supervisor resumeRecovery and leaves other pauses intact', () => {
    const mgr = open();
    const created = mgr.createGrant(input());
    const { token } = mgr.redeem(created.redeemCode);
    assert.throws(
      () => mgr.resumeRecovery(created.grant.grantId, { role: 'supervisor', token }),
      /supervisor cannot resume recovery/,
    );
    assert.equal(mgr.getGrant(created.grant.grantId)?.status, 'active');
    const store = readStore();
    delete store.checks;
    const permits = store.issuePermits as Array<Record<string, unknown>>;
    for (const permit of permits) {
      delete permit.evidence;
      delete permit.recommendation;
      delete permit.attemptedActions;
      delete permit.notificationStatus;
    }
    writeFileSync(storePath(), `${JSON.stringify(store)}\n`, 'utf-8');
    const reloaded = open();
    assert.deepEqual(reloaded.listChecks(created.grant.grantId), []);
    const loaded = reloaded.getGrant(created.grant.grantId)!;
    assert.equal(loaded.status, 'pending_recovery');
    const owner = reloaded.resumeRecovery(created.grant.grantId, { role: 'owner' });
    assert.equal(owner.status, 'active');
    assert.deepEqual(owner.pauseReasons, []);
  });
});