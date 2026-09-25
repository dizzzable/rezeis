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
} from '../src/modules/add-on-entitlements/services/reset-boundary-confirmation.service';

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
});

describe('term activation — the rolling anchor from the stamped profile', () => {
  function activation(options: { readonly stamped: Date | null; readonly panelCreatedAt?: string }) {
    const termUpdates: unknown[] = [];
    const panelReads: unknown[] = [];
    const stamps: Prisma.Sql[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          trafficResetStrategy: 'MONTH_ROLLING',
          planSnapshot: null,
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
});
