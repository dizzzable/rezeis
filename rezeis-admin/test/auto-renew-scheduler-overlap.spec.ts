import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutoRenewScheduler } from '../src/modules/auto-renew/auto-renew.scheduler';

/**
 * Two cycles walking the same window tell the same customer twice.
 *
 * The cron fires every minute, and the cycle stopped being short when expiry
 * notices learned to quote the customer's traffic and devices: each notice may
 * now consult the panel. A slow panel stretches one cycle past its own tick,
 * and both cycles then read "not yet notified" for everyone the first has not
 * reached — because the 20-hour throttle is a read-then-write with no unique
 * constraint underneath, so it stops a LATER cycle and not a concurrent one.
 */
function buildScheduler(runCycle: () => Promise<unknown>) {
  const scheduler = new AutoRenewScheduler(
    { runCycle } as never,
    { set: async () => undefined, get: async () => null } as never,
  );
  return scheduler;
}

describe('the auto-renew tick does not overlap itself', () => {
  it('stands down while a cycle is still running', async () => {
    let started = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = buildScheduler(async () => {
      started += 1;
      await blocked;
      return {};
    });

    const first = scheduler.tick();
    await Promise.resolve();
    // Second tick lands while the first is still inside the cycle.
    //
    // NOT awaited, deliberately. Without the guard this call enters the cycle
    // and blocks on the same promise, so awaiting it would hang the file until
    // the runner's timeout — a failure, but a slow and unreadable one. Letting
    // it run and asserting the counter turns the same regression into a plain
    // "expected 1, got 2".
    const second = scheduler.tick();
    await Promise.resolve();
    assert.equal(started, 1);

    release();
    await first;
    await second;
  });

  it('runs again once the previous cycle has finished', async () => {
    let started = 0;
    const scheduler = buildScheduler(async () => {
      started += 1;
      return {};
    });

    await scheduler.tick();
    await scheduler.tick();

    assert.equal(started, 2);
  });

  it('releases the guard when a cycle throws, rather than silencing the scheduler for ever', async () => {
    let started = 0;
    const scheduler = buildScheduler(async () => {
      started += 1;
      throw new Error('cycle exploded');
    });

    await scheduler.tick();
    await scheduler.tick();

    assert.equal(started, 2);
  });
});
