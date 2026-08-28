import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, networkInterfaces } from 'os';
import {
  formatHostForUrl,
  HealthProbeClient,
  healthProbeUrls,
  isDetailedHealth,
  isPublicHealth,
  localHealthProbeHosts,
  localHealthProbeUrls,
  loginUrlFromHealth,
  probeUrlLooksLoopback,
} from '../extension/src/health-probe.js';
import { Relay } from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import { CDPBridge } from '../src/server/cdp-bridge.js';
import type { ServerConfig } from '../src/server/types.js';

describe('localHealthProbeHosts', () => {
  it('maps 0.0.0.0 and IPv4 loopback to 127.0.0.1 first', () => {
    assert.deepEqual(localHealthProbeHosts('0.0.0.0'), ['127.0.0.1', '::1']);
    assert.deepEqual(localHealthProbeHosts('127.0.0.1'), ['127.0.0.1', '::1']);
    assert.deepEqual(localHealthProbeHosts('localhost'), ['127.0.0.1', '::1']);
  });

  it('maps IPv6 wildcard and loopback to ::1 first', () => {
    assert.deepEqual(localHealthProbeHosts('::'), ['::1', '127.0.0.1']);
    assert.deepEqual(localHealthProbeHosts('::1'), ['::1', '127.0.0.1']);
    assert.deepEqual(localHealthProbeHosts('[::]'), ['::1', '127.0.0.1']);
  });
});

describe('healthProbeUrls', () => {
  it('keeps 0.0.0.0 behavior as IPv4 loopback /health and does not use the wildcard', () => {
    const urls = healthProbeUrls('0.0.0.0', 3000);
    assert.equal(urls[0], 'http://127.0.0.1:3000/health');
    assert.equal(urls.some((u) => u.includes('0.0.0.0')), false);
  });

  it('brackets IPv6 probe hosts', () => {
    assert.equal(formatHostForUrl('::1'), '[::1]');
    assert.equal(healthProbeUrls('::', 3000)[0], 'http://[::1]:3000/health');
    assert.equal(healthProbeUrls('::1', 3000)[0], 'http://[::1]:3000/health');
  });

  it('prefers loopback then appends a concrete LAN bind host', () => {
    const urls = healthProbeUrls('192.168.1.50', 3000);
    assert.equal(urls[0], 'http://127.0.0.1:3000/health');
    assert.ok(urls.includes('http://192.168.1.50:3000/health'));
    assert.ok(
      urls.indexOf('http://127.0.0.1:3000/health') <
        urls.indexOf('http://192.168.1.50:3000/health')
    );
  });

  it('brackets a concrete IPv6 bind host after loopback', () => {
    const urls = healthProbeUrls('fd7a:115c:a1e0::1', 3000);
    assert.equal(urls[0], 'http://[::1]:3000/health');
    assert.ok(urls.includes('http://[fd7a:115c:a1e0::1]:3000/health'));
  });

  it('loopback-only helper still omits LAN (used as the prefix)', () => {
    const urls = localHealthProbeUrls('192.168.1.50', 3000);
    assert.equal(urls.some((u) => u.includes('192.168.1.50')), false);
  });
});

