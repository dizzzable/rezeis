import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { PrismaService } from '../src/common/prisma/prisma.service';
import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { StrippedPlanSnapshotRepairService } from '../src/modules/imports/services/stripped-plan-snapshot-repair.service';

/**
 * WHERE the plan snapshot repair runs: at boot, in the process that runs
 * scheduled work, and never in a way that holds boot up or fails it. What it
 * writes is pinned on a real database in
 * `stripped-plan-snapshot-repair-postgres.spec.ts`.
 */

function withRole(role: string | undefined): void {
  if (role === undefined) delete process.env.RUID_PROCESS_ROLE;
  else process.env.RUID_PROCESS_ROLE = role;
  _resetProcessRoleCacheForTests();
}

function service(execute: () => Promise<number>): { repair: StrippedPlanSnapshotRepairService; calls: () => number } {
  let calls = 0;
  const prisma = {
    $executeRaw: async () => {
      calls += 1;
      return execute();
    },
  };
  return { repair: new StrippedPlanSnapshotRepairService(prisma as unknown as PrismaService), calls: () => calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('StrippedPlanSnapshotRepairService at boot', () => {
  const previous = process.env.RUID_PROCESS_ROLE;
  afterEach(() => withRole(previous));

  it('runs in the worker, and in the one container of a small install', async () => {
    for (const role of ['worker', 'all', undefined]) {
      withRole(role);
      const { repair, calls } = service(async () => 0);
      repair.onApplicationBootstrap();
      await settle();
      assert.equal(calls(), 1, String(role));
    }
  });

  it('does not run in the API process, so two processes do not both run it on every deploy', async () => {
    withRole('api');
    const { repair, calls } = service(async () => 0);
    repair.onApplicationBootstrap();
    await settle();
    assert.equal(calls(), 0);
  });

  it('neither waits for the database nor fails boot when it cannot reach it', async () => {
    withRole('worker');
    let release: () => void = () => undefined;
    const pending = new Promise<number>((_resolve, reject) => {
      release = () => reject(new Error('database is down'));
    });
    const { repair, calls } = service(() => pending);
    assert.equal(repair.onApplicationBootstrap(), undefined, 'returns at once, with nothing to await');
    await settle();
    assert.equal(calls(), 1);
    release();
    await settle();
  });
});
