import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer, type AddressInfo } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  CDPBridge,
  formatWorkspaceDisplayName,
  isUsableWorkspaceIdentity,
  matchEligibleTargetsByWorkspace,
  parseCdpTitle,
} from '../src/server/cdp-bridge.js';
import type { CursorWindow, ServerConfig } from '../src/server/types.js';

const FILE_WORKSPACE = {
  id: '265d56b2c491736926ee6e06eeffd5de',
  scheme: 'file' as const,
  authority: '',
  path: '/Users/yaogj/works/ccspace/cursorremote',
};

const FILE_WORKSPACE_IDENTITY = {
  id: FILE_WORKSPACE.id,
  uri: {
    scheme: FILE_WORKSPACE.scheme,
    authority: FILE_WORKSPACE.authority,
    path: FILE_WORKSPACE.path,
  },
};

interface MockTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function testConfig(cdpUrl: string): ServerConfig {
  return {
    cdpUrl,
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 150,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: '/tmp',
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' },
  };
}

function onceEvent(ee: NodeJS.EventEmitter, event: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    ee.once(event, (arg: unknown) => {
      clearTimeout(timer);
      resolve(arg);
    });
  });
}

class MockCdpEndpoint {
  targets: MockTarget[] = [];
  userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Cursor/3.17.21 Chrome/144.0.7559.59 Electron/40.10.3 Safari/537.36';
  private http: HttpServer;
  private sockets = new Set<WsSocket>();
  private wssById = new Map<string, WebSocketServer>();
  private workspaceByTargetId = new Map<string, {
    id?: string;
    scheme?: string;
    path: string;
    authority: string;
  }>();
  private evaluateValueByTargetId = new Map<string, unknown>();
  port = 0;

