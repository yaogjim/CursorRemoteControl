import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { CdpClient } from '../src/server/cdp-client.js';

function listenTcp(): Promise<{ server: ReturnType<typeof createServer>; port: number; sockets: Set<import('node:net').Socket> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, sockets });
    });
  });
}

function listenWs(handler?: (socket: WsSocket) => void): Promise<{ wss: WebSocketServer; port: number; sockets: Set<WsSocket> }> {
  const sockets = new Set<WsSocket>();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (handler) handler(socket);
    else {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id?: number };
        if (msg.id !== undefined) {
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: null } } }));
        }
      });
    }
  });
  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({ wss, port: addr.port, sockets });
    });
  });
}

function closeTcp(
  server: ReturnType<typeof createServer>,
  sockets: Set<import('node:net').Socket>,
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWss(wss: WebSocketServer, sockets: Set<WsSocket>): Promise<void> {
  for (const socket of sockets) socket.terminate();
  return new Promise((resolve) => wss.close(() => resolve()));
}

describe('CdpClient connect reliability', () => {
  const clients: CdpClient[] = [];

  function makeClient(): CdpClient {
    const client = new CdpClient();
    clients.push(client);
    return client;
  }

  afterEach(() => {
    for (const client of clients) client.disconnect();
    clients.length = 0;
  });

  it('rejects connect when the handshake exceeds timeoutMs and terminates the socket', async () => {
    const { server, port, sockets } = await listenTcp();
    const client = makeClient();
    try {
      const started = Date.now();
      await assert.rejects(
        () => client.connect(`ws://127.0.0.1:${port}`, 150),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /connect timeout \(150ms\)/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 1000, 'timeout should not wait on TCP');
      assert.equal(client.isConnected(), false);

      await new Promise((r) => setTimeout(r, 80));
      assert.equal(sockets.size, 0, 'timed-out handshake must not leak the TCP socket');
    } finally {
      await closeTcp(server, sockets);
    }
  });

  it('tears down an in-flight handshake when connect() is called again', async () => {
    const hanging = await listenTcp();
    const live = await listenWs();
    const client = makeClient();
    try {
      const first = client.connect(`ws://127.0.0.1:${hanging.port}`, 5000);
      first.catch(() => { /* assertion below */ });
      await new Promise((r) => setTimeout(r, 30));
      await client.connect(`ws://127.0.0.1:${live.port}`);

      await assert.rejects(first, /Superseded by new connect/);
      assert.equal(client.isConnected(), true);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(hanging.sockets.size, 0, 'superseded connect must terminate the old socket');
    } finally {
      await closeTcp(hanging.server, hanging.sockets);
      await closeWss(live.wss, live.sockets);
    }
  });

  it('rejects pending CDP calls when the socket closes', async () => {
    const live = await listenWs((socket) => {
      socket.on('message', () => { /* swallow */ });
    });
    const client = makeClient();
    try {
      await client.connect(`ws://127.0.0.1:${live.port}`);

      const pending = client.send('Runtime.evaluate', { expression: '1' }, 5000);
      for (const socket of live.sockets) socket.close();
      await assert.rejects(pending, /WebSocket closed/);
      assert.equal(client.isConnected(), false);
    } finally {
      await closeWss(live.wss, live.sockets);
    }
  });

  it('rejects pending CDP calls on intentional disconnect', async () => {
    const live = await listenWs((socket) => {
      socket.on('message', () => { /* swallow */ });
    });
    const client = makeClient();
    try {
      await client.connect(`ws://127.0.0.1:${live.port}`);

      const pending = client.send('Runtime.evaluate', { expression: '1' }, 5000);
      client.disconnect();
      await assert.rejects(pending, /Intentional disconnect/);
      assert.equal(client.isConnected(), false);
    } finally {
      await closeWss(live.wss, live.sockets);
    }
  });

  it('rejects when the peer closes before the handshake completes', async () => {
    const { server, port, sockets } = await listenTcp();
    server.on('connection', (socket) => socket.destroy());
    const client = makeClient();
    try {
      await assert.rejects(
        () => client.connect(`ws://127.0.0.1:${port}`, 1000),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /closed before open|closed|ECONNRESET|socket hang up/i.test(err.message),
            `unexpected error: ${err.message}`,
          );
          return true;
        },
      );
      assert.equal(client.isConnected(), false);
    } finally {
      await closeTcp(server, sockets);
    }
  });

  it('round-trips a CDP command after a successful connect', async () => {
    const live = await listenWs();
    const client = makeClient();
    try {
      await client.connect(`ws://127.0.0.1:${live.port}`);
      const result = await client.send('Runtime.evaluate', { expression: '1+1' });
      assert.deepEqual(result, { result: { value: null } });
    } finally {
      await closeWss(live.wss, live.sockets);
    }
  });
});