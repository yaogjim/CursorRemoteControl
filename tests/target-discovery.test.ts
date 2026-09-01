import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:http';
import {
  classifyBrowserFamily,
  extractProductToken,
  probeCursorEndpoint,
  redactDiscoveryText,
  selectCursorTarget,
  toPublicDiscoveryStatus,
  verifyEndpointIdentity,
} from '../src/server/target-discovery.js';
import type { CdpVersionInfo, DiscoveryDiagnostic } from '../src/server/types.js';

const CURSOR_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Cursor/3.17.21 Chrome/144.0.7559.59 Electron/40.10.3 Safari/537.36';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/144.0.0.0 Safari/537.36';

const VSCODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Code/1.85.0 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36';

describe('verifyEndpointIdentity', () => {
  it('accepts a Cursor User-Agent from /json/version', () => {
    const identity = verifyEndpointIdentity({
      Browser: 'Chrome/144.0.7559.59',
      'Protocol-Version': '1.3',
      'User-Agent': CURSOR_UA,
    });
    assert.equal(identity.verified, true);
    assert.equal(identity.browserFamily, 'cursor');
    assert.equal(identity.product, 'Cursor/3.17.21');
    assert.equal(identity.diagnosticCode, 'identity_ok');
  });

  it('rejects Chrome, VS Code, missing UA, and missing version', () => {
    assert.equal(verifyEndpointIdentity({ 'User-Agent': CHROME_UA }).verified, false);
    assert.equal(verifyEndpointIdentity({ 'User-Agent': CHROME_UA }).browserFamily, 'chrome');
    assert.equal(verifyEndpointIdentity({ 'User-Agent': VSCODE_UA }).browserFamily, 'vscode');
    assert.equal(verifyEndpointIdentity({ 'User-Agent': VSCODE_UA }).verified, false);
    assert.equal(verifyEndpointIdentity({ Browser: 'Chrome/144' }).verified, false);
    assert.equal(verifyEndpointIdentity(null).verified, false);
    assert.equal(verifyEndpointIdentity(undefined).diagnosticCode, 'endpoint_unverified');
  });

  it('does not treat the word cursor in a non-product token as Cursor', () => {
    const ua = 'Mozilla/5.0 cursor-helper Chrome/144.0.0.0 Safari/537.36';
    assert.equal(classifyBrowserFamily(ua), 'chrome');
    assert.equal(verifyEndpointIdentity({ 'User-Agent': ua }).verified, false);
  });
});

describe('extractProductToken / redactDiscoveryText', () => {
  it('extracts Cursor product token and redacts urls without touching /json/version', () => {
    assert.equal(extractProductToken(CURSOR_UA), 'Cursor/3.17.21');
    const redacted = redactDiscoveryText(
      'Failed ws://127.0.0.1:9222/devtools/browser/abc at http://127.0.0.1:9222/json/version',
    );
    assert.match(redacted, /\[ws\]/);
    assert.match(redacted, /\[url\]/);
    assert.doesNotMatch(redacted, /9222/);
  });
});

describe('probeCursorEndpoint', () => {
  async function withVersionServer(payload: CdpVersionInfo | null, fn: (base: string) => Promise<void>): Promise<void> {
    const http = createServer((req, res) => {
      if (req.url === '/json/version') {
        if (!payload) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
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

  it('verifies a live Cursor /json/version endpoint', async () => {
    await withVersionServer({ 'User-Agent': CURSOR_UA, 'Protocol-Version': '1.3' }, async (base) => {
      const identity = await probeCursorEndpoint(base);
      assert.equal(identity.verified, true);
      assert.equal(identity.browserFamily, 'cursor');
    });
  });

  it('marks Chrome /json/version as unverified', async () => {
    await withVersionServer({ 'User-Agent': CHROME_UA }, async (base) => {
      const identity = await probeCursorEndpoint(base);
      assert.equal(identity.verified, false);
      assert.equal(identity.browserFamily, 'chrome');
      assert.equal(identity.diagnosticCode, 'endpoint_unverified');
    });
  });

  it('marks a missing /json/version as unverified', async () => {
    await withVersionServer(null, async (base) => {
      const identity = await probeCursorEndpoint(base);
      assert.equal(identity.verified, false);
      assert.equal(identity.diagnosticCode, 'endpoint_unverified');
    });
  });
});

describe('selectCursorTarget', () => {
  const targets = [
    {
      id: 'win-a',
      type: 'page',
      title: 'Alpha - Cursor',
      url: 'vscode-file://vscode-app/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/a',
    },
    {
      id: 'win-b',
      type: 'page',
      title: 'Beta - Cursor',
      url: 'vscode-file://vscode-app/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/b',
    },
    {
      id: 'other',
      type: 'iframe',
      title: 'Alpha - Cursor',
      url: 'about:blank',
    },
  ];

  it('uses ranking only when no preferred id is supplied', () => {
    assert.equal(selectCursorTarget(targets)?.id, 'win-a');
  });

  it('returns the preferred eligible target and null when that id is missing', () => {
    assert.equal(selectCursorTarget(targets, 'win-b')?.id, 'win-b');
    assert.equal(selectCursorTarget(targets, 'missing'), null);
    assert.equal(selectCursorTarget(targets, 'other'), null);
  });
});

describe('toPublicDiscoveryStatus', () => {
  it('strips unverified windows and does not include websocket urls', () => {
    const diagnostics: DiscoveryDiagnostic[] = [{
      id: 'd1',
      code: 'endpoint_unverified',
      severity: 'error',
      message: 'see ws://127.0.0.1:9222/devtools/page/secret',
      evidence: {},
      createdAt: 1,
    }];
    const publicStatus = toPublicDiscoveryStatus({
      status: 'endpoint_unverified',
      identity: {
        verified: false,
        browserFamily: 'chrome',
        protocolVersion: '1.3',
        product: 'Chrome/144.0.0.0',
        diagnosticCode: 'endpoint_unverified',
        diagnosticMessage: 'CDP endpoint is chrome, not Cursor',
      },
      activeTargetId: 'should-hide',
      targetGeneration: 9,
      preferredTargetPresent: false,
      windowCount: 3,
      lastRunAt: 123,
      lastError: { code: 'endpoint_unverified', message: 'ws://127.0.0.1:9/x' },
      diagnostics,
    });
    assert.equal(publicStatus.endpoint.verified, false);
    assert.equal(publicStatus.activeTargetId, '');
    assert.equal(publicStatus.windowCount, 0);
    assert.equal(publicStatus.targetGeneration, 0);
    assert.doesNotMatch(JSON.stringify(publicStatus), /ws:\/\//);
    assert.doesNotMatch(JSON.stringify(publicStatus), /should-hide/);
  });
});