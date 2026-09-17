import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OperationJournal, OPERATION_JOURNAL_FILE } from '../src/server/operation-journal.js';
import { ScopedCommandService, type ScopedCommandContext, type ScopedCommandRequest } from '../src/server/scoped-command-service.js';
import { SupervisionManager, SUPERVISION_STORE_FILE } from '../src/server/supervision-manager.js';
import type { CommandDispatchOptions } from '../src/server/command-executor.js';
import type { CommandResult, CursorState, WorkspaceIdentity } from '../src/server/types.js';

const NOW = 1_000_000;
const WS: WorkspaceIdentity = {
  id: 'ws-1',
  uri: { scheme: 'file', authority: '', path: '/tmp/project' },
};

function state(over: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: NOW,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [{ composerId: 'c-1', title: 'Task', isActive: true, status: '', selectorPath: '' }],
    activeComposerId: 'c-1',
    mode: { current: 'agent', available: [] },
    model: { current: 'gpt', currentId: 'gpt' },
    windows: [{ id: 'win-1', title: 'Project' }],
    activeWindowId: 'win-1',
    composerQueue: { items: [] },
    questionnaire: null,
    _workspaceIdentity: WS,
    ...over,
  };
}

function request(controlVersion: string, over: Partial<ScopedCommandRequest> = {}): ScopedCommandRequest {
  return {
    operationId: 'op-00000001',
    payloadDigest: 'digest-00000001',
    grantId: 'replace-grant',
    composerId: 'c-1',
    windowId: 'win-1',
    targetId: 'target-1',
    targetGeneration: 1,
    actionType: 'send_message',
    mode: 'agent',
    model: 'gpt',
    planVersion: 'plan-1',
    authorizationVersion: 'auth-1',
    controlVersion,
    ...over,
  };
}

