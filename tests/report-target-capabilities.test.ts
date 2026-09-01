import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTargetExclusions,
  defaultReportDeps,
  PASSIVE_CURRENT_VALUE_LIMITATION,
  queryWorkspacePath,
  reportTargetCapabilities,
  WORKSPACE_IDENTITY_EXPRESSION,
  workspaceIdentityFromPath,
  type CdpClientLike,
  type ReportTargetCapabilitiesDeps,
  type TargetCapabilityReport,
} from '../scripts/report-target-capabilities.js';
import {
  fetchCdpJson,
  probeCursorEndpoint,
  scoreCursorTargets,
  type TargetDescriptor,
} from '../src/server/target-discovery.js';
import { probePassiveCapabilities } from '../src/server/passive-capability-probe.js';
import type { EndpointIdentity, ModeCapability, ModelCapabilitySnapshot, ToolCapability } from '../src/server/types.js';

const CURSOR_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Cursor/3.17.21 Chrome/144.0.7559.59 Electron/40.10.3 Safari/537.36';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/144.0.0.0 Safari/537.36';

const SCRIPT_SOURCE = readFileSync(
  resolve(fileURLToPath(new URL('../scripts/report-target-capabilities.ts', import.meta.url))),
  'utf8',
);

const TWO_TARGET_FIXTURE: TargetDescriptor[] = [
  {
    id: 'win-a',
    type: 'page',
    title: 'secret-alpha - Cursor',
    url: 'vscode-file://vscode-app/Users/yaogj/works/secret-alpha/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/token-alpha',
  },
  {
    id: 'win-b',
    type: 'page',
    title: 'secret-beta - Cursor',
    url: 'vscode-file://vscode-app/Users/yaogj/works/secret-beta/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/token-beta',
  },
  {
    id: 'wv-1',
    type: 'webview',
    title: 'Composer webview',
    url: 'vscode-webview://abc/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/token-webview',
  },
  {
    id: 'worker-1',
    type: 'worker',
    title: 'worker',
    url: 'vscode-file://vscode-app/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/token-worker',
  },
  {
    id: 'blank-1',
    type: 'page',
    title: 'Workbench',
    url: 'about:blank',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/token-blank',
  },
];

const CURSOR_IDENTITY: EndpointIdentity = {
  verified: true,
  browserFamily: 'cursor',
  protocolVersion: '1.3',
  product: 'Cursor/3.17.21',
  diagnosticCode: 'identity_ok',
  diagnosticMessage: 'Cursor endpoint verified',
};

const MODE: ModeCapability = {
  id: 'agent',
  label: 'Agent',
  current: true,
  source: 'data_attribute',
  confidence: 1,
  scope: 'composer',
  selectable: true,
  observedAt: 1000,
};

const MODELS_COMPLETE: ModelCapabilitySnapshot = {
  items: [{
    id: 'label::GPT-5',
    label: 'GPT-5',
    selected: true,
    scope: 'composer',
    idStability: 'label',
    source: 'aria',
    confidence: 0.75,
    selectable: true,
    observedAt: 1000,
  }],
  completeness: 'complete',
  filterActive: false,
  observedAt: 1000,
};

const EXECUTABLE_TOOL: ToolCapability = {
  id: 'tool-1',
  type: 'shell',
  source: 'data_attribute',
  executable: true,
  actions: [{
    actionId: 'act_should_not_leak_as_executable',
    label: 'Run',
    kind: 'run',
    executable: true,
    requiresConfirmation: true,
    expiresAt: 2000,
  }],
};

function jsonOf(report: TargetCapabilityReport): string {
  return JSON.stringify(report);
}

