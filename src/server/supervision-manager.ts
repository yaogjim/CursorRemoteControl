import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './persist.js';
import type {
  ConsumeIssuePermitInput,
  CreateIssuePermitInput,
  CreateSupervisionGrantInput,
  IssueNotificationStatus,
  IssueDecision,
  IssuePermit,
  IssuePermitStatus,
  SupervisionCheckRecord,
  SupervisionCheckStatus,
  SupervisionGrant,
  SupervisionGrantStatus,
  SupervisionPauseReason,
  SupervisorAuthContext,
  WorkspaceIdentity,
} from './types.js';

export const SUPERVISION_STORE_FILE = 'supervision.json';
export const SUPERVISOR_REDEEM_TTL_MS = 10 * 60 * 1000;
export const SUPERVISOR_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SUPERVISION_MAX_COMPOSER_IDS = 64;
export const SUPERVISION_MAX_ALLOWED_VALUES = 32;
export const SUPERVISION_MAX_TEXT_LENGTH = 4096;
export const SUPERVISION_MAX_ID_LENGTH = 128;
export const SUPERVISION_MAX_GRANTS = 64;
export const SUPERVISION_MAX_REDEEM_CODES = 128;
export const SUPERVISION_MAX_TOKENS = 128;
export const SUPERVISION_MAX_ISSUE_PERMITS = 128;
export const SUPERVISION_MAX_CHECKS_PER_GRANT = 32;

const STORE_VERSION = 1;
const HASH_HEX_RE = /^[a-f0-9]{64}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/i;

const GRANT_STATUSES = new Set<SupervisionGrantStatus>([
  'active',
  'revoked',
  'expired',
  'pending_recovery',
]);
const PAUSE_REASONS = new Set<SupervisionPauseReason>([
  'human_takeover',
  'pending_issue',
  'supervisor_lost',
  'result_unknown',
  'revoked',
  'expired',
  'pending_recovery',
]);
const PERMIT_STATUSES = new Set<IssuePermitStatus>(['pending', 'consumed', 'expired', 'revoked']);
const NOTIFICATION_STATUSES = new Set<IssueNotificationStatus>([
  'not_configured',
  'pending',
  'sent',
  'delivery_unknown',
  'confirmed',
]);
const CHECK_STATUSES = new Set<SupervisionCheckStatus>(['ok', 'attention', 'failed']);

export type SupervisionActor =
  | { role: 'owner' }
  | { role: 'supervisor'; token: string };

export class SupervisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisionError';
  }
}

interface RedeemRecord {
  grantId: string;
  codeHash: string;
  expiresAt: number;
  consumedAt: number | null;
}

interface TokenRecord {
  grantId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface StoreState {
  version: 1;
  grants: SupervisionGrant[];
  redeemCodes: RedeemRecord[];
  tokens: TokenRecord[];
  issuePermits: IssuePermit[];
  checks: SupervisionCheckRecord[];
}

export interface SupervisionManagerOptions {
  dataDir: string;
  now?: () => number;
  redeemTtlMs?: number;
  tokenTtlMs?: number;
}

export class SupervisionManager {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly redeemTtlMs: number;
  private readonly tokenTtlMs: number;
  private state: StoreState;

  constructor(options: SupervisionManagerOptions) {
    this.filePath = join(options.dataDir, SUPERVISION_STORE_FILE);
    this.now = options.now ?? Date.now;
    this.redeemTtlMs = options.redeemTtlMs ?? SUPERVISOR_REDEEM_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? SUPERVISOR_TOKEN_TTL_MS;
    this.state = this.load();
  }

  createGrant(input: CreateSupervisionGrantInput): { grant: SupervisionGrant; redeemCode: string } {
    const ts = this.now();
    const grant = buildGrant(input, ts);
    const redeemCode = randomSecret();
    this.commit((next) => {
      if (next.grants.length >= SUPERVISION_MAX_GRANTS) throw new SupervisionError('too many grants');
      if (next.redeemCodes.length >= SUPERVISION_MAX_REDEEM_CODES) throw new SupervisionError('too many redeem codes');
      next.grants.push(grant);
      next.redeemCodes.push({
        grantId: grant.grantId,
        codeHash: sha256Hex(redeemCode),
        expiresAt: ts + this.redeemTtlMs,
        consumedAt: null,
      });
    });
    return { grant: clone(grant), redeemCode };
  }

  redeem(redeemCode: string): { token: string; expiresAt: number; grant: SupervisionGrant } {
    if (typeof redeemCode !== 'string' || redeemCode.length === 0) {
      throw new SupervisionError('invalid redeem code');
    }
    const ts = this.now();
    const codeHash = sha256Hex(redeemCode);
    const token = randomSecret();
    const tokenExpiresAt = ts + this.tokenTtlMs;
    let grantId = '';
    this.commit((next) => {
      const rec = next.redeemCodes.find((item) => safeEqualHex(item.codeHash, codeHash));
      if (!rec) throw new SupervisionError('invalid redeem code');
      if (rec.consumedAt !== null) throw new SupervisionError('redeem code already used');
      if (ts >= rec.expiresAt) throw new SupervisionError('redeem code expired');
      const grant = next.grants.find((item) => item.grantId === rec.grantId);
      if (!grant || !isGrantCurrentlyValid(grant, ts)) throw new SupervisionError('grant is not valid');
      if (next.tokens.length >= SUPERVISION_MAX_TOKENS) throw new SupervisionError('too many tokens');
      rec.consumedAt = ts;
      grantId = grant.grantId;
      next.tokens.push({
        grantId: grant.grantId,
        tokenHash: sha256Hex(token),
        createdAt: ts,
        expiresAt: tokenExpiresAt,
        revokedAt: null,
      });
    });
    return { token, expiresAt: tokenExpiresAt, grant: this.requireGrant(grantId) };
  }

