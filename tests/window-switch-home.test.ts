import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
  WindowMonitor,
  moveHomeWindow,
  selectNonHomeWindows,
} from '../src/server/window-monitor.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CDPBridge } from '../src/server/cdp-bridge.js';
import type { DOMExtractor } from '../src/server/dom-extractor.js';
import type { CursorState, CursorWindow, ServerConfig } from '../src/server/types.js';

class FakeCdpBridge extends EventEmitter {
  activeTargetId = '';
  windows: CursorWindow[] = [];
  connected = true;
  switchCalls: string[] = [];

  isConnected(): boolean {
    return this.connected;
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    return this.windows;
  }

  async switchWindow(targetId: string): Promise<void> {
    this.switchCalls.push(targetId);
    this.activeTargetId = targetId;
    this.emit('connected');
  }
}

function fakeConfig(): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 500,
    debounceMs: 0,
    selectorsPath: '',
    logLevel: 'error',
    webappPassword: '',
    windowTitleQualifier: true,
    dataDir: '/tmp',
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' },
  };
}

function win(id: string, wsUrl?: string): CursorWindow {
  return { id, title: id, url: `cursor://${id}`, wsUrl };
}

function extractionState(overrides: Partial<CursorState> = {}): CursorState {
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
    messages: [
      { type: 'human', id: 'm1', flatIndex: 0, text: 'hello', mentions: [] },
    ],
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
    ...overrides,
  };
}

const monitors: WindowMonitor[] = [];

function makeMonitor(bridge: FakeCdpBridge, stateManager = new StateManager(0)): WindowMonitor {
  const monitor = new WindowMonitor(
    bridge as unknown as CDPBridge,
    stateManager,
    null as unknown as DOMExtractor,
    fakeConfig()
  );
  monitors.push(monitor);
  return monitor;
}

afterEach(() => {
  for (const m of monitors) m.stop();
  monitors.length = 0;
});

describe('selectNonHomeWindows', () => {
  it('excludes the home window and windows without wsUrl', () => {
    const windows = [
      win('home', 'ws://home'),
      win('other', 'ws://other'),
      win('no-ws'),
    ];
    const polled = selectNonHomeWindows(windows, 'home');
    assert.deepEqual(polled.map((w) => w.id), ['other']);
  });

  it('does not treat the current CDP target as a non-home poll candidate after switch', () => {
    const windows = [win('a', 'ws://a'), win('b', 'ws://b')];
    const afterWebSwitch = selectNonHomeWindows(windows, 'b');
    assert.equal(afterWebSwitch.some((w) => w.id === 'b'), false);
    assert.deepEqual(afterWebSwitch.map((w) => w.id), ['a']);
  });
});

describe('moveHomeWindow (Telegram / web switch semantic)', () => {
  it('calls switchWindow then setHomeWindow', async () => {
    const order: string[] = [];
    await moveHomeWindow(
      {
        async switchWindow(id) {
          order.push(`switch:${id}`);
        },
      },
      {
        setHomeWindow(id) {
          order.push(`home:${id}`);
        },
      },
      'win-b'
    );
    assert.deepEqual(order, ['switch:win-b', 'home:win-b']);
  });

  it('still switches CDP when WindowMonitor is not wired', async () => {
    let switched: string | undefined;
    await moveHomeWindow(
      {
        async switchWindow(id) {
          switched = id;
        },
      },
      undefined,
      'win-b'
    );
    assert.equal(switched, 'win-b');
  });

  it('does not set home if switchWindow throws', async () => {
    let homeSet = false;
    await assert.rejects(
      () => moveHomeWindow(
        {
          async switchWindow() {
            throw new Error('cdp fail');
          },
        },
        {
          setHomeWindow() {
            homeSet = true;
          },
        },
        'win-b'
      ),
      /cdp fail/
    );
    assert.equal(homeSet, false);
  });

  it('sets home from actual activeTargetId after a successful switch', async () => {
    const bridge = {
      activeTargetId: '',
      async switchWindow(id: string) {
        this.activeTargetId = `actual:${id}`;
      },
    };
    let home: string | undefined;
    await moveHomeWindow(
      bridge,
      {
        setHomeWindow(id) {
          home = id;
        },
      },
      'requested'
    );
    assert.equal(home, 'actual:requested');
  });
});

