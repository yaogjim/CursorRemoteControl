import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Relay } from '../src/server/relay.js';
import { StateManager } from '../src/server/state-manager.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import type { CDPBridge } from '../src/server/cdp-bridge.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import { AdapterStore } from '../src/server/adapter-store.js';
import { RuntimeSelectorProvider, type RuntimeAdapterContext } from '../src/server/runtime-selector-provider.js';
import { TargetUiCoordinator } from '../src/server/target-ui-coordinator.js';
import type { SelectorConfig, ServerConfig } from '../src/server/types.js';

const ENDPOINT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BUILD = 'Cursor/3.17.21';
const DOM = 'bbbbbbbbbbbbbbbbbbbbbbbb';

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

function baselineSelectors(): SelectorConfig {
  return {
    chatContainer: { strategies: ['.chat'] },
    approveButton: { strategies: ['.approve'] },
    rejectButton: { strategies: ['.reject'] },
    chatInput: { strategies: ['.input'] },
    agentStatus: { strategies: ['.status'] },
    modeDropdown: { strategies: ['.mode-builtin'] },
    modelDropdown: { strategies: ['.model-builtin'] },
  };
}

function fakeClient(): CdpClient {
  return {
    isConnected: () => true,
    evaluate: async () => ({ count: 1, visibleCount: 1 }),
  } as unknown as CdpClient;
}

function fakeBridge(targetId: string, generation: number, client: CdpClient | null = fakeClient()): CDPBridge {
  return {
    activeTargetId: targetId,
    getTargetGeneration: () => generation,
    getClient: () => client,
    getDiscoveryStatus: () => ({ status: 'idle' }),
    windows: [],
  } as unknown as CDPBridge;
}

function adapter(id: string, overrides: Partial<{ cursorVersionRange: string; endpointFingerprint: string; domSignature: string }> = {}) {
  return {
    id,
    cursorVersionRange: overrides.cursorVersionRange ?? BUILD,
    endpointFingerprint: overrides.endpointFingerprint ?? ENDPOINT,
    domSignature: overrides.domSignature ?? DOM,
    capabilityKinds: ['mode'] as const,
    strategies: { modeDropdown: [{ id: 'mode-1', kind: 'dropdown', selector: '.mode-live', scope: 'composer', operationClass: 'interactive_read' as const }] },
    evidence: [{ source: 'test', summary: 'observation', confidence: 1 }],
  };
}

async function createRuntime(store: AdapterStore, generation = 1): Promise<{ runtime: RuntimeSelectorProvider; coordinator: TargetUiCoordinator; context: RuntimeAdapterContext }> {
  const runtime = new RuntimeSelectorProvider(baselineSelectors(), await store.load());
  const context = {
    endpointFingerprint: ENDPOINT,
    cursorBuild: BUILD,
    domSignature: DOM,
    targetId: 'target-a',
    targetGeneration: generation,
    observedAt: Date.now(),
  };
  runtime.setActiveContext(context);
  const coordinator = new TargetUiCoordinator();
  coordinator.setGeneration('target-a', generation);
  return { runtime, coordinator, context };
}

async function createRelay(dir: string, store: AdapterStore, generation = 1): Promise<{ relay: Relay; runtime: RuntimeSelectorProvider; context: RuntimeAdapterContext }> {
  const { runtime, coordinator, context } = await createRuntime(store, generation);
  const relay = new Relay(
    config(dir),
    new StateManager(0),
    {} as CommandExecutor,
    fakeBridge('target-a', generation),
    undefined,
    undefined,
    undefined,
    store,
    coordinator,
    runtime,
  );
  await relay.start();
  return { relay, runtime, context };
}

function bindingBody(context: RuntimeAdapterContext, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityKind: 'mode',
    cursorVersionRange: context.cursorBuild,
    endpointFingerprint: context.endpointFingerprint,
    domSignature: context.domSignature,
    ...extras,
  };
}