  authenticate(token: string): SupervisorAuthContext | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const ts = this.now();
    const tokenHash = sha256Hex(token);
    const rec = this.state.tokens.find((item) => safeEqualHex(item.tokenHash, tokenHash));
    if (!rec || rec.revokedAt !== null || ts >= rec.expiresAt) return null;
    const grant = this.state.grants.find((item) => item.grantId === rec.grantId);
    if (!grant || !isGrantCurrentlyValid(grant, ts)) return null;
    return { grant: clone(grant), expiresAt: rec.expiresAt };
  }

  revoke(grantId: string): SupervisionGrant {
    const ts = this.now();
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      grant.status = 'revoked';
      addPauseReason(grant, 'revoked');
      rotateControlVersion(grant);
      for (const rec of next.tokens) {
        if (rec.grantId === grantId && rec.revokedAt === null) rec.revokedAt = ts;
      }
      for (const rec of next.redeemCodes) {
        if (rec.grantId === grantId && rec.consumedAt === null) rec.consumedAt = ts;
      }
    });
    return this.requireGrant(grantId);
  }

  getGrant(grantId: string): SupervisionGrant | undefined {
    const grant = this.state.grants.find((item) => item.grantId === grantId);
    return grant ? clone(grant) : undefined;
  }

  listGrants(): SupervisionGrant[] {
    return this.state.grants.map(clone);
  }

  listGrantsForWorkspace(workspace: WorkspaceIdentity): SupervisionGrant[] {
    const validated = validateWorkspace(workspace);
    return this.state.grants
      .filter((grant) => workspaceEqual(grant.workspace, validated))
      .map(clone);
  }

  recordOperation(grantId: string, controlVersion: string): SupervisionGrant {
    const expected = requireId(controlVersion, 'controlVersion');
    const ts = this.now();
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      if (!isGrantCurrentlyValid(grant, ts)) throw new SupervisionError('grant is not valid');
      if (grant.controlVersion !== expected) throw new SupervisionError('control version mismatch');
      if (grant.operationsUsed >= grant.operationLimit) throw new SupervisionError('operation limit reached');
      grant.operationsUsed += 1;
      rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  pauseWorkspace(
    workspace: WorkspaceIdentity,
    reason: SupervisionPauseReason,
    actor: SupervisionActor,
  ): SupervisionGrant[] {
    this.assertActor(actor);
    if (actor.role !== 'owner') throw new SupervisionError('supervisor cannot pause workspace grants');
    assertPauseReason(reason);
    const validated = validateWorkspace(workspace);
    const ids = this.state.grants
      .filter((grant) => workspaceEqual(grant.workspace, validated) && grant.status === 'active')
      .map((grant) => grant.grantId);
    if (ids.length === 0) return [];
    this.commit((next) => {
      for (const grantId of ids) {
        const grant = findGrant(next, grantId);
        if (addPauseReason(grant, reason)) rotateControlVersion(grant);
      }
    });
    return ids.map((grantId) => this.requireGrant(grantId));
  }

  addPause(grantId: string, reason: SupervisionPauseReason, actor: SupervisionActor): SupervisionGrant {
    this.assertActor(actor);
    assertPauseReason(reason);
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      if (addPauseReason(grant, reason)) rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  clearPause(grantId: string, reason: SupervisionPauseReason, actor: SupervisionActor): SupervisionGrant {
    this.assertActor(actor);
    assertPauseReason(reason);
    if (actor.role === 'supervisor') {
      throw new SupervisionError(
        reason === 'human_takeover'
          ? 'supervisor cannot clear human_takeover'
          : 'supervisor cannot clear pause reasons',
      );
    }
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      grant.pauseReasons = grant.pauseReasons.filter((item) => item !== reason);
      rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  renewGrant(grantId: string, expiresAt: number, actor: SupervisionActor): SupervisionGrant {
    this.assertActor(actor);
    if (actor.role === 'supervisor') throw new SupervisionError('supervisor cannot renew authorization');
    const ts = this.now();
    assertFutureTimestamp(expiresAt, ts, 'expiresAt');
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      grant.expiresAt = expiresAt;
      rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  updateScopes(
    grantId: string,
    scopes: { readComposerIds?: string[]; writeComposerIds?: string[] },
    actor: SupervisionActor,
  ): SupervisionGrant {
    this.assertActor(actor);
    if (actor.role === 'supervisor') throw new SupervisionError('supervisor cannot expand authorization');
    const readComposerIds = scopes.readComposerIds === undefined
      ? undefined
      : boundedUniqueIds(scopes.readComposerIds, SUPERVISION_MAX_COMPOSER_IDS, 'readComposerIds');
    const writeComposerIds = scopes.writeComposerIds === undefined
      ? undefined
      : boundedUniqueIds(scopes.writeComposerIds, SUPERVISION_MAX_COMPOSER_IDS, 'writeComposerIds');
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      if (readComposerIds) grant.readComposerIds = readComposerIds;
      if (writeComposerIds) grant.writeComposerIds = writeComposerIds;
      rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  createIssuePermit(input: CreateIssuePermitInput): IssuePermit {
    const ts = this.now();
    const workspace = validateWorkspace(input.workspace);
    const composerId = requireId(input.composerId, 'composerId');
    const actionType = requireId(input.actionType, 'actionType');
    const actionId = requireId(input.actionId, 'actionId');
    const planVersion = requireId(input.planVersion, 'planVersion');
    const authorizationVersion = requireId(input.authorizationVersion, 'authorizationVersion');
    const contentDigest = requireId(input.contentDigest, 'contentDigest');
    assertFutureTimestamp(input.expiresAt, ts, 'expiresAt');
    const evidence = input.evidence === undefined ? '' : requireText(input.evidence, 'evidence', { required: false });
    const recommendation = input.recommendation === undefined
      ? ''
      : requireText(input.recommendation, 'recommendation', { required: false });
    const attemptedActions = input.attemptedActions === undefined
      ? []
      : boundedTexts(input.attemptedActions, SUPERVISION_MAX_ALLOWED_VALUES, 'attemptedActions');
    const existingGrant = this.state.grants.find((item) => item.grantId === input.grantId);
    if (!existingGrant) throw new SupervisionError('grant not found');
    if (!isGrantCurrentlyValid(existingGrant, ts)) throw new SupervisionError('grant is not valid');
    if (!workspaceEqual(existingGrant.workspace, workspace)) throw new SupervisionError('workspace mismatch');
    if (existingGrant.planVersion !== planVersion || existingGrant.authorizationVersion !== authorizationVersion) {
      throw new SupervisionError('version mismatch');
    }
    if (!existingGrant.writeComposerIds.includes(composerId)) throw new SupervisionError('composer is not writable');
    const duplicate = this.state.issuePermits.find((item) =>
      item.grantId === existingGrant.grantId
      && item.status === 'pending'
      && ts < item.expiresAt
      && item.composerId === composerId
      && item.actionType === actionType
      && item.actionId === actionId
      && item.planVersion === planVersion
      && item.authorizationVersion === authorizationVersion
      && item.contentDigest === contentDigest
      && workspaceEqual(item.workspace, workspace),
    );
    if (duplicate) return clone(duplicate);
    let created: IssuePermit | undefined;
    this.commit((next) => {
      const grant = findGrant(next, input.grantId);
      if (!isGrantCurrentlyValid(grant, ts)) throw new SupervisionError('grant is not valid');
      if (!workspaceEqual(grant.workspace, workspace)) throw new SupervisionError('workspace mismatch');
      if (grant.planVersion !== planVersion || grant.authorizationVersion !== authorizationVersion) {
        throw new SupervisionError('version mismatch');
      }
      if (!grant.writeComposerIds.includes(composerId)) throw new SupervisionError('composer is not writable');
      if (next.issuePermits.length >= SUPERVISION_MAX_ISSUE_PERMITS) {
        throw new SupervisionError('too many issue permits');
      }
      if (addPauseReason(grant, 'pending_issue')) rotateControlVersion(grant);
      const permit: IssuePermit = {
        issueId: randomId(),
        grantId: grant.grantId,
        workspace: clone(workspace),
        composerId,
        actionType,
        actionId,
        planVersion,
        authorizationVersion,
        controlVersion: grant.controlVersion,
        contentDigest,
        createdAt: ts,
        expiresAt: input.expiresAt,
        status: 'pending',
        evidence,
        recommendation,
        attemptedActions,
        notificationStatus: 'not_configured',
        decision: 'pending',
        decidedAt: null,
      };
      next.issuePermits.push(permit);
      created = permit;
    });
    return clone(created!);
  }

  consumeIssuePermit(input: ConsumeIssuePermitInput): IssuePermit {
    return this.consumeIssuePermitInternal(input, false).permit;
  }

  /** Atomically consume a one-shot decision and charge its supervised operation before dispatch. */
  consumeIssuePermitAndRecordOperation(
    input: ConsumeIssuePermitInput,
  ): { permit: IssuePermit; grant: SupervisionGrant } {
    return this.consumeIssuePermitInternal(input, true);
  }

  private consumeIssuePermitInternal(
    input: ConsumeIssuePermitInput,
    recordOperation: boolean,
  ): { permit: IssuePermit; grant: SupervisionGrant } {
    const ts = this.now();
    const workspace = validateWorkspace(input.workspace);
    let consumedId = '';
    let grantId = '';
    this.commit((next) => {
      const permit = next.issuePermits.find((item) => item.issueId === input.issueId);
      if (!permit) throw new SupervisionError('issue permit not found');
      if (permit.status !== 'pending') throw new SupervisionError('issue permit is not pending');
      if (permit.decision !== 'approved') throw new SupervisionError('issue permit is not approved');
      if (ts >= permit.expiresAt) throw new SupervisionError('issue permit expired');
      if (permit.grantId !== input.grantId) throw new SupervisionError('grant mismatch');
      if (!workspaceEqual(permit.workspace, workspace)) throw new SupervisionError('workspace mismatch');
      if (permit.composerId !== input.composerId || permit.actionType !== input.actionType || permit.actionId !== input.actionId) {
        throw new SupervisionError('action mismatch');
      }
      if (permit.planVersion !== input.planVersion || permit.authorizationVersion !== input.authorizationVersion) {
        throw new SupervisionError('version mismatch');
      }
      if (permit.contentDigest !== input.contentDigest) throw new SupervisionError('content digest mismatch');
      const grant = findGrant(next, permit.grantId);
      if (!isGrantCurrentlyValid(grant, ts)) throw new SupervisionError('grant is not valid');
      if (!workspaceEqual(grant.workspace, workspace)) throw new SupervisionError('workspace mismatch');
      if (grant.planVersion !== input.planVersion || grant.authorizationVersion !== input.authorizationVersion) {
        throw new SupervisionError('version mismatch');
      }
      if (permit.controlVersion !== input.controlVersion || grant.controlVersion !== input.controlVersion) {
        throw new SupervisionError('control version mismatch');
      }
      if (recordOperation && grant.operationsUsed >= grant.operationLimit) {
        throw new SupervisionError('operation limit reached');
      }
      permit.status = 'consumed';
      consumedId = permit.issueId;
      grantId = grant.grantId;
      const stillPending = next.issuePermits.some(
        (item) => item.grantId === grant.grantId && item.status === 'pending' && item.issueId !== permit.issueId,
      );
      let controlChanged = false;
      if (!stillPending && grant.pauseReasons.includes('pending_issue')) {
        grant.pauseReasons = grant.pauseReasons.filter((reason) => reason !== 'pending_issue');
        controlChanged = true;
      }
      if (recordOperation) {
        grant.operationsUsed += 1;
        controlChanged = true;
      }
      if (controlChanged) rotateControlVersion(grant);
    });
    const permit = this.state.issuePermits.find((item) => item.issueId === consumedId);
    const grant = this.state.grants.find((item) => item.grantId === grantId);
    if (!permit) throw new SupervisionError('issue permit not found');
    if (!grant) throw new SupervisionError('grant not found');
    return { permit: clone(permit), grant: clone(grant) };
  }

  getIssue(issueId: string): IssuePermit | undefined {
    const issue = this.state.issuePermits.find((item) => item.issueId === issueId);
    return issue ? clone(issue) : undefined;
  }

  decideIssue(issueId: string, decision: Exclude<IssueDecision, 'pending'>, actor: SupervisionActor): IssuePermit {
    this.assertActor(actor);
    if (actor.role !== 'owner') throw new SupervisionError('supervisor cannot decide issues');
    if (decision !== 'approved' && decision !== 'rejected') throw new SupervisionError('invalid issue decision');
    const ts = this.now();
    this.commit((next) => {
      const issue = next.issuePermits.find((item) => item.issueId === issueId);
      if (!issue) throw new SupervisionError('issue permit not found');
      if (issue.status !== 'pending' || issue.decision !== 'pending') {
        throw new SupervisionError('issue permit is not pending');
      }
      if (ts >= issue.expiresAt) throw new SupervisionError('issue permit expired');
      const grant = findGrant(next, issue.grantId);
      if (!isGrantCurrentlyValid(grant, ts)) throw new SupervisionError('grant is not valid');
      if (grant.controlVersion !== issue.controlVersion) throw new SupervisionError('control version mismatch');
      issue.decision = decision;
      issue.decidedAt = ts;
      issue.notificationStatus = 'confirmed';
      if (decision === 'rejected') {
        issue.status = 'revoked';
        const stillPending = next.issuePermits.some((item) =>
          item.grantId === grant.grantId && item.issueId !== issue.issueId && item.status === 'pending'
        );
        if (!stillPending && grant.pauseReasons.includes('pending_issue')) {
          grant.pauseReasons = grant.pauseReasons.filter((reason) => reason !== 'pending_issue');
          rotateControlVersion(grant);
        }
      }
    });
    return this.getIssue(issueId)!;
  }

  listIssues(grantId: string): IssuePermit[] {
    const ts = this.now();
    const expiredIds = this.state.issuePermits
      .filter((item) => item.grantId === grantId && item.status === 'pending' && ts >= item.expiresAt)
      .map((item) => item.issueId);
    const staleIds = this.state.issuePermits
      .filter((item) => {
        if (item.grantId !== grantId || item.status !== 'pending' || ts >= item.expiresAt) return false;
        const grant = this.state.grants.find((candidate) => candidate.grantId === item.grantId);
        return !grant
          || !isGrantCurrentlyValid(grant, ts)
          || grant.controlVersion !== item.controlVersion
          || grant.planVersion !== item.planVersion
          || grant.authorizationVersion !== item.authorizationVersion
          || !workspaceEqual(grant.workspace, item.workspace);
      })
      .map((item) => item.issueId);
    if (expiredIds.length > 0 || staleIds.length > 0) {
      this.commit((next) => {
        const affectedGrantIds = new Set<string>();
        for (const issueId of expiredIds) {
          const permit = next.issuePermits.find((item) => item.issueId === issueId);
          if (permit && permit.status === 'pending') {
            permit.status = 'expired';
            affectedGrantIds.add(permit.grantId);
          }
        }
        for (const issueId of staleIds) {
          const permit = next.issuePermits.find((item) => item.issueId === issueId);
          if (permit && permit.status === 'pending') {
            permit.status = 'revoked';
            affectedGrantIds.add(permit.grantId);
          }
        }
        for (const affectedGrantId of affectedGrantIds) {
          const grant = findGrant(next, affectedGrantId);
          const stillPending = next.issuePermits.some((item) =>
            item.grantId === affectedGrantId && item.status === 'pending'
          );
          if (!stillPending && grant.pauseReasons.includes('pending_issue')) {
            grant.pauseReasons = grant.pauseReasons.filter((reason) => reason !== 'pending_issue');
            rotateControlVersion(grant);
          }
        }
      });
    }
    return this.state.issuePermits.filter((item) => item.grantId === grantId).map(clone);
  }

  recordNotificationStatus(issueId: string, status: IssueNotificationStatus): IssuePermit {
    assertNotificationStatus(status);
    this.commit((next) => {
      const permit = next.issuePermits.find((item) => item.issueId === issueId);
      if (!permit) throw new SupervisionError('issue permit not found');
      permit.notificationStatus = status;
    });
    const permit = this.state.issuePermits.find((item) => item.issueId === issueId);
    if (!permit) throw new SupervisionError('issue permit not found');
    return clone(permit);
  }

  recordCheck(grantId: string, status: SupervisionCheckStatus, summary: string): SupervisionCheckRecord {
    assertCheckStatus(status);
    const checkedAt = this.now();
    const normalizedSummary = requireText(summary, 'summary', { required: false });
    let created: SupervisionCheckRecord | undefined;
    this.commit((next) => {
      findGrant(next, grantId);
      const record: SupervisionCheckRecord = {
        checkId: randomId(),
        grantId,
        checkedAt,
        status,
        summary: normalizedSummary,
      };
      next.checks.push(record);
      const owned = next.checks.filter((item) => item.grantId === grantId);
      const drop = Math.max(0, owned.length - SUPERVISION_MAX_CHECKS_PER_GRANT);
      if (drop > 0) {
        let dropped = 0;
        next.checks = next.checks.filter((item) => {
          if (item.grantId !== grantId || dropped >= drop) return true;
          dropped += 1;
          return false;
        });
      }
      created = record;
    });
    return clone(created!);
  }

  listChecks(grantId: string): SupervisionCheckRecord[] {
    return this.state.checks.filter((item) => item.grantId === grantId).map(clone);
  }

  /**
   * Pause grants whose explicitly configured active-check window elapsed.
   * A zero TTL is unconfigured and never creates a false loss signal.
   */
  markOverdueChecks(): SupervisionGrant[] {
    const ts = this.now();
    const overdueIds = this.state.grants
      .filter((grant) => {
        if (grant.status !== 'active' || grant.checkTtlMs <= 0 || grant.pauseReasons.includes('supervisor_lost')) return false;
        const checks = this.state.checks.filter((item) => item.grantId === grant.grantId);
        const latestAt = checks.reduce((value, item) => Math.max(value, item.checkedAt), grant.createdAt);
        return ts - latestAt > grant.checkTtlMs;
      })
      .map((grant) => grant.grantId);
    if (overdueIds.length === 0) return [];
    this.commit((next) => {
      for (const grantId of overdueIds) {
        const grant = findGrant(next, grantId);
        if (addPauseReason(grant, 'supervisor_lost')) rotateControlVersion(grant);
      }
    });
    return overdueIds.map((grantId) => this.requireGrant(grantId));
  }

  resumeRecovery(grantId: string, actor: SupervisionActor): SupervisionGrant {
    this.assertActor(actor);
    if (actor.role === 'supervisor') throw new SupervisionError('supervisor cannot resume recovery');
    this.commit((next) => {
      const grant = findGrant(next, grantId);
      if (grant.status !== 'pending_recovery') throw new SupervisionError('grant is not pending recovery');
      grant.pauseReasons = grant.pauseReasons.filter((reason) => reason !== 'pending_recovery');
      grant.status = 'active';
      rotateControlVersion(grant);
    });
    return this.requireGrant(grantId);
  }

  private assertActor(actor: SupervisionActor): void {
    if (!actor || (actor.role !== 'owner' && actor.role !== 'supervisor')) {
      throw new SupervisionError('invalid actor');
    }
    if (actor.role === 'supervisor' && !this.authenticate(actor.token)) {
      throw new SupervisionError('invalid supervisor token');
    }
  }

  private requireGrant(grantId: string): SupervisionGrant {
    const grant = this.getGrant(grantId);
    if (!grant) throw new SupervisionError('grant not found');
    return grant;
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
      throw new SupervisionError('invalid supervision store');
    }
    return this.markLoadedActiveGrantsPendingRecovery(validateStore(parsed));
  }

  private markLoadedActiveGrantsPendingRecovery(store: StoreState): StoreState {
    const next = clone(store);
    let changed = false;
    for (const grant of next.grants) {
      if (grant.status !== 'active') continue;
      grant.status = 'pending_recovery';
      addPauseReason(grant, 'pending_recovery');
      rotateControlVersion(grant);
      changed = true;
    }
    if (!changed) return store;
    writeJsonAtomic(this.filePath, next, undefined, { requireFsync: true });
    return next;
  }
}

function emptyStore(): StoreState {
  return { version: STORE_VERSION, grants: [], redeemCodes: [], tokens: [], issuePermits: [], checks: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

function randomId(): string {
  return randomBytes(16).toString('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function isGrantCurrentlyValid(grant: SupervisionGrant, now: number): boolean {
  return grant.status === 'active' && now < grant.expiresAt;
}

function findGrant(state: StoreState, grantId: string): SupervisionGrant {
  const grant = state.grants.find((item) => item.grantId === grantId);
  if (!grant) throw new SupervisionError('grant not found');
  return grant;
}

function addPauseReason(grant: SupervisionGrant, reason: SupervisionPauseReason): boolean {
  if (grant.pauseReasons.includes(reason)) return false;
  grant.pauseReasons.push(reason);
  return true;
}

function rotateControlVersion(grant: SupervisionGrant): void {
  let next = randomId();
  while (next === grant.controlVersion) next = randomId();
  grant.controlVersion = next;
}

function workspaceEqual(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return a.id === b.id
    && a.uri.scheme === b.uri.scheme
    && a.uri.authority === b.uri.authority
    && a.uri.path === b.uri.path;
}

function buildGrant(input: CreateSupervisionGrantInput, ts: number): SupervisionGrant {
  const workspace = validateWorkspace(input.workspace);
  const goal = requireText(input.goal, 'goal', { required: true });
  const constraints = input.constraints === undefined ? '' : requireText(input.constraints, 'constraints', { required: false });
  const acceptanceCriteria = input.acceptanceCriteria === undefined
    ? ''
    : requireText(input.acceptanceCriteria, 'acceptanceCriteria', { required: false });
  const planVersion = requireId(input.planVersion, 'planVersion');
  const authorizationVersion = requireId(input.authorizationVersion, 'authorizationVersion');
  const controlVersion = input.controlVersion === undefined ? '1' : requireId(input.controlVersion, 'controlVersion');
  assertFutureTimestamp(input.expiresAt, ts, 'expiresAt');
  const operationLimit = input.operationLimit === undefined ? 0 : requireNonNegativeInteger(input.operationLimit, 'operationLimit');
  const checkTtlMs = input.checkTtlMs === undefined ? 0 : requireNonNegativeInteger(input.checkTtlMs, 'checkTtlMs');
  return {
    grantId: randomId(),
    workspace,
    readComposerIds: boundedUniqueIds(input.readComposerIds ?? [], SUPERVISION_MAX_COMPOSER_IDS, 'readComposerIds'),
    writeComposerIds: boundedUniqueIds(input.writeComposerIds ?? [], SUPERVISION_MAX_COMPOSER_IDS, 'writeComposerIds'),
    goal,
    constraints,
    acceptanceCriteria,
    planVersion,
    authorizationVersion,
    controlVersion,
    expiresAt: input.expiresAt,
    operationLimit,
    operationsUsed: 0,
    checkTtlMs,
    allowedActionTypes: boundedUniqueIds(input.allowedActionTypes ?? [], SUPERVISION_MAX_ALLOWED_VALUES, 'allowedActionTypes'),
    allowedModes: boundedUniqueIds(input.allowedModes ?? [], SUPERVISION_MAX_ALLOWED_VALUES, 'allowedModes'),
    allowedModels: boundedUniqueIds(input.allowedModels ?? [], SUPERVISION_MAX_ALLOWED_VALUES, 'allowedModels'),
    pauseReasons: [],
    status: 'active',
    createdAt: ts,
  };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SUPERVISION_MAX_ID_LENGTH) {
    throw new SupervisionError(`invalid ${field}`);
  }
  if (value.trim() !== value || value.includes('\0')) throw new SupervisionError(`invalid ${field}`);
  return value;
}

function requireText(value: unknown, field: string, opts: { required: boolean }): string {
  if (typeof value !== 'string' || value.length > SUPERVISION_MAX_TEXT_LENGTH || value.includes('\0')) {
    throw new SupervisionError(`invalid ${field}`);
  }
  if (opts.required && value.trim().length === 0) throw new SupervisionError(`invalid ${field}`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SupervisionError(`invalid ${field}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SupervisionError(`invalid ${field}`);
  }
  return value;
}

function assertFutureTimestamp(value: unknown, now: number, field: string): asserts value is number {
  const ts = requireTimestamp(value, field);
  if (ts <= now) throw new SupervisionError(`invalid ${field}`);
}

function boundedUniqueIds(values: unknown, max: number, field: string): string[] {
  if (!Array.isArray(values)) throw new SupervisionError(`invalid ${field}`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const id = requireId(item, field);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > max) throw new SupervisionError(`invalid ${field}`);
  return out;
}

function boundedTexts(values: unknown, max: number, field: string): string[] {
  if (!Array.isArray(values)) throw new SupervisionError(`invalid ${field}`);
  if (values.length > max) throw new SupervisionError(`invalid ${field}`);
  return values.map((item) => requireText(item, field, { required: false }));
}

function assertPauseReason(value: unknown): asserts value is SupervisionPauseReason {
  if (typeof value !== 'string' || !PAUSE_REASONS.has(value as SupervisionPauseReason)) {
    throw new SupervisionError('invalid pause reason');
  }
}

function assertNotificationStatus(value: unknown): asserts value is IssueNotificationStatus {
  if (typeof value !== 'string' || !NOTIFICATION_STATUSES.has(value as IssueNotificationStatus)) {
    throw new SupervisionError('invalid notification status');
  }
}

function assertCheckStatus(value: unknown): asserts value is SupervisionCheckStatus {
  if (typeof value !== 'string' || !CHECK_STATUSES.has(value as SupervisionCheckStatus)) {
    throw new SupervisionError('invalid check status');
  }
}

function validateWorkspace(value: unknown): WorkspaceIdentity {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid workspace');
  const raw = value as { id?: unknown; uri?: { scheme?: unknown; authority?: unknown; path?: unknown } };
  if (!raw.uri || typeof raw.uri !== 'object') throw new SupervisionError('invalid workspace');
  const id = requireId(raw.id, 'workspace.id');
  if (typeof raw.uri.scheme !== 'string' || !SCHEME_RE.test(raw.uri.scheme) || raw.uri.scheme.includes('\0')) {
    throw new SupervisionError('invalid workspace.uri.scheme');
  }
  if (typeof raw.uri.authority !== 'string' || raw.uri.authority.length > SUPERVISION_MAX_ID_LENGTH * 2 || raw.uri.authority.includes('\0')) {
    throw new SupervisionError('invalid workspace.uri.authority');
  }
  if (typeof raw.uri.path !== 'string' || raw.uri.path.length === 0 || raw.uri.path.length > SUPERVISION_MAX_TEXT_LENGTH || raw.uri.path.includes('\0')) {
    throw new SupervisionError('invalid workspace.uri.path');
  }
  return { id, uri: { scheme: raw.uri.scheme, authority: raw.uri.authority, path: raw.uri.path } };
}

function validateStore(parsed: unknown): StoreState {
  if (!parsed || typeof parsed !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = parsed as {
    version?: unknown;
    grants?: unknown;
    redeemCodes?: unknown;
    tokens?: unknown;
    issuePermits?: unknown;
    checks?: unknown;
  };
  if (raw.version !== STORE_VERSION) throw new SupervisionError('invalid supervision store');
  if (!Array.isArray(raw.grants) || raw.grants.length > SUPERVISION_MAX_GRANTS) {
    throw new SupervisionError('invalid supervision store');
  }
  if (!Array.isArray(raw.redeemCodes) || raw.redeemCodes.length > SUPERVISION_MAX_REDEEM_CODES) {
    throw new SupervisionError('invalid supervision store');
  }
  if (!Array.isArray(raw.tokens) || raw.tokens.length > SUPERVISION_MAX_TOKENS) {
    throw new SupervisionError('invalid supervision store');
  }
  if (!Array.isArray(raw.issuePermits) || raw.issuePermits.length > SUPERVISION_MAX_ISSUE_PERMITS) {
    throw new SupervisionError('invalid supervision store');
  }
  const checksRaw = raw.checks === undefined ? [] : raw.checks;
  if (!Array.isArray(checksRaw) || checksRaw.length > SUPERVISION_MAX_GRANTS * SUPERVISION_MAX_CHECKS_PER_GRANT) {
    throw new SupervisionError('invalid supervision store');
  }
  return {
    version: STORE_VERSION,
    grants: raw.grants.map(validatePersistedGrant),
    redeemCodes: raw.redeemCodes.map(validateRedeemRecord),
    tokens: raw.tokens.map(validateTokenRecord),
    issuePermits: raw.issuePermits.map(validatePersistedPermit),
    checks: checksRaw.map(validatePersistedCheck),
  };
}

function validatePersistedGrant(value: unknown): SupervisionGrant {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== 'string' || !GRANT_STATUSES.has(raw.status as SupervisionGrantStatus)) {
    throw new SupervisionError('invalid supervision store');
  }
  if (!Array.isArray(raw.pauseReasons) || raw.pauseReasons.length > PAUSE_REASONS.size) {
    throw new SupervisionError('invalid supervision store');
  }
  const pauseReasons: SupervisionPauseReason[] = [];
  const seen = new Set<SupervisionPauseReason>();
  for (const item of raw.pauseReasons) {
    assertPauseReason(item);
    if (seen.has(item)) continue;
    seen.add(item);
    pauseReasons.push(item);
  }
  const operationsUsed = requireNonNegativeInteger(raw.operationsUsed, 'operationsUsed');
  const operationLimit = requireNonNegativeInteger(raw.operationLimit, 'operationLimit');
  if (operationsUsed > operationLimit) throw new SupervisionError('invalid supervision store');
  return {
    grantId: requireId(raw.grantId, 'grantId'),
    workspace: validateWorkspace(raw.workspace),
    readComposerIds: boundedUniqueIds(raw.readComposerIds, SUPERVISION_MAX_COMPOSER_IDS, 'readComposerIds'),
    writeComposerIds: boundedUniqueIds(raw.writeComposerIds, SUPERVISION_MAX_COMPOSER_IDS, 'writeComposerIds'),
    goal: requireText(raw.goal, 'goal', { required: true }),
    constraints: requireText(raw.constraints, 'constraints', { required: false }),
    acceptanceCriteria: requireText(raw.acceptanceCriteria, 'acceptanceCriteria', { required: false }),
    planVersion: requireId(raw.planVersion, 'planVersion'),
    authorizationVersion: requireId(raw.authorizationVersion, 'authorizationVersion'),
    controlVersion: requireId(raw.controlVersion, 'controlVersion'),
    expiresAt: requireTimestamp(raw.expiresAt, 'expiresAt'),
    operationLimit,
    operationsUsed,
    checkTtlMs: raw.checkTtlMs === undefined ? 0 : requireNonNegativeInteger(raw.checkTtlMs, 'checkTtlMs'),
    allowedActionTypes: boundedUniqueIds(raw.allowedActionTypes, SUPERVISION_MAX_ALLOWED_VALUES, 'allowedActionTypes'),
    allowedModes: boundedUniqueIds(raw.allowedModes, SUPERVISION_MAX_ALLOWED_VALUES, 'allowedModes'),
    allowedModels: boundedUniqueIds(raw.allowedModels, SUPERVISION_MAX_ALLOWED_VALUES, 'allowedModels'),
    pauseReasons,
    status: raw.status as SupervisionGrantStatus,
    createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
  };
}

function validateRedeemRecord(value: unknown): RedeemRecord {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = value as Record<string, unknown>;
  if (typeof raw.codeHash !== 'string' || !HASH_HEX_RE.test(raw.codeHash)) {
    throw new SupervisionError('invalid supervision store');
  }
  if (raw.consumedAt !== null && (typeof raw.consumedAt !== 'number' || !Number.isSafeInteger(raw.consumedAt) || raw.consumedAt < 0)) {
    throw new SupervisionError('invalid supervision store');
  }
  return {
    grantId: requireId(raw.grantId, 'grantId'),
    codeHash: raw.codeHash,
    expiresAt: requireTimestamp(raw.expiresAt, 'expiresAt'),
    consumedAt: raw.consumedAt,
  };
}

function validateTokenRecord(value: unknown): TokenRecord {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = value as Record<string, unknown>;
  if (typeof raw.tokenHash !== 'string' || !HASH_HEX_RE.test(raw.tokenHash)) {
    throw new SupervisionError('invalid supervision store');
  }
  if (raw.revokedAt !== null && (typeof raw.revokedAt !== 'number' || !Number.isSafeInteger(raw.revokedAt) || raw.revokedAt < 0)) {
    throw new SupervisionError('invalid supervision store');
  }
  return {
    grantId: requireId(raw.grantId, 'grantId'),
    tokenHash: raw.tokenHash,
    createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
    expiresAt: requireTimestamp(raw.expiresAt, 'expiresAt'),
    revokedAt: raw.revokedAt,
  };
}

function validatePersistedPermit(value: unknown): IssuePermit {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== 'string' || !PERMIT_STATUSES.has(raw.status as IssuePermitStatus)) {
    throw new SupervisionError('invalid supervision store');
  }
  return {
    issueId: requireId(raw.issueId, 'issueId'),
    grantId: requireId(raw.grantId, 'grantId'),
    workspace: validateWorkspace(raw.workspace),
    composerId: requireId(raw.composerId, 'composerId'),
    actionType: requireId(raw.actionType, 'actionType'),
    actionId: requireId(raw.actionId, 'actionId'),
    planVersion: requireId(raw.planVersion, 'planVersion'),
    authorizationVersion: requireId(raw.authorizationVersion, 'authorizationVersion'),
    controlVersion: requireId(raw.controlVersion, 'controlVersion'),
    contentDigest: requireId(raw.contentDigest, 'contentDigest'),
    createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
    expiresAt: requireTimestamp(raw.expiresAt, 'expiresAt'),
    status: raw.status as IssuePermitStatus,
    evidence: raw.evidence === undefined ? '' : requireText(raw.evidence, 'evidence', { required: false }),
    recommendation: raw.recommendation === undefined
      ? ''
      : requireText(raw.recommendation, 'recommendation', { required: false }),
    attemptedActions: raw.attemptedActions === undefined
      ? []
      : boundedTexts(raw.attemptedActions, SUPERVISION_MAX_ALLOWED_VALUES, 'attemptedActions'),
    notificationStatus: raw.notificationStatus === undefined
      ? 'not_configured'
      : persistedNotificationStatus(raw.notificationStatus),
    decision: raw.decision === undefined ? 'pending' : persistedIssueDecision(raw.decision),
    decidedAt: raw.decidedAt === undefined || raw.decidedAt === null
      ? null
      : requireTimestamp(raw.decidedAt, 'decidedAt'),
  };
}

function persistedIssueDecision(value: unknown): IssueDecision {
  if (value !== 'pending' && value !== 'approved' && value !== 'rejected') {
    throw new SupervisionError('invalid supervision store');
  }
  return value;
}

function persistedNotificationStatus(value: unknown): IssueNotificationStatus {
  if (typeof value !== 'string' || !NOTIFICATION_STATUSES.has(value as IssueNotificationStatus)) {
    throw new SupervisionError('invalid supervision store');
  }
  return value as IssueNotificationStatus;
}

function validatePersistedCheck(value: unknown): SupervisionCheckRecord {
  if (!value || typeof value !== 'object') throw new SupervisionError('invalid supervision store');
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== 'string' || !CHECK_STATUSES.has(raw.status as SupervisionCheckStatus)) {
    throw new SupervisionError('invalid supervision store');
  }
  return {
    checkId: requireId(raw.checkId, 'checkId'),
    grantId: requireId(raw.grantId, 'grantId'),
    checkedAt: requireTimestamp(raw.checkedAt, 'checkedAt'),
    status: raw.status as SupervisionCheckStatus,
    summary: requireText(raw.summary, 'summary', { required: false }),
  };
}