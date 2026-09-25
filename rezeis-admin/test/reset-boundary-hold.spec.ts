import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnEntitlementState, AddOnLifetime, type Prisma } from '@prisma/client';

import { entitlementEndBound } from '../src/modules/add-on-entitlements/domain/add-on-lifetime';
import { RESET_EXPIRY_MARGIN_MS } from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import {
  CALENDAR_BATCH_WINDOW_MS,
  confirmsCalendarReset,
  confirmsOwnReset,
  isHeldForResetConfirmation,
  RESET_CONFIRMATION_HOLD_MS,
  RESET_CONFIRMATION_TOLERANCE_MS,
  showsScheduledRun,
} from '../src/modules/add-on-entitlements/services/reset-boundary-confirmation.service';
import {
  RUN_STAMP_SPREAD_MS,
  SCHEDULED_RUN_SLACK_MS,
} from '../src/modules/add-on-entitlements/switches/reset-schedule-check';
import { labRun } from './helpers/remnawave-reset-lab';

/**
 * The hold, as a rule on one row, and the two confirmations — the pieces of
 * `reset-boundary-confirmation.service.ts` that are plain functions. The SQL
 * twin of the hold and the whole sweep are proved on PostgreSQL in
 * `reset-boundary-confirmation-postgres.spec.ts`.
 */

const PLANNED = new Date('2026-10-01T00:20:00.000Z');
const AT_RESET = new Date(PLANNED.getTime() + RESET_EXPIRY_MARGIN_MS);
const MINUTE = 60_000;

function row(patch: Partial<Parameters<typeof isHeldForResetConfirmation>[0]> = {}) {
  return {
    state: AddOnEntitlementState.ACTIVE,
    lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
    expiresAt: AT_RESET,
    expiryEpoch: { plannedEndsAt: PLANNED, closedAt: null },
    ...patch,
  };
}

describe('the hold — which add-on waits for Remnawave\'s reset', () => {
  it('pins its numbers: six hours at most, five minutes of clock skew, an hour for the batch', () => {
    assert.equal(RESET_CONFIRMATION_HOLD_MS, 6 * 60 * MINUTE);
    assert.equal(RESET_CONFIRMATION_TOLERANCE_MS, 5 * MINUTE);
    assert.equal(CALENDAR_BATCH_WINDOW_MS, 60 * MINUTE);
  });

  it('holds an ACTIVE add-on that ends AT the reset, from its end until six hours past it', () => {
    assert.equal(isHeldForResetConfirmation(row(), new Date(AT_RESET.getTime() + MINUTE)), true);
    assert.equal(
      isHeldForResetConfirmation(row(), new Date(AT_RESET.getTime() + RESET_CONFIRMATION_HOLD_MS - 1)),
      true,
    );
    assert.equal(
      isHeldForResetConfirmation(row(), new Date(AT_RESET.getTime() + RESET_CONFIRMATION_HOLD_MS)),
      false,
      'the hold runs out',
    );
  });

  it('releases it the moment its boundary is closed', () => {
    const closed = row({ expiryEpoch: { plannedEndsAt: PLANNED, closedAt: new Date(PLANNED.getTime() + MINUTE) } });
    assert.equal(isHeldForResetConfirmation(closed, new Date(AT_RESET.getTime() + MINUTE)), false);
  });

  it('never holds what ends with the subscription: cut short by it, sold so, or bound to no reset', () => {
    const now = new Date(AT_RESET.getTime() + MINUTE);
    const cutShort = row({ expiresAt: new Date(AT_RESET.getTime() - 1) });
    assert.equal(
      entitlementEndBound({ lifetime: cutShort.lifetime, expiresAt: cutShort.expiresAt, epochPlannedEndsAt: PLANNED }),
      'subscription_end',
    );
    assert.equal(isHeldForResetConfirmation(cutShort, now), false);
    assert.equal(isHeldForResetConfirmation(row({ lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END }), now), false);
    assert.equal(isHeldForResetConfirmation(row({ expiryEpoch: null }), now), false);
    assert.equal(isHeldForResetConfirmation(row({ expiresAt: null }), now), false);
  });

  it('holds only what is still ACTIVE', () => {
    const now = new Date(AT_RESET.getTime() + MINUTE);
    for (const state of [AddOnEntitlementState.EXPIRING, AddOnEntitlementState.EXPIRED, AddOnEntitlementState.REVERSED]) {
      assert.equal(isHeldForResetConfirmation(row({ state }), now), false, state);
    }
  });
});

