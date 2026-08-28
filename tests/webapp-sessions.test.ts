import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_PERSIST_MS,
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from '../src/server/webapp-sessions.js';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

describe('parseSessionCookie', () => {
  it('returns the named cookie value', () => {
    const header = `${WEBAPP_SESSION_COOKIE}=${TOKEN_A}; other=1`;
    assert.equal(parseSessionCookie(header, WEBAPP_SESSION_COOKIE), TOKEN_A);
  });

  it('returns undefined when missing', () => {
    assert.equal(parseSessionCookie(undefined, WEBAPP_SESSION_COOKIE), undefined);
    assert.equal(parseSessionCookie('foo=bar', WEBAPP_SESSION_COOKIE), undefined);
  });
});

describe('createWebappSessionStore', () => {
  let dir: string;
  let now: number;
  const stores: WebappSessionStore[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webapp-sessions-'));
    now = 1_000_000;
    stores.length = 0;
  });

  afterEach(() => {
    for (const s of stores) s.flush();
    stores.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function store(opts?: { persistIntervalMs?: number }) {
    const s = createWebappSessionStore(dir, {
      now: () => now,
      persistIntervalMs: opts?.persistIntervalMs ?? SESSION_TOUCH_PERSIST_MS,
    });
    stores.push(s);
    return s;
  }

  function diskLastSeen(token: string): number | undefined {
    const raw = JSON.parse(readFileSync(join(dir, 'webapp-sessions.json'), 'utf-8')) as {
      sessions: Array<{ token: string; lastSeenAt: number }>;
    };
    return raw.sessions.find((e) => e.token === token)?.lastSeenAt;
  }

  it('adds and has a well-shaped token', () => {
    const s = store();
    s.add(TOKEN_A);
    assert.equal(s.has(TOKEN_A), true);
    assert.equal(s.has(TOKEN_B), false);
    assert.equal(s.has('not-a-token'), false);
  });

  it('persists across store instances', () => {
    store().add(TOKEN_A);
    const reloaded = store();
    assert.equal(reloaded.has(TOKEN_A), true);
  });

  it('loads legacy { tokens } files with a fresh TTL', () => {
    writeFileSync(
      join(dir, 'webapp-sessions.json'),
      JSON.stringify({ tokens: [TOKEN_A] }) + '\n'
    );
    const s = store();
    assert.equal(s.has(TOKEN_A), true);
    now += SESSION_IDLE_MS - 1;
    assert.equal(s.has(TOKEN_A), true);
  });

  it('expires after idle timeout unless touched', () => {
    const s = store();
    s.add(TOKEN_A);
    now += SESSION_IDLE_MS - 1;
    assert.equal(s.has(TOKEN_A), true);
    now += 2;
    assert.equal(s.has(TOKEN_A), false);
  });

  it('touch refreshes idle expiry', () => {
    const s = store();
    s.add(TOKEN_A);
    now += SESSION_IDLE_MS - 1;
    assert.equal(s.touch(TOKEN_A), true);
    now += SESSION_IDLE_MS - 1;
    assert.equal(s.has(TOKEN_A), true);
  });

  it('expires at absolute max age even if touched', () => {
    const s = store();
    s.add(TOKEN_A);
    const start = now;
    while (now - start < SESSION_MAX_AGE_MS - SESSION_IDLE_MS / 2) {
      now += SESSION_IDLE_MS / 2;
      assert.equal(s.touch(TOKEN_A), true);
    }
    now = start + SESSION_MAX_AGE_MS + 1;
    assert.equal(s.has(TOKEN_A), false);
    assert.equal(s.touch(TOKEN_A), false);
  });

  it('evicts oldest sessions when over capacity', () => {
    const s = store();
    const tokens: string[] = [];
    for (let i = 0; i < 129; i++) {
      now += 1;
      const t = i.toString(16).padStart(64, '0');
      tokens.push(t);
      s.add(t);
    }
    assert.equal(s.has(tokens[0]), false);
    assert.equal(s.has(tokens[1]), true);
    assert.equal(s.has(tokens[128]), true);
  });

  it('writes the new sessions shape', () => {
    store().add(TOKEN_C);
    const raw = JSON.parse(readFileSync(join(dir, 'webapp-sessions.json'), 'utf-8')) as {
      sessions: Array<{ token: string; createdAt: number; lastSeenAt: number }>;
    };
    assert.equal(raw.sessions.length, 1);
    assert.equal(raw.sessions[0].token, TOKEN_C);
    assert.equal(raw.sessions[0].createdAt, 1_000_000);
  });

  it('creates missing nested data directories on save', () => {
    const nested = join(dir, 'a', 'b');
    const s = createWebappSessionStore(nested, { now: () => now });
    stores.push(s);
    s.add(TOKEN_A);
    assert.equal(existsSync(join(nested, 'webapp-sessions.json')), true);
    assert.equal(s.has(TOKEN_A), true);
  });

  it('does not write on every touch within the persist interval', () => {
    const s = store();
    s.add(TOKEN_A);
    const afterAdd = diskLastSeen(TOKEN_A);
    assert.equal(afterAdd, now);

    for (let i = 0; i < 20; i++) {
      now += 1;
      assert.equal(s.touch(TOKEN_A), true);
    }
    assert.equal(diskLastSeen(TOKEN_A), afterAdd, 'frequent touch must not rewrite the file');
    assert.equal(s.has(TOKEN_A), true);
  });

  it('persists a coalesced touch after the interval and via flush', () => {
    const s = store();
    s.add(TOKEN_A);
    now += 10;
    assert.equal(s.touch(TOKEN_A), true);
    assert.equal(diskLastSeen(TOKEN_A), 1_000_000);

    s.flush();
    assert.equal(diskLastSeen(TOKEN_A), now);

    now += SESSION_TOUCH_PERSIST_MS;
    assert.equal(s.touch(TOKEN_A), true);
    assert.equal(diskLastSeen(TOKEN_A), now);
  });

  it('keeps in-memory idle expiry correct even when touch is not yet on disk', () => {
    const s = store();
    s.add(TOKEN_A);
    now += 50;
    assert.equal(s.touch(TOKEN_A), true);
    assert.equal(diskLastSeen(TOKEN_A), 1_000_000);

    now += SESSION_IDLE_MS - 1;
    assert.equal(s.has(TOKEN_A), true, 'idle clock uses in-memory lastSeen');
    now += 2;
    assert.equal(s.has(TOKEN_A), false);
  });

  it('flush makes a throttled lastSeen survive process restart', () => {
    const s = store();
    s.add(TOKEN_A);
    now += 25;
    assert.equal(s.touch(TOKEN_A), true);
    s.flush();

    const reloaded = store();
    now += SESSION_IDLE_MS - 1;
    assert.equal(reloaded.has(TOKEN_A), true);
  });

  it('without flush, a restart uses the last persisted lastSeen for idle expiry', () => {
    const s = store();
    s.add(TOKEN_A);
    now += 25;
    assert.equal(s.touch(TOKEN_A), true);

    const reloaded = store();
    now = 1_000_000 + SESSION_IDLE_MS + 1;
    assert.equal(reloaded.has(TOKEN_A), false);
  });
});