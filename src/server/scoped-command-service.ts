import type { CommandDispatchOptions } from './command-executor.js';
import type { CommandResult, CursorState, SupervisionGrant, WorkspaceIdentity } from './types.js';
import { OperationJournal, type OperationRecord } from './operation-journal.js';
import { SupervisionManager } from './supervision-manager.js';
import { canWriteUnderSupervision } from './supervision-policy.js';

const SUPERVISION_STATE_FRESH_MS = 15_000;

export interface ScopedCommandContext {
  workspace: WorkspaceIdentity | null;
  state: CursorState;
  activeTargetId: string;
  targetGeneration: number;
  getDraftPresent: () => Promise<boolean | null>;
  hasAction?: (actionId: string) => boolean;
}

export interface ScopedCommandRequest {
  operationId: string;
  payloadDigest: string;
  grantId: string;
  composerId: string;
  windowId: string;
  targetId: string;
  targetGeneration: number;
  actionType: string;
  mode: string;
  model: string;
  planVersion: string;
  authorizationVersion: string;
  controlVersion: string;
  issueId?: string;
  actionId?: string;
  contentDigest?: string;
}

export interface ScopedCommandReceipt {
  operationId: string;
  status: OperationRecord['status'];
  dispatched: boolean;
  confirmed: boolean;
}

export interface ScopedCommandServiceOptions {
  journal: OperationJournal;
  supervisionManager: SupervisionManager;
  getContext: () => ScopedCommandContext;
  now?: () => number;
}

export class ScopedCommandService {
  private readonly journal: OperationJournal;
  private readonly supervisionManager: SupervisionManager;
  private readonly getContext: () => ScopedCommandContext;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<CommandResult>>();

  constructor(options: ScopedCommandServiceOptions) {
    this.journal = options.journal;
    this.supervisionManager = options.supervisionManager;
    this.getContext = options.getContext;
    this.now = options.now ?? Date.now;
    this.recoverUnknownPauses();
  }

  execute(
    request: ScopedCommandRequest,
    dispatch: (options: CommandDispatchOptions) => Promise<CommandResult>,
    confirm: () => boolean | Promise<boolean>,
  ): Promise<CommandResult> {
    const existing = this.inFlight.get(request.operationId);
    if (existing) return existing;
    const running = this.executeOnce(request, dispatch, confirm).finally(() => {
      this.inFlight.delete(request.operationId);
    });
    this.inFlight.set(request.operationId, running);
    return running;
  }