describe('WindowMonitor home follows CDP active window', () => {
  it('sets home on first connected event', () => {
    const bridge = new FakeCdpBridge();
    const monitor = makeMonitor(bridge);
    monitor.start();

    bridge.activeTargetId = 'win-a';
    bridge.emit('connected');

    assert.equal(monitor.getHomeWindowId(), 'win-a');
  });

  it('updates home when CDP reconnects to a different window (web switch)', () => {
    const bridge = new FakeCdpBridge();
    const monitor = makeMonitor(bridge);
    monitor.start();

    bridge.activeTargetId = 'win-a';
    bridge.emit('connected');
    assert.equal(monitor.getHomeWindowId(), 'win-a');

    // Regression: previously onConnected only set home when it was null, so a
    // web command:switch_window left the new active window in the non-home
    // parallel-poll set.
    bridge.activeTargetId = 'win-b';
    bridge.emit('connected');
    assert.equal(monitor.getHomeWindowId(), 'win-b');

    const windows = [win('win-a', 'ws://a'), win('win-b', 'ws://b')];
    const polled = selectNonHomeWindows(windows, monitor.getHomeWindowId());
    assert.equal(polled.some((w) => w.id === 'win-b'), false);
  });

  it('moveHomeWindow keeps WindowMonitor home in sync with the CDP target', async () => {
    const bridge = new FakeCdpBridge();
    const monitor = makeMonitor(bridge);
    monitor.start();

    bridge.activeTargetId = 'win-a';
    bridge.emit('connected');

    await moveHomeWindow(bridge, monitor, 'win-b');

    assert.deepEqual(bridge.switchCalls, ['win-b']);
    assert.equal(bridge.activeTargetId, 'win-b');
    assert.equal(monitor.getHomeWindowId(), 'win-b');
  });

  it('holds home snapshots until a fresh extraction after switch', async () => {
    const bridge = new FakeCdpBridge();
    const stateManager = new StateManager(0);
    const monitor = makeMonitor(bridge, stateManager);
    monitor.start();

    const windows = [win('win-a', 'ws://a'), win('win-b', 'ws://b')];
    stateManager.onConnectionChanged(true);
    stateManager.updateWindows(windows, 'win-a');

    bridge.activeTargetId = 'win-a';
    bridge.windows = windows;
    bridge.emit('connected');

    assert.equal(monitor.getSnapshot('win-a'), undefined);

    stateManager.updateWindows(windows, 'win-b');
    await moveHomeWindow(bridge, monitor, 'win-b');
    assert.equal(monitor.getSnapshot('win-b'), undefined);

    stateManager.onExtraction(extractionState());
    await new Promise((r) => setTimeout(r, 20));

    const snap = monitor.getSnapshot('win-b');
    assert.ok(snap);
    assert.equal(snap.windowId, 'win-b');
    assert.equal(snap.messages.length, 1);
  });

  it('does not cache extractor-fabricated mode lists without a verified capability snapshot', async () => {
    const bridge = new FakeCdpBridge();
    const stateManager = new StateManager(0);
    const monitor = makeMonitor(bridge, stateManager);
    monitor.start();

    const windows = [win('win-a', 'ws://a'), win('win-b', 'ws://b')];
    stateManager.onConnectionChanged(true);
    stateManager.updateWindows(windows, 'win-b');
    bridge.activeTargetId = 'win-b';
    bridge.windows = windows;
    bridge.emit('connected');

    stateManager.onExtraction(extractionState({
      mode: {
        current: 'agent',
        available: [
          { id: 'agent', label: 'Agent', icon: 'infinity' },
          { id: 'plan', label: 'Plan', icon: 'todos' },
          { id: 'debug', label: 'Debug', icon: 'bug' },
          { id: 'chat', label: 'Ask', icon: 'chat' },
        ],
      },
      model: { current: 'Auto', currentId: 'auto' },
    }));
    await new Promise((r) => setTimeout(r, 20));

    const snap = monitor.getSnapshot('win-b');
    assert.ok(snap);
    assert.deepEqual(snap.mode.available, []);
    assert.equal(snap.mode.current, '');
    assert.equal(snap.model.current, '');
    assert.equal(snap.model.currentId, '');
  });
});