describe('what confirms a reset', () => {
  it('a calendar boundary: a reset from five minutes before to an hour after the planned instant', () => {
    assert.equal(confirmsCalendarReset(new Date(PLANNED.getTime() + 27), PLANNED), true);
    assert.equal(confirmsCalendarReset(new Date(PLANNED.getTime() - 5 * MINUTE), PLANNED), true);
    assert.equal(confirmsCalendarReset(new Date(PLANNED.getTime() - 5 * MINUTE - 1), PLANNED), false, 'yesterday\'s batch, or a clock off');
    assert.equal(confirmsCalendarReset(new Date(PLANNED.getTime() + 60 * MINUTE), PLANNED), true);
    assert.equal(confirmsCalendarReset(new Date(PLANNED.getTime() + 60 * MINUTE + 1), PLANNED), false, 'a manual reset later on');
    assert.equal(confirmsCalendarReset(null, PLANNED), false);
  });

  it('a rolling subscription: its own counter reset at the planned instant or after, however long after', () => {
    assert.equal(confirmsOwnReset(new Date(PLANNED.getTime() + 11), PLANNED), true);
    assert.equal(confirmsOwnReset(new Date(PLANNED.getTime() + 20 * 24 * 60 * MINUTE), PLANNED), true);
    assert.equal(confirmsOwnReset(new Date(PLANNED.getTime() - 5 * MINUTE), PLANNED), true);
    assert.equal(confirmsOwnReset(new Date(PLANNED.getTime() - 5 * MINUTE - 1), PLANNED), false);
    assert.equal(confirmsOwnReset(null, PLANNED), false);
  });

  it('a calendar boundary for everybody: only a RUN — one instant on two profiles, or the cron minute\'s shape (R3a-04)', () => {
    const at = (ms: number, profiles = 1) => ({ resetAt: new Date(PLANNED.getTime() + ms), profiles });
    // One profile reset in Remnawave's own UI twenty minutes on: somebody's reset, not the run.
    assert.equal(showsScheduledRun([at(20 * MINUTE + 1_234)], PLANNED), false);
    // The same instant on two profiles: the run, however late within the hour.
    assert.equal(showsScheduledRun([at(20 * MINUTE + 1_234, 2)], PLANNED), true);
    // A lone profile stamped in the cron minute's first seconds: the run on time.
    assert.equal(showsScheduledRun([at(1_150)], PLANNED), true);
    assert.equal(showsScheduledRun([at(SCHEDULED_RUN_SLACK_MS)], PLANNED), true);
    assert.equal(showsScheduledRun([at(SCHEDULED_RUN_SLACK_MS + 1)], PLANNED), false);
    assert.equal(showsScheduledRun([at(-1)], PLANNED), false, 'a lone reset just before the minute is nobody\'s run');
    // Outside the batch window nothing is the run, shared or not.
    assert.equal(showsScheduledRun([at(60 * MINUTE + 1, 5)], PLANNED), false);
    assert.equal(showsScheduledRun([], PLANNED), false);
  });

  it('one run stamps a LIMITED profile milliseconds after the rest: a late run seen on one of each is still the run (R4-03)', () => {
    // The lab's DAY run on 3.4.4, as the stamps of a run that waited three
    // minutes behind another reset job — out of the cron minute's shape.
    const lab = labRun('3.4.4', 'shifted-clock', 'DAY');
    const limited = lab.find((stamp) => stamp.statusBefore === 'LIMITED')!;
    const other = lab.find((stamp) => stamp.statusBefore !== 'LIMITED')!;
    const spread = limited.at.getTime() - other.at.getTime();
    assert.ok(spread > 0 && spread <= RUN_STAMP_SPREAD_MS, `fixture: the lab's spread, ${spread} ms`);
    const late = (ms: number) => ({ resetAt: new Date(PLANNED.getTime() + 3 * MINUTE + ms), profiles: 1 });

    assert.equal(showsScheduledRun([late(0), late(spread)], PLANNED), true);
    assert.equal(showsScheduledRun([late(0), late(RUN_STAMP_SPREAD_MS)], PLANNED), true);
    assert.equal(showsScheduledRun([late(0), late(RUN_STAMP_SPREAD_MS + 1)], PLANNED), false, 'two resets, not one run');
    // A stamp outside the batch window is no part of the run.
    const outside = { resetAt: new Date(PLANNED.getTime() + 60 * MINUTE + 50), profiles: 1 };
    assert.equal(showsScheduledRun([{ resetAt: new Date(PLANNED.getTime() + 60 * MINUTE - 20), profiles: 1 }, outside], PLANNED), false);
  });
});

