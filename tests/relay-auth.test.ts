import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, networkInterfaces } from 'os';
import { Relay, isLoopbackBindHost, isLoopbackRemoteAddress, isAllowedSocketOrigin } from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import { CDPBridge } from '../src/server/cdp-bridge.js';
import type { CursorState, ServerConfig } from '../src/server/types.js';
import { WEBAPP_SESSION_COOKIE } from '../src/server/webapp-sessions.js';

function baseConfig(dir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' },
    ...overrides,
  };
}

function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      const family = String(a.family);
      if ((family === 'IPv4' || family === '4') && !a.internal) return a.address;
    }
  }
  return undefined;
}

describe('loopback / CORS helpers', () => {
  it('treats localhost variants as loopback bind hosts', () => {
    assert.equal(isLoopbackBindHost('127.0.0.1'), true);
    assert.equal(isLoopbackBindHost('localhost'), true);
    assert.equal(isLoopbackBindHost('::1'), true);
    assert.equal(isLoopbackBindHost('0.0.0.0'), false);
    assert.equal(isLoopbackBindHost('::'), false);
    assert.equal(isLoopbackBindHost('192.168.1.10'), false);
  });

  it('recognizes IPv4-mapped loopback peers', () => {
    assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
    assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackRemoteAddress('::1'), true);
    assert.equal(isLoopbackRemoteAddress('192.168.1.10'), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
  });

  it('allows same-origin socket Origins and missing Origin', () => {
    assert.equal(isAllowedSocketOrigin(undefined, '127.0.0.1:3000'), true);
    assert.equal(isAllowedSocketOrigin('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
    assert.equal(isAllowedSocketOrigin('http://192.168.1.5:3000', '192.168.1.5:3000'), true);
    assert.equal(isAllowedSocketOrigin('https://evil.example', '127.0.0.1:3000'), false);
    assert.equal(isAllowedSocketOrigin('http://127.0.0.1:3000', '192.168.1.5:3000'), false);
    assert.equal(isAllowedSocketOrigin('file://host', '127.0.0.1:3000'), false);
  });
});

describe('Relay auth / health', () => {
  let dir: string;
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    relays.length = 0;
  });

  afterEach(async () => {
    for (const r of relays) {
      try {
        await r.stop();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRelay(overrides: Partial<ServerConfig> = {}): Relay {
    const config = baseConfig(dir, overrides);
    const relay = new Relay(
      config,
      new StateManager(0),
      {} as CommandExecutor,
      new CDPBridge(config)
    );
    relays.push(relay);
    return relay;
  }

  it('allows localhost start without a password', async () => {
    const relay = makeRelay({ serverHost: '127.0.0.1', webappPassword: '' });
    await relay.start();
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    assert.equal(res.ok, true);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, false);
    assert.equal(body.sessionValid, true);
    assert.equal(typeof body.connected, 'boolean');
    assert.equal(typeof body.uptime, 'number');
  });

  it('refuses non-loopback bind without a password', async () => {
    const relay = makeRelay({ serverHost: '0.0.0.0', webappPassword: '' });
    await assert.rejects(
      () => relay.start(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /without a web app password/i);
        assert.match(err.message, /0\.0\.0\.0/);
        return true;
      }
    );
  });

  it('refuses a LAN IP bind without a password', async () => {
    const relay = makeRelay({ serverHost: '192.168.1.50', webappPassword: '' });
    await assert.rejects(() => relay.start(), /without a web app password/i);
  });

  it('starts on 0.0.0.0 when a password is set', async () => {
    const relay = makeRelay({ serverHost: '0.0.0.0', webappPassword: 'secret' });
    await relay.start();
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    assert.equal(res.ok, true);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true);
    // Loopback observer (extension) still receives details without a session.
    assert.equal(typeof body.connected, 'boolean');
    assert.equal(typeof body.agentStatus, 'string');
  });

  it('hides health details from unauthenticated LAN peers', async () => {
    const lan = firstLanIPv4();
    if (!lan) {
      console.log('[relay-auth] skip LAN health test — no non-internal IPv4');
      return;
    }
    const relay = makeRelay({ serverHost: '0.0.0.0', webappPassword: 'secret' });
    await relay.start();
    const res = await fetch(`http://${lan}:${relay.port}/health`);
    assert.equal(res.ok, true);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true);
    assert.equal(body.sessionValid, false);
    assert.equal('connected' in body, false);
    assert.equal('windows' in body, false);
    assert.equal('lastExtractionError' in body, false);
    assert.equal('agentStatus' in body, false);
  });

  it('returns full health after login', async () => {
    const relay = makeRelay({ serverHost: '127.0.0.1', webappPassword: 'secret' });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(login.ok, true);
    const { token } = (await login.json()) as { token: string };
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64);

    const res = await fetch(`http://127.0.0.1:${relay.port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.sessionValid, true);
    assert.equal(typeof body.connected, 'boolean');
    assert.equal(typeof body.generation, 'number');
  });

  it('sets an HttpOnly session cookie on login', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, new RegExp(`${WEBAPP_SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  it('rejects Socket.IO handshake from a foreign Origin', async () => {
    const relay = makeRelay({ webappPassword: '' });
    await relay.start();
    const res = await fetch(
      `http://127.0.0.1:${relay.port}/socket.io/?EIO=4&transport=polling`,
      { headers: { Origin: 'https://evil.example' } }
    );
    assert.notEqual(res.status, 200);
  });

  it('accepts same-origin Socket.IO handshake', async () => {
    const relay = makeRelay({ webappPassword: '' });
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const res = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: origin },
    });
    assert.equal(res.status, 200);
  });

  it('exposes _rawSignals on /debug/state', async () => {
    const sm = new StateManager(0);
    const seeded: CursorState = {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      _rawSignals: {
        shimmer: [],
        loadingIndicator: false,
        elements: [],
        orphanIndicators: [],
      },
    };
    sm.onConnectionChanged(true);
    sm.onExtraction(seeded);

    const config = baseConfig(dir);
    const relay = new Relay(
      config,
      sm,
      {} as CommandExecutor,
      new CDPBridge(config)
    );
    relays.push(relay);
    await relay.start();

    const res = await fetch(`http://127.0.0.1:${relay.port}/debug/state`);
    assert.equal(res.ok, true);
    const body = (await res.json()) as { _rawSignals: { loadingIndicator: boolean } | null };
    assert.ok(body._rawSignals);
    assert.equal(body._rawSignals.loadingIndicator, false);

    const health = await fetch(`http://127.0.0.1:${relay.port}/health`);
    const healthBody = (await health.json()) as { lastExtractionAt: number | null };
    assert.equal(typeof healthBody.lastExtractionAt, 'number');
  });
});