  private async executeOnce(
    request: ScopedCommandRequest,
    dispatch: (options: CommandDispatchOptions) => Promise<CommandResult>,
    confirm: () => boolean | Promise<boolean>,
  ): Promise<CommandResult> {
    let record: OperationRecord;
    try {
      record = this.journal.create({
        operationId: request.operationId,
        payloadDigest: request.payloadDigest,
        target: {
          workspaceId: this.supervisionManager.getGrant(request.grantId)?.workspace.id,
          grantId: request.grantId,
          composerId: request.composerId,
          windowId: request.windowId,
          targetId: request.targetId,
          targetGeneration: request.targetGeneration,
          actionType: request.actionType,
          planVersion: request.planVersion,
          authorizationVersion: request.authorizationVersion,
          controlVersion: request.controlVersion,
        },
      });
    } catch (err) {
      return this.failure(request.operationId, err);
    }

    if (record.status !== 'recorded' && record.status !== 'pending') {
      return this.replayResult(record);
    }
    if (record.status === 'recorded') {
      try {
        record = this.journal.markPending(request.operationId);
      } catch (err) {
        return this.failure(request.operationId, err);
      }
    }
    if (this.hasUnknownForGrant(request.grantId, request.operationId)) {
      this.failBeforeDispatch(request.operationId);
      return this.failure(request.operationId, 'A previous operation result is unknown');
    }
    try {
      this.assertBaseScope(request);
    } catch (err) {
      this.failBeforeDispatch(request.operationId);
      return this.failure(request.operationId, err);
    }

    let dispatchAuthorized = false;
    const beforeDispatch = async () => {
      try {
        const { grant, context } = await this.assertFinalScope(request);
        if (request.actionId && context.hasAction && !context.hasAction(request.actionId)) {
          throw new Error('action is no longer present');
        }
        this.journal.markDispatching(request.operationId);
        if (request.issueId) {
          this.supervisionManager.consumeIssuePermitAndRecordOperation({
            issueId: request.issueId,
            grantId: request.grantId,
            workspace: grant.workspace,
            composerId: request.composerId,
            actionType: request.actionType,
            actionId: request.actionId ?? '',
            planVersion: request.planVersion,
            authorizationVersion: request.authorizationVersion,
            controlVersion: request.controlVersion,
            contentDigest: request.contentDigest ?? '',
          });
        } else {
          this.supervisionManager.recordOperation(request.grantId, request.controlVersion);
        }
        dispatchAuthorized = true;
      } catch (err) {
        throw new Error(`Pre-dispatch check failed: ${errorMessage(err)}`);
      }
    };

    let result: CommandResult;
    try {
      result = await dispatch({ beforeDispatch, retry: false, humanInitiated: false });
    } catch (err) {
      if (!dispatchAuthorized) {
        this.failBeforeDispatch(request.operationId);
        return this.failure(request.operationId, err);
      }
      return this.markUnknown(request, err);
    }

    if (!dispatchAuthorized) {
      this.failBeforeDispatch(request.operationId);
      return result.ok ? this.failure(request.operationId, 'Dispatch guard was not executed') : result;
    }
    if (!result.ok) return this.markUnknown(request, result.error ?? 'Dispatch failed after authorization');

    try {
      this.journal.markDispatched(request.operationId);
    } catch (err) {
      return this.markUnknown(request, err);
    }

    let confirmed = false;
    try {
      confirmed = await confirm();
    } catch {
      confirmed = false;
    }
    if (!confirmed) return this.markUnknown(request, 'Target-side confirmation unavailable');

    try {
      const settled = this.journal.settle(request.operationId, 'confirmed');
      return {
        ...result,
        data: {
          ...(isRecord(result.data) ? result.data : {}),
          supervision: this.receipt(settled),
        },
      };
    } catch (err) {
      return this.markUnknown(request, err);
    }
  }

  private assertBaseScope(request: ScopedCommandRequest): {
    grant: SupervisionGrant;
    context: ScopedCommandContext;
  } {
    const grant = this.supervisionManager.getGrant(request.grantId);
    if (!grant) throw new Error('grant not found');
    const context = this.getContext();
    const observedAt = context.state.lastExtractionAt;
    if (typeof observedAt !== 'number' || this.now() - observedAt > SUPERVISION_STATE_FRESH_MS) {
      throw new Error('state is stale');
    }
    if (!workspaceEqual(context.workspace, grant.workspace)) throw new Error('workspace mismatch');
    if (context.activeTargetId !== request.targetId || context.targetGeneration !== request.targetGeneration) {
      throw new Error('target changed');
    }
    if (context.state.activeWindowId !== request.windowId || context.state.activeComposerId !== request.composerId) {
      throw new Error('window or composer changed');
    }
    const allowed = canWriteUnderSupervision(grant, {
      composerId: request.composerId,
      actionType: request.actionType,
      planVersion: request.planVersion,
      authorizationVersion: request.authorizationVersion,
      controlVersion: request.controlVersion,
      mode: request.mode,
      model: request.model,
      issueId: request.issueId,
      actionId: request.actionId,
      contentDigest: request.contentDigest,
      now: this.now(),
    });
    if (!allowed) throw new Error('supervision policy denied the operation');
    if (request.issueId) {
      const issue = this.supervisionManager.getIssue(request.issueId);
      if (!issue || issue.status !== 'pending' || issue.decision !== 'approved' || this.now() >= issue.expiresAt) {
        throw new Error('issue permit is not approved and current');
      }
      if (
        issue.grantId !== request.grantId
        || !workspaceEqual(issue.workspace, grant.workspace)
        || issue.composerId !== request.composerId
        || issue.actionType !== request.actionType
        || issue.actionId !== request.actionId
        || issue.planVersion !== request.planVersion
        || issue.authorizationVersion !== request.authorizationVersion
        || issue.controlVersion !== request.controlVersion
        || issue.contentDigest !== request.contentDigest
      ) {
        throw new Error('issue permit scope mismatch');
      }
    }
    return { grant, context };
  }

