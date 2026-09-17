import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  Relay,
  ACTION_TYPE_RE,
  OPERATION_ID_RE,
  SOCKET_DANGEROUS_RATE_MAX,
  SOCKET_MAX_HTTP_BUFFER_SIZE,
  currentPlanLabel,
  isValidActionType,
  socketCommandRequiresOperationId,
} from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import type { CDPBridge } from '../src/server/cdp-bridge.js';
import type { CommandResult, CursorState, ServerConfig } from '../src/server/types.js';

const RECORD_SEP = '\x1e';

function config(dir: string): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 150,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: dir,
    adapterStorePath: join(dir, 'adapters.json'),
    adapterBackupCount: 5,
    actionTtlMs: 30_000,
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' },
  };
}

function fakeBridge(): CDPBridge {
  return {
    activeTargetId: 'target-a',
    getTargetGeneration: () => 3,
    getClient: () => null,
    getDiscoveryStatus: () => ({ status: 'idle' }),
    windows: [],
  } as unknown as CDPBridge;
}

/** A bridge whose active target and generation can be moved while a relay runs. */
function mutableBridge(): { bridge: CDPBridge; live: { targetId: string; generation: number } } {
  const live = { targetId: 'target-a', generation: 3 };
  const bridge = {
    get activeTargetId() { return live.targetId; },
    getTargetGeneration: () => live.generation,
    getClient: () => null,
    getDiscoveryStatus: () => ({ status: 'idle' }),
    windows: [],
  } as unknown as CDPBridge;
  return { bridge, live };
}