function assertRedacted(report: TargetCapabilityReport): void {
  const json = jsonOf(report);
  assert.doesNotMatch(json, /ws:\/\//);
  assert.doesNotMatch(json, /wss:\/\//);
  assert.doesNotMatch(json, /webSocketDebuggerUrl/);
  assert.doesNotMatch(json, /token-alpha|token-beta|token-webview|token-worker|token-blank/);
  assert.doesNotMatch(json, /\/Users\//);
  assert.doesNotMatch(json, /secret-alpha - Cursor|secret-beta - Cursor/);
  assert.doesNotMatch(json, /vscode-file:|vscode-webview:|about:blank/);
  assert.doesNotMatch(json, /Bearer /);
  assert.doesNotMatch(json, /act_should_not_leak_as_executable/);
  assert.doesNotMatch(json, /Please approve this chat/);
}

class FakeClient implements CdpClientLike {
  readonly events: string[];
  readonly label: string;
  connectCalls: string[] = [];
  evaluateCalls: string[] = [];
  disconnected = false;
  forbiddenCalls: string[] = [];

  constructor(events: string[], label: string) {
    this.events = events;
    this.label = label;
  }

  async connect(wsUrl: string): Promise<void> {
    this.connectCalls.push(wsUrl);
    this.events.push(`connect:${this.label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  disconnect(): void {
    this.disconnected = true;
    this.events.push(`disconnect:${this.label}`);
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls.push(expression);
    return null;
  }

  click(): Promise<void> { this.forbiddenCalls.push('click'); throw new Error('click is forbidden'); }
  focus(): Promise<void> { this.forbiddenCalls.push('focus'); throw new Error('focus is forbidden'); }
  typeText(): Promise<void> { this.forbiddenCalls.push('typeText'); throw new Error('typeText is forbidden'); }
}

function observedAt(deps: Partial<ReportTargetCapabilitiesDeps> & Pick<ReportTargetCapabilitiesDeps, 'createClient' | 'probePassive' | 'queryWorkspacePath'>): ReportTargetCapabilitiesDeps {
  return {
    probeEndpoint: async () => CURSOR_IDENTITY,
    listTargets: async () => TWO_TARGET_FIXTURE,
    scoreTargets: scoreCursorTargets,
    now: () => 1_700_000_000_000,
    ...deps,
  };
}

describe('report-target-capabilities source contract', () => {
  it('is strictly passive and does not import interactive or write adapters', () => {
    assert.match(SCRIPT_SOURCE, /probePassiveCapabilities/);
    assert.match(SCRIPT_SOURCE, /probeCursorEndpoint/);
    assert.match(SCRIPT_SOURCE, /scoreCursorTargets/);
    assert.match(SCRIPT_SOURCE, /CdpClient/);
    assert.doesNotMatch(SCRIPT_SOURCE, /interactive-capability-probe/);
    assert.doesNotMatch(SCRIPT_SOURCE, /probeInteractive/);
    assert.doesNotMatch(SCRIPT_SOURCE, /switchWindow/);
    assert.doesNotMatch(SCRIPT_SOURCE, /adapter-store|AdapterStore|adapter-registry/);
    assert.doesNotMatch(SCRIPT_SOURCE, /\.click\(|\.focus\(|scrollIntoView|dispatchMouseEvent|insertText/);
  });
});

describe('workspaceIdentityFromPath / applyTargetExclusions', () => {
  it('hashes the full path and keeps only the basename', () => {
    const identity = workspaceIdentityFromPath('/Users/yaogj/works/ccspace/cursorremote');
    assert.ok(identity);
    assert.equal(identity.basename, 'cursorremote');
    assert.equal(identity.token.length, 16);
    assert.doesNotMatch(identity.token, /Users|ccspace|\//);
    assert.deepEqual(
      workspaceIdentityFromPath('/Users/yaogj/works/ccspace/cursorremote'),
      identity,
    );
  });

  it('marks webview, worker, and about:blank ineligible even if scored as workbench', () => {
    const ranked = applyTargetExclusions(scoreCursorTargets(TWO_TARGET_FIXTURE));
    const byId = Object.fromEntries(ranked.map((item) => [item.target.id, item]));
    assert.equal(byId['win-a']?.eligible, true);
    assert.equal(byId['win-b']?.eligible, true);
    assert.equal(byId['wv-1']?.eligible, false);
    assert.ok(byId['wv-1']?.reasons.includes('excluded_webview'));
    assert.equal(byId['worker-1']?.eligible, false);
    assert.ok(byId['worker-1']?.reasons.includes('excluded_worker'));
    assert.equal(byId['blank-1']?.eligible, false);
    assert.ok(byId['blank-1']?.reasons.includes('excluded_about_blank'));
  });
});

describe('queryWorkspacePath', () => {
  it('evaluates only the fixed read-only workspace expression', async () => {
    const client: CdpClientLike = {
      async connect() { /* unused */ },
      disconnect() { /* unused */ },
      async evaluate(expression: string) {
        assert.equal(expression, WORKSPACE_IDENTITY_EXPRESSION);
        assert.doesNotMatch(expression, /click|focus|scroll/i);
        return JSON.stringify({ path: '/Users/yaogj/works/ccspace/cursorremote' });
      },
    };
    assert.equal(await queryWorkspacePath(client), '/Users/yaogj/works/ccspace/cursorremote');
  });
});

describe('reportTargetCapabilities', () => {
  it('does not list or connect targets when /json/version is not Cursor', async () => {
    let listed = false;
    let created = false;
    const report = await reportTargetCapabilities('http://127.0.0.1:1', {
      probeEndpoint: async () => ({
        verified: false,
        browserFamily: 'chrome',
        protocolVersion: '1.3',
        product: 'Chrome/144.0.0.0',
        diagnosticCode: 'endpoint_unverified',
        diagnosticMessage: 'CDP endpoint is chrome, not Cursor',
      }),
      listTargets: async () => {
        listed = true;
        return TWO_TARGET_FIXTURE;
      },
      scoreTargets: scoreCursorTargets,
      createClient: () => {
        created = true;
        throw new Error('must not connect');
      },
      probePassive: async () => {
        throw new Error('must not probe');
      },
      queryWorkspacePath: async () => {
        throw new Error('must not query workspace');
      },
      now: () => 42,
    });
    assert.equal(listed, false);
    assert.equal(created, false);
    assert.equal(report.endpoint.verified, false);
    assert.equal(report.endpoint.browserFamily, 'chrome');
    assert.equal(report.targets.length, 0);
    assert.equal(report.probes.length, 0);
    assert.equal(report.error?.code, 'endpoint_unverified');
    assert.equal(report.limitationKind, 'passive_current_value_only');
    assert.equal(report.limitation, PASSIVE_CURRENT_VALUE_LIMITATION);
  });

  it('scores all targets, probes two eligible workbench pages sequentially, and redacts output', async () => {
    const events: string[] = [];
    const clients: FakeClient[] = [];
    const connected: string[] = [];
    let inflight = 0;
    let maxInflight = 0;

    const report = await reportTargetCapabilities('http://127.0.0.1:9222', observedAt({
      createClient: () => {
        const label = `c${clients.length + 1}`;
        const client = new FakeClient(events, label);
        const originalConnect = client.connect.bind(client);
        client.connect = async (wsUrl: string) => {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          connected.push(wsUrl);
          await originalConnect(wsUrl);
        };
        const originalDisconnect = client.disconnect.bind(client);
        client.disconnect = () => {
          inflight -= 1;
          originalDisconnect();
        };
        clients.push(client);
        return client;
      },
      queryWorkspacePath: async () => {
        const index = clients.length - 1;
        return index === 0
          ? '/Users/yaogj/works/ccspace/secret-alpha'
          : '/Users/yaogj/works/ccspace/secret-beta';
      },
      probePassive: async () => ({
        composerReady: true,
        modes: [MODE],
        models: MODELS_COMPLETE,
        tools: [EXECUTABLE_TOOL],
        observedAt: 1000,
      }),
    }));

    assert.equal(report.endpoint.verified, true);
    assert.equal(report.endpoint.product, 'Cursor/3.17.21');
    assert.equal(report.targets.length, 5);
    assert.deepEqual(
      report.targets.filter((t) => t.eligible).map((t) => t.id),
      ['win-a', 'win-b'],
    );
    assert.equal(report.targets.find((t) => t.id === 'wv-1')?.eligible, false);
    assert.equal(report.targets.find((t) => t.id === 'worker-1')?.eligible, false);
    assert.equal(report.targets.find((t) => t.id === 'blank-1')?.eligible, false);
    assert.equal(report.probes.length, 2);
    assert.equal(clients.length, 2);
    assert.equal(maxInflight, 1);
    assert.deepEqual(events, ['connect:c1', 'disconnect:c1', 'connect:c2', 'disconnect:c2']);
    assert.equal(connected.length, 2);
    assert.ok(connected.every((url) => url.startsWith('ws://')));

    assert.equal(report.probes[0]?.targetId, 'win-a');
    assert.equal(report.probes[0]?.workspace?.basename, 'secret-alpha');
    assert.equal(report.probes[1]?.workspace?.basename, 'secret-beta');
    assert.notEqual(report.probes[0]?.workspace?.token, report.probes[1]?.workspace?.token);
    assert.equal(report.probes[0]?.composerReady, true);
    assert.equal(report.probes[0]?.modes[0]?.id, 'agent');
    assert.equal(report.probes[0]?.models.completeness, 'unknown');
    assert.equal(report.probes[0]?.models.filterActive, false);
    assert.equal(report.probes[0]?.tools[0]?.executable, false);
    assert.deepEqual(report.probes[0]?.tools[0]?.actions, []);
    assert.equal(report.probes[0]?.observedAt, 1000);
    assert.match(report.limitation, /Passive\/current-value only/);
    assert.equal(report.limitationKind, 'passive_current_value_only');
    assert.equal(clients.every((c) => c.forbiddenCalls.length === 0), true);
    assertRedacted(report);
    for (const target of report.targets) {
      assert.equal('url' in target, false);
      assert.equal('title' in target, false);
      assert.equal('webSocketDebuggerUrl' in target, false);
    }
  });

  it('records a per-target unavailable error and still probes the other target', async () => {
    let created = 0;
    const report = await reportTargetCapabilities('http://127.0.0.1:9222', observedAt({
      createClient: () => {
        created += 1;
        const index = created;
        return {
          async connect() {
            if (index === 1) throw new Error('WebSocket failed ws://127.0.0.1:9222/devtools/page/token-alpha');
          },
          disconnect() { /* ok */ },
          async evaluate() { return null; },
        };
      },
      queryWorkspacePath: async () => '/Users/yaogj/works/ccspace/cursorremote',
      probePassive: async () => ({
        composerReady: true,
        modes: [MODE],
        models: { ...MODELS_COMPLETE, completeness: 'unknown' },
        tools: [{ id: 'tool-1', type: 'shell', source: 'data_attribute', executable: false, actions: [] }],
        observedAt: 9,
      }),
    }));
    assert.equal(report.probes.length, 2);
    assert.equal(report.probes[0]?.error?.code, 'target_unverified');
    assert.doesNotMatch(report.probes[0]?.error?.message ?? '', /ws:\/\//);
    assert.equal(report.probes[1]?.composerReady, true);
    assert.equal(report.probes[1]?.error, undefined);
    assertRedacted(report);
  });

  it('wires default deps to target-discovery, CdpClient, and probePassiveCapabilities without live CDP', () => {
    const deps = defaultReportDeps();
    assert.equal(deps.probeEndpoint, probeCursorEndpoint);
    assert.equal(deps.scoreTargets, scoreCursorTargets);
    assert.equal(deps.probePassive, probePassiveCapabilities);
    assert.equal(deps.queryWorkspacePath, queryWorkspacePath);
    assert.equal(typeof deps.createClient, 'function');
    assert.equal(typeof deps.listTargets, 'function');
  });
});

describe('reportTargetCapabilities mocked CDP HTTP fixture', () => {
  async function withFixture(
    payload: { version: Record<string, string>; targets: TargetDescriptor[] },
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const http = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload.version));
        return;
      }
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload.targets));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  it('uses real probeCursorEndpoint and GET /json against a local fixture, not live Cursor CDP', async () => {
    await withFixture({
      version: { 'User-Agent': CURSOR_UA, 'Protocol-Version': '1.3' },
      targets: TWO_TARGET_FIXTURE,
    }, async (base) => {
      const identity = await probeCursorEndpoint(base);
      assert.equal(identity.verified, true);
      const listed = await fetchCdpJson<TargetDescriptor[]>(`${base}/json`);
      assert.equal(listed.length, 5);

      let created = 0;
      const report = await reportTargetCapabilities(base, {
        ...defaultReportDeps(),
        createClient: () => {
          created += 1;
          return {
            async connect() { /* fixture: no live websocket */ },
            disconnect() { /* ok */ },
            async evaluate() { return JSON.stringify({ path: '/Users/yaogj/works/ccspace/cursorremote' }); },
          };
        },
        probePassive: async () => ({
          composerReady: false,
          modes: [],
          models: { items: [], completeness: 'unknown', filterActive: true, observedAt: 1 },
          tools: [],
          observedAt: 1,
        }),
      });
      assert.equal(report.endpoint.verified, true);
      assert.equal(report.endpoint.browserFamily, 'cursor');
      assert.equal(report.targets.filter((t) => t.eligible).length, 2);
      assert.equal(created, 2);
      assert.equal(report.probes[0]?.models.filterActive, true);
      assert.equal(report.probes[0]?.workspace?.basename, 'cursorremote');
      assertRedacted(report);
    });
  });

  it('rejects a Chrome /json/version fixture without connecting', async () => {
    await withFixture({
      version: { 'User-Agent': CHROME_UA, 'Protocol-Version': '1.3' },
      targets: TWO_TARGET_FIXTURE,
    }, async (base) => {
      let created = 0;
      const report = await reportTargetCapabilities(base, {
        ...defaultReportDeps(),
        createClient: () => {
          created += 1;
          throw new Error('must not connect');
        },
      });
      assert.equal(report.endpoint.verified, false);
      assert.equal(created, 0);
      assert.equal(report.probes.length, 0);
    });
  });
});