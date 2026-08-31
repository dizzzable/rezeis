import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability } from '@prisma/client';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

describe('PaymentSubscriptionMutationService NEW checkout availability', () => {
  it('keeps a paid trial marked as trial when its live plan changes TRIAL to ALL', async () => {
    const result = await fulfillNewPurchase({
      snapshotAvailability: PlanAvailability.TRIAL,
      liveAvailability: PlanAvailability.ALL,
    });

    assert.equal(result.createdData.isTrial, true);
    assert.equal(result.trialGrantUpserts, 1);
  });

  it('does not turn a regular purchase into a trial when its live plan changes ALL to TRIAL', async () => {
    const result = await fulfillNewPurchase({
      snapshotAvailability: PlanAvailability.ALL,
      liveAvailability: PlanAvailability.TRIAL,
    });

    assert.equal(result.createdData.isTrial, false);
    assert.equal(result.trialGrantUpserts, 0);
  });

  it('keeps legacy draft behavior when checkout availability is absent', async () => {
    const result = await fulfillNewPurchase({
      snapshotAvailability: null,
      liveAvailability: PlanAvailability.TRIAL,
    });

    assert.equal(result.createdData.isTrial, true);
    assert.equal(result.trialGrantUpserts, 1);
  });
});

async function fulfillNewPurchase(input: {
  readonly snapshotAvailability: PlanAvailability | null;
  readonly liveAvailability: PlanAvailability;
}): Promise<{
  readonly createdData: Record<string, unknown>;
  readonly trialGrantUpserts: number;
}> {
  let createdData: Record<string, unknown> | null = null;
  let trialGrantUpserts = 0;
  let trialClaimCreates = 0;
  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    purchaseType: 'NEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '10' },
    deviceTypes: [],
    planSnapshot: {
      id: 'plan-1',
      selectedDurationDays: 30,
      ...(input.snapshotAvailability === null
        ? {}
        : { availability: input.snapshotAvailability }),
    },
  };
  const purchasedPlan = {
    id: 'plan-1',
    name: 'Plan',
    description: null,
    tag: null,
    icon: null,
    type: 'BOTH',
    availability: input.liveAvailability,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
  };
  const tx = {
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return { id: 'sub-1', remnawaveId: null, ...data };
      },
    },
    trialGrant: {
      upsert: async () => {
        trialGrantUpserts += 1;
      },
    },
    trialClaim: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        trialClaimCreates += 1;
        return { id: 'claim-1', ...data };
      },
      update: async () => assert.fail('missing legacy reservation should create a claim'),
      aggregate: async () => ({ _sum: { units: 1 } }),
    },
    profileSyncJob: {
      create: async () => ({ id: 'sync-1', subscriptionId: 'sub-1' }),
    },
    transaction: { update: async () => undefined },
    user: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };
  const service = new PaymentSubscriptionMutationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const create = (
    service as unknown as {
      createSubscriptionFromPayment(input: {
        readonly transaction: unknown;
        readonly purchasedPlan: unknown;
        readonly selectedDurationDays: number;
      }): Promise<unknown>;
    }
  ).createSubscriptionFromPayment.bind(service);

  await create({ transaction, purchasedPlan, selectedDurationDays: 30 });
  assert.notEqual(createdData, null);
  assert.equal(trialClaimCreates, createdData!['isTrial'] === true ? 1 : 0);
  return { createdData: createdData!, trialGrantUpserts };
}
