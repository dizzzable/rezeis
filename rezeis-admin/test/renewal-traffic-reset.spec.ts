import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * Paying for another period gives the period's traffic back
 * ═════════════════════════════════════════════════════════
 * Reported from production: a customer paid to renew and kept getting no
 * traffic. Not a condition that mis-fired — a link that was never made.
 *
 * `PATCH /api/users` carries the traffic LIMIT and never the USAGE, so a
 * renewal moved `expireAt` forward and left `usedTrafficBytes` exactly where
 * the previous period ended. That is not a stale statistic: Remnawave derives
 * `LIMITED` from the counter against the limit, and `toPanelStatus` in the
 * sync processor deliberately declines to push a status of its own precisely
 * because "LIMITED [is derived] from the traffic counter, so there is nothing
 * for us to assert". Correct — but only if something clears the counter.
 * Nothing did. `SyncAction.TRAFFIC_RESET` existed in the schema and was
 * handled by the processor, and no code in the tree ever created one; the only
 * live reset was the operator's button.
 *
 * So the customer ended up paid, active, and passing nothing.
 *
 * These tests pin both halves of the link, and the two halves fail for
 * different reasons on purpose. The producer half asks "does a renewal ASK for
 * the reset"; the consumer half asks "does the processor make the call, and
 * only when asked". The second question is the dangerous one: a reset that
 * fires on every UPDATE would zero the counter on an ordinary admin edit or a
 * plan-snapshot sync, handing out the traffic already used this period for
 * free — a leak with no symptom anyone would report.
 */

/** `FOR UPDATE` row lock the renewal takes before reading its source row. */
function renewalTx(input: {
  readonly remnawaveId: string | null;
  readonly onJob: (data: Record<string, unknown>) => void;
}) {
  return {
    $queryRaw: async () => [{ id: 'sub-1' }],
    subscription: {
      findUnique: async () => ({
        id: 'sub-1',
        status: 'ACTIVE',
        isTrial: false,
        expiresAt: new Date(Date.now() + 86_400_000),
        remnawaveId: input.remnawaveId,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'sub-1',
        remnawaveId: input.remnawaveId,
        expiresAt: data.expiresAt,
      }),
    },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        input.onJob(data);
        return { id: 'job-1', subscriptionId: 'sub-1' };
      },
    },
    transaction: { update: async () => undefined },
  };
}

async function runRenewal(remnawaveId: string | null): Promise<Record<string, unknown>> {
  let jobData: Record<string, unknown> = {};
  const tx = renewalTx({
    remnawaveId,
    onJob: (data) => {
      jobData = data;
    },
  });
  const service = new PaymentSubscriptionMutationService(
    { $transaction: async (cb: (client: unknown) => unknown) => cb(tx) } as never,
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
      availability: 'ALL',
      name: 'Plan',
      description: null,
      tag: null,
      type: 'BOTH',
      trafficLimit: 100,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
    },
    selectedDurationDays: 30,
  });
  return jobData;
}

describe('a paid renewal asks for the counter to be cleared', () => {
  it('marks the sync job so the processor makes the separate reset call', async () => {
    const jobData = await runRenewal('rw-1');

    assert.equal(jobData.action, SyncAction.UPDATE);
    assert.equal((jobData.payload as Record<string, unknown>).resetTraffic, true);
  });

  it('does not ask for a reset when the profile is being created', async () => {
    // A fresh panel profile starts at zero used bytes, so there is nothing to
    // clear — and the reset endpoint takes an identity this row does not have
    // yet.
    const jobData = await runRenewal(null);

    assert.equal(jobData.action, SyncAction.CREATE);
    assert.equal(
      Object.prototype.hasOwnProperty.call(jobData.payload, 'resetTraffic'),
      false,
      'a CREATE must not carry the flag at all',
    );
  });
});

/** One UPDATE job through the processor, reporting the order of panel calls. */
async function runUpdateJob(payload: Record<string, unknown>): Promise<readonly string[]> {
  const calls: string[] = [];
  const processor = new ProfileSyncProcessor(
    {
      profileSyncJob: {
        findUnique: async () => ({
          id: 'sync-job-1',
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          attempts: 0,
          supersededAt: null,
          payload,
          subscription: {
            id: 'sub-1',
            userId: 'user-1',
            // A profile provisioned on this panel: `remnawaveId` IS the
            // numeric user id, so the PATCH and the reset address it without a
            // resolve of their own.
            remnawaveId: '7',
            remnawavePanelId: 7,
            remnawavePanelUsername: 'rz_sub_1',
            configUrl: null,
            trafficLimit: 100,
            deviceLimit: 3,
            internalSquads: [],
            externalSquad: null,
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            planSnapshot: { tag: 'premium', trafficLimitStrategy: 'NO_RESET' },
          },
        }),
        updateMany: async () => ({ count: 1 }),
        update: async () => undefined,
      },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscriptionTerm: { updateMany: async () => ({ count: 1 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused' }) },
        }),
    } as never,
    {
      updateUser: async () => {
        calls.push('update');
        return {
          kind: 'ok' as const,
          drifted: false,
          data: {
            response: {
              id: 7,
              username: 'rz_sub_1',
              createdAt: new Date('2026-08-01T00:00:00.000Z'),
            },
          },
        };
      },
      resetTraffic: async () => {
        calls.push('reset');
        return { kind: 'ok' as const, drifted: false, data: { response: { id: 7 } } };
      },
    } as never,
    {
      generateProfileName: async () => ({
        username: 'rz_sub_1',
        description: 'profile description',
      }),
      getContactInfo: async () => ({ email: 'user@example.test', telegramId: 123n }),
    } as never,
    { error: () => undefined, info: () => undefined } as never,
  );

  await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);
  return calls;
}

describe('the processor clears the counter only when the job asks', () => {
  it('resets after the profile has been updated, never before', async () => {
    const calls = await runUpdateJob({ source: 'PAYMENT_COMPLETION', resetTraffic: true });

    // Order is the assertion, not just presence. Zeroing the counter against
    // the OLD limit and only then raising the limit would leave the customer
    // on the previous period's allowance for the period they just bought.
    assert.deepStrictEqual(calls, ['update', 'reset']);
  });

  it('leaves the counter alone on an ordinary update', async () => {
    // A plan edit, an admin mutation, a squad change — every one of these runs
    // the same UPDATE job. If the reset were unconditional, each would hand the
    // subscriber back the traffic they had already spent this period, and
    // nothing about the symptom would ever point here.
    const calls = await runUpdateJob({ source: 'ADMIN_MUTATION', propagateStatus: true });

    assert.deepStrictEqual(calls, ['update']);
  });

  it('leaves the counter alone when the job carries no payload at all', async () => {
    const calls = await runUpdateJob({});

    assert.deepStrictEqual(calls, ['update']);
  });
});
