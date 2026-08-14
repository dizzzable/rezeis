import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

describe('PaymentSubscriptionMutationService renewal term queue', () => {
  for (const blockedSource of [
    { name: 'free trial', status: 'ACTIVE', isTrial: true },
    { name: 'paid trial', status: 'EXPIRED', isTrial: true },
    { name: 'disabled subscription', status: 'DISABLED', isTrial: false },
  ]) {
    it(`rejects single renewal fulfillment for a ${blockedSource.name}`, async () => {
      let updates = 0;
      let lockQueries = 0;
      const tx = {
        $queryRaw: async (query: unknown) => {
          assertForUpdate(query);
          lockQueries += 1;
          return [{ id: 'sub-1' }];
        },
        subscription: {
          findUnique: async () => ({
            id: 'sub-1',
            status: blockedSource.status,
            isTrial: blockedSource.isTrial,
            expiresAt: new Date('2026-08-01T00:00:00.000Z'),
            remnawaveId: 'rw-1',
          }),
          update: async () => {
            updates += 1;
            return {};
          },
        },
      };
      const prisma = {
        $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
      };
      const service = new PaymentSubscriptionMutationService(
        prisma as never,
        { info: () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const renew = (
        service as unknown as {
          renewSubscriptionFromPayment(input: {
            transaction: unknown;
            purchasedPlan: unknown;
            selectedDurationDays: number;
          }): Promise<unknown>;
        }
      ).renewSubscriptionFromPayment.bind(service);

      await assert.rejects(() =>
        renew({
          transaction: {
            id: 'tx-1',
            paymentId: 'pay-1',
            subscriptionId: 'sub-1',
          },
          purchasedPlan: { id: 'plan-1', availability: 'ALL' },
          selectedDurationDays: 30,
        }),
      );
      assert.equal(updates, 0);
      assert.equal(lockQueries, 1, 'source policy must run after an unconditional row lock');
    });
  }

  it('uses checkout-time ALL availability when the live plan later becomes TRIAL', async () => {
    // The renewal base must stay in the future. A fixed calendar date makes
    // this assertion flip after that date, even though the service correctly
    // starts an already-expired subscription from the current instant.
    const expiry = new Date(Date.now() + 86_400_000);
    // The update payload is captured from inside the double, where the
    // surrounding flow analysis cannot see the write; holding it on an object
    // keeps it typed as the payload rather than as the initial null.
    const captured: { updateData: Record<string, unknown> | null } = { updateData: null };
    let lockQueries = 0;
    const tx = {
      $queryRaw: async (query: unknown) => {
        assertForUpdate(query);
        lockQueries += 1;
        return [{ id: 'sub-1' }];
      },
      subscription: {
        findUnique: async () => ({
          id: 'sub-1',
          status: 'ACTIVE',
          isTrial: false,
          expiresAt: expiry,
          remnawaveId: 'rw-1',
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          captured.updateData = data;
          return { id: 'sub-1', remnawaveId: 'rw-1', expiresAt: data.expiresAt };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'job-1', subscriptionId: 'sub-1' }) },
      transaction: { update: async () => undefined },
    };
    const prisma = { $transaction: async (callback: (client: unknown) => unknown) => callback(tx) };
    const service = new PaymentSubscriptionMutationService(
      prisma as never,
      { info: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const renew = (
      service as unknown as {
        renewSubscriptionFromPayment(input: {
          transaction: unknown;
          purchasedPlan: unknown;
          selectedDurationDays: number;
        }): Promise<unknown>;
      }
    ).renewSubscriptionFromPayment.bind(service);

    await renew({
      transaction: {
        id: 'tx-1',
        paymentId: 'pay-1',
        subscriptionId: 'sub-1',
        planSnapshot: { availability: 'ALL', selectedDurationDays: 30 },
        gatewayType: 'YOOKASSA',
        amount: '10',
        currency: 'USD',
        userId: 'user-1',
        purchaseType: 'RENEW',
      },
      purchasedPlan: {
        id: 'plan-1',
        availability: 'TRIAL',
        name: 'Plan',
        description: null,
        tag: null,
        type: 'BOTH',
        trafficLimit: 1024,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
      },
      selectedDurationDays: 30,
    });

    assert.equal(lockQueries, 1);
    assert.ok(captured.updateData);
    assert.equal(
      (captured.updateData.expiresAt as Date).getTime(),
      expiry.getTime() + 30 * 86_400_000,
    );
  });

  it('appends a distinct term after the latest scheduled tail instead of reusing it', async () => {
    const activeEndsAt = new Date('2026-08-01T00:00:00.000Z');
    const scheduledEndsAt = new Date('2026-08-31T00:00:00.000Z');
    const creates: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      subscriptionTerm: {
        findFirst: async (input: { where: { status?: unknown } }) => {
          const status = input.where.status;
          if (status === 'ACTIVE') return { id: 'term-active', generation: 1, endsAt: activeEndsAt };
          if (status === 'SCHEDULED') {
            return { id: 'term-scheduled', generation: 2, startsAt: activeEndsAt, endsAt: scheduledEndsAt };
          }
          if (typeof status === 'object') {
            return { id: 'term-scheduled', generation: 2, startsAt: activeEndsAt, endsAt: scheduledEndsAt };
          }
          return null;
        },
      },
    };
    const terms = {
      createScheduledInTransaction: async (_tx: unknown, input: Record<string, unknown>) => {
        creates.push(input);
        return { id: 'term-new', generation: 3, status: 'SCHEDULED' };
      },
    };
    const service = new PaymentSubscriptionMutationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      terms as never,
    );
    const append = (
      service as unknown as {
        scheduleRenewalTermInTransaction(
          txClient: unknown,
          input: { subscriptionId: string; plan: unknown; durationDays: number },
        ): Promise<{ id: string; startsAt: Date; endsAt: Date | null } | null>;
      }
    ).scheduleRenewalTermInTransaction.bind(service);

    const created = await append(tx, {
      subscriptionId: 'sub-1',
      plan: {
        id: 'plan-2',
        name: 'Plan 2',
        description: null,
        tag: null,
        type: 'BOTH',
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: ['squad-new'],
        externalSquad: null,
      },
      durationDays: 30,
    });

    assert.equal(created?.id, 'term-new');
    assert.equal(creates.length, 1);
    assert.equal((creates[0]!.startsAt as Date).getTime(), scheduledEndsAt.getTime());
    assert.equal((creates[0]!.endsAt as Date).getTime(), scheduledEndsAt.getTime() + 30 * 86_400_000);
  });

  it('keeps a single renewal baseline deferred when an ACTIVE durable term exists', async () => {
    const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const currentExpiry = new Date(Date.now() + 30 * 86_400_000);
    // Captured inside the double — see the note on the first such holder above.
    const captured: { updateData: Record<string, unknown> | null } = { updateData: null };
    const termCreates: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      subscriptionTerm: {
        findFirst: async (input: { where: { status?: unknown } }) =>
          input.where.status === 'ACTIVE'
            ? { id: 'term-active' }
            : { id: 'term-active', status: 'ACTIVE', generation: 1, endsAt: currentExpiry },
      },
      subscription: {
        findUnique: async () => ({
          id: 'sub-1',
          expiresAt: currentExpiry,
          remnawaveId: 'rw-1',
          trafficLimit: 1500,
          deviceLimit: 4,
          planSnapshot: { id: 'plan-current' },
          internalSquads: ['current-squad'],
          externalSquad: 'current-external',
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          captured.updateData = data;
          return { id: 'sub-1', remnawaveId: 'rw-1', expiresAt: data.expiresAt };
        },
      },
      profileSyncJob: {
        create: async () => ({ id: 'job-1', subscriptionId: 'sub-1', targetRemnawaveId: 'rw-1' }),
      },
      transaction: { update: async () => undefined },
    };
    const prisma = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) };
    const terms = {
      createScheduledInTransaction: async (_tx: unknown, input: Record<string, unknown>) => {
        termCreates.push(input);
        return { id: 'term-new', status: 'SCHEDULED', generation: 2 };
      },
    };
    const service = new PaymentSubscriptionMutationService(
      prisma as never,
      { info: () => undefined } as never,
      {} as never,
      {} as never,
      terms as never,
    );
    const renew = (
      service as unknown as {
        renewSubscriptionFromPayment(input: {
          transaction: unknown;
          purchasedPlan: unknown;
          selectedDurationDays: number;
        }): Promise<unknown>;
      }
    ).renewSubscriptionFromPayment.bind(service);
    const futurePlan = {
      id: 'plan-future', name: 'Future', description: null, tag: null, type: 'BOTH',
      trafficLimit: 1024, deviceLimit: 1, trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['future-squad'], externalSquad: null,
    };

    try {
      await renew({
        transaction: {
          id: 'tx-1', paymentId: 'pay-1', subscriptionId: 'sub-1',
          planSnapshot: { selectedDurationDays: 30 }, gatewayType: 'YOOKASSA',
          amount: '10', currency: 'USD', userId: 'user-1', purchaseType: 'RENEW',
        },
        purchasedPlan: futurePlan,
        selectedDurationDays: 30,
      });
      assert.equal(termCreates.length, 1);
      assert.ok(captured.updateData);
      const updateData = captured.updateData;
      assert.equal(Object.prototype.hasOwnProperty.call(updateData, 'trafficLimit'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(updateData, 'deviceLimit'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(updateData, 'planSnapshot'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(updateData, 'internalSquads'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(updateData, 'externalSquad'), false);
    } finally {
      if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
    }
  });
  it('calculates expiry from the authoritative subscription row locked for the durable term', async () => {
    const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const staleExpiry = new Date('2026-01-01T00:00:00.000Z');
    const lockedExpiry = new Date('2040-06-15T00:00:00.000Z');
    let findUniqueCalls = 0;
    // Captured inside the double — see the note on the first such holder above.
    const captured: { updateData: Record<string, unknown> | null } = { updateData: null };
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      subscriptionTerm: {
        findFirst: async (input: { where: { status?: unknown } }) =>
          input.where.status === 'ACTIVE'
            ? { id: 'term-active' }
            : { id: 'term-active', status: 'ACTIVE', generation: 1, endsAt: lockedExpiry },
      },
      subscription: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return { id: 'sub-1', expiresAt: findUniqueCalls === 1 ? staleExpiry : lockedExpiry, remnawaveId: 'rw-1' };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          captured.updateData = data;
          return { id: 'sub-1', remnawaveId: 'rw-1', expiresAt: data.expiresAt };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'job-1', subscriptionId: 'sub-1' }) },
      transaction: { update: async () => undefined },
    };
    const prisma = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) };
    const terms = { createScheduledInTransaction: async () => ({ id: 'term-new', status: 'SCHEDULED', generation: 2 }) };
    const service = new PaymentSubscriptionMutationService(prisma as never, { info: () => undefined } as never, {} as never, {} as never, terms as never);
    const renew = (service as unknown as { renewSubscriptionFromPayment(input: { transaction: unknown; purchasedPlan: unknown; selectedDurationDays: number }): Promise<unknown> }).renewSubscriptionFromPayment.bind(service);
    try {
      await renew({
        transaction: { id: 'tx-1', paymentId: 'pay-1', subscriptionId: 'sub-1', planSnapshot: { selectedDurationDays: 30 }, gatewayType: 'YOOKASSA', amount: '10', currency: 'USD', userId: 'user-1', purchaseType: 'RENEW' },
        purchasedPlan: { id: 'plan-future', name: 'Future', description: null, tag: null, type: 'BOTH', trafficLimit: 1024, deviceLimit: 1, trafficLimitStrategy: 'NO_RESET', internalSquads: ['future-squad'], externalSquad: null },
        selectedDurationDays: 30,
      });
      assert.equal(findUniqueCalls, 2);
      assert.ok(captured.updateData);
      assert.equal((captured.updateData.expiresAt as Date).getTime(), lockedExpiry.getTime() + 30 * 86_400_000);
    } finally {
      if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
    }
  });
});

function assertForUpdate(query: unknown): void {
  const statement =
    typeof query === 'object' && query !== null && 'sql' in query
      ? String((query as { readonly sql: unknown }).sql)
      : String(query);
  assert.match(statement.replace(/\s+/g, ' '), /\bFOR\s+UPDATE\b/i);
}
