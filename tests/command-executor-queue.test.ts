import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandExecutor } from '../src/server/command-executor.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeClickClient(log: string[], label: string, delayMs: number): CdpClient {
  return {
    isConnected: () => true,
    click: async (selector: string) => {
      log.push(`${label}:start:${selector}`);
      await sleep(delayMs);
      log.push(`${label}:end:${selector}`);
    },
    evaluate: async () => null,
  } as unknown as CdpClient;
}

describe('CommandExecutor per-window serial queue', () => {
  it('serializes concurrent commands on the same window client', async () => {
    const log: string[] = [];
    const client = fakeClickClient(log, 'w1', 40);
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(client);

    const first = executor.clickAction('cmd-1', '#one');
    const second = executor.clickAction('cmd-2', '#two');
    await Promise.all([first, second]);

    assert.deepEqual(log, [
      'w1:start:#one',
      'w1:end:#one',
      'w1:start:#two',
      'w1:end:#two',
    ]);
  });

  it('does not let a second window wait on a different client', async () => {
    const log: string[] = [];
    const clientA = fakeClickClient(log, 'A', 50);
    const clientB = fakeClickClient(log, 'B', 50);
    const executor = new CommandExecutor({} as SelectorConfig);

    executor.setClient(clientA);
    const first = executor.clickAction('cmd-a', '#a');
    executor.setClient(clientB);
    const second = executor.clickAction('cmd-b', '#b');
    await Promise.all([first, second]);

    const aStart = log.indexOf('A:start:#a');
    const bStart = log.indexOf('B:start:#b');
    const aEnd = log.indexOf('A:end:#a');
    assert.ok(aStart >= 0 && bStart >= 0 && aEnd >= 0);
    assert.ok(bStart < aEnd, 'second window should start before the first window finishes');
  });

  it('keeps the existing not-connected result without queueing work', async () => {
    const executor = new CommandExecutor({} as SelectorConfig);
    const result = await executor.clickAction('cmd-x', '#x');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not connected to Cursor');
  });
});