import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  ProviderSubscriptionStatus,
  PurchaseType,
} from '@prisma/client';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';

/**
 * A new purchase's provider subscription (Platega, RollyPay) is named on the
 * subscription it renews in the same write that creates that subscription.
 *
 * Before, the row waited for the next look at the provider — up to a day — to
 * be bound, and meanwhile the checkout guard admitted a second autopay on the
 * new subscription and the sweep could not check it (R-money laterList 11).
 * The real fulfilment write, over a double whose rows the real guard reads.
 */

const TERMS = { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-a', subscriptionId: null };

function world(options: {
  readonly withTerms: boolean;
  readonly boundTo?: string | null;
  /** A double with no provider subscriptions at all: any write to them throws. */
  readonly noProviderSubscriptions?: boolean;
}) {
  const rows = [
    {
      id: 'ps-1',
      userId: 'user-1',
      subscriptionId: options.boundTo ?? null,
      status: ProviderSubscriptionStatus.ACTIVE,
      firstTransactionId: 'tx-1',
    },
  ];
  const providerSubscription = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const matching = rows.filter(
        (row) => row.firstTransactionId === where.firstTransactionId && row.subscriptionId === where.subscriptionId,
      );
      for (const row of matching) Object.assign(row, data);
      return { count: matching.length };
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => row.subscriptionId === where.subscriptionId && row.status === where.status) ?? null,
  };
  const tx = {
    subscription: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-sub', ...data }) },
    profileSyncJob: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'job-1', ...data }) },
    transaction: { update: async ({ data }: { data: Record<string, unknown> }) => data },
    user: { updateMany: async () => ({ count: 1 }) },
    ...(options.noProviderSubscriptions === true ? {} : { providerSubscription }),
  };
  const mutations = new PaymentSubscriptionMutationService(
    { $transaction: async (run: (client: unknown) => unknown) => run(tx) } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const create = (
    mutations as unknown as {
      createSubscriptionFromPayment(input: {
        transaction: unknown;
        purchasedPlan: unknown;
        selectedDurationDays: number;
      }): Promise<{ subscription: { id: string } }>;
    }
  ).createSubscriptionFromPayment.bind(mutations);
  const fulfil = () =>
    create({
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        subscriptionId: null,
        purchaseType: PurchaseType.ADDITIONAL,
        gatewayType: PaymentGatewayType.PLATEGA,
        amount: '299',
        currency: Currency.RUB,
        deviceTypes: [],
        planSnapshot: {
          id: 'plan-a',
          availability: PlanAvailability.ALL,
          selectedDurationDays: 30,
          ...(options.withTerms ? { providerSubscription: TERMS } : {}),
        },
      },
      purchasedPlan: {
        id: 'plan-a',
        name: 'plan-a',
        description: null,
        tag: null,
        type: PlanType.BOTH,
        icon: null,
        availability: PlanAvailability.ALL,
        trafficLimit: 1024,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
      },
      selectedDurationDays: 30,
    });
  const guard = new ProviderSubscriptionService({ providerSubscription } as never, {} as never, {} as never, {} as never);
  return { rows, fulfil, guard };
}

describe("a new purchase's provider subscription and the subscription it creates", () => {
  it('is named on it in the write that creates it, so a second autopay on it is refused at once', async () => {
    const w = world({ withTerms: true });

    const { subscription } = await w.fulfil();

    assert.equal(w.rows[0]?.subscriptionId, subscription.id);
    await assert.rejects(w.guard.assertNoLiveSubscriptionFor(subscription.id), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { reason?: unknown }).reason, 'ALREADY_ACTIVE');
      return true;
    });
  });

  it('leaves a row that already names its subscription alone', async () => {
    const w = world({ withTerms: true, boundTo: 'another-sub' });

    await w.fulfil();

    assert.equal(w.rows[0]?.subscriptionId, 'another-sub');
  });

  it('touches no provider subscription for an ordinary payment', async () => {
    // The double has none: a write would throw and roll the fulfilment back.
    const w = world({ withTerms: false, noProviderSubscriptions: true });

    const { subscription } = await w.fulfil();

    assert.equal(subscription.id, 'new-sub');
  });
});
