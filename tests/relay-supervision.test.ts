import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CSRF_COOKIE, Relay } from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandDispatchOptions, CommandExecutor } from '../src/server/command-executor.js';
import type { CDPBridge } from '../src/server/cdp-bridge.js';
import { SUPERVISION_STORE_FILE } from '../src/server/supervision-manager.js';
import { WEBAPP_SESSION_COOKIE } from '../src/server/webapp-sessions.js';
import type {
  CommandResult,
  CursorState,
  ServerConfig,
  WorkspaceIdentity,
} from '../src/server/types.js';

const RECORD_SEP = '\x1e';
const PASSWORD = 'secret';
const WS: WorkspaceIdentity = {
  id: 'ws-stable',
  uri: { scheme: 'file', authority: '', path: '/Users/secret/project' },
};
const OTHER_WS: WorkspaceIdentity = {
  id: 'ws-other',
  uri: { scheme: 'file', authority: '', path: '/Users/secret/other' },
};

const WRITE_COMMANDS: Array<{ event: string; payload: Record<string, unknown> }> = [
  { event: 'command:send_message', payload: { commandId: 'w-send', text: 'hi', operationId: 'op-send-01' } },
  { event: 'command:approve', payload: { commandId: 'w-approve', actionId: 'act-1', operationId: 'op-approve-01' } },
  { event: 'command:approve_all', payload: { commandId: 'w-all', actionId: 'act-2', operationId: 'op-all-01' } },
  { event: 'command:reject', payload: { commandId: 'w-reject', actionId: 'act-3', operationId: 'op-reject-01' } },
  { event: 'command:switch_tab', payload: { commandId: 'w-tab', tabTitle: 'Read' } },
  { event: 'command:new_chat', payload: { commandId: 'w-new', operationId: 'op-new-01' } },
  { event: 'command:set_mode', payload: { commandId: 'w-mode', modeId: 'agent', operationId: 'op-mode-01' } },
  { event: 'command:set_model', payload: { commandId: 'w-model', modelId: 'auto', operationId: 'op-model-01' } },
  { event: 'command:get_model_options', payload: { commandId: 'w-opts' } },
  { event: 'command:get_plan_model_options', payload: { commandId: 'w-plan-opts', actionId: 'act-4' } },
  { event: 'command:set_plan_model', payload: { commandId: 'w-plan-model', actionId: 'act-5', planModelId: 'm1', operationId: 'op-pm-01' } },
  { event: 'command:click_action', payload: { commandId: 'w-click', actionId: 'act-6', actionType: 'continue', operationId: 'op-click-01' } },
  { event: 'command:switch_window', payload: { commandId: 'w-win', windowId: 'win-1' } },
];

function baseConfig(dir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 150,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    webappPassword: PASSWORD,
    windowTitleQualifier: true,
    dataDir: dir,
    adapterStorePath: join(dir, 'adapters.json'),
    adapterBackupCount: 5,
    actionTtlMs: 30_000,
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' },
    ...overrides,
  };
}

function fakeBridge(identityRef: { current: WorkspaceIdentity | null }): CDPBridge {
  return {
    activeTargetId: 'win-1',
    getTargetGeneration: () => 1,
    getClient: () => null,
    getDiscoveryStatus: () => ({ status: 'idle' }),
    windows: [],
    getActiveWorkspaceIdentity: () => identityRef.current,
  } as unknown as CDPBridge;
}

function mockExecutor(calls: Array<{ method: string; commandId: string }>): CommandExecutor {
  const record = (method: string) => async (commandId: string) => {
    calls.push({ method, commandId });
    return { commandId, ok: true } satisfies CommandResult;
  };
  return {
    sendMessage: record('sendMessage'),
    clickRegisteredAction: record('clickRegisteredAction'),
    switchTab: record('switchTab'),
    newChat: record('newChat'),
    setMode: record('setMode'),
    setModel: record('setModel'),
    getModelOptions: record('getModelOptions'),
    getRegisteredPlanModelOptions: record('getRegisteredPlanModelOptions'),
    setRegisteredPlanModel: record('setRegisteredPlanModel'),
    discoverPlans: record('discoverPlans'),
    resolvePlanFile: record('resolvePlanFile'),
  } as unknown as CommandExecutor;
}

function sampleState(over: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: 'file:///Users/secret/project boom',
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [
      { type: 'human', id: 'm1', flatIndex: 0, text: 'secret task', mentions: [] },
    ],
    pendingApprovals: [{ id: 'ap1', description: 'run rm', actions: [] }],
    inputAvailable: true,
    chatTabs: [
      { composerId: 'c-read', title: 'Read me', isActive: true, status: '', selectorPath: '/secret/read' },
      { composerId: 'c-other', title: 'Other', isActive: false, status: '', selectorPath: '/secret/other' },
    ],
    activeComposerId: 'c-read',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [
      { id: 'win-1', title: 'Proj', url: 'file:///Users/secret/project', wsUrl: 'ws://127.0.0.1/secret' },
      { id: 'win-2', title: 'OtherWin', url: 'file:///Users/secret/other', wsUrl: 'ws://127.0.0.1/other' },
    ],
    activeWindowId: 'win-1',
    composerQueue: { items: [{ id: 'q1', text: 'queued secret' }] },
    questionnaire: {
      questions: [],
      activeIndex: 0,
      totalLabel: '0',
      skipSelectorPath: '/skip',
      continueSelectorPath: '/continue',
      continueDisabled: true,
    },
    _workspaceIdentity: WS,
    ...over,
  };
}