  constructor() {
    this.http = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          Browser: 'Chrome/144.0.7559.59',
          'Protocol-Version': '1.3',
          'User-Agent': this.userAgent,
        }));
        return;
      }
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.targets));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => {
        this.port = (this.http.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  setEvaluateValue(id: string, value: unknown): void {
    this.evaluateValueByTargetId.set(id, value);
  }

  async addWorkbench(
    id: string,
    title: string,
    workspace?: { path: string; authority?: string; id?: string; scheme?: string },
  ): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once('error', reject);
      wss.once('listening', () => resolve());
    });
    const wsPort = (wss.address() as AddressInfo).port;
    if (workspace) {
      this.workspaceByTargetId.set(id, {
        id: workspace.id,
        scheme: workspace.scheme,
        path: workspace.path,
        authority: workspace.authority ?? '',
      });
    }
    wss.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string };
        if (msg.id !== undefined) {
          let value: unknown = null;
          if (msg.method === 'Runtime.evaluate') {
            if (this.evaluateValueByTargetId.has(id)) {
              value = this.evaluateValueByTargetId.get(id);
            } else {
              const ws = this.workspaceByTargetId.get(id);
              if (ws) {
                value = JSON.stringify({
                  id: ws.id ?? '',
                  scheme: ws.scheme ?? '',
                  path: ws.path,
                  authority: ws.authority,
                });
              }
            }
          }
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
        }
      });
    });
    this.wssById.set(id, wss);
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    this.targets.push({
      id,
      type: 'page',
      title,
      url: 'vscode-file://vscode-app/workbench.html',
      webSocketDebuggerUrl: wsUrl,
    });
    return wsUrl;
  }

  removeTarget(id: string): MockTarget | undefined {
    const index = this.targets.findIndex((target) => target.id === id);
    if (index < 0) return undefined;
    const [removed] = this.targets.splice(index, 1);
    return removed;
  }

  closeTargetSockets(id: string): void {
    const wss = this.wssById.get(id);
    if (!wss) return;
    for (const client of wss.clients) client.close();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await Promise.all(
      [...this.wssById.values()].map(
        (wss) => new Promise<void>((resolve) => wss.close(() => resolve())),
      ),
    );
    this.wssById.clear();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

describe('workspace identity matching', () => {
  it('parses Cursor titles conservatively and rejects unusable identities', () => {
    assert.equal(parseCdpTitle('Alpha - Cursor'), 'Alpha');
    assert.equal(parseCdpTitle('file.ts - Alpha - Cursor'), 'Alpha');
    assert.equal(parseCdpTitle('Alpha [WSL: Ubuntu] - Cursor'), 'Alpha [WSL: Ubuntu]');
    assert.equal(isUsableWorkspaceIdentity('Alpha'), true);
    assert.equal(isUsableWorkspaceIdentity('Cursor'), false);
    assert.equal(isUsableWorkspaceIdentity(''), false);
    assert.equal(formatWorkspaceDisplayName(FILE_WORKSPACE.path, ''), 'cursorremote');
    assert.equal(formatWorkspaceDisplayName('/tmp/Alpha', ''), 'Alpha');
    assert.equal(
      formatWorkspaceDisplayName('/home/proj', 'wsl+Ubuntu', true),
      'proj [WSL: Ubuntu]',
    );
    assert.equal(formatWorkspaceDisplayName('/home/proj', 'wsl+Ubuntu', false), 'proj');
  });

  it('returns only eligible workbench targets with an exact parsed-title match', () => {
    const targets = [
      { id: 'a', type: 'page', title: 'file.ts - Alpha - Cursor', url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://a' },
      { id: 'b', type: 'page', title: 'Beta - Cursor', url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://b' },
      { id: 'c', type: 'page', title: 'Alpha - Cursor', url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://c' },
      { id: 'd', type: 'iframe', title: 'Alpha - Cursor', url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://d' },
    ];
    assert.deepEqual(matchEligibleTargetsByWorkspace(targets, 'Alpha').map((t) => t.id), ['a', 'c']);
    assert.deepEqual(matchEligibleTargetsByWorkspace(targets, 'Beta').map((t) => t.id), ['b']);
    assert.deepEqual(matchEligibleTargetsByWorkspace(targets, 'Missing').map((t) => t.id), []);
    assert.deepEqual(matchEligibleTargetsByWorkspace(targets, 'Cursor').map((t) => t.id), []);
  });
});

describe('CDPBridge reconnect target', () => {
  const bridges: CDPBridge[] = [];
  const endpoints: MockCdpEndpoint[] = [];

  afterEach(async () => {
    for (const bridge of bridges) await bridge.disconnect();
    bridges.length = 0;
    for (const endpoint of endpoints) await endpoint.stop();
    endpoints.length = 0;
  });

  it('reconnects to the switchWindow target after a failed switch, not the first window', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-b', 'Beta - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    const connected = onceEvent(bridge, 'connected');
    await bridge.connect();
    await connected;
    assert.equal(bridge.activeTargetId, 'win-a');
    assert.equal(bridge.isConnected(), true);

    // Make B fail the next handshake, then restore it so the scheduled reconnect can succeed.
    const bTarget = endpoint.targets.find(t => t.id === 'win-b')!;
    const goodB = bTarget.webSocketDebuggerUrl;
    bTarget.webSocketDebuggerUrl = `ws://127.0.0.1:1`;

    const failed = onceEvent(bridge, 'error');
    await Promise.all([
      failed,
      assert.rejects(() => bridge.switchWindow('win-b')),
    ]);
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.getClient(), null, 'failed connect must not leave a leftover client');
    assert.equal(bridge.activeTargetId, '');

    bTarget.webSocketDebuggerUrl = goodB;
    await onceEvent(bridge, 'connected', 2500);
    assert.equal(bridge.activeTargetId, 'win-b', 'reconnect must retry the switch target, not fall back to win-a');
    assert.equal(bridge.isConnected(), true);
  });

  it('reconnects to the last connected window after an unexpected drop', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-b', 'Beta - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-b')]);
    assert.equal(bridge.activeTargetId, 'win-b');

    const reconnected = onceEvent(bridge, 'connected', 2500);
    endpoint.closeTargetSockets('win-b');
    await reconnected;
    assert.equal(bridge.activeTargetId, 'win-b', 'unexpected drop must reconnect to the same target');
  });

  it('does not leak the previous client when connect() is retried after failure', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    const aTarget = endpoint.targets.find(t => t.id === 'win-a')!;
    const goodA = aTarget.webSocketDebuggerUrl;
    aTarget.webSocketDebuggerUrl = 'ws://127.0.0.1:1';

    const failed = onceEvent(bridge, 'error');
    await bridge.connect('win-a');
    await failed;
    assert.equal(bridge.getClient(), null);
    assert.equal(bridge.isConnected(), false);

    aTarget.webSocketDebuggerUrl = goodA;
    await onceEvent(bridge, 'connected', 2500);
    assert.equal(bridge.activeTargetId, 'win-a');
    assert.ok(bridge.getClient());
    assert.equal(bridge.isConnected(), true);
  });

  it('switchWindow throws when the target is missing and does not fall back to the first window', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-b', 'Beta - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.equal(bridge.activeTargetId, 'win-a');

    await assert.rejects(
      () => bridge.switchWindow('missing-window'),
      /not found/,
    );
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.activeTargetId, '');
    assert.equal(bridge.getClient(), null);
  });

  it('switchWindow throws on handshake failure without connecting to another window', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-b', 'Beta - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.equal(bridge.activeTargetId, 'win-a');

    const bTarget = endpoint.targets.find(t => t.id === 'win-b')!;
    bTarget.webSocketDebuggerUrl = 'ws://127.0.0.1:1';

    await assert.rejects(() => bridge.switchWindow('win-b'));
    assert.equal(bridge.isConnected(), false);
    assert.notEqual(bridge.activeTargetId, 'win-a');
    assert.equal(bridge.activeTargetId, '');
  });

  it('reconnect does not fall back to the first window when the preferred target is removed', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-b', 'Beta - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    // EventEmitter throws on unhandled 'error'; keep reconnect scheduling intact.
    bridge.on('error', () => { /* observed via onceEvent below */ });

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.equal(bridge.activeTargetId, 'win-a');

    const bIndex = endpoint.targets.findIndex(t => t.id === 'win-b');
    const bTarget = endpoint.targets[bIndex]!;
    const goodB = bTarget.webSocketDebuggerUrl;
    bTarget.webSocketDebuggerUrl = 'ws://127.0.0.1:1';

    await assert.rejects(() => bridge.switchWindow('win-b'));
    assert.equal(bridge.activeTargetId, '');
    assert.equal(bridge.isConnected(), false);

    endpoint.targets.splice(bIndex, 1);

    await onceEvent(bridge, 'error', 2500);
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.activeTargetId, '', 'must stay empty, not fall back to win-a');
    assert.equal(bridge.getClient(), null);

    bTarget.webSocketDebuggerUrl = goodB;
    endpoint.targets.push(bTarget);
    await onceEvent(bridge, 'connected', 3500);
    assert.equal(bridge.activeTargetId, 'win-b');
    assert.equal(bridge.isConnected(), true);
  });

  it('keeps the exact preferred target when it still exists even if another window shares the workspace', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', { path: '/tmp/Alpha' });
    await endpoint.addWorkbench('win-a-clone', 'file.ts - Alpha - Cursor', { path: '/tmp/Alpha' });

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.equal(bridge.activeTargetId, 'win-a');
    const generation = bridge.getTargetGeneration('win-a');

    const reconnected = onceEvent(bridge, 'connected', 2500);
    endpoint.closeTargetSockets('win-a');
    await reconnected;
    assert.equal(bridge.activeTargetId, 'win-a', 'exact preferred id must win over a same-workspace clone');
    assert.equal(bridge.getTargetGeneration('win-a'), generation + 1);
    assert.equal(bridge.isConnected(), true);
  });

  it('remaps automatic reconnect to a unique workspace match after the preferred target id is replaced', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-b', 'Beta - Cursor', { path: '/tmp/Beta' });
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', { path: '/tmp/Alpha' });

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.equal(bridge.activeTargetId, 'win-a');
    const oldGeneration = bridge.getTargetGeneration('win-a');

    endpoint.removeTarget('win-a');
    await endpoint.addWorkbench('win-a2', 'file.ts - Alpha - Cursor');
    const reconnected = onceEvent(bridge, 'connected', 2500);
    endpoint.closeTargetSockets('win-a');
    await reconnected;

    assert.equal(bridge.activeTargetId, 'win-a2', 'unique Alpha match must win; must not score-pick Beta');
    assert.equal(bridge.isConnected(), true);
    assert.equal(bridge.getTargetGeneration(), 1);
    assert.equal(bridge.getTargetGeneration('win-a'), oldGeneration, 'old target generation must be preserved');
    assert.equal(bridge.getDiscoveryStatus().preferredTargetPresent, true);
    assert.equal(bridge.getDiscoveryStatus().status, 'ok');
  });

  it('fails closed when multiple windows match the preferred workspace after target replacement', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-b', 'Beta - Cursor', { path: '/tmp/Beta' });
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', { path: '/tmp/Alpha' });

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.equal(bridge.activeTargetId, 'win-a');

    endpoint.removeTarget('win-a');
    await endpoint.addWorkbench('win-a2', 'Alpha - Cursor');
    await endpoint.addWorkbench('win-a3', 'file.ts - Alpha - Cursor');
    const failed = onceEvent(bridge, 'error', 2500);
    endpoint.closeTargetSockets('win-a');
    await failed;

    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.activeTargetId, '', 'ambiguous Alpha must not pick Beta or either Alpha');
    assert.equal(bridge.getClient(), null);
    const discovery = bridge.getDiscoveryStatus();
    assert.equal(discovery.status, 'target_unverified');
    assert.equal(discovery.lastError?.code, 'preferred_target_ambiguous');
    assert.equal(discovery.preferredTargetPresent, false);
  });

  it('does not remap an explicit failed switch to the previous workspace', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', { path: '/tmp/Alpha' });
    await endpoint.addWorkbench('win-b', 'Beta - Cursor', { path: '/tmp/Beta' });

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.equal(bridge.activeTargetId, 'win-a');

    await assert.rejects(
      () => bridge.switchWindow('missing-window'),
      /not found/,
    );
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.activeTargetId, '');

    await onceEvent(bridge, 'error', 2500);
    assert.equal(bridge.isConnected(), false, 'failed switch must keep retrying the requested id, not remap to Alpha');
    assert.equal(bridge.activeTargetId, '');
    assert.equal(bridge.getClient(), null);
    const discovery = bridge.getDiscoveryStatus();
    assert.equal(discovery.status, 'target_unverified');
    assert.equal(discovery.lastError?.code, 'target_unverified');
    assert.match(discovery.lastError?.message ?? '', /not found/);
  });

  it('does not remap to an unrelated window when the preferred target disappears', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-b', 'Beta - Cursor', { path: '/tmp/Beta' });
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', { path: '/tmp/Alpha' });

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.equal(bridge.activeTargetId, 'win-a');

    endpoint.removeTarget('win-a');
    const failed = onceEvent(bridge, 'error', 2500);
    endpoint.closeTargetSockets('win-a');
    await failed;

    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.activeTargetId, '', 'zero matches must not fall back to Beta');
    assert.equal(bridge.getClient(), null);
    const discovery = bridge.getDiscoveryStatus();
    assert.equal(discovery.status, 'target_unverified');
    assert.equal(discovery.lastError?.code, 'target_unverified');
  });

  it('does not expose a client when /json/version is not Cursor', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');
    endpoint.userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/144.0.0.0 Safari/537.36';

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    let connected = false;
    bridge.on('connected', () => { connected = true; });

    await Promise.all([onceEvent(bridge, 'error', 2500), bridge.connect()]);
    assert.equal(connected, false);
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.getClient(), null);
    assert.equal(bridge.isEndpointVerified(), false);
    assert.equal(bridge.activeTargetId, '');
    const discovery = bridge.getDiscoveryStatus();
    assert.equal(discovery.status, 'endpoint_unverified');
    assert.equal(discovery.endpoint.verified, false);
    assert.equal(discovery.endpoint.browserFamily, 'chrome');
    assert.equal(discovery.windowCount, 0);
  });
});