describe('health URL helpers', () => {
  it('derives /api/login from /health without putting secrets in the path', () => {
    assert.equal(
      loginUrlFromHealth('http://192.168.1.50:3000/health'),
      'http://192.168.1.50:3000/api/login'
    );
    assert.equal(probeUrlLooksLoopback('http://127.0.0.1:3000/health'), true);
    assert.equal(probeUrlLooksLoopback('http://192.168.1.50:3000/health'), false);
  });

  it('classifies public vs detailed health bodies', () => {
    assert.equal(isPublicHealth({ ok: true, authRequired: true, sessionValid: false }), true);
    assert.equal(isDetailedHealth({ ok: true, authRequired: true, sessionValid: false }), false);
    assert.equal(isDetailedHealth({ ok: true, connected: true }), true);
    assert.equal(isPublicHealth({ ok: true, connected: false }), false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PUBLIC_BODY = { ok: true, authRequired: true, sessionValid: false };
const DETAILED_BODY = {
  ok: true,
  authRequired: true,
  sessionValid: true,
  connected: true,
  agentStatus: 'idle',
};

describe('HealthProbeClient', () => {
  it('does not treat a public LAN body as detailed health', async () => {
    const client = new HealthProbeClient({
      password: '',
      fetch: async () => jsonResponse(PUBLIC_BODY),
    });
    const result = await client.probe(['http://192.168.1.5:3000/health'], 1000);
    assert.ok(result);
    assert.equal(result.detailed, false);
    assert.equal(isDetailedHealth(result.body), false);
    assert.equal('connected' in result.body, false);
  });

  it('logs in with POST body (not URL) and retries /health with Bearer', async () => {
    const calls: Array<{ url: string; auth?: string; method?: string; body?: string }> = [];
    const token = 'a'.repeat(64);
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? init.body : undefined;
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({ url, auth: headers?.Authorization, method: init?.method, body });
        if (url.endsWith('/api/login')) {
          assert.ok(!url.includes('s3cret'), 'password must not appear in the login URL');
          return jsonResponse({ token });
        }
        if (headers?.Authorization === `Bearer ${token}`) {
          return jsonResponse(DETAILED_BODY);
        }
        return jsonResponse(PUBLIC_BODY);
      },
    });
    const result = await client.probe(['http://192.168.1.5:3000/health'], 1000);
    assert.ok(result?.detailed);
    assert.equal((result.body as { connected: boolean }).connected, true);
    assert.equal(client.getToken(), token);
    assert.equal(calls.some((c) => c.url.endsWith('/api/login') && c.method === 'POST'), true);
    const login = calls.find((c) => c.url.endsWith('/api/login'))!;
    assert.equal(JSON.parse(login.body ?? '{}').password, 's3cret');
    assert.ok(!login.url.includes('s3cret'));
  });

  it('caches the session token and does not log in on the next probe', async () => {
    let logins = 0;
    const token = 'b'.repeat(64);
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input, init) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        if (url.endsWith('/api/login')) {
          logins++;
          return jsonResponse({ token });
        }
        if (headers?.Authorization === `Bearer ${token}`) return jsonResponse(DETAILED_BODY);
        return jsonResponse(PUBLIC_BODY);
      },
    });
    assert.equal((await client.probe(['http://10.0.0.2:3000/health'], 1000))?.detailed, true);
    assert.equal((await client.probe(['http://10.0.0.2:3000/health'], 1000))?.detailed, true);
    assert.equal(logins, 1);
  });

  it('clears the token on 401 and reconnects with a fresh login', async () => {
    let logins = 0;
    let authedGets = 0;
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input, init) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        if (url.endsWith('/api/login')) {
          logins++;
          return jsonResponse({ token: `tok${logins}`.padEnd(64, '0') });
        }
        if (headers?.Authorization?.startsWith('Bearer ')) {
          authedGets++;
          if (authedGets === 2) return new Response('', { status: 401 });
          return jsonResponse(DETAILED_BODY);
        }
        return jsonResponse(PUBLIC_BODY);
      },
    });
    assert.equal((await client.probe(['http://10.0.0.2:3000/health'], 1000))?.detailed, true);
    const first = client.getToken();
    assert.equal((await client.probe(['http://10.0.0.2:3000/health'], 1000))?.detailed, true);
    assert.notEqual(client.getToken(), first);
    assert.equal(logins, 2);
  });

  it('clears the token on connection failure', async () => {
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/login')) return jsonResponse({ token: 'c'.repeat(64) });
        if (url.includes('192.168.1.5')) return jsonResponse(PUBLIC_BODY);
        throw new TypeError('fetch failed');
      },
    });
    await client.probe(['http://192.168.1.5:3000/health'], 1000);
    assert.ok(client.getToken());
    const missed = await client.probe(['http://127.0.0.1:9/health'], 1000);
    assert.equal(missed, null);
    assert.equal(client.getToken(), null);
  });

  it('clears the token when the password changes or login fails', async () => {
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/login')) return jsonResponse({ error: 'Invalid password' }, 401);
        return jsonResponse(PUBLIC_BODY);
      },
    });
    (client as unknown as { token: string }).token = 'stale'.padEnd(64, '0');
    client.setPassword('wrong');
    assert.equal(client.getToken(), null);
    const result = await client.probe(['http://192.168.1.5:3000/health'], 1000);
    assert.equal(result?.detailed, false);
    assert.equal(client.getToken(), null);
  });

  it('uses loopback detailed health without logging in', async () => {
    let logins = 0;
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/login')) {
          logins++;
          return jsonResponse({ token: 'd'.repeat(64) });
        }
        if (url.includes('127.0.0.1')) return jsonResponse(DETAILED_BODY);
        throw new TypeError('fetch failed');
      },
    });
    const result = await client.probe(
      ['http://127.0.0.1:3000/health', 'http://192.168.1.5:3000/health'],
      1000
    );
    assert.equal(result?.detailed, true);
    assert.equal(result?.url, 'http://127.0.0.1:3000/health');
    assert.equal(logins, 0);
  });

  it('falls through to the bind host when loopback fails and authenticates', async () => {
    const token = 'e'.repeat(64);
    const client = new HealthProbeClient({
      password: 's3cret',
      fetch: async (input, init) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        if (url.includes('127.0.0.1') || url.includes('[::1]')) throw new TypeError('fetch failed');
        if (url.endsWith('/api/login')) return jsonResponse({ token });
        if (headers?.Authorization === `Bearer ${token}`) return jsonResponse(DETAILED_BODY);
        return jsonResponse(PUBLIC_BODY);
      },
    });
    const result = await client.probe(healthProbeUrls('192.168.1.50', 3000), 1000);
    assert.equal(result?.detailed, true);
    assert.equal(result?.url, 'http://192.168.1.50:3000/health');
  });
});

function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      const family = String(a.family);
      if ((family === 'IPv4' || family === '4') && !a.internal) return a.address;
    }
  }
  return undefined;
}

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

describe('HealthProbeClient against Relay on a concrete LAN bind', () => {
  let dir: string;
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-probe-lan-'));
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

  it('gets connected via Bearer after public LAN /health', async () => {
    const lan = firstLanIPv4();
    if (!lan) {
      console.log('[health-probe] skip LAN bind test — no non-internal IPv4');
      return;
    }
    const config = baseConfig(dir, { serverHost: lan, webappPassword: 'lan-secret' });
    const relay = new Relay(
      config,
      new StateManager(0),
      {} as CommandExecutor,
      new CDPBridge(config)
    );
    relays.push(relay);
    try {
      await relay.start();
    } catch (err) {
      console.log(`[health-probe] skip LAN bind test — listen failed: ${err}`);
      return;
    }

    const unauth = await fetch(`http://${lan}:${relay.port}/health`);
    const publicBody = (await unauth.json()) as Record<string, unknown>;
    assert.equal(publicBody.ok, true);
    assert.equal('connected' in publicBody, false);

    const client = new HealthProbeClient({ password: 'lan-secret' });
    const result = await client.probe(healthProbeUrls(lan, relay.port), 2000);
    assert.ok(result?.detailed, 'authenticated probe must return detailed health');
    assert.equal(typeof (result.body as { connected: boolean }).connected, 'boolean');
    assert.equal(result.url, `http://${lan}:${relay.port}/health`);
    assert.ok(client.getToken());
  });
});