function pollingUrl(origin: string, sid: string): string {
  return `${origin}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`;
}

function splitPackets(body: string): string[] {
  return body.split(RECORD_SEP).filter(Boolean);
}

function parseSocketEvents(body: string): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [];
  for (const packet of splitPackets(body)) {
    if (!packet.startsWith('42')) continue;
    const data = JSON.parse(packet.slice(2)) as [string, unknown];
    events.push(data);
  }
  return events;
}

async function eioPost(
  origin: string,
  sid: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(pollingUrl(origin, sid), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
    body,
  });
}

async function connectSocket(
  origin: string,
  opts: { token?: string; cookie?: string } = {},
): Promise<{ sid: string; events: Array<[string, unknown]> }> {
  const headers: Record<string, string> = { Origin: origin };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const hs = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`, { headers });
  const text = await hs.text();
  const sid = /"sid":"([^"]+)"/.exec(text)?.[1];
  if (!sid) throw new Error(`handshake failed: ${hs.status} ${text}`);
  const auth = opts.token ? JSON.stringify({ token: opts.token }) : '';
  const connect = await eioPost(origin, sid, `40${auth}`, headers);
  assert.equal(connect.status, 200);
  const drain = await fetch(pollingUrl(origin, sid), { headers });
  assert.equal(drain.status, 200);
  return { sid, events: parseSocketEvents(await drain.text()) };
}

async function postCommand(
  origin: string,
  sid: string,
  event: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await eioPost(origin, sid, `42${JSON.stringify([event, payload])}`, headers);
  if (res.status !== 200) throw new Error(`emit ${res.status} ${await res.text()}`);
}

async function collectResults(
  origin: string,
  sid: string,
  count: number,
  headers: Record<string, string> = {},
  timeoutMs = 4000,
): Promise<CommandResult[]> {
  const found: CommandResult[] = [];
  const deadline = Date.now() + timeoutMs;
  while (found.length < count && Date.now() < deadline) {
    try {
      const res = await fetch(pollingUrl(origin, sid), {
        headers,
        signal: AbortSignal.timeout(Math.max(50, deadline - Date.now())),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`poll ${res.status} ${text}`);
      for (const packet of splitPackets(text)) {
        if (packet === '2') {
          await eioPost(origin, sid, '3', headers);
          continue;
        }
        if (!packet.startsWith('42')) continue;
        const data = JSON.parse(packet.slice(2)) as [string, unknown];
        if (data[0] === 'command:result') found.push(data[1] as CommandResult);
      }
    } catch (err) {
      if (found.length >= count) break;
      if (Date.now() >= deadline) break;
      if (err instanceof Error && err.name === 'TimeoutError') continue;
      throw err;
    }
  }
  if (found.length < count) {
    throw new Error(`timed out waiting for ${count} command:result, got ${found.length}`);
  }
  return found;
}

async function emitCommand(
  origin: string,
  sid: string,
  event: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<CommandResult> {
  await postCommand(origin, sid, event, payload, headers);
  const [result] = await collectResults(origin, sid, 1, headers);
  return result;
}

async function collectNamed(
  origin: string,
  sid: string,
  name: string,
  timeoutMs = 2000,
  headers: Record<string, string> = {},
): Promise<Array<[string, unknown]>> {
  const found: Array<[string, unknown]> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(pollingUrl(origin, sid), {
        headers,
        signal: AbortSignal.timeout(Math.max(50, deadline - Date.now())),
      });
      const text = await res.text();
      if (res.status !== 200) return found;
      for (const packet of splitPackets(text)) {
        if (packet === '2') {
          await eioPost(origin, sid, '3', headers);
          continue;
        }
        if (!packet.startsWith('42')) continue;
        const data = JSON.parse(packet.slice(2)) as [string, unknown];
        if (data[0] === name) found.push(data);
      }
      if (found.length > 0) return found;
    } catch {
      break;
    }
  }
  return found;
}

function cookieHeader(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((part) => part.split(';')[0]).join('; ');
}

function cookieMaxAge(res: Response, name: string): number | null {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const line = setCookies.find((part) => part.startsWith(`${name}=`));
  if (!line) return null;
  const match = /Max-Age=(\d+)/i.exec(line);
  return match ? Number(match[1]) : null;
}

function assertNoSecretLeak(raw: string, extra: string[] = []): void {
  assert.doesNotMatch(raw, /\/Users\/secret/);
  assert.doesNotMatch(raw, /file:\/\/\/Users/);
  assert.doesNotMatch(raw, /file:\/\/\/secret/);
  for (const item of extra) {
    if (item.length >= 16) assert.equal(raw.includes(item), false, `leaked ${item.slice(0, 8)}…`);
  }
}

describe('Relay supervision', () => {
  let dir: string;
  const relays: Relay[] = [];
  const executorCalls: Array<{ method: string; commandId: string }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-supervision-'));
    relays.length = 0;
    executorCalls.length = 0;
  });

  afterEach(async () => {
    for (const r of relays) {
      try { await r.stop(); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRelay(over: {
    config?: Partial<ServerConfig>;
    identity?: WorkspaceIdentity | null;
    state?: CursorState;
    sm?: StateManager;
    executor?: CommandExecutor;
  } = {}): { relay: Relay; sm: StateManager; identityRef: { current: WorkspaceIdentity | null } } {
    const config = baseConfig(dir, over.config);
    const sm = over.sm ?? new StateManager(0);
    const seeded = over.state ?? sampleState();
    sm.onConnectionChanged(true);
    sm.updateWindows(seeded.windows, seeded.activeWindowId);
    sm.onExtraction(seeded);
    const identityRef = { current: over.identity === undefined ? WS : over.identity };
    const relay = new Relay(config, sm, over.executor ?? mockExecutor(executorCalls), fakeBridge(identityRef));
    relays.push(relay);
    return { relay, sm, identityRef };
  }

  async function login(origin: string): Promise<{ token: string; cookie: string }> {
    const res = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string };
    return { token: body.token, cookie: cookieHeader(res) };
  }

  async function createGrant(
    origin: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; json: Record<string, unknown>; raw: string; res: Response }> {
    const res = await fetch(`${origin}/api/supervision/grants`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        goal: 'watch the agent',
        planVersion: 'plan-1',
        authorizationVersion: 'auth-1',
        expiresAt: Date.now() + 120_000,
        readComposerIds: ['c-read'],
        writeComposerIds: ['c-read'],
        ...body,
      }),
    });
    const raw = await res.text();
    const json = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return { status: res.status, json, raw, res };
  }

  async function redeem(origin: string, code: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(`${origin}/api/supervision/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...extraHeaders },
      body: JSON.stringify({ code }),
    });
  }

  it('redeems a code once, sets cookies, and never returns or stores plaintext', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    assert.equal(created.status, 200);
    assert.equal(created.res.headers.get('cache-control'), 'no-store');
    const grant = created.json.grant as { grantId: string };
    const redeemCode = created.json.redeemCode as string;
    assert.equal(typeof grant.grantId, 'string');
    assert.equal(typeof redeemCode, 'string');
    assert.ok(redeemCode.length >= 32);
    assert.equal('token' in created.json, false);
    assertNoSecretLeak(created.raw);

    const storePath = join(dir, SUPERVISION_STORE_FILE);
    assert.equal(existsSync(storePath), true);
    const diskBefore = readFileSync(storePath, 'utf-8');
    assert.equal(diskBefore.includes(redeemCode), false);

    const first = await redeem(origin, redeemCode);
    assert.equal(first.status, 200);
    const firstRaw = await first.text();
    const firstBody = JSON.parse(firstRaw) as Record<string, unknown>;
    assert.equal(firstBody.ok, true);
    assert.equal('token' in firstBody, false);
    assert.equal('redeemCode' in firstBody, false);
    assertNoSecretLeak(firstRaw, [redeemCode]);

    const setCookies = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : [];
    const sessionLine = setCookies.find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`)) ?? '';
    const csrfLine = setCookies.find((part) => part.startsWith(`${CSRF_COOKIE}=`)) ?? '';
    assert.match(sessionLine, /HttpOnly/i);
    assert.match(sessionLine, /SameSite=Lax/i);
    assert.match(csrfLine, /SameSite=Lax/i);
    const sessionCookie = setCookies.map((part) => part.split(';')[0]).join('; ');
    assert.match(sessionCookie, new RegExp(`${WEBAPP_SESSION_COOKIE}=`));
    assert.match(sessionCookie, new RegExp(`${CSRF_COOKIE}=`));
    const sessionAge = cookieMaxAge(first, WEBAPP_SESSION_COOKIE);
    const csrfAge = cookieMaxAge(first, CSRF_COOKIE);
    assert.ok(sessionAge !== null && sessionAge > 0 && sessionAge <= 120);
    assert.ok(csrfAge !== null && csrfAge > 0 && csrfAge <= 120);

    const supervisorToken = sessionCookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';
    assert.ok(supervisorToken.length >= 32);
    const diskAfter = readFileSync(storePath, 'utf-8');
    assert.equal(diskAfter.includes(redeemCode), false);
    assert.equal(diskAfter.includes(supervisorToken), false);

    const second = await redeem(origin, redeemCode);
    assert.equal(second.status, 401);
    const secondRaw = await second.text();
    assert.equal(secondRaw.includes(redeemCode), false);
    assert.equal(secondRaw.includes(supervisorToken), false);
  });

  it('rejects a foreign Origin on redeem and ignores client-supplied workspace on create', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token, { workspace: OTHER_WS });
    assert.equal(created.status, 200);
    const grant = created.json.grant as { workspace: WorkspaceIdentity };
    assert.equal(grant.workspace.id, WS.id);
    const foreign = await redeem(origin, created.json.redeemCode as string, { Origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
  });

  it('rejects write scopes that are not a subset of read or unknown composers', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const notSubset = await createGrant(origin, token, {
      readComposerIds: ['c-read'],
      writeComposerIds: ['c-other'],
    });
    assert.equal(notSubset.status, 400);
    const unknown = await createGrant(origin, token, {
      readComposerIds: ['c-missing'],
      writeComposerIds: [],
    });
    assert.equal(unknown.status, 400);
  });

  it('filters supervisor health and forbids debug/capabilities/discovery/adapters/grants', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';

    const healthRes = await fetch(`${origin}/health`, { headers: { Cookie: cookie } });
    const healthRaw = await healthRes.text();
    const health = JSON.parse(healthRaw) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.sessionValid, true);
    assert.equal(typeof health.connected, 'boolean');
    assert.equal(typeof health.extractorStatus, 'string');
    assert.equal(typeof health.version, 'string');
    assert.equal(typeof health.instanceId, 'string');
    assert.equal(health.activeWindowId, 'win-1');
    assert.equal(health.activeComposerId, 'c-read');
    assert.equal('windows' in health, false);
    assert.equal('chatTabs' in health, false);
    assert.equal('messages' in health, false);
    assert.equal('lastExtractionError' in health, false);
    assertNoSecretLeak(healthRaw, [supervisorToken, created.json.redeemCode as string]);

    const headers = { Authorization: `Bearer ${supervisorToken}` };
    const forbidden = [
      '/debug/state',
      '/api/capabilities',
      '/api/capabilities/diff',
      '/api/discovery/status',
      '/api/adapters/history',
      `/api/supervision/grants/${(created.json.grant as { grantId: string }).grantId}`,
    ];
    for (const path of forbidden) {
      const res = await fetch(`${origin}${path}`, { headers });
      assert.equal(res.status, 403, path);
    }
    const createAsSupervisor = await fetch(`${origin}/api/supervision/grants`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'nope', planVersion: 'p', authorizationVersion: 'a', expiresAt: Date.now() + 10_000 }),
    });
    assert.equal(createAsSupervisor.status, 403);
  });

  it('filters supervisor socket state, upgrades patches to full, and denies cross-composer reads and incomplete writes', async () => {
    const { relay, sm } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';

    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    const eventNames = sock.events.map(([name]) => name);
    assert.equal(eventNames.includes('capabilities:full'), false);
    assert.equal(eventNames.includes('adapter:pending'), false);
    const full = sock.events.find(([name]) => name === 'state:full')?.[1] as CursorState;
    assert.ok(full);
    assert.deepEqual(full.chatTabs.map((t) => t.composerId), ['c-read']);
    assert.equal(full.messages.length, 1);
    assert.equal(full.activeComposerId, 'c-read');
    assert.equal(full.activeWindowId, 'win-1');
    assert.equal(full.windows.length, 1);
    assert.equal(full.windows[0].id, 'win-1');
    assert.equal('url' in full.windows[0] && Boolean((full.windows[0] as { url?: string }).url), false);
    assert.equal('wsUrl' in full.windows[0], false);
    const fullRaw = JSON.stringify(full);
    assert.equal(full.lastExtractionError, null);
    assertNoSecretLeak(fullRaw, [supervisorToken]);

    sm.onExtraction(sampleState({
      activeComposerId: 'c-other',
      chatTabs: sampleState().chatTabs.map((t) => ({ ...t, isActive: t.composerId === 'c-other' })),
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const updates = await collectNamed(origin, sock.sid, 'state:full', 1500, { Cookie: cookie, Origin: origin });
    const patchNames = updates.length > 0 ? [] : (await collectNamed(origin, sock.sid, 'state:patch', 200, { Cookie: cookie, Origin: origin }));
    assert.ok(updates.length >= 1);
    assert.equal(patchNames.length, 0);
    const next = updates[0][1] as CursorState;
    assert.deepEqual(next.chatTabs.map((t) => t.composerId), ['c-read']);
    assert.deepEqual(next.messages, []);
    assert.equal(next.activeComposerId, '');
    assert.equal(next.activeWindowId, '');
    assert.deepEqual(next.pendingApprovals, []);
    assert.equal(next.questionnaire, null);
    assert.deepEqual(next.composerQueue.items, []);
    assert.equal(next.agentStatus, 'idle');
    assert.equal(next.agentActivityText, null);
    assert.equal(next.agentActivityLive, false);
    assert.equal(next.inputAvailable, false);
    assert.deepEqual(next.mode, { current: '', available: [] });
    assert.deepEqual(next.model, { current: '', currentId: '' });

    const cross = await emitCommand(origin, sock.sid, 'command:discover_plans', {
      commandId: 'cmd-cross',
      windowId: 'win-1',
      composerId: 'c-other',
    }, { Cookie: cookie, Origin: origin });
    assert.equal(cross.ok, false);
    assert.equal(cross.error, 'Supervision scope denied');
    assert.equal(executorCalls.some((c) => c.method === 'discoverPlans'), false);

    for (const cmd of WRITE_COMMANDS) {
      const result = await emitCommand(origin, sock.sid, cmd.event, cmd.payload, { Cookie: cookie, Origin: origin });
      assert.equal(result.ok, false, cmd.event);
      const route = cmd.event.slice('command:'.length);
      const expected = ['send_message', 'approve', 'approve_all', 'reject', 'set_plan_model', 'click_action'].includes(route)
        ? 'Supervision write scope is incomplete'
        : ['set_mode', 'set_model'].includes(route)
          ? 'Capability state is not verified'
          : 'Supervision scope denied';
      assert.equal(result.error, expected, cmd.event);
    }
    assert.equal(executorCalls.length, 0);
  });

  it('never treats an invalidated supervisor socket as an owner write', async () => {
    const { relay } = makeRelay();
    let disconnected = false;
    let dispatches = 0;
    const socket = {
      data: { principalRole: 'supervisor' },
      handshake: { auth: {}, headers: {} },
      disconnect: () => { disconnected = true; },
    };
    const guarded = relay as unknown as {
      runScopedWrite: (
        socket: unknown,
        route: string,
        payload: Record<string, unknown>,
        commandId: string,
        dispatch: (options: CommandDispatchOptions) => Promise<CommandResult>,
        confirm: () => boolean,
      ) => Promise<CommandResult>;
    };

    const result = await guarded.runScopedWrite(
      socket,
      'send_message',
      { commandId: 'invalidated-supervisor', text: 'must not dispatch' },
      'invalidated-supervisor',
      async () => {
        dispatches += 1;
        return { commandId: 'invalidated-supervisor', ok: true };
      },
      () => true,
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Supervision scope denied');
    assert.equal(disconnected, true);
    assert.equal(dispatches, 0);
  });

  it('dispatches one fully scoped supervisor write and rejects a stale control version', async () => {
    const sm = new StateManager(0);
    const seeded = sampleState();
    sm.onConnectionChanged(true);
    sm.updateWindows(seeded.windows, seeded.activeWindowId);
    sm.onExtraction(seeded);
    let dispatches = 0;
    const executor = {
      hasComposerDraftNow: async () => false,
      sendMessage: async (commandId: string, text: string, opts: CommandDispatchOptions = {}) => {
        await opts.beforeDispatch?.();
        dispatches += 1;
        sm.onExtraction(sampleState({
          messages: [
            ...sm.getCurrentState().messages,
            { type: 'human', id: `sent-${dispatches}`, flatIndex: dispatches, text, mentions: [] },
          ],
        }));
        return { commandId, ok: true } satisfies CommandResult;
      },
    } as unknown as CommandExecutor;
    const { relay } = makeRelay({ sm, executor });
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token, {
      operationLimit: 2,
      allowedActionTypes: ['send_message'],
      allowedModes: ['agent'],
      allowedModels: ['Auto'],
    });
    const grant = created.json.grant as { controlVersion: string };
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';
    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    const scope = {
      composerId: 'c-read',
      windowId: 'win-1',
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: grant.controlVersion,
    };

    const first = await emitCommand(origin, sock.sid, 'command:send_message', {
      commandId: 'scoped-send-1',
      operationId: 'scoped-operation-1',
      text: 'authorized message',
      ...scope,
    }, { Cookie: cookie, Origin: origin });
    assert.equal(first.ok, true);
    assert.equal(dispatches, 1);
    assert.equal((first.data as { supervision?: { status?: string } }).supervision?.status, 'confirmed');

    const stale = await emitCommand(origin, sock.sid, 'command:send_message', {
      commandId: 'scoped-send-2',
      operationId: 'scoped-operation-2',
      text: 'must not dispatch',
      ...scope,
    }, { Cookie: cookie, Origin: origin });
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? '', /policy denied|control version/i);
    assert.equal(dispatches, 1);
  });

  it('completes a bound issue decision once and rejects replay', async () => {
    const sm = new StateManager(0);
    const seeded = sampleState();
    sm.onConnectionChanged(true);
    sm.updateWindows(seeded.windows, seeded.activeWindowId);
    sm.onExtraction(seeded);
    let relay!: Relay;
    let dispatches = 0;
    const executor = {
      hasComposerDraftNow: async () => false,
      clickRegisteredAction: async (
        commandId: string,
        _actionId: string,
        _target: unknown,
        opts: CommandDispatchOptions = {},
      ) => {
        await opts.beforeDispatch?.();
        dispatches += 1;
        sm.onExtraction(sampleState({ pendingApprovals: [] }));
        return { commandId, ok: true } satisfies CommandResult;
      },
    } as unknown as CommandExecutor;
    ({ relay } = makeRelay({ sm, executor }));
    const action = relay.getActionRegistry().register({
      windowId: 'win-1',
      targetId: 'win-1',
      targetGeneration: 1,
      composerId: 'c-read',
      toolCallId: 'tool-1',
      adapterId: 'builtin',
      actionType: 'approve',
      expectedLabel: 'Approve',
      selectorStrategyId: 'observed',
      selectorPath: '#approve',
    });
    sm.onExtraction(sampleState({
      pendingApprovals: [{
        id: 'ap-current',
        description: 'Approve current action',
        actions: [{
          label: 'Approve',
          type: 'approve',
          selectorPath: '#approve',
          actionId: action.actionId,
        }],
      }],
    }));
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const owner = await login(origin);
    const created = await createGrant(origin, owner.token, {
      operationLimit: 2,
      allowedActionTypes: ['approve'],
      allowedModes: ['agent'],
      allowedModels: ['Auto'],
    });
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';
    const csrf = cookie
      .split('; ')
      .find((part) => part.startsWith(`${CSRF_COOKIE}=`))
      ?.slice(`${CSRF_COOKIE}=`.length) ?? '';
    const issueResponse = await fetch(`${origin}/api/supervision/issues`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({
        composerId: 'c-read',
        actionType: 'approve',
        actionId: action.actionId,
        planVersion: 'plan-1',
        authorizationVersion: 'auth-1',
        expiresAt: Date.now() + 60_000,
      }),
    });
    assert.equal(issueResponse.status, 200);
    const issue = ((await issueResponse.json()) as { issue: {
      issueId: string;
      controlVersion: string;
      contentDigest: string;
    } }).issue;
    assert.match(issue.contentDigest, /^[a-f0-9]{64}$/);

    const decision = await fetch(`${origin}/api/supervision/issues/${issue.issueId}/decision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(decision.status, 200);

    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    const approved = await emitCommand(origin, sock.sid, 'command:approve', {
      commandId: 'issue-approve-1',
      operationId: 'issue-operation-1',
      composerId: 'c-read',
      windowId: 'win-1',
      actionId: action.actionId,
      issueId: issue.issueId,
      contentDigest: issue.contentDigest,
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: issue.controlVersion,
    }, { Cookie: cookie, Origin: origin });
    assert.equal(approved.ok, true);
    assert.equal(dispatches, 1);

    const replay = await emitCommand(origin, sock.sid, 'command:approve', {
      commandId: 'issue-approve-2',
      operationId: 'issue-operation-2',
      composerId: 'c-read',
      windowId: 'win-1',
      actionId: action.actionId,
      issueId: issue.issueId,
      contentDigest: issue.contentDigest,
      planVersion: 'plan-1',
      authorizationVersion: 'auth-1',
      controlVersion: issue.controlVersion,
    }, { Cookie: cookie, Origin: origin });
    assert.equal(replay.ok, false);
    assert.equal(dispatches, 1);
  });

  it('keeps a restarted grant pending until owner recovery prerequisites are checked', async () => {
    const first = makeRelay();
    await first.relay.start();
    const firstOrigin = `http://127.0.0.1:${first.relay.port}`;
    const owner = await login(firstOrigin);
    const created = await createGrant(firstOrigin, owner.token);
    const grantId = (created.json.grant as { grantId: string }).grantId;
    const redeemed = await redeem(firstOrigin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';
    await first.relay.stop();

    const restarted = makeRelay();
    await restarted.relay.start();
    const origin = `http://127.0.0.1:${restarted.relay.port}`;
    const before = await fetch(`${origin}/api/supervision/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as { grant: { status: string } }).grant.status, 'pending_recovery');
    const supervisorBefore = await fetch(`${origin}/health`, {
      headers: { Authorization: `Bearer ${supervisorToken}` },
    });
    assert.equal(((await supervisorBefore.json()) as { sessionValid?: boolean }).sessionValid, false);

    const resume = await fetch(`${origin}/api/supervision/grants/${grantId}/resume-recovery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(resume.status, 200);
    assert.equal(((await resume.json()) as { grant: { status: string } }).grant.status, 'active');
    const supervisorAfter = await fetch(`${origin}/health`, {
      headers: { Authorization: `Bearer ${supervisorToken}` },
    });
    assert.equal(((await supervisorAfter.json()) as { sessionValid?: boolean }).sessionValid, true);
  });

  it('disconnects supervisor sockets on revoke and rejects the token immediately', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    const grantId = (created.json.grant as { grantId: string }).grantId;
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';
    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    assert.ok(sock.sid);

    const revoke = await fetch(`${origin}/api/supervision/grants/${grantId}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(revoke.status, 200);

    const poll = await fetch(pollingUrl(origin, sock.sid), {
      headers: { Cookie: cookie, Origin: origin },
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    const pollStatus = poll?.status ?? 0;
    const pollText = poll ? await poll.text().catch(() => '') : '';
    assert.ok(
      pollStatus !== 200 || pollText.includes('41'),
      `expected supervisor socket to drop, got ${pollStatus} ${pollText.slice(0, 80)}`,
    );

    const health = await fetch(`${origin}/health`, { headers: { Cookie: cookie } });
    const body = (await health.json()) as Record<string, unknown>;
    assert.equal(body.sessionValid, false);
    assert.equal('windows' in body, false);

    const caps = await fetch(`${origin}/api/capabilities`, {
      headers: { Authorization: `Bearer ${supervisorToken}` },
    });
    assert.equal(caps.status, 401);
  });

  it('lets only the owner explicitly resume supervision after a human takeover', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const owner = await login(origin);
    const created = await createGrant(origin, owner.token);
    const grantId = (created.json.grant as { grantId: string }).grantId;
    const ownerSocket = await connectSocket(origin, { token: owner.token });

    const takeover = await emitCommand(origin, ownerSocket.sid, 'command:send_message', {
      commandId: 'owner-takeover',
      operationId: 'owner-takeover-operation',
      text: 'human action',
    });
    assert.equal(takeover.ok, true);

    const pausedResponse = await fetch(`${origin}/api/supervision/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const paused = ((await pausedResponse.json()) as {
      grant: { pauseReasons: string[]; controlVersion: string };
    }).grant;
    assert.equal(paused.pauseReasons.includes('human_takeover'), true);

    const resumedResponse = await fetch(`${origin}/api/supervision/grants/${grantId}/resume-supervision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = ((await resumedResponse.json()) as {
      grant: { pauseReasons: string[]; controlVersion: string };
    }).grant;
    assert.equal(resumed.pauseReasons.includes('human_takeover'), false);
    assert.notEqual(resumed.controlVersion, paused.controlVersion);

    const secondResume = await fetch(`${origin}/api/supervision/grants/${grantId}/resume-supervision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(secondResume.status, 409);
  });

  it('pauses active grants on human takeover when workspace observation is stale', async () => {
    const { relay, sm } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const owner = await login(origin);
    const created = await createGrant(origin, owner.token);
    const grantId = (created.json.grant as { grantId: string }).grantId;
    sm.getCurrentState().lastExtractionAt = Date.now() - 20_000;
    const ownerSocket = await connectSocket(origin, { token: owner.token });

    const takeover = await emitCommand(origin, ownerSocket.sid, 'command:send_message', {
      commandId: 'owner-stale-takeover',
      operationId: 'owner-stale-takeover-operation',
      text: 'human action while identity is stale',
    });
    assert.equal(takeover.ok, true);

    const pausedResponse = await fetch(`${origin}/api/supervision/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const paused = ((await pausedResponse.json()) as { grant: { pauseReasons: string[] } }).grant;
    assert.equal(paused.pauseReasons.includes('human_takeover'), true);
  });

  it('keeps owner HTTP and socket behavior, including no-auth localhost grant/redeem', async () => {
    const { relay, sm } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);

    const health = await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${token}` } });
    const healthBody = (await health.json()) as Record<string, unknown>;
    assert.equal(healthBody.sessionValid, true);
    assert.ok(Array.isArray(healthBody.windows));
    assert.equal('lastExtractionError' in healthBody, true);
    assert.equal(healthBody.activeComposerId, 'c-read');

    const caps = await fetch(`${origin}/api/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(caps.status, 200);
    const debug = await fetch(`${origin}/debug/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(debug.status, 200);

    const sock = await connectSocket(origin, { token });
    const full = sock.events.find(([name]) => name === 'state:full')?.[1] as CursorState;
    assert.equal(full.chatTabs.length, 2);
    assert.equal(full.windows[0].url, 'file:///Users/secret/project');
    sm.onExtraction(sampleState({ agentStatus: 'thinking' }));
    const patches = await collectNamed(origin, sock.sid, 'state:patch');
    assert.ok(patches.length >= 1);

    const sent = await emitCommand(origin, sock.sid, 'command:get_model_options', { commandId: 'owner-opts' });
    assert.equal(sent.ok, true);
    assert.equal(executorCalls.some((c) => c.method === 'getModelOptions'), true);

    const { relay: openRelay } = makeRelay({ config: { webappPassword: '' } });
    await openRelay.start();
    const openOrigin = `http://127.0.0.1:${openRelay.port}`;
    const created = await createGrant(openOrigin, 'no-auth');
    assert.equal(created.status, 200);
    const redeemed = await redeem(openOrigin, created.json.redeemCode as string);
    assert.equal(redeemed.status, 200);
    const openHealth = await fetch(`${openOrigin}/health`);
    const openBody = (await openHealth.json()) as Record<string, unknown>;
    assert.equal(openBody.authRequired, false);
    assert.ok(Array.isArray(openBody.windows));
  });

  it('empties supervisor state when the observed workspace switches away and strips raw extraction errors', async () => {
    const { relay, sm } = makeRelay();
    sm.onExtractionFailure('file:///secret boom');
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';

    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    const matched = sock.events.find(([name]) => name === 'state:full')?.[1] as CursorState;
    assert.equal(matched.lastExtractionError, null);
    assert.doesNotMatch(JSON.stringify(matched), /file:\/\/\/secret/);

    sm.onExtraction(sampleState({ agentStatus: 'thinking', agentActivityText: 'secret activity', _workspaceIdentity: OTHER_WS }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const updates = await collectNamed(origin, sock.sid, 'state:full', 1500, { Cookie: cookie, Origin: origin });
    assert.ok(updates.length >= 1);
    const next = updates[0][1] as CursorState;
    assert.deepEqual(next.chatTabs, []);
    assert.deepEqual(next.windows, []);
    assert.deepEqual(next.messages, []);
    assert.deepEqual(next.pendingApprovals, []);
    assert.deepEqual(next.composerQueue.items, []);
    assert.equal(next.questionnaire, null);
    assert.equal(next.activeComposerId, '');
    assert.equal(next.activeWindowId, '');
    assert.equal(next.lastExtractionError, null);
    assert.equal(next.connected, false);
    assert.equal(next.agentStatus, 'idle');
    assert.equal(next.agentActivityText, null);
    assert.equal(next.agentActivityLive, false);
    assert.equal(next.inputAvailable, false);
    assert.deepEqual(next.mode, { current: '', available: [] });
    assert.deepEqual(next.model, { current: '', currentId: '' });
    const raw = JSON.stringify(next);
    assert.doesNotMatch(raw, /file:\/\/\/secret/);
    assertNoSecretLeak(raw, [supervisorToken]);
  });

  it('treats an explicit supervisor token as supervisor even without a webapp password', async () => {
    const { relay } = makeRelay({ config: { webappPassword: '' } });
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const created = await createGrant(origin, 'no-auth');
    assert.equal(created.status, 200);
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    assert.equal(redeemed.status, 200);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';

    const debug = await fetch(`${origin}/debug/state`, { headers: { Cookie: cookie } });
    assert.equal(debug.status, 403);
    const caps = await fetch(`${origin}/api/capabilities`, { headers: { Authorization: `Bearer ${supervisorToken}` } });
    assert.equal(caps.status, 403);
    const adapters = await fetch(`${origin}/api/adapters/history`, { headers: { Cookie: cookie } });
    assert.equal(adapters.status, 403);
    const grantAgain = await fetch(`${origin}/api/supervision/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'nope',
        planVersion: 'p',
        authorizationVersion: 'a',
        expiresAt: Date.now() + 10_000,
        readComposerIds: ['c-read'],
        writeComposerIds: ['c-read'],
      }),
    });
    assert.equal(grantAgain.status, 403);

    const sock = await connectSocket(origin, { token: supervisorToken, cookie });
    const write = await emitCommand(origin, sock.sid, 'command:send_message', {
      commandId: 'noauth-send',
      text: 'hi',
      operationId: 'op-noauth-01',
    }, { Cookie: cookie, Origin: origin });
    assert.equal(write.ok, false);
    assert.equal(write.error, 'Supervision write scope is incomplete');
    assert.equal(executorCalls.some((c) => c.method === 'sendMessage'), false);

    const bogusHealth = await fetch(`${origin}/health`, { headers: { Cookie: `${WEBAPP_SESSION_COOKIE}=deadbeef` } });
    const bogusBody = (await bogusHealth.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(bogusBody.windows));
  });

  it('does not emit adapter:pending to supervisor sockets', async () => {
    const { relay } = makeRelay();
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const { token } = await login(origin);
    const created = await createGrant(origin, token);
    const redeemed = await redeem(origin, created.json.redeemCode as string);
    const cookie = cookieHeader(redeemed);
    const supervisorToken = cookie
      .split('; ')
      .find((part) => part.startsWith(`${WEBAPP_SESSION_COOKIE}=`))
      ?.slice(`${WEBAPP_SESSION_COOKIE}=`.length) ?? '';

    const ownerSock = await connectSocket(origin, { token });
    const supSock = await connectSocket(origin, { token: supervisorToken, cookie });
    relay.notifyAdapterPending({
      id: 'adapter-1',
      status: 'pending_confirmation',
      capabilityKinds: ['mode'],
      createdAt: 1,
    });
    const ownerEvents = await collectNamed(origin, ownerSock.sid, 'adapter:pending', 1500);
    const supEvents = await collectNamed(origin, supSock.sid, 'adapter:pending', 400, { Cookie: cookie, Origin: origin });
    assert.ok(ownerEvents.length >= 1);
    assert.equal(supEvents.length, 0);
  });
});