/** Monotonic clock so TTL tests never wait in real time. */
function monotonicClock(start = 1_700_000_000_000): { now: () => number; set: (value: number) => void; advance: (delta: number) => void } {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => { current = value; },
    advance: (delta: number) => { current += delta; },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface ExecutorCall {
  method: string;
  commandId: string;
  actionId?: string;
  expected?: unknown;
  text?: string;
}

interface PlanDiscoveryFixture {
  toolCallId: string;
  title: string;
  description?: string;
}

type ExecutorOptions = {
  gate?: Promise<void>;
  planFileName?: string;
  planPlansRoot?: string;
  plans?: PlanDiscoveryFixture[];
  reachedStart?: boolean;
};

function defaultDiscoveryPlans(): PlanDiscoveryFixture[] {
  return [
    { toolCallId: 'tc-history-1', title: '历史计划一', description: '第一段说明' },
    { toolCallId: 'tc-history-2', title: '历史计划二' },
  ];
}

function mockExecutor(calls: ExecutorCall[], opts: ExecutorOptions = {}): CommandExecutor {
  return {
    discoverPlans: async (
      commandId: string,
      expected: { windowId: string; composerId: string },
      isCurrent: () => boolean,
    ) => {
      calls.push({ method: 'discoverPlans', commandId, expected });
      if (opts.gate) await opts.gate;
      if (isCurrent && !isCurrent()) return { commandId, ok: false, error: '计划发现已失效' };
      return {
        commandId,
        ok: true,
        data: {
          plans: (opts.plans ?? defaultDiscoveryPlans()).map((plan) => ({ ...plan })),
          observedAt: Date.now(),
          reachedStart: opts.reachedStart ?? true,
          completeness: 'partial' as const,
        },
      } satisfies CommandResult;
    },
    resolvePlanFile: async (commandId: string, expected: unknown, isCurrent: () => boolean) => {
      calls.push({ method: 'resolvePlanFile', commandId, expected });
      if (opts.gate) await opts.gate;
      if (!isCurrent()) return { commandId, ok: false, error: '读取目标已失效' };
      return {
        commandId,
        ok: true,
        data: {
          fileName: opts.planFileName || 'resolved.plan.md',
          observedAt: Date.now(),
          ...(opts.planPlansRoot ? { plansRoot: opts.planPlansRoot } : {}),
        },
      };
    },
    clickRegisteredAction: async (commandId: string, actionId: string, expected?: unknown) => {
      if (opts.gate) await opts.gate;
      calls.push({ method: 'clickRegisteredAction', commandId, actionId, expected });
      return { commandId, ok: true } satisfies CommandResult;
    },
    sendMessage: async (commandId: string, text: string) => {
      if (opts.gate) await opts.gate;
      calls.push({ method: 'sendMessage', commandId, text });
      return { commandId, ok: true } satisfies CommandResult;
    },
    newChat: async (commandId: string) => {
      calls.push({ method: 'newChat', commandId });
      return { commandId, ok: true } satisfies CommandResult;
    },
    switchTab: async (commandId: string) => ({ commandId, ok: true }),
    setMode: async (commandId: string) => ({ commandId, ok: true }),
    setModel: async (commandId: string) => ({ commandId, ok: true }),
    getModelOptions: async (commandId: string) => ({ commandId, ok: true, data: { options: [] } }),
    getRegisteredPlanModelOptions: async (commandId: string) => ({ commandId, ok: true }),
    setRegisteredPlanModel: async (commandId: string) => ({ commandId, ok: true }),
  } as unknown as CommandExecutor;
}

function splitPackets(body: string): string[] {
  return body.split(RECORD_SEP).filter(Boolean);
}

function pollingUrl(origin: string, sid: string): string {
  return `${origin}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`;
}

async function handshake(origin: string): Promise<{ sid: string; maxPayload: number }> {
  const res = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`);
  const text = await res.text();
  const sid = /"sid":"([^"]+)"/.exec(text)?.[1];
  if (!sid) throw new Error(`handshake failed: ${res.status} ${text}`);
  const maxPayload = Number(/"maxPayload":(\d+)/.exec(text)?.[1] ?? 0);
  return { sid, maxPayload };
}

async function eioPost(origin: string, sid: string, body: string): Promise<Response> {
  return fetch(pollingUrl(origin, sid), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body,
  });
}

async function connectSocket(origin: string): Promise<{ sid: string; maxPayload: number }> {
  const { sid, maxPayload } = await handshake(origin);
  const connect = await eioPost(origin, sid, '40');
  assert.equal(connect.status, 200);
  const drain = await fetch(pollingUrl(origin, sid));
  assert.equal(drain.status, 200);
  await drain.text();
  return { sid, maxPayload };
}

async function postCommand(
  origin: string,
  sid: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = `42${JSON.stringify([event, payload])}`;
  const res = await eioPost(origin, sid, body);
  if (res.status !== 200) throw new Error(`emit ${res.status} ${await res.text()}`);
}

async function collectResults(
  origin: string,
  sid: string,
  count: number,
  timeoutMs = 4000,
): Promise<CommandResult[]> {
  const found: CommandResult[] = [];
  const deadline = Date.now() + timeoutMs;
  while (found.length < count && Date.now() < deadline) {
    const res = await fetch(pollingUrl(origin, sid));
    const text = await res.text();
    if (res.status !== 200) throw new Error(`poll ${res.status} ${text}`);
    for (const packet of splitPackets(text)) {
      if (packet === '2') {
        await eioPost(origin, sid, '3');
        continue;
      }
      if (!packet.startsWith('42')) continue;
      const data = JSON.parse(packet.slice(2)) as [string, unknown];
      if (data[0] === 'command:result') found.push(data[1] as CommandResult);
    }
  }
  if (found.length < count) throw new Error(`timed out waiting for ${count} command:result, got ${found.length}`);
  return found;
}

/**
 * Deadline variant that can use a saved real clock: required whenever `Date.now`
 * is mocked, because a mocked clock would either freeze or blow up the deadline.
 */
async function collectResultsBounded(
  origin: string,
  sid: string,
  count: number,
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<CommandResult[]> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const found: CommandResult[] = [];
  const deadline = now() + timeoutMs;
  while (found.length < count && now() < deadline) {
    const res = await fetch(pollingUrl(origin, sid));
    const text = await res.text();
    if (res.status !== 200) throw new Error(`poll ${res.status} ${text}`);
    for (const packet of splitPackets(text)) {
      if (packet === '2') {
        await eioPost(origin, sid, '3');
        continue;
      }
      if (!packet.startsWith('42')) continue;
      const data = JSON.parse(packet.slice(2)) as [string, unknown];
      if (data[0] === 'command:result') found.push(data[1] as CommandResult);
    }
  }
  if (found.length < count) throw new Error(`bounded poll got ${found.length}/${count} command:result`);
  return found;
}

async function emitCommandBounded(
  origin: string,
  sid: string,
  event: string,
  payload: Record<string, unknown>,
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<CommandResult> {
  await postCommand(origin, sid, event, payload);
  const [result] = await collectResultsBounded(origin, sid, 1, opts);
  return result;
}

async function collectNamed(
  origin: string,
  sid: string,
  eventName: string,
  count: number,
  timeoutMs = 4000,
): Promise<unknown[]> {
  const found: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  while (found.length < count && Date.now() < deadline) {
    const res = await fetch(pollingUrl(origin, sid));
    const text = await res.text();
    if (res.status !== 200) throw new Error(`poll ${res.status} ${text}`);
    for (const packet of splitPackets(text)) {
      if (packet === '2') {
        await eioPost(origin, sid, '3');
        continue;
      }
      if (!packet.startsWith('42')) continue;
      const data = JSON.parse(packet.slice(2)) as [string, unknown];
      if (data[0] === eventName) found.push(data[1]);
    }
  }
  if (found.length < count) throw new Error(`timed out waiting for ${count} ${eventName}, got ${found.length}`);
  return found;
}

async function emitCommand(
  origin: string,
  sid: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  await postCommand(origin, sid, event, payload);
  const [result] = await collectResults(origin, sid, 1);
  return result;
}

type PlanFailureWire = {
  code: string;
  stage: string;
  commandId: string;
  requested?: { windowId?: string; composerId?: string; planId?: string };
};

function planFailureOf(result: CommandResult): PlanFailureWire {
  const failure = (result as CommandResult & { failure?: PlanFailureWire }).failure;
  assert.ok(failure, `expected structured plan failure, error=${result.error ?? ''}`);
  return failure;
}

function assertPlanFailure(
  result: CommandResult,
  expected: { commandId: string; code: string; stage: string; requested?: PlanFailureWire['requested'] },
): PlanFailureWire {
  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(typeof result.error, 'string');
  assert.ok((result.error as string).length > 0, 'generic error string must remain for compatibility');
  const failure = planFailureOf(result);
  assert.equal(failure.code, expected.code);
  assert.equal(failure.stage, expected.stage);
  assert.equal(failure.commandId, expected.commandId);
  if (expected.requested) assert.deepEqual(failure.requested, expected.requested);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, /\.cursor\/plans/);
  assert.equal(serialized.includes('botToken'), false);
  assert.equal('activeWindowId' in failure, false);
  assert.equal('activeTargetId' in failure, false);
  assert.equal('path' in failure, false);
  assert.equal('fileName' in failure, false);
  return failure;
}

function stateWithPlan(id = 'plan-current', label = 'current_plan.plan.md'): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [{
      type: 'plan',
      id,
      flatIndex: 0,
      label,
      fileName: /\.md$/.test(label) ? label : undefined,
      toolCallId: 'tc-current-plan',
      title: 'Current plan',
      todosCompleted: 0,
      todosTotal: 0,
    }],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    activeComposerId: 'composer-current',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: 'target-a',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

/** Same session identity, but no plan card is mounted in the message flow. */
function stateWithoutPlanCards(): CursorState {
  return { ...stateWithPlan(), messages: [] };
}

describe('socket inbound protocol helpers', () => {
  it('validates actionType with the ActionRegistry shape', () => {
    assert.equal(isValidActionType('approve_all'), true);
    assert.equal(isValidActionType('questionnaire_option'), true);
    assert.equal(isValidActionType('Approve'), false);
    assert.equal(isValidActionType(''), false);
    assert.equal(isValidActionType('x'.repeat(80)), false);
    assert.equal(ACTION_TYPE_RE.test('run'), true);
  });

  it('requires operationId only for dangerous socket commands and action types', () => {
    assert.equal(socketCommandRequiresOperationId('send_message'), true);
    assert.equal(socketCommandRequiresOperationId('approve_all'), true);
    assert.equal(socketCommandRequiresOperationId('new_chat'), true);
    assert.equal(socketCommandRequiresOperationId('set_plan_model'), true);
    assert.equal(socketCommandRequiresOperationId('reject'), true);
    assert.equal(socketCommandRequiresOperationId('click_action', 'run'), true);
    assert.equal(socketCommandRequiresOperationId('click_action', 'continue'), true);
    assert.equal(socketCommandRequiresOperationId('click_action', 'skip'), true);
    assert.equal(socketCommandRequiresOperationId('click_action', 'questionnaire_option'), true);
    assert.equal(socketCommandRequiresOperationId('get_plan_full'), false);
    assert.equal(OPERATION_ID_RE.test('op-click-01'), true);
    assert.equal(OPERATION_ID_RE.test('short'), false);
  });

  it('resolves plan labels only from the current state', () => {
    const state = stateWithPlan();
    assert.equal(currentPlanLabel(state, 'plan-current'), 'current_plan.plan.md');
    assert.equal(currentPlanLabel(state, 'plan-forged'), null);
    assert.equal(currentPlanLabel(state, '../current_plan.plan.md'), null);
  });
});

describe('Relay inbound action protocol', () => {
  let dir: string;
  let originalHome: string | undefined;
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-inbound-'));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    mkdirSync(join(dir, '.cursor', 'plans'), { recursive: true });
    relays.length = 0;
  });

  afterEach(async () => {
    for (const relay of relays) {
      try { await relay.stop(); } catch { /* ignore */ }
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startRelay(
    calls: ExecutorCall[],
    execOpts?: ExecutorOptions,
    stateManager: StateManager = new StateManager(0),
  ): Promise<{ relay: Relay; origin: string }> {
    stateManager.updateWindows([], 'target-a');
    const relay = new Relay(config(dir), stateManager, mockExecutor(calls, execOpts), fakeBridge());
    relays.push(relay);
    await relay.start();
    return { relay, origin: `http://127.0.0.1:${relay.port}` };
  }

  it('rejects click_action without actionId or a valid actionType and does not call the executor', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);

    const missingType = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-missing-type',
      actionId: 'act_abc',
    });
    assert.equal(missingType.commandId, 'cmd-missing-type');
    assert.equal(missingType.ok, false);
    assert.match(missingType.error ?? '', /actionType/);

    const missingId = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-missing-id',
      actionType: 'run',
      selectorPath: 'button.run',
    });
    assert.equal(missingId.commandId, 'cmd-missing-id');
    assert.equal(missingId.ok, false);
    assert.match(missingId.error ?? '', /actionId/);

    const invalidType = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-bad-type',
      actionId: 'act_abc',
      actionType: 'Approve All',
    });
    assert.equal(invalidType.commandId, 'cmd-bad-type');
    assert.equal(invalidType.ok, false);
    assert.match(invalidType.error ?? '', /actionType/);

    const selectorOnly = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-selector',
      selectorPath: 'div > button',
    });
    assert.equal(selectorOnly.commandId, 'cmd-selector');
    assert.equal(selectorOnly.ok, false);
    assert.equal(calls.length, 0);
  });

  it('rejects get_plan_full unless planId exists in current session state', async () => {
    const calls: ExecutorCall[] = [];
    const stateManager = new StateManager(0);
    stateManager.onConnectionChanged(true);
    stateManager.onExtraction(stateWithPlan('plan-current', 'definitely-missing-current.plan.md'));
    const { origin } = await startRelay(calls, undefined, stateManager);
    const { sid } = await connectSocket(origin);

    const forged = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-forged',
      windowId: 'target-a', composerId: 'composer-current',
      planId: 'plan-forged',
      planLabel: 'definitely-missing-current.plan.md',
    });
    assert.equal(forged.ok, false);
    assert.match(forged.error ?? '', /当前会话/);

    const current = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-current',
      windowId: 'target-a', composerId: 'composer-current',
      planId: 'plan-current',
      planLabel: '../ignored-client-label.md',
    });
    assert.equal(current.ok, false);
    assert.match(current.error ?? '', /not found|could not be read/);
  });

  it('returns a versioned complete plan file for the explicit current target', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'current_plan.plan.md'), '---\nname: Test\n---\n# 全文开头\n\n中段证据\n\n全文末尾');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan());
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-full', planId: 'plan-current', windowId: 'target-a', composerId: 'composer-current',
      planLabel: '../secret.md', fileName: '../secret.md',
    });
    assert.equal(result.ok, true);
    const data = result.data as { body: string; metadata: Record<string, unknown> };
    assert.match(data.body, /全文开头[\s\S]*中段证据[\s\S]*全文末尾/);
    assert.equal(data.metadata.windowId, 'target-a');
    assert.equal(data.metadata.composerId, 'composer-current');
    assert.equal(data.metadata.planId, 'plan-current');
    assert.equal(data.metadata.source, 'cursor_plan_file');
    assert.equal(data.metadata.completeness, 'complete');
    assert.equal(data.metadata.fileName, 'current_plan.plan.md');
    assert.match(String(data.metadata.version), /^[0-9a-f]{64}$/);
    assert.equal(calls.length, 0);
  });

  it('rejects missing, foreign and stale plan targets before resolving a document', async () => {
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'Created Plan'));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    for (const target of [{}, { windowId: 'other', composerId: 'composer-current' }, { windowId: 'target-a', composerId: 'other' }]) {
      const result = await emitCommand(origin, sid, 'command:get_plan_full', { commandId: 'bad-plan-' + JSON.stringify(target), planId: 'plan-current', ...target });
      assert.equal(result.ok, false);
      assert.equal(result.data, undefined);
    }
    manager.getCurrentState().lastExtractionAt = Date.now() - 60_000;
    const stale = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-stale', planId: 'plan-current', windowId: 'target-a', composerId: 'composer-current',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.data, undefined);
    assert.equal(calls.length, 0);
  });

  it('resolves a title-only plan via its server-observed tool identity, not a client filename', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'resolved.plan.md'), '# Resolved body');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    const state = stateWithPlan('plan-current', 'Created Plan');
    // 即使展示标题长得像文件名，也不能变成文件引用。
    state.messages[0] = { ...state.messages[0], label: 'unrelated.plan.md' };
    manager.onExtraction(state);
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-resolve', planId: 'plan-current', windowId: 'target-a', composerId: 'composer-current',
      fileName: 'forged.plan.md', toolCallId: 'tc-forged',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ method: 'resolvePlanFile', commandId: 'cmd-plan-resolve', expected: {
      windowId: 'target-a', composerId: 'composer-current', planId: 'plan-current', toolCallId: 'tc-current-plan',
    } }]);
    assert.equal((result.data as { metadata: { fileName: string } }).metadata.fileName, 'resolved.plan.md');
  });

  it('reads a workspace plan from the resolved root and never leaks that path', async () => {
    const workspacePath = join(dir, 'cursorremote');
    const plansRoot = join(workspacePath, '.cursor', 'plans');
    mkdirSync(plansRoot, { recursive: true });
    writeFileSync(join(plansRoot, 'workspace.plan.md'), '# 工作区计划正文');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'Created Plan'));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, {
      planFileName: 'workspace.plan.md',
      planPlansRoot: plansRoot,
    }, manager);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-workspace-full',
      planId: 'plan-current',
      windowId: 'target-a',
      composerId: 'composer-current',
      fileName: 'forged.plan.md',
      path: '/etc/passwd',
      plansRoot: '/etc',
    });
    assert.equal(result.ok, true, result.error);
    const data = result.data as { body: string; metadata: Record<string, unknown> };
    assert.equal(data.body, '# 工作区计划正文');
    assert.equal(data.metadata.fileName, 'workspace.plan.md');
    assert.equal(data.metadata.source, 'cursor_plan_file');
    assert.equal('plansRoot' in data.metadata, false);
    assert.equal('path' in data.metadata, false);
    assert.equal('root' in data.metadata, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(plansRoot), false);
    assert.equal(serialized.includes(workspacePath), false);
    assert.equal(serialized.includes('/etc/passwd'), false);
    assert.deepEqual(calls, [{ method: 'resolvePlanFile', commandId: 'cmd-workspace-full', expected: {
      windowId: 'target-a', composerId: 'composer-current', planId: 'plan-current', toolCallId: 'tc-current-plan',
    } }]);
  });

  it('does not leak a workspace root when the resolved plan file cannot be read', async () => {
    const workspacePath = join(dir, 'missing-workspace');
    const plansRoot = join(workspacePath, '.cursor', 'plans');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'Created Plan'));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, {
      planFileName: 'missing.plan.md',
      planPlansRoot: plansRoot,
    }, manager);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-workspace-missing',
      planId: 'plan-current',
      windowId: 'target-a',
      composerId: 'composer-current',
      plansRoot,
      path: workspacePath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.match(result.error ?? '', /not found|not safe|could not be read/i);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(plansRoot), false);
    assert.equal(serialized.includes(workspacePath), false);
    assert.equal((result.error ?? '').includes('.cursor/plans'), false);
  });

  it('ignores a client-supplied plansRoot when the current plan already has a file name', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'current_plan.plan.md'), '# Home plan body');
    const outsider = join(dir, 'outsider', '.cursor', 'plans');
    mkdirSync(outsider, { recursive: true });
    writeFileSync(join(outsider, 'current_plan.plan.md'), '# SECRET_SHOULD_NOT_LEAK');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan());
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-client-root',
      planId: 'plan-current',
      windowId: 'target-a',
      composerId: 'composer-current',
      plansRoot: outsider,
      path: join(outsider, 'current_plan.plan.md'),
    });
    assert.equal(result.ok, true, result.error);
    const data = result.data as { body: string; metadata: Record<string, unknown> };
    assert.equal(data.body, '# Home plan body');
    assert.equal(data.metadata.fileName, 'current_plan.plan.md');
    assert.equal('plansRoot' in data.metadata, false);
    assert.equal(JSON.stringify(result).includes('SECRET_SHOULD_NOT_LEAK'), false);
    assert.equal(JSON.stringify(result).includes(outsider), false);
    assert.equal(calls.length, 0);
  });

  it('discards plan resolution after the session changes while awaiting the UI', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'Created Plan'));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, { gate }, manager);
    const { sid } = await connectSocket(origin);
    await postCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-delayed', planId: 'plan-current', windowId: 'target-a', composerId: 'composer-current',
    });
    try {
      for (let i = 0; calls.length === 0 && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(calls.length, 1);
      manager.onExtraction({ ...stateWithPlan('plan-current', 'Created Plan'), activeComposerId: 'other' });
    } finally { release(); }
    const [result] = await collectResults(origin, sid, 1);
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.match(result.error ?? '', /无法确认|失效/);
  });

  it('reports expired when the plan fingerprint changes during get_plan_full', async () => {
    const gate = deferred();
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'Created Plan'));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, { gate: gate.promise }, manager);
    const { sid } = await connectSocket(origin);
    const requested = { windowId: 'target-a', composerId: 'composer-current', planId: 'plan-current' };
    await postCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-fingerprint', ...requested,
    });
    try {
      for (let i = 0; calls.length === 0 && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(calls.length, 1);
      const next = stateWithPlan('plan-current', 'Created Plan');
      next.messages[0] = { ...next.messages[0], todosCompleted: 1, todosTotal: 3, title: 'Plan updated' };
      manager.onExtraction(next);
    } finally { gate.resolve(); }
    const [result] = await collectResults(origin, sid, 1);
    assert.match(result.error ?? '', /无法确认|失效/);
    assertPlanFailure(result, {
      commandId: 'cmd-plan-fingerprint', code: 'expired', stage: 'guard', requested,
    });
    assert.equal(calls.some((call) => call.method === 'resolvePlanFile'), true);
  });

  it('get_plan_full 守卫失败带稳定结构化原因且保留通用 error', async () => {
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan());
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    const requested = { windowId: 'target-a', composerId: 'composer-current', planId: 'plan-current' };

    const missing = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-missing-target', planId: 'plan-current',
    });
    assert.match(missing.error ?? '', /读取计划需要明确/);
    assertPlanFailure(missing, {
      commandId: 'cmd-plan-missing-target', code: 'invalid', stage: 'validate',
      requested: { planId: 'plan-current' },
    });

    const foreignWindow = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-window', ...requested, windowId: 'target-b',
    });
    assert.match(foreignWindow.error ?? '', /无法确认|失效/);
    assertPlanFailure(foreignWindow, {
      commandId: 'cmd-plan-window', code: 'window', stage: 'guard',
      requested: { windowId: 'target-b', composerId: 'composer-current', planId: 'plan-current' },
    });
    assert.equal(JSON.stringify(foreignWindow).includes('target-a'), false, 'must not leak the other window id');

    const foreignComposer = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-session', ...requested, composerId: 'composer-other',
    });
    assertPlanFailure(foreignComposer, {
      commandId: 'cmd-plan-session', code: 'session', stage: 'guard',
      requested: { windowId: 'target-a', composerId: 'composer-other', planId: 'plan-current' },
    });

    const missingPlan = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-absent', ...requested, planId: 'plan-forged',
    });
    assert.match(missingPlan.error ?? '', /当前会话/);
    assertPlanFailure(missingPlan, {
      commandId: 'cmd-plan-absent', code: 'plan', stage: 'guard',
      requested: { windowId: 'target-a', composerId: 'composer-current', planId: 'plan-forged' },
    });

    manager.getCurrentState().lastExtractionAt = Date.now() - 60_000;
    const stale = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-expired', ...requested,
    });
    assertPlanFailure(stale, {
      commandId: 'cmd-plan-expired', code: 'expired', stage: 'guard', requested,
    });

    manager.getCurrentState().lastExtractionAt = Date.now();
    manager.onExtractionFailure('selector miss');
    const extraction = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-extraction', ...requested,
    });
    assertPlanFailure(extraction, {
      commandId: 'cmd-plan-extraction', code: 'extraction', stage: 'guard', requested,
    });

    manager.onExtraction(stateWithPlan());
    manager.onConnectionChanged(false);
    const disconnected = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-connection', ...requested,
    });
    assertPlanFailure(disconnected, {
      commandId: 'cmd-plan-connection', code: 'connection', stage: 'guard', requested,
    });

    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithPlan('plan-current', 'missing-on-disk.plan.md'));
    const fileMiss = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-file', ...requested,
    });
    assert.match(fileMiss.error ?? '', /not found|could not be read/);
    assertPlanFailure(fileMiss, {
      commandId: 'cmd-plan-file', code: 'file', stage: 'read', requested,
    });
    assert.equal(calls.length, 0);
  });

  it('refuses a legacy summary-only plan card without resolving a file or reading disk', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'Build Plan in Parallel.plan.md'), '# decoy body must not be returned');
    writeFileSync(join(dir, '.cursor', 'plans', 'current_plan.plan.md'), '# another decoy');
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    const state = stateWithPlan('plan-executing', 'Build Plan in Parallel');
    state.messages[0] = {
      type: 'plan',
      id: 'plan-executing',
      flatIndex: 0,
      label: 'Build Plan in Parallel',
      title: 'Build Plan in Parallel',
      todosCompleted: 0,
      todosTotal: 0,
    };
    manager.onExtraction(state);
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, undefined, manager);
    const { sid } = await connectSocket(origin);
    const requested = {
      windowId: 'target-a',
      composerId: 'composer-current',
      planId: 'plan-executing',
    };
    const result = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-summary-only',
      ...requested,
      fileName: 'Build Plan in Parallel.plan.md',
      planLabel: 'Build Plan in Parallel.plan.md',
      toolCallId: 'tc-forged',
    });
    assert.match(result.error ?? '', /缺少可核对的文件关联/);
    assert.match(result.error ?? '', /无法读取全文/);
    assert.match(result.error ?? '', /创建计划记录/);
    assert.match(result.error ?? '', /不保证一定存在创建记录/);
    assert.match(result.error ?? '', /当前会话/);
    assertPlanFailure(result, {
      commandId: 'cmd-plan-summary-only',
      code: 'plan',
      stage: 'resolve',
      requested,
    });
    assert.equal(calls.length, 0, 'must not call resolvePlanFile without a server-observed toolCallId');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /decoy body/);
    assert.doesNotMatch(serialized, /Build Plan in Parallel\.plan\.md/);
    assert.equal(serialized.includes('tc-forged'), false);
  });

  it('forwards click_action with actionId and validated actionType', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-skip-1',
      actionId: 'act_skip',
      actionType: 'skip',
      operationId: 'op-skip-forward-1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.commandId, 'cmd-skip-1');
    assert.deepEqual(calls, [{
      method: 'clickRegisteredAction',
      commandId: 'cmd-skip-1',
      actionId: 'act_skip',
      expected: { targetId: 'target-a', targetGeneration: 3, actionType: 'skip' },
    }]);
  });

  it('passes approve_all as approve_all rather than approve', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);
    const result = await emitCommand(origin, sid, 'command:approve_all', {
      commandId: 'cmd-all-1',
      actionId: 'act_all',
      operationId: 'op-approve-all-1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.commandId, 'cmd-all-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'clickRegisteredAction');
    assert.equal((calls[0]?.expected as { actionType: string }).actionType, 'approve_all');
  });

  it('requires a bounded operationId on dangerous socket commands and retains commandId', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);

    const missing = await emitCommand(origin, sid, 'command:send_message', {
      commandId: 'cmd-op-missing',
      text: 'hello',
    });
    assert.equal(missing.commandId, 'cmd-op-missing');
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'operationId required');

    const invalid = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-op-bad',
      actionId: 'act_run',
      actionType: 'run',
      operationId: 'bad',
    });
    assert.equal(invalid.commandId, 'cmd-op-bad');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, 'Invalid operation id');

    const noCommand = await emitCommand(origin, sid, 'command:new_chat', {});
    assert.equal(noCommand.commandId, 'unknown');
    assert.equal(noCommand.ok, false);
    assert.equal(noCommand.error, 'Missing commandId');
    assert.equal(calls.length, 0);
  });

  it('replays the same per-session per-route operationId once and conflicts on a different fingerprint', async () => {
    const calls: ExecutorCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { origin } = await startRelay(calls, { gate });
    const { sid } = await connectSocket(origin);
    const payload = {
      actionId: 'act_run',
      actionType: 'run',
      operationId: 'op-run-same-1',
    };

    await postCommand(origin, sid, 'command:click_action', { commandId: 'cmd-a', ...payload });
    await postCommand(origin, sid, 'command:click_action', { commandId: 'cmd-b', ...payload });
    await postCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-c',
      ...payload,
      actionId: 'act_other',
    });
    release();
    const results = await collectResults(origin, sid, 3);
    const byId = new Map(results.map((item) => [item.commandId, item]));
    assert.equal(byId.get('cmd-a')?.ok, true);
    assert.equal(byId.get('cmd-b')?.ok, true);
    assert.equal(byId.get('cmd-c')?.ok, false);
    assert.match(byId.get('cmd-c')?.error ?? '', /already used for different input/);
    assert.equal(calls.length, 1);
  });

  it('rate-limits dangerous socket commands per session and route', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);
    const results: CommandResult[] = [];
    for (let i = 0; i < SOCKET_DANGEROUS_RATE_MAX + 1; i++) {
      results.push(await emitCommand(origin, sid, 'command:send_message', {
        commandId: `cmd-rate-${i}`,
        text: 'hello',
        operationId: `op-rate-${String(i).padStart(2, '0')}`,
      }));
    }
    assert.equal(results.slice(0, SOCKET_DANGEROUS_RATE_MAX).every((item) => item.ok), true);
    const limited = results[SOCKET_DANGEROUS_RATE_MAX];
    assert.equal(limited?.ok, false);
    assert.equal(limited?.commandId, `cmd-rate-${SOCKET_DANGEROUS_RATE_MAX}`);
    assert.match(limited?.error ?? '', /Too many requests/);
    assert.equal(calls.length, SOCKET_DANGEROUS_RATE_MAX);

    const skip = await emitCommand(origin, sid, 'command:click_action', {
      commandId: 'cmd-skip-rate',
      actionId: 'act_skip',
      actionType: 'skip',
      operationId: 'op-skip-rate-01',
    });
    assert.equal(skip.ok, true);
  });

  it('advertises and enforces Socket.IO maxHttpBufferSize', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid, maxPayload } = await connectSocket(origin);
    assert.equal(maxPayload, SOCKET_MAX_HTTP_BUFFER_SIZE);
    const huge = `42${JSON.stringify(['command:send_message', {
      commandId: 'cmd-huge',
      text: 'a'.repeat(SOCKET_MAX_HTTP_BUFFER_SIZE),
      operationId: 'op-huge-buffer-1',
    }])}`;
    const res = await eioPost(origin, sid, huge);
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  it('replies to state:request with a full snapshot', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);
    await postCommand(origin, sid, 'state:request', {});
    const snapshots = await collectNamed(origin, sid, 'state:full', 1);
    assert.equal(snapshots.length, 1);
    assert.equal(typeof snapshots[0], 'object');
  });

  it('replays questionnaire_option with the same operationId and does not double-click', async () => {
    const calls: ExecutorCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { origin } = await startRelay(calls, { gate });
    const { sid } = await connectSocket(origin);
    const payload = {
      actionId: 'act_opt_a',
      actionType: 'questionnaire_option',
      operationId: 'op-q-opt-same-1',
    };
    await postCommand(origin, sid, 'command:click_action', { commandId: 'cmd-q-a', ...payload });
    await postCommand(origin, sid, 'command:click_action', { commandId: 'cmd-q-b', ...payload });
    release();
    const results = await collectResults(origin, sid, 2);
    const byId = new Map(results.map((item) => [item.commandId, item]));
    assert.equal(byId.get('cmd-q-a')?.ok, true);
    assert.equal(byId.get('cmd-q-b')?.ok, true);
    assert.equal(calls.length, 1);
  });
});

