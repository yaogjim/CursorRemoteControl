import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetUiCoordinator,
  TargetUiError,
} from '../src/server/target-ui-coordinator.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TargetUiCoordinator', () => {
  it('serializes concurrent ops on the same targetId', async () => {
    const coord = new TargetUiCoordinator();
    const log: string[] = [];
    const first = coord.enqueue('t1', async () => {
      log.push('a-start');
      await sleep(40);
      log.push('a-end');
      return 'a';
    });
    const second = coord.enqueue('t1', async () => {
      log.push('b-start');
      log.push('b-end');
      return 'b';
    });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, ['a', 'b']);
    assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different targetIds in parallel', async () => {
    const coord = new TargetUiCoordinator();
    const log: string[] = [];
    const a = coord.enqueue('t1', async () => {
      log.push('a-start');
      await sleep(50);
      log.push('a-end');
    });
    const b = coord.enqueue('t2', async () => {
      log.push('b-start');
      await sleep(50);
      log.push('b-end');
    });
    await Promise.all([a, b]);
    const bStart = log.indexOf('b-start');
    const aEnd = log.indexOf('a-end');
    assert.ok(bStart >= 0 && aEnd >= 0);
    assert.ok(bStart < aEnd, 'second target should start before the first finishes');
  });

  it('cancels queued work so it never runs', async () => {
    const coord = new TargetUiCoordinator();
    let ranSecond = false;
    const first = coord.enqueue('t1', async ({ signal }) => {
      await sleep(60);
      if (signal.aborted) throw new TargetUiError('cancelled', 't1');
      return 'first';
    });
    const second = coord.enqueue('t1', async () => {
      ranSecond = true;
      return 'second';
    });
    coord.cancel('t1');
    await assert.rejects(() => first, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'cancelled');
      return true;
    });
    await assert.rejects(() => second, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'cancelled');
      return true;
    });
    assert.equal(ranSecond, false);
  });

  it('times out a hung op and lets the next op run', async () => {
    const coord = new TargetUiCoordinator();
    const hung = coord.enqueue('t1', async () => {
      await sleep(200);
      return 'hung';
    }, { timeoutMs: 30 });
    await assert.rejects(() => hung, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'timeout');
      return true;
    });
    const next = await coord.enqueue('t1', async () => 'ok', { timeoutMs: 200 });
    assert.equal(next, 'ok');
  });

  it('does not start the next mutation while a timed-out callback is still running', async () => {
    const coord = new TargetUiCoordinator();
    let hungActive = false;
    const hung = coord.enqueue('t1', async () => {
      hungActive = true;
      await sleep(80);
      hungActive = false;
      return 'hung';
    }, { timeoutMs: 15 });
    const next = coord.enqueue('t1', async () => {
      assert.equal(hungActive, false, 'timed-out callback must finish before the next mutation');
      return 'ok';
    });
    await assert.rejects(() => hung, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'timeout');
      assert.equal(hungActive, true, 'timeout must reject before the callback finishes');
      return true;
    });
    assert.equal(await next, 'ok');
  });

  it('does not start the next mutation while a cancelled callback is still running', async () => {
    const coord = new TargetUiCoordinator();
    let firstActive = false;
    const first = coord.enqueue('t1', async () => {
      firstActive = true;
      await sleep(80);
      firstActive = false;
      return 'first';
    });
    await sleep(10);
    coord.cancel('t1');
    await assert.rejects(() => first, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'cancelled');
      return true;
    });
    const next = await coord.enqueue('t1', async () => {
      assert.equal(firstActive, false, 'cancelled callback must finish before the next mutation');
      return 'ok';
    });
    assert.equal(next, 'ok');
  });

  it('invalidates queued ops when generation changes', async () => {
    const coord = new TargetUiCoordinator();
    let ranSecond = false;
    const first = coord.enqueue('t1', async () => {
      await sleep(50);
      return 'first';
    });
    const queuedGen = coord.getGeneration('t1');
    const second = coord.enqueue('t1', async () => {
      ranSecond = true;
      return 'second';
    }, { generation: queuedGen });
    coord.bumpGeneration('t1');
    await assert.rejects(() => first, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'generation_changed');
      return true;
    });
    await assert.rejects(() => second, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'generation_changed');
      return true;
    });
    assert.equal(ranSecond, false);
    const after = await coord.enqueue('t1', async () => 'fresh');
    assert.equal(after, 'fresh');
  });

  it('rejects enqueue when the provided generation is already stale', async () => {
    const coord = new TargetUiCoordinator();
    const gen = coord.getGeneration('t1');
    coord.bumpGeneration('t1');
    await assert.rejects(
      () => coord.enqueue('t1', async () => 'nope', { generation: gen }),
      (err: unknown) => {
        assert.ok(err instanceof TargetUiError);
        assert.equal(err.code, 'generation_changed');
        return true;
      },
    );
  });

  it('aborts via the caller AbortSignal', async () => {
    const coord = new TargetUiCoordinator();
    const ac = new AbortController();
    const op = coord.enqueue('t1', async ({ signal }) => {
      await sleep(80);
      if (signal.aborted) throw new TargetUiError('aborted', 't1');
      return 'done';
    }, { signal: ac.signal, timeoutMs: 500 });
    ac.abort();
    await assert.rejects(() => op, (err: unknown) => {
      assert.ok(err instanceof TargetUiError);
      assert.equal(err.code, 'aborted');
      return true;
    });
  });
});