describe('ScopedCommandService', () => {
  let dir: string;
  let manager: SupervisionManager;
  let journal: OperationJournal;
  let current: ScopedCommandContext;
  let grantId: string;
  let controlVersion: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scoped-command-'));
    manager = new SupervisionManager({ dataDir: dir, now: () => NOW });
    const { grant } = manager.createGrant({
      workspace: WS,
      readComposerIds: ['c-1'],
      writeComposerIds: ['c-1'],
      goal: 'test',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      expiresAt: NOW + 60_000,
      operationLimit: 3,
      allowedActionTypes: ['send_message'],
      allowedModes: ['agent'],
      allowedModels: ['gpt'],
    });
    grantId = grant.grantId;
    controlVersion = grant.controlVersion;
    journal = new OperationJournal({ dataDir: dir, now: () => NOW });
    current = {
      workspace: WS,
      state: state(),
      activeTargetId: 'target-1',
      targetGeneration: 1,
      getDraftPresent: async () => false,
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function service(): ScopedCommandService {
    return new ScopedCommandService({
      journal,
      supervisionManager: manager,
      getContext: () => current,
      now: () => NOW,
    });
  }

  function req(over: Partial<ScopedCommandRequest> = {}): ScopedCommandRequest {
    return request(controlVersion, { grantId, ...over });
  }

  async function dispatchOnce(
    options: CommandDispatchOptions,
    onDispatch: () => void,
    result: CommandResult = { commandId: 'cmd-1', ok: true },
  ): Promise<CommandResult> {
    assert.equal(options.retry, false);
    assert.equal(options.humanInitiated, false);
    await options.beforeDispatch?.();
    onDispatch();
    return result;
  }

  it('does not dispatch or change memory when the first journal write fails', async () => {
    mkdirSync(join(dir, OPERATION_JOURNAL_FILE));
    let dispatched = 0;
    const result = await service().execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
    assert.deepEqual(journal.list(), []);
  });

  it('does not dispatch when durable supervision accounting fails', async () => {
    const supervisionPath = join(dir, SUPERVISION_STORE_FILE);
    unlinkSync(supervisionPath);
    mkdirSync(supervisionPath);
    let dispatched = 0;
    const result = await service().execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
    assert.equal(manager.getGrant(grantId)?.operationsUsed, 0);
    assert.equal(journal.get('op-00000001')?.status, 'failed');
  });

  it('atomically preserves an approved issue when operation accounting fails', async () => {
    const permit = manager.createIssuePermit({
      grantId,
      workspace: WS,
      composerId: 'c-1',
      actionType: 'send_message',
      actionId: 'act-issue-1',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      contentDigest: 'digest-issue-1',
      expiresAt: NOW + 30_000,
    });
    manager.decideIssue(permit.issueId, 'approved', { role: 'owner' });
    const supervisionPath = join(dir, SUPERVISION_STORE_FILE);
    unlinkSync(supervisionPath);
    mkdirSync(supervisionPath);
    let dispatched = 0;
    const result = await service().execute(
      req({
        operationId: 'op-issue-001',
        payloadDigest: 'digest-op-issue-1',
        controlVersion: permit.controlVersion,
        issueId: permit.issueId,
        actionId: permit.actionId,
        contentDigest: permit.contentDigest,
      }),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
    assert.equal(manager.getIssue(permit.issueId)?.status, 'pending');
    assert.equal(manager.getIssue(permit.issueId)?.decision, 'approved');
    assert.equal(manager.getGrant(grantId)?.operationsUsed, 0);
    assert.ok(manager.getGrant(grantId)?.pauseReasons.includes('pending_issue'));
    assert.equal(journal.get('op-issue-001')?.status, 'failed');
  });

  it('persists before dispatch, confirms target evidence, charges once, and replays without redispatch', async () => {
    let dispatched = 0;
    const scoped = service();
    const first = await scoped.execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(first.ok, true);
    assert.equal(dispatched, 1);
    assert.equal(journal.get('op-00000001')?.status, 'confirmed');
    assert.equal(manager.getGrant(grantId)?.operationsUsed, 1);
    const replay = await scoped.execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(replay.ok, true);
    assert.equal(dispatched, 1);
    assert.equal(manager.getGrant(grantId)?.operationsUsed, 1);
  });

  it('fails before dispatch on target mismatch or a composer draft', async () => {
    let dispatched = 0;
    current = { ...current, targetGeneration: 2 };
    const mismatched = await service().execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(mismatched.ok, false);
    assert.equal(dispatched, 0);
    assert.equal(journal.get('op-00000001')?.status, 'failed');

    current = { ...current, targetGeneration: 1, getDraftPresent: async () => true };
    const draft = await service().execute(
      req({ operationId: 'op-draft-001', payloadDigest: 'digest-draft-001' }),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(draft.ok, false);
    assert.match(draft.error ?? '', /composer draft/);
    assert.equal(dispatched, 0);
  });

  it('rechecks live mode and model immediately before dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatched = 0;
    const running = service().execute(
      req(),
      async (options) => {
        await gate;
        await options.beforeDispatch?.();
        dispatched += 1;
        return { commandId: 'cmd-mode-model-race', ok: true };
      },
      async () => true,
    );
    current = { ...current, state: state({ model: { current: 'other', currentId: 'other' } }) };
    release();
    const result = await running;
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /model changed/);
    assert.equal(dispatched, 0);
    assert.equal(journal.get('op-00000001')?.status, 'failed');
  });

  it('rechecks controlVersion after queueing and cancels a not-yet-dispatched operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatched = 0;
    const running = service().execute(
      req(),
      async (options) => {
        await gate;
        await options.beforeDispatch?.();
        dispatched += 1;
        return { commandId: 'cmd-race', ok: true };
      },
      async () => true,
    );
    manager.addPause(grantId, 'human_takeover', { role: 'owner' });
    release();
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
    assert.equal(journal.get('op-00000001')?.status, 'failed');
  });

  it('marks missing target evidence unknown, pauses the grant, and blocks a second operation', async () => {
    let dispatched = 0;
    const scoped = service();
    const first = await scoped.execute(
      req(),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => false,
    );
    assert.equal(first.ok, false);
    assert.match(first.error ?? '', /unknown/i);
    assert.equal(dispatched, 1);
    assert.equal(journal.get('op-00000001')?.status, 'unknown');
    assert.ok(manager.getGrant(grantId)?.pauseReasons.includes('result_unknown'));

    const currentGrant = manager.getGrant(grantId)!;
    const second = await scoped.execute(
      req({
        operationId: 'op-00000002',
        payloadDigest: 'digest-00000002',
        controlVersion: currentGrant.controlVersion,
      }),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /previous operation result is unknown/i);
    assert.equal(dispatched, 1);
  });

  it('recovers pending as unknown on restart and never dispatches it', async () => {
    const journalPath = join(dir, OPERATION_JOURNAL_FILE);
    const pending = {
      version: 1,
      records: [{
        operationId: 'op-pending-01',
        payloadDigest: 'digest-pending-01',
        target: { workspaceId: WS.id, grantId, composerId: 'c-1', windowId: 'win-1' },
        status: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      }],
    };
    writeFileSync(journalPath, `${JSON.stringify(pending)}\n`, 'utf-8');
    journal = new OperationJournal({ dataDir: dir, now: () => NOW + 1 });
    let dispatched = 0;
    const restarted = service();
    assert.equal(journal.get('op-pending-01')?.status, 'unknown');
    assert.ok(manager.getGrant(grantId)?.pauseReasons.includes('result_unknown'));
    const result = await restarted.execute(
      req({ operationId: 'op-pending-01', payloadDigest: 'digest-pending-01' }),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
  });

  it('rechecks unresolved operations immediately before dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatched = 0;
    const scoped = service();
    const running = scoped.execute(
      req({ operationId: 'op-queued-001', payloadDigest: 'digest-queued-001' }),
      async (options) => {
        await gate;
        await options.beforeDispatch?.();
        dispatched += 1;
        return { commandId: 'cmd-queued', ok: true };
      },
      async () => true,
    );
    journal.create({
      operationId: 'op-blocker-01',
      payloadDigest: 'digest-blocker-01',
      target: { workspaceId: WS.id, grantId, composerId: 'c-1', windowId: 'win-1' },
    });
    journal.markDispatching('op-blocker-01');
    release();
    const result = await running;
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /previous operation result is unknown/i);
    assert.equal(dispatched, 0);
    assert.equal(journal.get('op-queued-001')?.status, 'failed');
  });

  it('cancels only definitely unmutated operations for a human takeover', () => {
    const scoped = service();
    journal.create({
      operationId: 'op-cancel-001',
      payloadDigest: 'digest-cancel-001',
      target: { workspaceId: WS.id, grantId, composerId: 'c-1', windowId: 'win-1' },
    });
    journal.create({
      operationId: 'op-other-0001',
      payloadDigest: 'digest-other-0001',
      target: { workspaceId: 'ws-other', grantId, composerId: 'c-1', windowId: 'win-1' },
    });
    journal.create({
      operationId: 'op-dispatch-01',
      payloadDigest: 'digest-dispatch-01',
      target: { workspaceId: WS.id, grantId, composerId: 'c-1', windowId: 'win-1' },
    });
    journal.markDispatching('op-dispatch-01');

    const cancelled = scoped.cancelPendingForWorkspace(WS);
    assert.deepEqual(cancelled.map((record) => record.operationId), ['op-cancel-001']);
    assert.equal(journal.get('op-cancel-001')?.status, 'cancelled');
    assert.equal(journal.get('op-other-0001')?.status, 'recorded');
    assert.equal(journal.get('op-dispatch-01')?.status, 'dispatching');
  });

  it('recovers dispatching as unknown on restart, pauses, and never replays', async () => {
    journal.create({
      operationId: 'op-restart-01',
      payloadDigest: 'digest-restart-01',
      target: { workspaceId: WS.id, grantId, composerId: 'c-1', windowId: 'win-1' },
    });
    journal.markDispatching('op-restart-01');
    journal = new OperationJournal({ dataDir: dir, now: () => NOW + 1 });
    let dispatched = 0;
    const restarted = service();
    assert.equal(journal.get('op-restart-01')?.status, 'unknown');
    assert.ok(manager.getGrant(grantId)?.pauseReasons.includes('result_unknown'));
    const result = await restarted.execute(
      req({ operationId: 'op-restart-01', payloadDigest: 'digest-restart-01' }),
      (options) => dispatchOnce(options, () => { dispatched += 1; }),
      async () => true,
    );
    assert.equal(result.ok, false);
    assert.equal(dispatched, 0);
  });
});