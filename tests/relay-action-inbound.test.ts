import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
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

interface ExecutorCall {
  method: string;
  commandId: string;
  actionId?: string;
  expected?: unknown;
  text?: string;
}

function mockExecutor(calls: ExecutorCall[], opts: { gate?: Promise<void> } = {}): CommandExecutor {
  return {
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
    assert.equal(socketCommandRequiresOperationId('reject'), false);
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
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-inbound-'));
    relays.length = 0;
  });

  afterEach(async () => {
    for (const relay of relays) {
      try { await relay.stop(); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function startRelay(
    calls: ExecutorCall[],
    execOpts?: { gate?: Promise<void> },
    stateManager: StateManager = new StateManager(0),
  ): Promise<{ relay: Relay; origin: string }> {
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
      planId: 'plan-forged',
      planLabel: 'definitely-missing-current.plan.md',
    });
    assert.equal(forged.ok, false);
    assert.match(forged.error ?? '', /current session/);

    const current = await emitCommand(origin, sid, 'command:get_plan_full', {
      commandId: 'cmd-plan-current',
      planId: 'plan-current',
      planLabel: '../ignored-client-label.md',
    });
    assert.equal(current.ok, false);
    assert.match(current.error ?? '', /not found|could not be read/);
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