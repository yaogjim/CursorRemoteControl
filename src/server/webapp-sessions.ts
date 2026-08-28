import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './persist.js';

/** HttpOnly cookie name; must match client expectations only for non-HttpOnly flows (we use server-side parse). */
export const WEBAPP_SESSION_COOKIE = 'cursor_remote_session';

const MAX_SESSIONS = 128;
const TOKEN_HEX_LEN = 64; // randomBytes(32).toString('hex')

/** Absolute session lifetime; cookie Max-Age is aligned with this. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding idle timeout; refreshed on authenticated use. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_MAX_AGE_SEC = Math.floor(SESSION_MAX_AGE_MS / 1000);

interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
}

export interface WebappSessionStore {
  has(token: string): boolean;
  add(token: string): void;
  /** Refresh idle expiry; returns false if the token is missing or expired. */
  touch(token: string): boolean;
  /** Persist any coalesced touch() writes. Call on process shutdown. */
  flush(): void;
}

export interface WebappSessionStoreOptions {
  now?: () => number;
  /** Minimum interval between touch() disk writes. Mutations (add/expire) still save immediately. */
  persistIntervalMs?: number;
}

/** Coalesce authenticated-request touch() writes; still well below SESSION_IDLE_MS. */
export const SESSION_TOUCH_PERSIST_MS = 60 * 1000;

export function createWebappSessionStore(
  dataDir: string,
  options?: WebappSessionStoreOptions
): WebappSessionStore {
  const filePath = join(dataDir, 'webapp-sessions.json');
  const sessions = new Map<string, SessionRecord>();
  const now = options?.now ?? Date.now;
  const persistIntervalMs = options?.persistIntervalMs ?? SESSION_TOUCH_PERSIST_MS;
  let dirty = false;
  let lastPersistAt = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function isExpired(rec: SessionRecord, ts: number): boolean {
    if (ts - rec.createdAt > SESSION_MAX_AGE_MS) return true;
    if (ts - rec.lastSeenAt > SESSION_IDLE_MS) return true;
    return false;
  }

  function purgeExpired(ts: number): boolean {
    let removed = false;
    for (const [token, rec] of sessions) {
      if (isExpired(rec, ts)) {
        sessions.delete(token);
        removed = true;
      }
    }
    return removed;
  }

  function evictOverflow(): void {
    while (sessions.size > MAX_SESSIONS) {
      let oldestToken: string | undefined;
      let oldestCreated = Infinity;
      for (const [token, rec] of sessions) {
        if (rec.createdAt < oldestCreated) {
          oldestCreated = rec.createdAt;
          oldestToken = token;
        }
      }
      if (oldestToken === undefined) break;
      sessions.delete(oldestToken);
    }
  }

  function load(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { tokens?: unknown; sessions?: unknown };
      const ts = now();
      if (Array.isArray(data.sessions)) {
        for (const entry of data.sessions) {
          if (!entry || typeof entry !== 'object') continue;
          const rec = entry as { token?: unknown; createdAt?: unknown; lastSeenAt?: unknown };
          if (typeof rec.token !== 'string' || !isTokenShape(rec.token)) continue;
          if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) continue;
          const lastSeenAt =
            typeof rec.lastSeenAt === 'number' && Number.isFinite(rec.lastSeenAt)
              ? rec.lastSeenAt
              : rec.createdAt;
          sessions.set(rec.token, { createdAt: rec.createdAt, lastSeenAt });
        }
      } else if (Array.isArray(data.tokens)) {
        // Legacy `{ tokens: string[] }` — grant a fresh TTL so restarts don't mass-expire.
        for (const t of data.tokens) {
          if (typeof t === 'string' && isTokenShape(t)) {
            sessions.set(t, { createdAt: ts, lastSeenAt: ts });
          }
        }
      }
      if (purgeExpired(ts)) save();
    } catch {
      // ignore corrupt or missing file
    }
  }

  function save(): void {
    try {
      const arr = [...sessions.entries()].map(([token, rec]) => ({
        token,
        createdAt: rec.createdAt,
        lastSeenAt: rec.lastSeenAt,
      }));
      writeJsonAtomic(filePath, { sessions: arr });
      lastPersistAt = now();
      dirty = false;
    } catch (e) {
      console.error('[relay] Failed to persist web app sessions:', e);
    }
  }

  function clearPersistTimer(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  }

  function scheduleTouchPersist(): void {
    dirty = true;
    const ts = now();
    if (lastPersistAt === 0 || ts - lastPersistAt >= persistIntervalMs) {
      clearPersistTimer();
      save();
      return;
    }
    if (persistTimer) return;
    const delay = Math.max(persistIntervalMs - (ts - lastPersistAt), 0);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (dirty) save();
    }, delay);
    persistTimer.unref();
  }

  load();

  return {
    has(token: string): boolean {
      if (!isTokenShape(token)) return false;
      const rec = sessions.get(token);
      if (!rec) return false;
      const ts = now();
      if (isExpired(rec, ts)) {
        sessions.delete(token);
        clearPersistTimer();
        save();
        return false;
      }
      return true;
    },
    add(token: string): void {
      if (!isTokenShape(token)) return;
      const ts = now();
      purgeExpired(ts);
      if (sessions.has(token)) {
        const rec = sessions.get(token)!;
        rec.lastSeenAt = ts;
        clearPersistTimer();
        save();
        return;
      }
      sessions.set(token, { createdAt: ts, lastSeenAt: ts });
      evictOverflow();
      clearPersistTimer();
      save();
    },
    touch(token: string): boolean {
      if (!isTokenShape(token)) return false;
      const rec = sessions.get(token);
      if (!rec) return false;
      const ts = now();
      if (isExpired(rec, ts)) {
        sessions.delete(token);
        clearPersistTimer();
        save();
        return false;
      }
      rec.lastSeenAt = ts;
      scheduleTouchPersist();
      return true;
    },
    flush(): void {
      clearPersistTimer();
      if (dirty) save();
    },
  };
}

function isTokenShape(s: string): boolean {
  return s.length === TOKEN_HEX_LEN && /^[a-f0-9]+$/i.test(s);
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}