describe('Relay history plan discovery and plan-ref reads', () => {
  let dir: string;
  let originalHome: string | undefined;
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-plan-refs-'));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    mkdirSync(join(dir, '.cursor', 'plans'), { recursive: true });
    relays.length = 0;
  });

  afterEach(async () => {
    for (const relay of relays) {
      try { await relay.stop(); } catch { /* ignore */ }
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  });

  interface DiscoveryData {
    windowId: string;
    composerId: string;
    observedAt: number;
    expiresAt: number;
    completeness: string;
    reachedStart: boolean;
    plans: Array<{ id: string; toolCallId: string; label: string; title: string; description?: string }>;
  }

  function discoveryData(result: CommandResult): DiscoveryData {
    assert.equal(result.ok, true, `discovery failed: ${result.error ?? ''}`);
    return result.data as DiscoveryData;
  }

  function discoverPayload(commandId: string): Record<string, unknown> {
    return { commandId, type: 'discover_plans', windowId: 'target-a', composerId: 'composer-current' };
  }

  /** Connected session with the right window/composer but no mounted plan card. */
  function freshManager(): StateManager {
    const manager = new StateManager(0);
    manager.onConnectionChanged(true);
    manager.onExtraction(stateWithoutPlanCards());
    return manager;
  }

  function refReadPayload(commandId: string, planId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      commandId,
      windowId: 'target-a',
      composerId: 'composer-current',
      planId,
      ...extra,
    };
  }

  async function startRelay(
    calls: ExecutorCall[],
    execOpts: ExecutorOptions = {},
    stateManager: StateManager = freshManager(),
    bridge: CDPBridge = fakeBridge(),
  ): Promise<{ relay: Relay; origin: string }> {
    stateManager.updateWindows([], 'target-a');
    const relay = new Relay(config(dir), stateManager, mockExecutor(calls, execOpts), bridge);
    relays.push(relay);
    await relay.start();
    return { relay, origin: `http://127.0.0.1:${relay.port}` };
  }

  it('issues random plan-ref ids, returns metadata only, and reads a ref full text without a mounted card', async () => {
    writeFileSync(
      join(dir, '.cursor', 'plans', 'resolved.plan.md'),
      '---\nname: History\n---\n# 历史计划全文开头\n\n中段证据\n\n历史计划全文末尾',
    );
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);

    const discovery = await emitCommand(origin, sid, 'command:discover_plans', {
      ...discoverPayload('cmd-discover-1'),
      // 伪造的定位/正文信息不得被转发给 executor
      toolCallId: 'tc-forged',
      fileName: '../secret.md',
      path: '../secret.md',
      body: 'forged body',
      plans: [{ toolCallId: 'tc-forged', title: 'forged' }],
    });
    assert.equal(discovery.ok, true);
    const data = discoveryData(discovery);
    assert.equal(data.windowId, 'target-a');
    assert.equal(data.composerId, 'composer-current');
    assert.equal(data.completeness, 'partial');
    assert.equal(data.reachedStart, true);
    assert.equal(typeof data.observedAt, 'number');
    // 五分钟有界阅读时间，允许签发时几毫秒的时钟抖动。
    assert.ok(
      data.expiresAt - data.observedAt > 299_000 && data.expiresAt - data.observedAt <= 300_500,
      `ref batch must live about 5min, got ${data.expiresAt - data.observedAt}ms`,
    );
    assert.equal(data.plans.length, 2);
    const firstPlan = data.plans[0]!;
    const secondPlan = data.plans[1]!;
    assert.match(firstPlan.id, /^plan-ref:[\x20-\x7e]+$/, 'ref ids must carry the plan-ref prefix');
    assert.equal(new Set([firstPlan.id, secondPlan.id]).size, 2, 'each discovered plan gets its own ref id');
    assert.deepEqual(firstPlan, {
      id: firstPlan.id,
      toolCallId: 'tc-history-1',
      label: '历史计划一',
      title: '历史计划一',
      description: '第一段说明',
    });
    assert.deepEqual(secondPlan, {
      id: secondPlan.id,
      toolCallId: 'tc-history-2',
      label: '历史计划二',
      title: '历史计划二',
    });
    assert.equal(JSON.stringify(discovery.data).includes('历史计划全文'), false, 'discovery carries metadata only');
    assert.deepEqual(calls, [{
      method: 'discoverPlans',
      commandId: 'cmd-discover-1',
      expected: { windowId: 'target-a', composerId: 'composer-current' },
    }]);

    const full = await emitCommand(origin, sid, 'command:get_plan_full', refReadPayload('cmd-ref-read-1', firstPlan.id, {
      // 客户端自带的文件/工具身份必须被忽略
      toolCallId: 'tc-forged',
      fileName: '../secret.md',
      path: '../secret.md',
      body: 'forged body',
      planLabel: '../secret.md',
    }));
    assert.equal(full.ok, true, full.error);
    const fullData = full.data as {
      body: string;
      bodyHtml: string;
      todos: unknown[];
      metadata: Record<string, unknown>;
    };
    assert.match(fullData.body, /历史计划全文开头[\s\S]*中段证据[\s\S]*历史计划全文末尾/);
    assert.equal(fullData.metadata.windowId, 'target-a');
    assert.equal(fullData.metadata.composerId, 'composer-current');
    assert.equal(fullData.metadata.source, 'cursor_plan_file');
    // 客户端 validatePlanFullResult 要求 ref 读也返回完整快照：planId 为 ref、completeness 为 complete、
    // fileName/version/todos/bodyHtml 齐备，否则卡片不会展示全文。
    assert.equal(fullData.metadata.planId, firstPlan.id);
    assert.equal(fullData.metadata.completeness, 'complete');
    assert.match(String(fullData.metadata.fileName), /\.md$/);
    assert.match(String(fullData.metadata.version), /^[0-9a-f]{64}$/);
    assert.equal(Array.isArray(fullData.todos), true);
    assert.equal(typeof fullData.bodyHtml, 'string');
    assert.ok(fullData.bodyHtml.length > 0);
    const resolutions = calls.filter((call) => call.method === 'resolvePlanFile');
    assert.equal(resolutions.length, 1, 'a ref read must relocate the file exactly once');
    const resolved = resolutions[0]!.expected as Record<string, unknown>;
    assert.equal(resolved.toolCallId, 'tc-history-1', 'the real toolCallId must drive relocation');
    assert.equal(resolved.windowId, 'target-a');
    assert.equal(resolved.composerId, 'composer-current');
    for (const key of ['fileName', 'path', 'body', 'planLabel']) {
      assert.equal(key in resolved, false, `client field ${key} must not reach the executor`);
    }
  });

  it('refuses refs from another socket, forged ids, and foreign scopes before resolving a file', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'resolved.plan.md'), '# 正文');
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const owner = await connectSocket(origin);
    const stranger = await connectSocket(origin);

    const refId = discoveryData(
      await emitCommand(origin, owner.sid, 'command:discover_plans', discoverPayload('cmd-discover-share')),
    ).plans[0]!.id;

    const refused: Array<[string, CommandResult]> = [];
    refused.push(['another socket', await emitCommand(origin, stranger.sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-foreign-socket', refId))]);
    refused.push(['a forged id', await emitCommand(origin, owner.sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-forged-id', 'plan-ref:forged'))]);
    refused.push(['a foreign window', await emitCommand(origin, owner.sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-foreign-window', refId, { windowId: 'target-b' }))]);
    refused.push(['a foreign composer', await emitCommand(origin, owner.sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-foreign-composer', refId, { composerId: 'composer-other' }))]);
    refused.push(['a foreign window on the stranger socket', await emitCommand(origin, stranger.sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-stranger-window', refId, { windowId: 'target-b' }))]);
    for (const [label, result] of refused) {
      assert.equal(result.ok, false, `${label} must not read a referenced plan`);
      assert.equal(result.data, undefined, `${label} must not return a body`);
    }
    assert.equal(calls.filter((call) => call.method === 'resolvePlanFile').length, 0,
      'a refused ref must never reach the executor');

    const legit = await emitCommand(origin, owner.sid, 'command:get_plan_full', refReadPayload('cmd-ref-legit', refId, {
      toolCallId: 'tc-history-2',
      fileName: 'forged.plan.md',
      body: 'forged',
    }));
    assert.equal(legit.ok, true, legit.error);
    const resolutions = calls.filter((call) => call.method === 'resolvePlanFile');
    assert.equal(resolutions.length, 1);
    const resolved = resolutions[0]!.expected as Record<string, unknown>;
    assert.equal(resolved.toolCallId, 'tc-history-1', 'client supplied toolCallId must be ignored');
    assert.equal('fileName' in resolved, false);
    assert.equal('body' in resolved, false);
  });

  it('invalidates refs on target change away and back, on generation change, and on rediscovery', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'resolved.plan.md'), '# 正文');
    const calls: ExecutorCall[] = [];
    const { bridge, live } = mutableBridge();
    const manager = freshManager();
    const { origin } = await startRelay(calls, {}, manager, bridge);
    const { sid } = await connectSocket(origin);

    const firstRef = discoveryData(
      await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-first')),
    ).plans[0]!.id;
    assert.equal((await emitCommand(origin, sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-first-read', firstRef))).ok, true);

    live.targetId = 'target-b';
    manager.updateWindows([], 'target-b');
    const away = await emitCommand(origin, sid, 'command:get_plan_full', refReadPayload('cmd-ref-away', firstRef));
    assert.equal(away.ok, false, 'a ref must not survive leaving its target');

    live.targetId = 'target-a';
    manager.updateWindows([], 'target-a');
    const back = await emitCommand(origin, sid, 'command:get_plan_full', refReadPayload('cmd-ref-back', firstRef));
    assert.equal(back.ok, false, 'a target that changed away and back must not revive an earlier ref');
    assert.equal(back.data, undefined);

    const secondRef = discoveryData(
      await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-second')),
    ).plans[0]!.id;
    assert.notEqual(secondRef, firstRef, 'a new discovery must mint fresh ref ids');
    assert.equal((await emitCommand(origin, sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-second-read', secondRef))).ok, true);
    assert.equal((await emitCommand(origin, sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-first-replaced', firstRef))).ok, false, 'rediscovery must retire the previous batch');

    live.generation = 4;
    const newGeneration = await emitCommand(origin, sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-generation', secondRef));
    assert.equal(newGeneration.ok, false, 'a new target generation must invalidate refs');

    const thirdRef = discoveryData(
      await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-third')),
    ).plans[0]!.id;
    assert.equal((await emitCommand(origin, sid, 'command:get_plan_full',
      refReadPayload('cmd-ref-third-read', thirdRef))).ok, true, 'rediscovery on the new generation must work');
  });

  it('五分钟引用到期后拒绝读取，重新发现不恢复旧引用', async () => {
    writeFileSync(join(dir, '.cursor', 'plans', 'resolved.plan.md'), '# 正文');
    const clock = monotonicClock();
    const originalNow = Date.now;
    try {
      Date.now = clock.now;
      // 时钟被 mock 后，轮询截止时间必须使用保存下来的真实时钟。
      const now = { now: originalNow };
      const calls: ExecutorCall[] = [];
      const manager = freshManager();
      const { origin } = await startRelay(calls, {}, manager);
      const { sid } = await connectSocket(origin);

      const data = discoveryData(
        await emitCommandBounded(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-ttl'), now),
      );
      assert.ok(
        data.expiresAt - data.observedAt > 299_000 && data.expiresAt - data.observedAt <= 300_000,
        '模拟时钟下引用有效期为五分钟',
      );

      clock.set(data.expiresAt - 1_000);
      manager.onExtraction(stateWithoutPlanCards());
      const beforeExpiry = await emitCommandBounded(origin, sid, 'command:get_plan_full',
        refReadPayload('cmd-ref-before-expiry', data.plans[0]!.id), now);
      assert.equal(beforeExpiry.ok, true, 'a ref must still read one second before its TTL');

      clock.set(data.expiresAt + 1);
      manager.onExtraction(stateWithoutPlanCards());
      const expired = await emitCommandBounded(origin, sid, 'command:get_plan_full',
        refReadPayload('cmd-ref-expired', data.plans[0]!.id), now);
      assert.equal(expired.ok, false);
      assert.equal(expired.data, undefined);
      assert.match(String(expired.error ?? ''), /过期|expired|失效|无法确认/);

      const refreshed = discoveryData(
        await emitCommandBounded(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-refreshed'), now),
      );
      assert.ok(refreshed.expiresAt > clock.now(), 'a refreshed batch must be live again');
      const refreshedRead = await emitCommandBounded(origin, sid, 'command:get_plan_full',
        refReadPayload('cmd-ref-refreshed', refreshed.plans[0]!.id), now);
      assert.equal(refreshedRead.ok, true, refreshedRead.error);
      assert.equal((await emitCommandBounded(origin, sid, 'command:get_plan_full',
        refReadPayload('cmd-ref-expired-again', data.plans[0]!.id), now)).ok, false,
      'rediscovery must not resurrect an expired ref');
    } finally {
      Date.now = originalNow;
    }
  });

  it('rejects reentrant discovery and drops a discovery whose target changed while it ran', async () => {
    const calls: ExecutorCall[] = [];
    const { bridge, live } = mutableBridge();
    const manager = freshManager();
    const gate = deferred();
    const { origin } = await startRelay(calls, { gate: gate.promise }, manager, bridge);
    const { sid } = await connectSocket(origin);

    await postCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-slow'));
    for (let i = 0; calls.length === 0 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 1, 'the slow discovery must reach the executor once');

    const reentrant = await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-reentrant'));
    assert.equal(reentrant.ok, false, 'a concurrent discovery must be refused');
    assert.equal(reentrant.data, undefined);
    assert.equal(calls.length, 1, 'a refused reentrant discovery must not reach the executor');

    live.targetId = 'target-b';
    manager.updateWindows([], 'target-b');
    gate.resolve();
    const [result] = await collectResults(origin, sid, 1);
    assert.equal(result.commandId, 'cmd-discover-slow');
    assert.equal(result.ok, false, 'a discovery finishing after a target change must not return refs');
    assert.equal(result.data, undefined, 'no ref batch may be issued for a stale target');
  });

  it('drops a discovery whose target generation changed while it ran', async () => {
    const calls: ExecutorCall[] = [];
    const { bridge, live } = mutableBridge();
    const manager = freshManager();
    const gate = deferred();
    const { origin } = await startRelay(calls, { gate: gate.promise }, manager, bridge);
    const { sid } = await connectSocket(origin);

    await postCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-generation'));
    for (let i = 0; calls.length === 0 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 1);
    live.generation = 4;
    gate.resolve();
    const [result] = await collectResults(origin, sid, 1);
    assert.equal(result.commandId, 'cmd-discover-generation');
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
  });

  it('A→B→A during in-flight discover reports expired, not unknown', async () => {
    const calls: ExecutorCall[] = [];
    const { bridge, live } = mutableBridge();
    const manager = freshManager();
    const gate = deferred();
    const { origin } = await startRelay(calls, { gate: gate.promise }, manager, bridge);
    const { sid } = await connectSocket(origin);

    await postCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-aba'));
    for (let i = 0; calls.length === 0 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 1);
    live.targetId = 'target-b';
    manager.updateWindows([], 'target-b');
    live.targetId = 'target-a';
    manager.updateWindows([], 'target-a');
    gate.resolve();
    const [result] = await collectResults(origin, sid, 1);
    assert.equal(result.commandId, 'cmd-discover-aba');
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assertPlanFailure(result, {
      commandId: 'cmd-discover-aba',
      code: 'expired',
      stage: 'guard',
      requested: { windowId: 'target-a', composerId: 'composer-current' },
    });
  });

  it('refuses discovery for a foreign, missing, or unknown target without issuing refs', async () => {
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls);
    const { sid } = await connectSocket(origin);

    const rejected: Array<Record<string, unknown>> = [
      { commandId: 'cmd-discover-foreign-window', type: 'discover_plans', windowId: 'target-b', composerId: 'composer-current' },
      { commandId: 'cmd-discover-foreign-composer', type: 'discover_plans', windowId: 'target-a', composerId: 'composer-other' },
      { commandId: 'cmd-discover-no-window', type: 'discover_plans', composerId: 'composer-current' },
      { commandId: 'cmd-discover-no-composer', type: 'discover_plans', windowId: 'target-a' },
      { commandId: 'cmd-discover-empty', type: 'discover_plans', windowId: '', composerId: '' },
    ];
    for (const payload of rejected) {
      const result = await emitCommand(origin, sid, 'command:discover_plans', payload);
      assert.equal(result.ok, false, `${payload.commandId} must be refused`);
      assert.equal(result.data, undefined, `${payload.commandId} must not return a ref batch`);
    }
    for (const call of calls.filter((item) => item.method === 'discoverPlans')) {
      const expected = call.expected as Record<string, unknown>;
      for (const key of ['fileName', 'path', 'body', 'toolCallId', 'plans', 'planLabel']) {
        assert.equal(key in expected, false, `client field ${key} must not reach the executor`);
      }
    }

    // 无当前 plan 卡片也能发现，并且只有授权 scope 才能拿到 ref
    const valid = await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-valid'));
    assert.equal(valid.ok, true, valid.error);
    assert.equal(discoveryData(valid).plans.length, 2);
  });

  it('discover_plans 守卫失败带稳定结构化原因且不泄漏其他目标', async () => {
    const manager = freshManager();
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, {}, manager);
    const { sid } = await connectSocket(origin);
    const requested = { windowId: 'target-a', composerId: 'composer-current' };

    const missing = await emitCommand(origin, sid, 'command:discover_plans', {
      commandId: 'cmd-discover-invalid', type: 'discover_plans',
    });
    assert.match(missing.error ?? '', /查找计划需要明确/);
    assertPlanFailure(missing, {
      commandId: 'cmd-discover-invalid', code: 'invalid', stage: 'validate',
    });

    const foreignWindow = await emitCommand(origin, sid, 'command:discover_plans', {
      commandId: 'cmd-discover-window', type: 'discover_plans',
      windowId: 'target-b', composerId: 'composer-current',
    });
    assert.match(foreignWindow.error ?? '', /无法确认|失效|窗口/);
    assertPlanFailure(foreignWindow, {
      commandId: 'cmd-discover-window', code: 'window', stage: 'guard',
      requested: { windowId: 'target-b', composerId: 'composer-current' },
    });
    assert.equal(JSON.stringify(foreignWindow).includes('target-a'), false, 'must not leak the other window id');

    const foreignComposer = await emitCommand(origin, sid, 'command:discover_plans', {
      commandId: 'cmd-discover-session', type: 'discover_plans',
      windowId: 'target-a', composerId: 'composer-other',
    });
    assertPlanFailure(foreignComposer, {
      commandId: 'cmd-discover-session', code: 'session', stage: 'guard',
      requested: { windowId: 'target-a', composerId: 'composer-other' },
    });

    manager.getCurrentState().lastExtractionAt = Date.now() - 60_000;
    const stale = await emitCommand(origin, sid, 'command:discover_plans', {
      ...discoverPayload('cmd-discover-expired'),
    });
    assertPlanFailure(stale, {
      commandId: 'cmd-discover-expired', code: 'expired', stage: 'guard', requested,
    });

    manager.getCurrentState().lastExtractionAt = Date.now();
    manager.onExtractionFailure('selector miss');
    const extraction = await emitCommand(origin, sid, 'command:discover_plans', {
      ...discoverPayload('cmd-discover-extraction'),
    });
    assertPlanFailure(extraction, {
      commandId: 'cmd-discover-extraction', code: 'extraction', stage: 'guard', requested,
    });

    manager.onExtraction(stateWithoutPlanCards());
    manager.onConnectionChanged(false);
    const disconnected = await emitCommand(origin, sid, 'command:discover_plans', {
      ...discoverPayload('cmd-discover-connection'),
    });
    assertPlanFailure(disconnected, {
      commandId: 'cmd-discover-connection', code: 'connection', stage: 'guard', requested,
    });

    const busyCalls: ExecutorCall[] = [];
    const busyManager = freshManager();
    const gate = deferred();
    const busy = await startRelay(busyCalls, { gate: gate.promise }, busyManager);
    const busySock = await connectSocket(busy.origin);
    await postCommand(busy.origin, busySock.sid, 'command:discover_plans', discoverPayload('cmd-discover-busy-owner'));
    for (let i = 0; busyCalls.length === 0 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const reentrant = await emitCommand(busy.origin, busySock.sid, 'command:discover_plans', discoverPayload('cmd-discover-busy'));
    assert.match(reentrant.error ?? '', /正在查找/);
    assertPlanFailure(reentrant, {
      commandId: 'cmd-discover-busy', code: 'busy', stage: 'guard', requested,
    });
    gate.resolve();
    await collectResults(busy.origin, busySock.sid, 1);

    assert.equal(calls.filter((call) => call.method === 'discoverPlans').length, 0);
  });

  it('never returns more than 32 refs in one batch', async () => {
    const many: PlanDiscoveryFixture[] = Array.from({ length: 40 }, (_value, index) => ({
      toolCallId: `tc-bulk-${index}`,
      title: `批量计划 ${index}`,
    }));
    const calls: ExecutorCall[] = [];
    const { origin } = await startRelay(calls, { plans: many });
    const { sid } = await connectSocket(origin);

    const bulk = await emitCommand(origin, sid, 'command:discover_plans', discoverPayload('cmd-discover-bulk'));
    if (bulk.ok) {
      const data = discoveryData(bulk);
      assert.equal(data.plans.length, 32, 'an over-cap batch must be trimmed to 32 refs');
      assert.equal(new Set(data.plans.map((plan) => plan.id)).size, 32);
      assert.ok(data.plans.every((plan) => plan.id.startsWith('plan-ref:')));
    } else {
      assert.equal(bulk.data, undefined, 'an over-cap batch must not leak refs');
    }
  });
});