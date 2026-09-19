import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { CONNECT_HELP_CATCH_UP_MS } from '../src/modules/connect-signal/connect-signal.constants';
import {
  CONNECT_HELP_BATCH,
  CONNECT_HELP_CLOSING_MS,
  CONNECT_HELP_CRON,
  CONNECT_HELP_LAST_RESULT_KEY,
  CONNECT_HELP_RESUME_CAP,
} from '../src/modules/connect-help/connect-help.constants';
import { connectHelpCandidatesSql, connectHelpWindow } from '../src/modules/connect-help/connect-help.sql';
import { ConnectHelpSweepService } from '../src/modules/connect-help/services/connect-help-sweep.service';

/**
 * The sender's clock and its cadence — the parts that need no database. What
 * it decides about real rows is `connect-help-postgres.spec.ts`.
 */

const HOUR = 60 * 60 * 1000;

describe('the window, on a fixed clock', () => {
  const now = new Date('2026-09-19T10:40:00.000Z');

  it('helps what is N hours old, and catches up 72 hours further back', () => {
    const window = connectHelpWindow(now, 24);
    assert.equal(window.to.toISOString(), '2026-09-18T10:40:00.000Z');
    assert.equal(window.from.toISOString(), '2026-09-15T10:40:00.000Z');
    assert.equal(CONNECT_HELP_CATCH_UP_MS, 72 * HOUR);
  });

  it('moves with the operator’s hours', () => {
    const window = connectHelpWindow(now, 1);
    assert.equal(window.to.toISOString(), '2026-09-19T09:40:00.000Z');
    assert.equal(window.from.toISOString(), '2026-09-16T09:40:00.000Z');
    const week = connectHelpWindow(now, 168);
    assert.equal(week.to.toISOString(), '2026-09-12T10:40:00.000Z');
  });

  it('keeps most of a cycle for new candidates: resumed ladders take at most a fifth of it', () => {
    assert.equal(CONNECT_HELP_BATCH, 100);
    assert.equal(CONNECT_HELP_RESUME_CAP, 20);
  });

  it('closes on the last twenty minutes, and bounds the payment’s creation a day earlier', () => {
    const window = connectHelpWindow(now, 24);
    assert.equal(CONNECT_HELP_CLOSING_MS, 20 * 60 * 1000);
    assert.equal(window.closingBefore.toISOString(), '2026-09-15T11:00:00.000Z');
    assert.equal(window.createdSince.toISOString(), '2026-09-14T10:40:00.000Z');
  });

  it('binds every instant as a value and never asks the database for now()', () => {
    for (const includeTrials of [false, true]) {
      const query = connectHelpCandidatesSql({
        now,
        settings: { enabled: true, delayHours: 24, includeTrials },
        limit: CONNECT_HELP_BATCH,
        resumeCap: CONNECT_HELP_RESUME_CAP,
      });
      assert.doesNotMatch(query.sql, /now\(\)|current_timestamp|localtimestamp/i);
      const instants = query.values.filter((value): value is Date => value instanceof Date);
      // The paid window's three (and the trial window's two): the begun ladders
      // are listed at any age, so they bind none.
      assert.equal(instants.length, includeTrials ? 5 : 3, `${instants.length} bound instants`);
      assert.equal(query.values.includes(CONNECT_HELP_BATCH), true);
      assert.equal(query.values.includes(CONNECT_HELP_RESUME_CAP), true, 'the resumed ladders are not capped');
      assert.equal(/'trial'::text/.test(query.sql), includeTrials, 'the trial arm follows the switch');
    }
  });
});

describe('the cadence', () => {
  const savedRole = process.env.RUID_PROCESS_ROLE;

  afterEach(() => {
    if (savedRole === undefined) delete process.env.RUID_PROCESS_ROLE;
    else process.env.RUID_PROCESS_ROLE = savedRole;
    _resetProcessRoleCacheForTests();
  });

  function counted(cycle: () => Promise<unknown>) {
    const service = new ConnectHelpSweepService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    let runs = 0;
    (service as unknown as { runCycle: () => Promise<unknown> }).runCycle = async () => {
      runs += 1;
      return cycle();
    };
    return { service, runs: () => runs };
  }

  it('runs every ten minutes', () => {
    assert.equal(CONNECT_HELP_CRON, '*/10 * * * *');
    assert.equal(CONNECT_HELP_LAST_RESULT_KEY, 'rezeis:connect-help:last-result');
  });

  it('never runs in the API process', async () => {
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const { service, runs } = counted(async () => undefined);
    await service.tick();
    assert.equal(runs(), 0);
  });

  it('runs in the worker, one cycle at a time', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    let finish!: () => void;
    let started = 0;
    // The first cycle hangs until released; any later one returns at once.
    const { service, runs } = counted(() => {
      started += 1;
      return started > 1
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            finish = resolve;
          });
    });
    const first = service.tick();
    await service.tick();
    assert.equal(runs(), 1, 'an overlapping tick started a second cycle');
    finish();
    await first;
    await service.tick();
    assert.equal(runs(), 2);
  });

  it('comes back after a cycle that threw', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    const { service, runs } = counted(async () => {
      throw new Error('database gone');
    });
    await service.tick();
    await service.tick();
    assert.equal(runs(), 2, 'a thrown cycle left the running flag set');
  });
});