describe('Relay adapter activation and operation ids', () => {
  let dir: string;
  const relays: Relay[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-adapter-'));
    relays.length = 0;
  });

  afterEach(async () => {
    for (const relay of relays) {
      try { await relay.stop(); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires explicit confirmation before activating a pending adapter', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-pending'));
    const { relay, context } = await createRelay(dir, store);
    relays.push(relay);

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/${pending.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-apply-confirm-1' },
      body: JSON.stringify(bindingBody(context)),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /explicit adapter confirmation required/);
    assert.equal((await store.get(pending.id))?.status, 'pending_confirmation');
  });

  it('keeps pending adapters fail-closed and never activates via HTTP apply', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-live'));
    const before = await store.load();
    const { relay, runtime, context } = await createRelay(dir, store);
    relays.push(relay);

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/${pending.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-apply-live-1' },
      body: JSON.stringify(bindingBody(context, { confirmed: true })),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'ADAPTER_ACTIVATION_UNAVAILABLE');
    assert.equal((await store.get(pending.id))?.status, 'pending_confirmation');
    assert.equal(runtime.selectors.modeDropdown.strategies[0], '.mode-builtin');
    assert.equal(runtime.getUsage().mode.source, 'builtin');
    const after = await store.load();
    assert.equal(after.revision, before.revision);
    assert.equal(after.activeBindings.length, 0);
    assert.deepEqual(after.adapters.map((item) => item.status), before.adapters.map((item) => item.status));
  });

  it('does not mutate adapter state when apply input mismatches the runtime context', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-mismatch'));
    const before = await store.load();
    const { relay, context } = await createRelay(dir, store);
    relays.push(relay);

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/${pending.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-apply-mismatch-1' },
      body: JSON.stringify(bindingBody(context, { confirmed: true, domSignature: 'cccccccccccccccccccccccc' })),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'ADAPTER_ACTIVATION_UNAVAILABLE');
    assert.equal((await store.get(pending.id))?.status, 'pending_confirmation');
    assert.equal(store.getState().activeBindings.length, 0);
    assert.equal((await store.load()).revision, before.revision);
  });

  it('ignores prototype-key pollution and still refuses to activate', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-proto'));
    const { relay, context } = await createRelay(dir, store);
    relays.push(relay);
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/${pending.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-apply-proto-1' },
      body: JSON.stringify({
        ...bindingBody(context, { confirmed: true }),
        __proto__: { confirmed: true, status: 'active' },
        constructor: { prototype: { status: 'active' } },
      }),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'ADAPTER_ACTIVATION_UNAVAILABLE');
    assert.equal((await store.get(pending.id))?.status, 'pending_confirmation');
    assert.equal(store.getState().activeBindings.length, 0);
  });

  it('rolls back the exact active binding and restores builtin selectors', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-rollback'));
    await store.apply(pending.id, {
      capabilityKind: 'mode', cursorVersionRange: BUILD, endpointFingerprint: ENDPOINT, domSignature: DOM,
    });
    const { relay, runtime, context } = await createRelay(dir, store);
    relays.push(relay);
    assert.equal(runtime.selectors.modeDropdown.strategies[0], '.mode-live');

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-rollback-live-1' },
      body: JSON.stringify(bindingBody(context, { adapterId: pending.id })),
    });
    assert.equal(res.status, 200);
    assert.equal(runtime.selectors.modeDropdown.strategies[0], '.mode-builtin');
    assert.equal(runtime.getUsage().mode.source, 'builtin');
    assert.equal((await store.get(pending.id))?.status, 'rolled_back');
    assert.equal(store.getState().activeBindings.length, 0);
  });

  it('reserves an in-flight operation id so concurrent identical writes run once', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const { relay } = await createRelay(dir, store);
    relays.push(relay);
    let runs = 0;
    relay.setDiscoveryRunner(async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { seq: runs };
    });
    const url = `http://127.0.0.1:${relay.port}/api/discovery/run`;
    const headers = { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-concurrent-1' };
    const [first, second] = await Promise.all([
      fetch(url, { method: 'POST', headers, body: '{}' }),
      fetch(url, { method: 'POST', headers, body: '{}' }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json() as { ok: boolean; data: { seq: number } };
    const b = await second.json() as { ok: boolean; data: { seq: number } };
    assert.equal(runs, 1);
    assert.deepEqual(a, b);
  });

  it('returns 409 when the same operation id is reused with different input', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const { relay } = await createRelay(dir, store);
    relays.push(relay);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    relay.setDiscoveryRunner(async () => { await gate; return { ok: true }; });
    const url = `http://127.0.0.1:${relay.port}/api/discovery/run`;
    const first = fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-mismatch-1' }, body: JSON.stringify({ n: 1 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conflict = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Id': 'op-mismatch-1' }, body: JSON.stringify({ n: 2 }),
    });
    assert.equal(conflict.status, 409);
    release();
    assert.equal((await first).status, 200);
  });

  it('rejects apply without an operation id before reaching the adapter handler', async () => {
    const store = new AdapterStore(join(dir, 'adapters.json'));
    const pending = await store.savePending(adapter('adapter-no-operation'));
    const { relay, context } = await createRelay(dir, store);
    relays.push(relay);

    const res = await fetch(`http://127.0.0.1:${relay.port}/api/adapters/${pending.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bindingBody(context, { confirmed: true })),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /X-Operation-Id header required/);
    assert.equal((await store.get(pending.id))?.status, 'pending_confirmation');
  });
});