  private async assertFinalScope(request: ScopedCommandRequest): Promise<{
    grant: SupervisionGrant;
    context: ScopedCommandContext;
  }> {
    const { grant, context } = this.assertBaseScope(request);
    const draftPresent = await context.getDraftPresent();
    if (draftPresent === null) throw new Error('composer draft state unavailable');
    if (draftPresent) throw new Error('composer draft is present');
    if (request.actionType !== 'set_mode' && context.state.mode.current !== request.mode) {
      throw new Error('mode changed');
    }
    const liveModel = context.state.model.currentId || context.state.model.current;
    if (
      request.actionType !== 'set_model'
      && request.actionType !== 'set_plan_model'
      && liveModel !== request.model
    ) {
      throw new Error('model changed');
    }
    if (this.hasUnknownForGrant(request.grantId, request.operationId)) {
      throw new Error('A previous operation result is unknown');
    }
    return { grant, context };
  }

  /** Cancel operations that have definitely not reached their first UI mutation. */
  cancelPendingForWorkspace(workspace: WorkspaceIdentity | null): OperationRecord[] {
    const cancelled: OperationRecord[] = [];
    for (const record of this.journal.list()) {
      if (record.status !== 'recorded' && record.status !== 'pending') continue;
      if (workspace && record.target.workspaceId !== workspace.id) continue;
      cancelled.push(this.journal.cancelPending(record.operationId));
    }
    return cancelled;
  }

  private markUnknown(request: ScopedCommandRequest, err: unknown): CommandResult {
    let record = this.journal.get(request.operationId);
    try {
      if (record?.status === 'dispatching') record = this.journal.markDispatched(request.operationId);
      if (record?.status === 'dispatched' || record?.status === 'dispatching') {
        record = this.journal.settle(request.operationId, 'unknown');
      }
      const grant = this.supervisionManager.getGrant(request.grantId);
      if (grant && !grant.pauseReasons.includes('result_unknown')) {
        this.supervisionManager.addPause(request.grantId, 'result_unknown', { role: 'owner' });
      }
    } catch {
      // The durable unresolved record remains a write blocker even if pause persistence fails.
    }
    return {
      commandId: request.operationId,
      ok: false,
      error: `Operation result unknown: ${errorMessage(err)}`,
      data: record ? { supervision: this.receipt(record) } : undefined,
    };
  }

  private failBeforeDispatch(operationId: string): void {
    const record = this.journal.get(operationId);
    if (!record || !['recorded', 'pending', 'dispatching'].includes(record.status)) return;
    this.journal.settle(operationId, 'failed');
  }

  private hasUnknownForGrant(grantId: string, excludingOperationId: string): boolean {
    return this.journal.list().some((record) =>
      record.operationId !== excludingOperationId
      && record.target.grantId === grantId
      && (record.status === 'dispatching' || record.status === 'dispatched' || record.status === 'unknown')
    );
  }

  private recoverUnknownPauses(): void {
    const grantIds = new Set(
      this.journal.list()
        .filter((record) => record.status === 'unknown' && record.target.grantId)
        .map((record) => record.target.grantId!),
    );
    for (const grantId of grantIds) {
      const grant = this.supervisionManager.getGrant(grantId);
      if (!grant || grant.status !== 'active' || grant.pauseReasons.includes('result_unknown')) continue;
      this.supervisionManager.addPause(grantId, 'result_unknown', { role: 'owner' });
    }
  }

  private replayResult(record: OperationRecord): CommandResult {
    const confirmed = record.status === 'confirmed';
    return {
      commandId: record.operationId,
      ok: confirmed,
      ...(confirmed ? {} : { error: `Operation is ${record.status}; it will not be replayed` }),
      data: { supervision: this.receipt(record) },
    };
  }

  private receipt(record: OperationRecord): ScopedCommandReceipt {
    return {
      operationId: record.operationId,
      status: record.status,
      dispatched: record.status === 'dispatching' || record.status === 'dispatched' || record.status === 'confirmed' || record.status === 'unknown',
      confirmed: record.status === 'confirmed',
    };
  }

  private failure(operationId: string, err: unknown): CommandResult {
    return { commandId: operationId, ok: false, error: errorMessage(err) };
  }
}

function workspaceEqual(a: WorkspaceIdentity | null, b: WorkspaceIdentity): boolean {
  if (!a) return false;
  return a.id === b.id
    && a.uri.scheme === b.uri.scheme
    && a.uri.authority === b.uri.authority
    && a.uri.path === b.uri.path;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}