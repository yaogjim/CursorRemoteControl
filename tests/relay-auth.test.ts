import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, networkInterfaces } from 'os';
import { Relay, isLoopbackBindHost, isLoopbackRemoteAddress, isAllowedSocketOrigin, isAllowedHttpOrigin, CSRF_COOKIE, SENSITIVE_PROBE_RATE_MAX, sensitiveWriteKind, API_JSON_LIMIT_BYTES } from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import { CDPBridge } from '../src/server/cdp-bridge.js';
import { CapabilityStateManager } from '../src/server/capability-state-manager.js';
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

  it('classifies only discovery and adapter POSTs as sensitive writes', () => {
    assert.equal(sensitiveWriteKind('POST', '/api/discovery/run'), 'probe');
    assert.equal(sensitiveWriteKind('POST', '/api/adapters/abc/validate'), 'probe');
    assert.equal(sensitiveWriteKind('POST', '/api/adapters/abc/apply'), 'adapter');
    assert.equal(sensitiveWriteKind('POST', '/api/adapters/abc/reject'), 'adapter');
    assert.equal(sensitiveWriteKind('POST', '/api/adapters/rollback'), 'adapter');
    assert.equal(sensitiveWriteKind('POST', '/api/login'), null);
    assert.equal(sensitiveWriteKind('GET', '/api/discovery/run'), null);
    assert.equal(sensitiveWriteKind('POST', '/api/capabilities'), null);
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

  it('allows same-origin HTTP writes and rejects foreign origins', () => {
    assert.equal(isAllowedHttpOrigin(undefined, '127.0.0.1:3000'), true);
    assert.equal(isAllowedHttpOrigin('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
    assert.equal(isAllowedHttpOrigin('https://evil.example', '127.0.0.1:3000'), false);
  });

  it('rejects a foreign Origin on the login write endpoint', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(res.status, 403);
  });

  it('protects the capabilities endpoint with the HTTP session', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const denied = await fetch(`http://127.0.0.1:${relay.port}/api/capabilities`);
    assert.equal(denied.status, 401);

    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const allowed = await fetch(`http://127.0.0.1:${relay.port}/api/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { snapshots: unknown[] };
    assert.deepEqual(body.snapshots, []);
  });

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

  it('serves GET /api/discovery/status without a password on localhost', async () => {
    const relay = makeRelay({ webappPassword: '' });
    await relay.start();
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discovery/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.status, 'string');
    assert.ok(body.endpoint && typeof body.endpoint === 'object');
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /webSocketDebuggerUrl/);
    assert.doesNotMatch(raw, /ws:\/\//);
  });

  it('rejects unauthenticated GET /api/discovery/status when a password is set', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discovery/status`);
    assert.equal(res.status, 401);
  });

  it('returns sanitized discovery status with a Bearer token', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/discovery/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      endpoint: { verified: boolean; browserFamily: string };
      windowCount: number;
    };
    assert.equal(body.status, 'idle');
    assert.equal(body.endpoint.verified, false);
    assert.equal(typeof body.windowCount, 'number');
  });

  it('does not expose a script-eval or discovery-run write API', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Operation-Id': 'op-discovery-script-1',
    };
    const run = await fetch(`http://127.0.0.1:${relay.port}/api/discovery/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ script: 'alert(1)', selector: 'body' }),
    });
    assert.equal(run.status, 503);
    const evalRes = await fetch(`http://127.0.0.1:${relay.port}/api/eval`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expression: '1+1' }),
    });
    assert.notEqual(evalRes.status, 200);
  });

  it('issues an authenticated CSRF token for cookie writes', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const denied = await fetch(`http://127.0.0.1:${relay.port}/api/csrf`);
    assert.equal(denied.status, 401);

    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    const cookie = setCookies.map((part) => part.split(';')[0]).join('; ');
    const csrfRes = await fetch(`http://127.0.0.1:${relay.port}/api/csrf`, {
      headers: { Authorization: `Bearer ${token}`, Cookie: cookie },
    });
    assert.equal(csrfRes.status, 200);
    const csrfBody = (await csrfRes.json()) as { csrfToken: string };
    assert.equal(typeof csrfBody.csrfToken, 'string');
    assert.ok(csrfBody.csrfToken.length >= 24);
    assert.match(cookie, new RegExp(`${CSRF_COOKIE}=`));

    const origin = `http://127.0.0.1:${relay.port}`;
    const missing = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
      },
      body: '{}',
    });
    assert.equal(missing.status, 403);
    assert.equal(((await missing.json()) as { error: string }).error, 'CSRF token required');

    const withCsrf = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
        'X-CSRF-Token': csrfBody.csrfToken,
        'X-Operation-Id': 'op-test-discovery-1',
      },
      body: '{}',
    });
    assert.equal(withCsrf.status, 503);
  });

  it('rejects cookie writes without Origin and allows Bearer CLI calls without Origin or CSRF', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    const cookie = setCookies.map((part) => part.split(';')[0]).join('; ');
    const csrf = setCookies
      .map((part) => part.split(';')[0])
      .find((part) => part.startsWith(`${CSRF_COOKIE}=`))
      ?.slice(`${CSRF_COOKIE}=`.length) ?? '';

    const cookieNoOrigin = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'X-Operation-Id': 'op-cookie-no-origin-1',
      },
      body: '{}',
    });
    assert.equal(cookieNoOrigin.status, 403);
    assert.equal(((await cookieNoOrigin.json()) as { error: string }).error, 'Forbidden origin');

    const bearer = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Operation-Id': 'op-bearer-no-origin-1',
      },
      body: '{}',
    });
    assert.equal(bearer.status, 503);

    const foreign = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Operation-Id': 'op-bearer-foreign-origin-1',
      },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
  });

  it('requires a bounded X-Operation-Id before executing sensitive POSTs', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    let runs = 0;
    relay.setDiscoveryRunner(async () => {
      runs += 1;
      return { ok: true };
    });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const url = `http://127.0.0.1:${relay.port}/api/discovery/run`;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const missing = await fetch(url, { method: 'POST', headers: authHeaders, body: '{}' });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /X-Operation-Id header required/);

    const invalid = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Operation-Id': 'bad' },
      body: '{}',
    });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /Invalid operation id/);

    const loginNoOp = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(loginNoOp.status, 200);
    assert.equal(runs, 0);
  });

  it('replays concurrent duplicate operation ids once and rejects mismatched fingerprints', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    relay.setDiscoveryRunner(async () => {
      runs += 1;
      await gate;
      return { seq: runs };
    });
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const url = `http://127.0.0.1:${relay.port}/api/discovery/run`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Operation-Id': 'op-concurrent-auth-1',
    };
    const first = fetch(url, { method: 'POST', headers, body: JSON.stringify({ n: 1 }) });
    const second = fetch(url, { method: 'POST', headers, body: JSON.stringify({ n: 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conflict = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'X-Operation-Id': 'op-concurrent-auth-1' },
      body: JSON.stringify({ n: 2 }),
    });
    assert.equal(conflict.status, 409);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(runs, 1);
    assert.deepEqual(await a.json(), await b.json());
  });

  it('rate-limits discovery probes and returns Retry-After', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    relay.setDiscoveryRunner(async () => ({ ok: true }));
    await relay.start();
    const login = await fetch(`http://127.0.0.1:${relay.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const url = `http://127.0.0.1:${relay.port}/api/discovery/run`;
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < SENSITIVE_PROBE_RATE_MAX + 1; i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Operation-Id': `op-rate-limit-${String(i).padStart(2, '0')}`,
        },
        body: '{}',
      });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }
    assert.deepEqual(statuses.slice(0, SENSITIVE_PROBE_RATE_MAX), Array(SENSITIVE_PROBE_RATE_MAX).fill(200));
    assert.equal(limited?.status, 429);
    const retryAfter = Number(limited?.headers.get('retry-after'));
    assert.equal(Number.isInteger(retryAfter) && retryAfter >= 1, true);
    assert.match(((await limited!.json()) as { error: string }).error, /Too many requests/);
  });

  it('returns structured JSON 400/413 for malformed and oversize bodies', async () => {
    const relay = makeRelay({ webappPassword: 'secret' });
    await relay.start();
    const origin = `http://127.0.0.1:${relay.port}`;

    const malformedLogin = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password":',
    });
    assert.equal(malformedLogin.status, 400);
    assert.match(malformedLogin.headers.get('content-type') ?? '', /json/i);
    assert.equal(((await malformedLogin.json()) as { error: string }).error, 'Invalid JSON');

    const oversizeLogin = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"password":"${'a'.repeat(API_JSON_LIMIT_BYTES)}}`,
    });
    assert.equal(oversizeLogin.status, 413);
    assert.match(oversizeLogin.headers.get('content-type') ?? '', /json/i);
    assert.equal(((await oversizeLogin.json()) as { error: string }).error, 'Payload too large');

    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const { token } = (await login.json()) as { token: string };
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Operation-Id': 'op-body-limit-1',
    };

    const malformedApi = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: authHeaders,
      body: '{not-json',
    });
    assert.equal(malformedApi.status, 400);
    assert.match(malformedApi.headers.get('content-type') ?? '', /json/i);
    assert.equal(((await malformedApi.json()) as { error: string }).error, 'Invalid JSON');

    const oversizeApi = await fetch(`${origin}/api/discovery/run`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Operation-Id': 'op-body-limit-2' },
      body: `{"n":"${'b'.repeat(API_JSON_LIMIT_BYTES)}}`,
    });
    assert.equal(oversizeApi.status, 413);
    assert.match(oversizeApi.headers.get('content-type') ?? '', /json/i);
    assert.equal(((await oversizeApi.json()) as { error: string }).error, 'Payload too large');
  });

  it('returns current snapshot status diff fields instead of a null-baseline empty diff', async () => {
    const caps = new CapabilityStateManager();
    caps.setActiveTarget('target-diff', 2);
    caps.applyObserved({
      targetId: 'target-diff',
      targetGeneration: 2,
      modes: [
        { id: 'agent', label: 'Agent', current: true, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true, observedAt: 1 },
        { id: 'plan', label: 'Plan', current: false, source: 'data_attribute', confidence: 1, scope: 'composer', selectable: true, observedAt: 1 },
      ],
      models: {
        items: [{ id: 'auto', label: 'Auto', selected: true, scope: 'composer', idStability: 'stable', source: 'menu', confidence: 1, selectable: true, observedAt: 1 }],
        completeness: 'complete',
        filterActive: false,
        observedAt: 1,
      },
      state: 'ok',
    });
    const config = baseConfig(dir);
    const relay = new Relay(
      config,
      new StateManager(0),
      {} as CommandExecutor,
      new CDPBridge(config),
      undefined,
      caps,
    );
    relays.push(relay);
    await relay.start();

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/capabilities/diff`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      targetId: string;
      added: string[];
      removed: string[];
      changed: string[];
      conflicts: string[];
      completeness: string;
    };
    assert.equal(body.targetId, 'target-diff');
    assert.ok(body.added.includes('mode:agent'));
    assert.ok(body.added.includes('mode:plan'));
    assert.ok(body.added.includes('model:auto'));
    assert.deepEqual(body.removed, []);
    assert.equal(body.completeness, 'complete');
  });
});