function assertWindowHidesPath(win: CursorWindow | undefined, fullPath: string): void {
  assert.ok(win);
  assert.equal('path' in win, false);
  assert.equal('uri' in win, false);
  assert.equal(JSON.stringify(win).includes(fullPath), false);
}

describe('CDPBridge workspace identity', () => {
  const bridges: CDPBridge[] = [];
  const endpoints: MockCdpEndpoint[] = [];

  afterEach(async () => {
    for (const bridge of bridges) await bridge.disconnect();
    bridges.length = 0;
    for (const endpoint of endpoints) await endpoint.stop();
    endpoints.length = 0;
  });

  it('stores the evaluated single-root identity and does not put the path on CursorWindow', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'cursorremote - Cursor', FILE_WORKSPACE);

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), FILE_WORKSPACE_IDENTITY);

    const cloned = bridge.getActiveWorkspaceIdentity();
    assert.ok(cloned);
    cloned.id = 'mutated';
    cloned.uri.path = '/tmp/leaked';
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), FILE_WORKSPACE_IDENTITY);

    const win = bridge.windows.find((w) => w.id === 'win-a');
    assert.equal(win?.title, 'cursorremote');
    assertWindowHidesPath(win, FILE_WORKSPACE.path);
    assert.equal(JSON.stringify(bridge.windows).includes(FILE_WORKSPACE.path), false);
    assert.equal(JSON.stringify(bridge.getDiscoveryStatus()).includes(FILE_WORKSPACE.path), false);
  });

  it('keeps remote identity as-is and still uses basename for the display title', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    const remote = {
      id: 'remote-ws-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      scheme: 'vscode-remote',
      authority: 'ssh-remote+host',
      path: '/home/proj',
    };
    await endpoint.addWorkbench('win-a', 'proj - Cursor', remote);

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), {
      id: remote.id,
      uri: { scheme: remote.scheme, authority: remote.authority, path: remote.path },
    });
    const win = bridge.windows.find((w) => w.id === 'win-a');
    assert.equal(win?.title, 'proj [SSH: host]');
    assertWindowHidesPath(win, remote.path);
  });

  it('does not invent identity from the CDP title when evaluate is empty', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor');

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect()]);
    assert.equal(bridge.isConnected(), true);
    assert.equal(bridge.getActiveWorkspaceIdentity(), null);
    assert.equal(bridge.windows.find((w) => w.id === 'win-a')?.title, 'Alpha');
  });

  it('rejects empty and malformed evaluate payloads without using the title', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'Alpha - Cursor', {
      id: FILE_WORKSPACE.id,
      scheme: 'file',
      path: FILE_WORKSPACE.path,
    });

    const malformed = [
      'not-json',
      JSON.stringify({ scheme: 'file', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: '', scheme: 'file', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: `x\0y`, scheme: 'file', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file\0', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: 'a\0b', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: '', path: `${FILE_WORKSPACE.path}\0` }),
      JSON.stringify({ id: 'a'.repeat(129), scheme: 'file', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'f'.repeat(33), authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: 'a'.repeat(257), path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: '', path: `/${'a'.repeat(4092)}/proj` }),
      JSON.stringify({ id: 1, scheme: 'file', authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 1, authority: '', path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: null, path: FILE_WORKSPACE.path }),
      JSON.stringify({ id: FILE_WORKSPACE.id, scheme: 'file', authority: '', path: 1 }),
    ];

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    for (const payload of malformed) {
      endpoint.setEvaluateValue('win-a', payload);
      await Promise.all([onceEvent(bridge, 'connected', 3500), bridge.connect('win-a')]);
      assert.equal(bridge.getActiveWorkspaceIdentity(), null, String(payload).slice(0, 80));
      assert.equal(bridge.isConnected(), true);
      await bridge.disconnect();
    }
  });

  it('updates identity on a successful switch and clears it on switch failure, disconnect, and drop', async () => {
    const endpoint = new MockCdpEndpoint();
    endpoints.push(endpoint);
    await endpoint.start();
    await endpoint.addWorkbench('win-a', 'cursorremote - Cursor', FILE_WORKSPACE);
    const beta = {
      id: 'beta-workspace-id-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      scheme: 'file' as const,
      authority: '',
      path: '/tmp/Beta',
    };
    await endpoint.addWorkbench('win-b', 'Beta - Cursor', beta);

    const bridge = new CDPBridge(testConfig(`http://127.0.0.1:${endpoint.port}`));
    bridges.push(bridge);
    bridge.on('error', () => { /* reconnect loop */ });

    await Promise.all([onceEvent(bridge, 'connected'), bridge.connect('win-a')]);
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), FILE_WORKSPACE_IDENTITY);

    await bridge.switchWindow('win-b');
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), {
      id: beta.id,
      uri: { scheme: beta.scheme, authority: beta.authority, path: beta.path },
    });
    assertWindowHidesPath(bridge.windows.find((w) => w.id === 'win-b'), beta.path);

    await assert.rejects(() => bridge.switchWindow('missing-window'), /not found/);
    assert.equal(bridge.getActiveWorkspaceIdentity(), null);
    assert.equal(bridge.isConnected(), false);

    await Promise.all([onceEvent(bridge, 'connected', 3500), bridge.connect('win-a')]);
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), FILE_WORKSPACE_IDENTITY);

    const dropped = onceEvent(bridge, 'disconnected');
    endpoint.closeTargetSockets('win-a');
    await dropped;
    assert.equal(bridge.getActiveWorkspaceIdentity(), null);

    await onceEvent(bridge, 'connected', 2500);
    assert.deepEqual(bridge.getActiveWorkspaceIdentity(), FILE_WORKSPACE_IDENTITY);

    await bridge.disconnect();
    assert.equal(bridge.getActiveWorkspaceIdentity(), null);
  });
});
