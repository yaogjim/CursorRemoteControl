import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runChild(dataDir: string, source: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDir, ...extraEnv },
      encoding: 'utf8',
    },
  ).trim();
}

describe('cross-process supervision recovery', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('starts grants pending recovery and keeps an interrupted dispatch unknown without replay', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'supervision-process-'));
    dirs.push(dataDir);
    const created = JSON.parse(runChild(dataDir, `
      import { SupervisionManager } from './src/server/supervision-manager.ts';
      import { OperationJournal } from './src/server/operation-journal.ts';
      const manager = new SupervisionManager({ dataDir: process.env.DATA_DIR });
      const created = manager.createGrant({
        workspace: { id: 'ws-process', uri: { scheme: 'file', authority: '', path: '/tmp/project' } },
        readComposerIds: ['composer-process'],
        writeComposerIds: ['composer-process'],
        goal: 'verify process recovery',
        planVersion: 'plan-process',
        authorizationVersion: 'auth-process',
        expiresAt: Date.now() + 60_000,
        operationLimit: 1,
        allowedActionTypes: ['send_message'],
        allowedModes: ['agent'],
        allowedModels: ['Auto'],
      });
      const redeemed = manager.redeem(created.redeemCode);
      const journal = new OperationJournal({ dataDir: process.env.DATA_DIR });
      journal.create({
        operationId: 'operation-process-1',
        payloadDigest: 'digest-process-1',
        target: { workspaceId: 'ws-process', composerId: 'composer-process', grantId: created.grant.grantId },
      });
      journal.markDispatching('operation-process-1');
      console.log(JSON.stringify({ grantId: created.grant.grantId, token: redeemed.token }));
    `)) as { grantId: string; token: string };

    const recovered = JSON.parse(runChild(dataDir, `
      import { SupervisionManager } from './src/server/supervision-manager.ts';
      import { OperationJournal } from './src/server/operation-journal.ts';
      const manager = new SupervisionManager({ dataDir: process.env.DATA_DIR });
      const journal = new OperationJournal({ dataDir: process.env.DATA_DIR });
      const grant = manager.getGrant(process.env.GRANT_ID);
      const operation = journal.get('operation-process-1');
      console.log(JSON.stringify({
        grantStatus: grant?.status,
        pauseReasons: grant?.pauseReasons,
        tokenValid: Boolean(manager.authenticate(process.env.TOKEN)),
        operationStatus: operation?.status,
      }));
    `, { GRANT_ID: created.grantId, TOKEN: created.token })) as {
      grantStatus: string;
      pauseReasons: string[];
      tokenValid: boolean;
      operationStatus: string;
    };

    assert.equal(recovered.grantStatus, 'pending_recovery');
    assert.equal(recovered.pauseReasons.includes('pending_recovery'), true);
    assert.equal(recovered.tokenValid, false);
    assert.equal(recovered.operationStatus, 'unknown');
  });
});