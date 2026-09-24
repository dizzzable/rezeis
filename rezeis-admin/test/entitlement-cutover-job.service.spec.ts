import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  ADD_ON_CUTOVER_JOB_ID,
  ADD_ON_CUTOVER_QUEUE,
  ADD_ON_CUTOVER_TICK_JOB,
} from '../src/modules/add-on-entitlements/add-on-cutover.constants';
import { EntitlementCutoverProcessor } from '../src/modules/add-on-entitlements/entitlement-cutover.processor';
import type { CutoverRunOptions } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { EntitlementCutoverJobService } from '../src/modules/add-on-entitlements/services/entitlement-cutover-job.service';
import { admitThroughBullMq, OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * The background cutover's scheduling half. The pass itself — paging,
 * idempotency, per-row failure, restart — is proved against PostgreSQL in
 * `add-on-cutover-job-postgres.spec.ts`; this file proves WHEN a pass is
 * queued, under WHICH id, and that the queue it is handed is BullMQ's own
 * admission check rather than a fake that takes any id.
 */

const ENV = ['ADDON_ENTITLEMENT_SHADOW', 'RUID_PROCESS_ROLE'] as const;
const saved: Record<string, string | undefined> = {};

function build() {
  const queue = new OfflineBullMqQueue<unknown>(ADD_ON_CUTOVER_QUEUE);
  const runs: CutoverRunOptions[] = [];
  const cutover = {
    runCutover: async (options: CutoverRunOptions) => {
      runs.push(options);
      return { dryRun: false, candidates: 0 };
    },
  };
  const service = new EntitlementCutoverJobService(cutover as never, queue.asQueue());
  return { queue, runs, service };
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  // Every case starts with stage 1 explicitly OFF and says so when it wants it
  // on. Unset is not "off" any more: the shipped default is ON (24.09.2026),
  // and the cases that are about that default unset it themselves.
  process.env.ADDON_ENTITLEMENT_SHADOW = 'false';
  process.env.RUID_PROCESS_ROLE = 'worker';
  _resetProcessRoleCacheForTests();
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetProcessRoleCacheForTests();
});

describe('EntitlementCutoverJobService — the tick and its id', () => {
  it('uses a fixed id BullMQ admits: no colon, not an integer', async () => {
    // Literal, not the constant: the check must not move with the value.
    assert.equal(ADD_ON_CUTOVER_JOB_ID, 'add-on-entitlement-cutover-tick');
    const job = await admitThroughBullMq(ADD_ON_CUTOVER_QUEUE, ADD_ON_CUTOVER_TICK_JOB, {}, { jobId: ADD_ON_CUTOVER_JOB_ID });
    assert.equal(job.id, ADD_ON_CUTOVER_JOB_ID);
  });

  it('queues one tick, and a second enqueue while it exists adds nothing', async () => {
    const { queue, service } = build();

    assert.equal(await service.enqueueTick(), true);
    assert.equal(await service.enqueueTick(), true);

    assert.deepEqual(queue.refused, [], 'BullMQ refused the tick');
    assert.deepEqual(queue.heldIds(), [ADD_ON_CUTOVER_JOB_ID]);
    assert.deepEqual(queue.admitted.map((add) => add.collapsed), [false, true]);
    // The id must be FREE again once a pass ends, or every later add would
    // collapse onto a retained finished job and nothing would ever run again.
    assert.equal(queue.admitted[0]!.opts.removeOnComplete, true);
    assert.equal(queue.admitted[0]!.opts.removeOnFail, true);
    assert.equal(queue.admitted[0]!.name, ADD_ON_CUTOVER_TICK_JOB);
  });

  it('collapses onto a tick that is already running', async () => {
    const { queue, service } = build();
    await service.enqueueTick();
    queue.setState(ADD_ON_CUTOVER_JOB_ID, 'active');

    await service.enqueueTick();

    assert.deepEqual(queue.heldIds(), [ADD_ON_CUTOVER_JOB_ID]);
    assert.equal(queue.admitted[1]!.collapsed, true);
  });

  it('never throws when Redis is down; the next cron retries', async () => {
    const { queue, service } = build();
    queue.goDown();
    assert.equal(await service.enqueueTick(), false);
  });
});

describe('EntitlementCutoverJobService — when a tick is queued', () => {
  it('queues nothing while stage 1 is off', async () => {
    const { queue, service } = build();
    assert.equal(await service.schedule(), false);
    assert.deepEqual(queue.heldIds(), []);
  });

  it('queues a tick every cron while stage 1 is on', async () => {
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const { queue, service } = build();
    assert.equal(await service.schedule(), true);
    assert.deepEqual(queue.heldIds(), [ADD_ON_CUTOVER_JOB_ID]);
  });

  it('queues nothing on a process that does not run schedules', async () => {
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const { queue, service } = build();
    assert.equal(await service.schedule(), false);
    assert.deepEqual(queue.heldIds(), []);
  });

  it('queues the first tick at boot without the boot waiting for it', async () => {
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const { queue, service } = build();
    const returned = service.onApplicationBootstrap();
    assert.equal(returned, undefined, 'bootstrap must not hand Nest a promise to await');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(queue.heldIds(), [ADD_ON_CUTOVER_JOB_ID]);
  });

  it('starts on an install that sets nothing: the shipped default is ON', async () => {
    delete process.env.ADDON_ENTITLEMENT_SHADOW;
    const { queue, service } = build();
    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(queue.heldIds(), [ADD_ON_CUTOVER_JOB_ID], 'the first tick is queued at boot');
    assert.equal(await service.schedule(), true, 'and by every cron after it');
  });
});

describe('EntitlementCutoverJobService — the pass', () => {
  it('re-reads the flag: a tick queued before stage 1 was switched off does nothing', async () => {
    const { runs, service } = build();
    assert.equal(await service.runTick(), null);
    assert.deepEqual(runs, []);
  });

  it('runs the pass on an install that sets nothing: the shipped default is ON', async () => {
    delete process.env.ADDON_ENTITLEMENT_SHADOW;
    const { runs, service } = build();
    await service.runTick();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.dryRun, false);
  });

  it('runs a bounded, applying pass that stops at shutdown', async () => {
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const { runs, service } = build();
    const now = 1_790_000_000_000;

    await service.runTick(now);

    assert.equal(runs.length, 1);
    const options = runs[0]!;
    assert.equal(options.dryRun, false);
    assert.equal(options.batchSize, 200);
    assert.equal(options.maxRows, 5_000);
    assert.equal(options.deadline, now + 180_000);
    assert.equal(options.pauseMs, 100);
    assert.equal(options.shouldStop?.(), false);
    service.beforeApplicationShutdown();
    assert.equal(options.shouldStop?.(), true, 'a pass in flight must see the shutdown');
  });
});

describe('EntitlementCutoverProcessor', () => {
  it('runs a tick for its own job and ignores any other name', async () => {
    let ticks = 0;
    const processor = new EntitlementCutoverProcessor({
      runTick: async () => {
        ticks += 1;
        return null;
      },
    } as never);

    await processor.process({ name: ADD_ON_CUTOVER_TICK_JOB } as never);
    await processor.process({ name: 'something-else' } as never);

    assert.equal(ticks, 1);
  });
});
