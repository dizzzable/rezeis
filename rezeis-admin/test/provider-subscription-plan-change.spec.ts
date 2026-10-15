import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { ProviderSubscriptionStatus, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import {
  PLAN_CHANGE_SIGN_UP_HOLD_MS,
  planChangeOf,
  ProviderSubscriptionService,
  strandedReason,
} from '../src/modules/payments/services/provider-subscription.service';

/**
 * «Сменить тариф» with «для автоматического списания» (the owner, 15.10.2026):
 * the provider subscription is made on the UPGRADE of a paid plan, and is
 * recorded on the subscription it changes from the start. Until its first
 * charge lands, though, that subscription is on the plan it is leaving, and the
 * sweep that stops an autopay whose subscription "moved to another plan" read
 * exactly that as a move. The autopay left on the OLD plan is the one the sweep
 * must stop, once the change lands.
 */

const SUBSCRIPTION = 'paid-sub';
const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('planChangeOf', () => {
  // Unpaid unless the case says otherwise: a checkout made a minute ago.
  const checkout = (
    overrides: Partial<{
      subscriptionId: string | null;
      status: TransactionStatus;
      fulfilledAt: Date | null;
      createdAt: Date;
      planSnapshot: unknown;
    }> = {},
  ) => ({
    subscriptionId: SUBSCRIPTION,
    status: TransactionStatus.PENDING,
    fulfilledAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    planSnapshot: { id: 'plan-b' },
    ...overrides,
  });

  it('speaks only for a checkout that changes this very subscription', () => {
    assert.deepEqual(planChangeOf(undefined, SUBSCRIPTION, false, NOW), {});
    assert.deepEqual(planChangeOf(checkout({ subscriptionId: 'another-sub' }), SUBSCRIPTION, false, NOW), {});
    assert.deepEqual(planChangeOf(checkout(), null, false, NOW), {});
  });

  it("leaves a trial's conversion to trialConversionOf", () => {
    assert.deepEqual(planChangeOf(checkout(), SUBSCRIPTION, true, NOW), {});
    assert.deepEqual(
      planChangeOf(checkout({ planSnapshot: { id: 'plan-b', convertsTrial: true } }), SUBSCRIPTION, false, NOW),
      {},
    );
  });

  it('holds the change as pending until its charge is applied, paid or not', () => {
    assert.deepEqual(planChangeOf(checkout(), SUBSCRIPTION, false, NOW), { planChange: 'PENDING' });
    // Paid, fulfilment in flight — or failed, and waiting for its retry.
    assert.deepEqual(planChangeOf(checkout({ status: TransactionStatus.COMPLETED }), SUBSCRIPTION, false, NOW), {
      planChange: 'PENDING',
    });
    // Unpaid yet: the payer may still confirm it in the bank.
    for (const status of [TransactionStatus.CANCELED, TransactionStatus.FAILED]) {
      assert.deepEqual(planChangeOf(checkout({ status }), SUBSCRIPTION, false, NOW), { planChange: 'PENDING' }, status);
    }
  });

  it('lets a change its own charge applied be compared as any subscription is', () => {
    assert.deepEqual(
      planChangeOf(checkout({ status: TransactionStatus.COMPLETED, fulfilledAt: NOW }), SUBSCRIPTION, false, NOW),
      {},
    );
  });

  it('calls the change lost once its charge has not landed for a day', () => {
    const old = new Date(NOW.getTime() - PLAN_CHANGE_SIGN_UP_HOLD_MS);
    for (const status of [TransactionStatus.PENDING, TransactionStatus.COMPLETED, TransactionStatus.FAILED]) {
      assert.deepEqual(planChangeOf(checkout({ status, createdAt: old }), SUBSCRIPTION, false, NOW), {
        planChange: 'LOST',
      });
    }
    // Control: a minute short of it is still on its way.
    assert.deepEqual(
      planChangeOf(checkout({ createdAt: new Date(old.getTime() + 60_000) }), SUBSCRIPTION, false, NOW),
      { planChange: 'PENDING' },
    );
  });
});

describe('strandedReason on a plan change', () => {
  // The subscription is still on the plan it is leaving; the autopay is on the one it moves to.
  const leaving = { status: SubscriptionStatus.ACTIVE, planId: 'plan-a' } as const;
  const reason = (
    subscription: Parameters<typeof strandedReason>[0]['subscription'],
    overrides: Partial<Parameters<typeof strandedReason>[0]> = {},
  ) => strandedReason({ userDeleted: false, userBlocked: false, subscription, planId: 'plan-b', ...overrides });

  it('does not read a subscription awaiting its plan change as a move to another plan', () => {
    assert.equal(reason({ ...leaving, planChange: 'PENDING' }), null);
    // Without the change it is what it looks like.
    assert.equal(reason(leaving), 'subscription moved to another plan');
  });

  it('stops one whose change never landed', () => {
    assert.equal(reason({ ...leaving, planChange: 'LOST' }), 'plan change without its first charge');
  });

  it('still stops for a deleted subscription and for a blocked or deleted account', () => {
    assert.equal(
      reason({ status: SubscriptionStatus.DELETED, planId: 'plan-a', planChange: 'PENDING' }),
      'subscription deleted',
    );
    assert.equal(reason({ ...leaving, planChange: 'PENDING' }, { userBlocked: true }), 'account blocked');
    assert.equal(reason({ ...leaving, planChange: 'PENDING' }, { userDeleted: true }), 'account deleted');
  });

  it('stops the autopay left on the old plan once the change lands', () => {
    // The old row is on plan-a; the subscription is now on plan-b.
    assert.equal(
      strandedReason({
        userDeleted: false,
        userBlocked: false,
        subscription: { status: SubscriptionStatus.ACTIVE, planId: 'plan-b' },
        planId: 'plan-a',
      }),
      'subscription moved to another plan',
    );
  });
});

describe('assertNoLiveSubscriptionFor on a plan change', () => {
  const service = (live: ReadonlyArray<{ planId: string }>) => {
    const asked: Array<Record<string, unknown>> = [];
    const prisma = {
      providerSubscription: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          asked.push(where);
          if (where.status !== ProviderSubscriptionStatus.ACTIVE) return null;
          const match = live.find((row) => where.planId === undefined || row.planId === where.planId);
          return match === undefined ? null : { id: 'ps-live' };
        },
      },
    };
    return { service: new ProviderSubscriptionService(prisma as never, {} as never, {} as never, {} as never), asked };
  };
  const refusal = (error: unknown): unknown => {
    assert.ok(error instanceof BadRequestException);
    return (error.getResponse() as { reason?: unknown }).reason;
  };

  it('lets a change through beside an autopay on the plan it leaves', async () => {
    const { service: guard, asked } = service([{ planId: 'plan-a' }]);

    await guard.assertNoLiveSubscriptionFor(SUBSCRIPTION, { pendingOtherThan: 'tx-1', planChangeTo: 'plan-b' });

    assert.deepEqual(asked[0], {
      subscriptionId: SUBSCRIPTION,
      status: ProviderSubscriptionStatus.ACTIVE,
      planId: 'plan-b',
    });
  });

  it('refuses one beside an autopay already on the plan it moves to', async () => {
    const { service: guard } = service([{ planId: 'plan-b' }]);

    await assert.rejects(
      guard.assertNoLiveSubscriptionFor(SUBSCRIPTION, { pendingOtherThan: 'tx-1', planChangeTo: 'plan-b' }),
      (error: unknown) => refusal(error) === 'ALREADY_ACTIVE',
    );
  });

  it('control: without a plan change any live autopay refuses, as before', async () => {
    const { service: guard } = service([{ planId: 'plan-a' }]);

    await assert.rejects(
      guard.assertNoLiveSubscriptionFor(SUBSCRIPTION),
      (error: unknown) => refusal(error) === 'ALREADY_ACTIVE',
    );
  });
});
