import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer, type AddressInfo } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { CDPBridge } from '../src/server/cdp-bridge.js';
import type { ServerConfig } from '../src/server/types.js';

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
  private http: HttpServer;
  private sockets = new Set<WsSocket>();
  private wssById = new Map<string, WebSocketServer>();
  port = 0;

  constructor() {
    this.http = createServer((req, res) => {
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

  async addWorkbench(id: string, title: string): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once('error', reject);
      wss.once('listening', () => resolve());
    });
    const wsPort = (wss.address() as AddressInfo).port;
    wss.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id?: number };
        if (msg.id !== undefined) {
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: null } } }));
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
});