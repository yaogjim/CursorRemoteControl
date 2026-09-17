import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPlanFailure,
  diagnosePlanGuardFailure,
  planCommandFailure,
  planFailResult,
  planRequestedTarget,
  sanitizePlanFailure,
  type PlanGuardSnapshot,
} from '../src/server/plan-command-failure.js';

function snapshot(overrides: Partial<PlanGuardSnapshot> = {}): PlanGuardSnapshot {
  return {
    socketConnected: true,
    authEnabled: false,
    hasAuthSession: false,
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: 1_700_000_000_000,
    activeWindowId: 'target-a',
    activeComposerId: 'composer-current',
    activeTargetId: 'target-a',
    requestedWindowId: 'target-a',
    requestedComposerId: 'composer-current',
    now: 1_700_000_005_000,
    ...overrides,
  };
}

describe('plan command failure diagnosis', () => {
  it('returns null when the requested target is current and fresh', () => {
    assert.equal(diagnosePlanGuardFailure(snapshot()), null);
  });

  it('maps guard conditions to stable codes without embedding other targets', () => {
    assert.equal(diagnosePlanGuardFailure(snapshot({ socketConnected: false })), 'auth');
    assert.equal(diagnosePlanGuardFailure(snapshot({ authEnabled: true, hasAuthSession: false })), 'auth');
    assert.equal(diagnosePlanGuardFailure(snapshot({ connected: false })), 'connection');
    assert.equal(diagnosePlanGuardFailure(snapshot({ extractorStatus: 'stale' })), 'extraction');
    assert.equal(diagnosePlanGuardFailure(snapshot({ lastExtractionAt: 1_700_000_005_000 - 16_000 })), 'expired');
    assert.equal(diagnosePlanGuardFailure(snapshot({
      requestedWindowId: 'target-b',
      activeWindowId: 'target-a',
      activeTargetId: 'target-a',
    })), 'window');
    assert.equal(diagnosePlanGuardFailure(snapshot({ requestedComposerId: 'composer-other' })), 'session');
    assert.equal(diagnosePlanGuardFailure(snapshot({ epochMatch: false })), 'expired');
  });

  it('prefers connection over extraction when both are unhealthy', () => {
    assert.equal(diagnosePlanGuardFailure(snapshot({
      connected: false,
      extractorStatus: 'idle',
      lastExtractionAt: null,
    })), 'connection');
  });

  it('copies only requested identifiers and strips paths or extra keys', () => {
    const requested = planRequestedTarget({
      windowId: 'target-b',
      composerId: 'composer-current',
      planId: 'plan-1',
      path: '/Users/secret/.cursor/plans/x.plan.md',
    } as { windowId: string; composerId: string; planId: string; path: string });
    assert.deepEqual(requested, {
      windowId: 'target-b',
      composerId: 'composer-current',
      planId: 'plan-1',
    });
    const failure = sanitizePlanFailure({
      code: 'window',
      stage: 'guard',
      commandId: 'cmd-1',
      requested: { windowId: 'target-b', composerId: 'composer-current', path: '/tmp/secret' },
      activeWindowId: 'target-a',
      fileName: 'secret.plan.md',
    });
    assert.deepEqual(failure, {
      code: 'window',
      stage: 'guard',
      commandId: 'cmd-1',
      requested: { windowId: 'target-b', composerId: 'composer-current' },
    });
    assert.equal(JSON.stringify(failure).includes('target-a'), false);
    assert.equal(JSON.stringify(failure).includes('secret'), false);
  });

  it('keeps the generic error string when attaching a structured failure', () => {
    const result = planFailResult({
      commandId: 'cmd-1',
      error: '当前会话的目标或读取权限无法确认，请刷新后重试',
      code: 'window',
      stage: 'guard',
      requested: { windowId: 'target-b', composerId: 'composer-current' },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /无法确认/);
    assert.equal(result.failure?.code, 'window');
    const attached = attachPlanFailure(
      { commandId: 'cmd-2', ok: false, error: '未连接到 Cursor' },
      { code: 'connection', stage: 'discover', commandId: 'cmd-2', requested: { windowId: 'target-a' } },
    );
    assert.equal(attached.error, '未连接到 Cursor');
    assert.equal(attached.failure?.code, 'connection');
    assert.equal(attachPlanFailure(
      { commandId: 'cmd-3', ok: true, data: { ok: true } },
      { code: 'unknown', stage: 'discover', commandId: 'cmd-3' },
    ).failure, undefined);
    assert.deepEqual(planCommandFailure({
      code: 'auth', stage: 'guard', commandId: 'cmd-4',
    }), { code: 'auth', stage: 'guard', commandId: 'cmd-4' });
  });

  it('rejects path, control, padded, empty, and overlong diagnostic ids instead of truncating them', () => {
    assert.equal(planRequestedTarget({
      windowId: '/Users/secret/.cursor/plans/x.plan.md',
      composerId: 'composer-current',
      planId: 'plan-1',
    })?.windowId, undefined);
    assert.deepEqual(planRequestedTarget({
      windowId: 'target-a',
      composerId: '..\\secret',
      planId: 'plan-1',
    }), { windowId: 'target-a', planId: 'plan-1' });
    assert.equal(planRequestedTarget({ windowId: ' target-a ', composerId: 'composer-current' })?.windowId, undefined);
    assert.equal(planRequestedTarget({ windowId: 'a'.repeat(200), composerId: 'composer-current' })?.windowId, undefined);
    assert.equal(planRequestedTarget({ windowId: 'target-a\u0000b', planId: 'plan-1' })?.windowId, undefined);
    assert.deepEqual(planRequestedTarget({ windowId: 'target-a', composerId: 'composer-current', planId: 'plan-1' }), {
      windowId: 'target-a',
      composerId: 'composer-current',
      planId: 'plan-1',
    });
    assert.equal(planRequestedTarget(null as unknown as { windowId: string }), undefined);
    assert.equal(planRequestedTarget(undefined as unknown as { windowId: string }), undefined);
  });

  it('sanitizePlanFailure treats requested:null as missing and drops nested unsafe ids', () => {
    const withNull = sanitizePlanFailure({
      code: 'window',
      stage: 'guard',
      commandId: 'cmd-1',
      requested: null,
    });
    assert.deepEqual(withNull, { code: 'window', stage: 'guard', commandId: 'cmd-1' });
    assert.equal('requested' in (withNull ?? {}), false);

    const nested = sanitizePlanFailure({
      code: 'session',
      stage: 'discover',
      commandId: 'cmd-ok',
      requested: {
        windowId: '../other-target',
        composerId: 'composer-current',
        planId: 'p'.repeat(300),
      },
    });
    assert.deepEqual(nested, {
      code: 'session',
      stage: 'discover',
      commandId: 'cmd-ok',
      requested: { composerId: 'composer-current' },
    });
    assert.equal(JSON.stringify(nested).includes('other-target'), false);

    assert.equal(sanitizePlanFailure({
      code: 'window', stage: 'guard', commandId: '', requested: { windowId: 'target-a' },
    }), undefined);
    assert.equal(sanitizePlanFailure({
      code: 'window', stage: 'guard', commandId: '/tmp/secret', requested: { windowId: 'target-a' },
    }), undefined);
  });

  it('attachPlanFailure overlays inner commandId and requested with the outer request', () => {
    const attached = attachPlanFailure(
      {
        commandId: 'inner-cmd',
        ok: false,
        error: '计划发现目标窗口不匹配',
        failure: {
          code: 'window',
          stage: 'discover',
          commandId: 'forged-cmd',
          requested: { windowId: 'leaked-target', composerId: '../secret', planId: '' },
        },
      },
      {
        code: 'unknown',
        stage: 'discover',
        commandId: 'outer-cmd',
        requested: { windowId: 'target-a', composerId: 'composer-current' },
      },
    );
    assert.equal(attached.error, '计划发现目标窗口不匹配');
    assert.equal(attached.failure?.code, 'window');
    assert.equal(attached.failure?.commandId, 'outer-cmd');
    assert.deepEqual(attached.failure?.requested, { windowId: 'target-a', composerId: 'composer-current' });
    assert.equal(JSON.stringify(attached.failure).includes('leaked-target'), false);
    assert.equal(JSON.stringify(attached.failure).includes('forged-cmd'), false);
    assert.equal(JSON.stringify(attached.failure).includes('secret'), false);
  });

  it('keeps expired when a once-invalid guard is observed after the target matches again', () => {
    assert.equal(diagnosePlanGuardFailure(snapshot({
      invalidated: true,
      epochMatch: false,
    })), 'expired');
    assert.equal(diagnosePlanGuardFailure(snapshot({
      invalidated: true,
      epochMatch: true,
    })), 'expired');
  });
});