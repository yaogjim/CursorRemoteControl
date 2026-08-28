import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  LifecycleLock,
  OWNER_LOCK_FILE,
  RESTART_STALE_MS,
  pidAlive,
  type OwnerLockState,
} from '../extension/src/lifecycle-lock.js';

describe('pidAlive', () => {
  it('rejects non-positive pids', () => {
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
  });

  it('detects the current process', () => {
    assert.equal(pidAlive(process.pid), true);
  });
});

describe('LifecycleLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifecycle-lock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function plant(state: OwnerLockState): void {
    writeFileSync(join(dir, OWNER_LOCK_FILE), JSON.stringify(state) + '\n');
  }

  it('creates the data directory on first claim', () => {
    const nested = join(dir, 'missing');
    const lock = new LifecycleLock(nested, 'win-a');
    assert.equal(lock.tryClaimOwner(), true);
    assert.equal(existsSync(join(nested, OWNER_LOCK_FILE)), true);
  });

  it('lets the first window claim and blocks a live peer', () => {
    const a = new LifecycleLock(dir, 'win-a');
    const b = new LifecycleLock(dir, 'win-b');
    assert.equal(a.tryClaimOwner(), true);
    assert.equal(b.tryClaimOwner(), false);
    assert.equal(a.isOwnedByUs(), true);
    assert.equal(b.isOwnedByUs(), false);
    assert.equal(a.read()?.generation, 1);
  });

  it('allows reclaim by the current owner', () => {
    const a = new LifecycleLock(dir, 'win-a');
    assert.equal(a.tryClaimOwner(), true);
    const gen = a.read()?.generation;
    assert.equal(a.tryClaimOwner(), true);
    assert.equal(a.read()?.generation, gen);
  });

  it('lets a window steal a lock whose owner pid is dead', () => {
    plant({
      generation: 3,
      ownerId: 'dead-window',
      pid: 0,
      intent: 'running',
      updatedAt: Date.now(),
    });
    const b = new LifecycleLock(dir, 'win-b');
    assert.equal(b.tryClaimOwner(), true);
    assert.equal(b.read()?.ownerId, 'win-b');
    assert.equal(b.read()?.generation, 4);
  });

  it('does not steal a live restarting lock even if it looks stale', () => {
    plant({
      generation: 2,
      ownerId: 'restarter',
      pid: process.pid,
      intent: 'restarting',
      updatedAt: Date.now() - RESTART_STALE_MS - 1,
    });
    const observer = new LifecycleLock(dir, 'observer');
    assert.equal(observer.tryClaimOwner(), false);
    assert.equal(observer.read()?.ownerId, 'restarter');
  });

  it('steals a stopped lock even if the previous owner pid is still live', () => {
    plant({
      generation: 1,
      ownerId: 'old-owner',
      pid: process.pid,
      intent: 'stopped',
      updatedAt: Date.now(),
    });
    const next = new LifecycleLock(dir, 'new-owner');
    assert.equal(next.tryClaimOwner(), true);
    assert.equal(next.read()?.ownerId, 'new-owner');
  });

  it('blocks observers while beginRestart is in flight', () => {
    const owner = new LifecycleLock(dir, 'owner');
    const observer = new LifecycleLock(dir, 'observer');
    assert.equal(owner.tryClaimOwner(), true);
    owner.beginRestart();
    assert.equal(owner.isRestarting(), true);
    assert.equal(observer.tryClaimOwner(), false);
    assert.equal(observer.isRestarting(), true);
    owner.endRestart();
    assert.equal(owner.isRestarting(), false);
    assert.equal(owner.read()?.intent, 'running');
  });

  it('releaseOwner is a no-op for a non-owner', () => {
    const a = new LifecycleLock(dir, 'win-a');
    const b = new LifecycleLock(dir, 'win-b');
    assert.equal(a.tryClaimOwner(), true);
    b.releaseOwner();
    assert.equal(existsSync(join(dir, OWNER_LOCK_FILE)), true);
    a.releaseOwner();
    assert.equal(existsSync(join(dir, OWNER_LOCK_FILE)), false);
  });

  it('manual-stop flag is shared and creates the directory', () => {
    const nested = join(dir, 'flags');
    const a = new LifecycleLock(nested, 'win-a');
    const b = new LifecycleLock(nested, 'win-b');
    a.setManualStop(true);
    assert.equal(a.isManualStopped(), true);
    assert.equal(b.isManualStopped(), true);
    assert.equal(a.read()?.intent, 'stopped');
    b.setManualStop(false);
    assert.equal(a.isManualStopped(), false);
  });

  it('leaves no tmp siblings after lock writes', () => {
    const lock = new LifecycleLock(dir, 'win-a');
    lock.tryClaimOwner();
    lock.beginRestart();
    lock.endRestart();
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});