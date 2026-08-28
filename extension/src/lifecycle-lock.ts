import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const MANUAL_STOP_FILE = 'manual-stop';
export const OWNER_LOCK_FILE = 'server-owner.lock';
/** Restart intent older than this is treated as abandoned so takeover can proceed. */
export const RESTART_STALE_MS = 15_000;

export type LifecycleIntent = 'running' | 'restarting' | 'stopped';

export interface OwnerLockState {
  generation: number;
  ownerId: string;
  pid: number;
  intent: LifecycleIntent;
  updatedAt: number;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-window coordination for the singleton relay process.
 *
 * - `manual-stop` keeps the existing "user stopped the server everywhere" flag.
 * - `server-owner.lock` records who may spawn, a generation counter, and whether
 *   a restart is in flight so observers do not dual-start or takeover mid-restart.
 */
export class LifecycleLock {
  constructor(
    private readonly dataDir: string,
    readonly ownerId: string
  ) {}

  get lockPath(): string {
    return join(this.dataDir, OWNER_LOCK_FILE);
  }

  get manualStopPath(): string {
    return join(this.dataDir, MANUAL_STOP_FILE);
  }

  read(): OwnerLockState | null {
    try {
      if (!existsSync(this.lockPath)) return null;
      const raw = JSON.parse(readFileSync(this.lockPath, 'utf-8')) as OwnerLockState;
      if (!raw || typeof raw.ownerId !== 'string') return null;
      if (typeof raw.generation !== 'number' || !Number.isFinite(raw.generation)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  isOwnedByUs(): boolean {
    return this.read()?.ownerId === this.ownerId;
  }

  isManualStopped(): boolean {
    return existsSync(this.manualStopPath);
  }

  setManualStop(stopped: boolean): void {
    mkdirSync(this.dataDir, { recursive: true });
    if (stopped) {
      writeFileSync(this.manualStopPath, String(Date.now()));
      const current = this.read();
      this.write({
        generation: current?.generation ?? 0,
        ownerId: current?.ownerId ?? this.ownerId,
        pid: process.pid,
        intent: 'stopped',
        updatedAt: Date.now(),
      });
    } else if (existsSync(this.manualStopPath)) {
      unlinkSync(this.manualStopPath);
    }
  }

  isRestarting(): boolean {
    const state = this.read();
    if (!state || state.intent !== 'restarting') return false;
    return Date.now() - state.updatedAt < RESTART_STALE_MS;
  }

  /**
   * Mark a restart in progress and take the lock identity. Observers must not
   * spawn while this is fresh. The window that clicked Restart becomes the
   * intended next owner (including when an observer requests restart).
   */
  beginRestart(): void {
    const current = this.read();
    this.write({
      generation: (current?.generation ?? 0) + 1,
      ownerId: this.ownerId,
      pid: process.pid,
      intent: 'restarting',
      updatedAt: Date.now(),
    });
  }

  endRestart(): void {
    const current = this.read();
    if (!current || current.ownerId !== this.ownerId) return;
    this.write({
      ...current,
      intent: 'running',
      pid: process.pid,
      updatedAt: Date.now(),
    });
  }

  /**
   * Exclusive claim to spawn the server. Write-then-read so concurrent claimants
   * lose unless they are the last writer with a matching ownerId.
   *
   * Returns false when another live owner holds a non-stopped lock — including
   * a restart that has gone past RESTART_STALE_MS — so observers never dual-start
   * while the restarter's extension host is still alive. Dead pids (crashed
   * owner) or intent `stopped` can be stolen.
   */
  tryClaimOwner(): boolean {
    const current = this.read();
    if (current) {
      if (current.ownerId === this.ownerId) {
        this.write({
          ...current,
          pid: process.pid,
          intent: current.intent === 'stopped' ? 'running' : current.intent,
          updatedAt: Date.now(),
        });
        return true;
      }
      if (current.intent !== 'stopped' && pidAlive(current.pid)) {
        return false;
      }
    }

    const next: OwnerLockState = {
      generation: (current?.generation ?? 0) + 1,
      ownerId: this.ownerId,
      pid: process.pid,
      intent: 'running',
      updatedAt: Date.now(),
    };
    this.write(next);
    const confirm = this.read();
    return confirm?.ownerId === this.ownerId && confirm.generation === next.generation;
  }

  /** Drop the lock only if we currently own it. */
  releaseOwner(): void {
    const current = this.read();
    if (!current || current.ownerId !== this.ownerId) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private write(state: OwnerLockState): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmpPath = `${this.lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(state) + '\n', 'utf-8');
      try {
        renameSync(tmpPath, this.lockPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Windows cannot replace an existing dest with rename().
        if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
          if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
          renameSync(tmpPath, this.lockPath);
        } else {
          throw err;
        }
      }
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}