describe('term activation — the rolling anchor from the stamped profile', () => {
  function activation(options: {
    readonly stamped: Date | null;
    readonly panelCreatedAt?: string;
    /** The anchor the due term was minted with (P2): the profile's `createdAt` another term carried, or none. */
    readonly termAnchor?: Date | null;
  }) {
    const termUpdates: unknown[] = [];
    const panelReads: unknown[] = [];
    const stamps: Prisma.Sql[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          trafficResetStrategy: 'MONTH_ROLLING',
          planSnapshot: null,
          startsAt: new Date('2026-07-31T08:00:00.000Z'),
          resetAnchorAt: options.termAnchor ?? null,
        }),
        update: async (input: unknown) => {
          termUpdates.push(input);
        },
      },
    };
    const prisma = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          subscription: {
            remnawaveId: '4711',
            remnawavePanelId: 4711,
            remnawavePanelUsername: 'rz_rolling',
            configUrl: null,
            remnawaveProfileCreatedAt: options.stamped,
          },
        }),
      },
      $executeRaw: async (sql: Prisma.Sql) => {
        stamps.push(sql);
        return 1;
      },
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const service = new EntitlementBoundaryService(
      prisma as never,
      { transitionInTransaction: async () => ({ changed: false }) } as never,
      { activateInTransaction: async () => ({ id: 'term-rolling', status: 'ACTIVE', changed: true }) } as never,
      { recomputeInTransaction: async () => ({ desiredRevision: 1n, changed: false }) } as never,
      {
        getPanelUser: async (ref: unknown) => {
          panelReads.push(ref);
          return options.panelCreatedAt === undefined ? null : { createdAt: options.panelCreatedAt, lastTrafficResetAt: null };
        },
      } as never,
    );
    return { service, termUpdates, panelReads, stamps };
  }

  async function withRollingStage<T>(body: () => Promise<T>): Promise<T> {
    const previous = process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
    process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = 'true';
    try {
      return await body();
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
      else process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = previous;
    }
  }

  it('takes the stamped createdAt, and does not ask Remnawave at all', async () => {
    await withRollingStage(async () => {
      const stamped = new Date('2025-01-31T08:00:00.000Z');
      const { service, termUpdates, panelReads } = activation({ stamped, panelCreatedAt: '2020-01-01T00:00:00.000Z' });
      await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.deepEqual(termUpdates, [{ where: { id: 'term-rolling' }, data: { resetAnchorAt: stamped } }]);
      assert.deepEqual(panelReads, []);
    });
  });

  it('asks Remnawave only while nothing is stamped, and stamps what it said', async () => {
    await withRollingStage(async () => {
      const { service, termUpdates, panelReads, stamps } = activation({
        stamped: null,
        panelCreatedAt: '2025-02-28T10:00:00.000Z',
      });
      await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.equal(panelReads.length, 1);
      assert.deepEqual(termUpdates, [
        { where: { id: 'term-rolling' }, data: { resetAnchorAt: new Date('2025-02-28T10:00:00.000Z') } },
      ]);
      assert.equal(stamps.length, 1, 'the read is stamped for the next reader');
      assert.ok(stamps[0]!.values.some((value) => value instanceof Date && value.toISOString() === '2025-02-28T10:00:00.000Z'));
    });
  });

  it('keeps the anchor the term was minted with when nothing is stamped and the read learns nothing', async () => {
    // P2 minted the queued term with the rolling anchor another term carried;
    // nulling it here took a known cycle away and withheld its «до сброса» sales.
    await withRollingStage(async () => {
      const minted = new Date('2025-03-15T09:30:00.000Z');
      const { service, termUpdates, panelReads } = activation({ stamped: null, termAnchor: minted });
      await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.equal(panelReads.length, 1, 'Remnawave was asked, and said nothing');
      assert.deepEqual(termUpdates, [{ where: { id: 'term-rolling' }, data: { resetAnchorAt: minted } }]);
    });
  });

  it('leaves no anchor at all when there is none to keep: rolling «до сброса» stays fail-closed', async () => {
    await withRollingStage(async () => {
      const { service, termUpdates } = activation({ stamped: null, termAnchor: null });
      await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.deepEqual(termUpdates, [{ where: { id: 'term-rolling' }, data: { resetAnchorAt: null } }]);
    });
  });
});
