import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
  TrialClaimSource,
  TrialClaimStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * End-to-end trial-quota state machine across the provider lifecycle:
 * reserve → release (provider-terminal) → late SUCCESS revival → replay.
 *
 * These drive the real `PaymentReconciliationService` and the real
 * `PaymentSubscriptionMutationService` against one in-memory ledger, so the
 * assertions are about committed quota units rather than about which helper
 * happened to be called.
 */
describe('trial claim ledger across a late provider success', () => {
  it('frees the reserved unit when the provider cancels the payment', async () => {
    const world = createLedgerWorld({ maxClaims: 1 });

    await world.deliver('canceled');

    assert.equal(world.claimFor('tx-1')?.status, TrialClaimStatus.RELEASED);
    assert.equal(world.claimFor('tx-1')?.releaseReason, 'PROVIDER_TERMINAL_CANCELED');
    assert.equal(world.committedUnits('user-1'), 0);
    assert.equal(world.transaction.status, TransactionStatus.CANCELED);
  });

  it('reports the over-cap late success once and stays idempotent on replay', async () => {
    const world = createLedgerWorld({ maxClaims: 1 });

    // 1. Provider gives up on the paid trial: the reservation is released and
    //    the user's single trial slot is free again.
    await world.deliver('canceled');
    assert.equal(world.committedUnits('user-1'), 0);

    // 2. The user immediately spends that freed slot on a free trial.
    world.addFreeConsumedClaim('user-1');
    assert.equal(world.committedUnits('user-1'), 1);

    // 3. The abandoned payment succeeds late. The money is captured, so the
    //    subscription must still be delivered — but the operator has to learn
    //    that the released slot was already reused.
    await world.deliver('succeeded');

    assert.equal(world.subscriptionCreates.length, 1);
    assert.equal(world.claimFor('tx-1')?.status, TrialClaimStatus.CONSUMED);
    assert.equal(world.claimFor('tx-1')?.releasedAt, null);
    assert.equal(world.claims.length, 2, 'the revived reservation must not mint a second claim row');
    assert.equal(world.committedUnits('user-1'), 2);
    assert.equal(world.overCapEvents.length, 1);
    assert.deepStrictEqual(
      {
        usedUnits: world.overCapEvents[0]?.usedUnits,
        maxClaims: world.overCapEvents[0]?.maxClaims,
        transactionId: world.overCapEvents[0]?.transactionId,
      },
      { usedUnits: 2, maxClaims: 1, transactionId: 'tx-1' },
    );

    // 4. The provider redelivers the same success. Nothing may be provisioned
    //    or counted twice.
    await world.deliver('succeeded');

    assert.equal(world.subscriptionCreates.length, 1);
    assert.equal(world.claims.length, 2);
    assert.equal(world.committedUnits('user-1'), 2);
    assert.equal(world.overCapEvents.length, 1);
  });

  it('does not report an over-cap late success when the freed slot was never reused', async () => {
    const world = createLedgerWorld({ maxClaims: 1 });

    await world.deliver('canceled');
    await world.deliver('succeeded');

    assert.equal(world.subscriptionCreates.length, 1);
    assert.equal(world.claimFor('tx-1')?.status, TrialClaimStatus.CONSUMED);
    assert.equal(world.committedUnits('user-1'), 1);
    assert.deepStrictEqual(world.overCapEvents, []);
  });

  it('does not report an over-cap success on the ordinary first-attempt path', async () => {
    const world = createLedgerWorld({ maxClaims: 1 });

    await world.deliver('succeeded');

    assert.equal(world.claimFor('tx-1')?.status, TrialClaimStatus.CONSUMED);
    assert.equal(world.committedUnits('user-1'), 1);
    assert.deepStrictEqual(world.overCapEvents, []);
  });

  it('keeps the consumed unit when a stale cancel arrives after fulfillment', async () => {
    const world = createLedgerWorld({ maxClaims: 1 });

    await world.deliver('succeeded');
    await world.deliver('canceled');

    // A provider-terminal release after the trial was delivered would hand the
    // user a second free slot for a subscription they still hold.
    assert.equal(world.claimFor('tx-1')?.status, TrialClaimStatus.CONSUMED);
    assert.equal(world.committedUnits('user-1'), 1);
    assert.equal(world.subscriptionCreates.length, 1);
  });
});

interface ClaimRow {
  id: string;
  userId: string;
  planId: string | null;
  transactionId: string | null;
  subscriptionId: string | null;
  source: TrialClaimSource;
  status: TrialClaimStatus;
  units: number;
  reservedAt: Date | null;
  consumedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
}

interface WebhookEventRow {
  readonly id: string;
  readonly gatewayType: PaymentGatewayType;
  readonly paymentId: string;
  readonly providerEventId: string;
  readonly eventStatus: string;
  readonly status: PaymentWebhookLifecycleStatus;
  readonly rawPayload: Record<string, unknown>;
}

function createLedgerWorld(input: { readonly maxClaims: number }) {
  const planSnapshot = {
    id: 'plan-1',
    selectedDurationDays: 30,
    availability: PlanAvailability.TRIAL,
    trialSettings: { free: false, maxClaims: input.maxClaims, availabilityScope: 'ALL' },
  };
  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null as string | null,
    fulfilledAt: null as Date | null,
    status: TransactionStatus.PENDING as TransactionStatus,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: new Prisma.Decimal('8.00'),
    paymentAsset: null,
    planSnapshot: planSnapshot as Record<string, unknown>,
    gatewayId: null as string | null,
    gatewayData: null as Record<string, unknown> | null,
    deviceTypes: [] as readonly string[],
    createdAt: new Date('2026-07-31T10:00:00.000Z'),
    updatedAt: new Date('2026-07-31T10:00:00.000Z'),
  };
  // The paid trial reserved its quota unit when the draft was created.
  const claims: ClaimRow[] = [
    {
      id: 'claim-reserved',
      userId: 'user-1',
      planId: 'plan-1',
      transactionId: 'tx-1',
      subscriptionId: null,
      source: TrialClaimSource.PAID,
      status: TrialClaimStatus.RESERVED,
      units: 1,
      reservedAt: new Date('2026-07-31T10:00:00.000Z'),
      consumedAt: null,
      releasedAt: null,
      releaseReason: null,
    },
  ];
  const subscriptionCreates: Record<string, unknown>[] = [];
  const overCapEvents: Record<string, unknown>[] = [];
  const events: WebhookEventRow[] = [];
  let sequence = 0;

  const trialClaim = {
    findUnique: async (args: { where: { transactionId?: string; id?: string } }) =>
      claims.find(
        (claim) =>
          (args.where.transactionId !== undefined &&
            claim.transactionId === args.where.transactionId) ||
          (args.where.id !== undefined && claim.id === args.where.id),
      ) ?? null,
    findFirst: async (args: { where: { userId: string; status?: TrialClaimStatus } }) =>
      claims.find(
        (claim) =>
          claim.userId === args.where.userId &&
          (args.where.status === undefined || claim.status === args.where.status),
      ) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const created: ClaimRow = {
        id: `claim-${++sequence}`,
        userId: String(data['userId']),
        planId: (data['planId'] as string | null) ?? null,
        transactionId: (data['transactionId'] as string | null) ?? null,
        subscriptionId: (data['subscriptionId'] as string | null) ?? null,
        source: data['source'] as TrialClaimSource,
        status: data['status'] as TrialClaimStatus,
        units: (data['units'] as number | undefined) ?? 1,
        reservedAt: (data['reservedAt'] as Date | undefined) ?? null,
        consumedAt: (data['consumedAt'] as Date | undefined) ?? null,
        releasedAt: null,
        releaseReason: null,
      };
      claims.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const claim = claims.find((row) => row.id === where.id);
      assert.ok(claim, `claim ${where.id} must exist`);
      Object.assign(claim, data);
      return claim;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { transactionId?: string; status?: TrialClaimStatus };
      data: Record<string, unknown>;
    }) => {
      const matched = claims.filter(
        (claim) =>
          (where.transactionId === undefined || claim.transactionId === where.transactionId) &&
          (where.status === undefined || claim.status === where.status),
      );
      for (const claim of matched) Object.assign(claim, data);
      return { count: matched.length };
    },
    aggregate: async (args: {
      where: {
        userId: string;
        status: { in: readonly TrialClaimStatus[] };
        transactionId?: { not: string };
      };
    }) => {
      const units = claims
        .filter(
          (claim) =>
            claim.userId === args.where.userId &&
            args.where.status.in.includes(claim.status) &&
            (args.where.transactionId === undefined ||
              claim.transactionId !== args.where.transactionId.not),
        )
        .reduce((total, claim) => total + claim.units, 0);
      return { _sum: { units } };
    },
  };

  const prisma = {
    paymentWebhookEvent: {
      findUnique: async (args: { where: { id: string } }) =>
        events.find((event) => event.id === args.where.id) ?? null,
    },
    transaction: {
      findUnique: async (args: { where: { id?: string; paymentId?: string } }) =>
        args.where.id === transaction.id || args.where.paymentId === transaction.paymentId
          ? { ...transaction }
          : null,
      findFirst: async () => null,
      count: async () => 0,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        assert.equal(where.id, transaction.id);
        Object.assign(transaction, data);
        return { ...transaction };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; fulfilledAt?: Date | null };
        data: Record<string, unknown>;
      }) => {
        const fulfilledMatches =
          where.fulfilledAt === undefined ||
          (where.fulfilledAt === null
            ? transaction.fulfilledAt === null
            : transaction.fulfilledAt?.getTime() === where.fulfilledAt.getTime());
        if (where.id !== transaction.id || !fulfilledMatches) {
          return { count: 0 };
        }
        Object.assign(transaction, data);
        return { count: 1 };
      },
    },
    transactionItem: { findMany: async () => [] },
    plan: {
      findUnique: async () => ({
        id: 'plan-1',
        name: 'Paid trial',
        description: null,
        tag: null,
        icon: null,
        type: 'BOTH',
        availability: PlanAvailability.TRIAL,
        trafficLimit: 10,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        trialSettings: planSnapshot.trialSettings,
      }),
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        subscriptionCreates.push(data);
        return { id: `sub-${subscriptionCreates.length}`, remnawaveId: null, ...data };
      },
      findUnique: async () => null,
      update: async () => null,
    },
    trialClaim,
    trialGrant: { upsert: async () => undefined },
    profileSyncJob: {
      create: async () => ({ id: `sync-${++sequence}` }),
    },
    user: { updateMany: async () => ({ count: 1 }) },
    paymentGateway: { findUnique: async () => null },
  };
  const prismaDouble = {
    ...prisma,
    $transaction: async <T>(callback: (client: unknown) => Promise<T>): Promise<T> =>
      callback(prismaDouble),
  };

  const mutationService = new PaymentSubscriptionMutationService(
    prismaDouble as unknown as PrismaService,
    {
      info: () => undefined,
      warn: (type: string, _source: unknown, _message: unknown, metadata: Record<string, unknown>) => {
        if (type === EVENT_TYPES.TRIAL_CLAIM_LATE_SUCCESS_OVER_CAP) {
          overCapEvents.push(metadata);
        }
      },
      error: () => undefined,
      emit: () => undefined,
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const service = new PaymentReconciliationService(
    prismaDouble as unknown as PrismaService,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async () => undefined,
      markFailed: async () => events[events.length - 1],
    } as never,
    mutationService,
    { notifyWebhookFailed: async () => undefined } as never,
    {
      processPartnerEarning: async () => undefined,
      reverseEarningsForTransaction: async () => 0,
    } as never,
    {
      qualifyReferralAfterPurchase: async () => undefined,
      reverseQualificationForTransaction: async () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { enqueueRegisterIncome: async () => undefined, enqueueCancelIncome: async () => undefined } as never,
    { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
  );

  return {
    claims,
    subscriptionCreates,
    overCapEvents,
    transaction,
    claimFor: (transactionId: string): ClaimRow | undefined =>
      claims.find((claim) => claim.transactionId === transactionId),
    committedUnits: (userId: string): number =>
      claims
        .filter(
          (claim) =>
            claim.userId === userId &&
            (claim.status === TrialClaimStatus.RESERVED ||
              claim.status === TrialClaimStatus.CONSUMED),
        )
        .reduce((total, claim) => total + claim.units, 0),
    addFreeConsumedClaim: (userId: string): void => {
      claims.push({
        id: `claim-free-${++sequence}`,
        userId,
        planId: 'plan-1',
        transactionId: null,
        subscriptionId: `sub-free-${sequence}`,
        source: TrialClaimSource.FREE,
        status: TrialClaimStatus.CONSUMED,
        units: 1,
        reservedAt: null,
        consumedAt: new Date('2026-07-31T11:00:00.000Z'),
        releasedAt: null,
        releaseReason: null,
      });
    },
    deliver: async (providerStatus: string): Promise<void> => {
      const id = `event-${++sequence}`;
      events.push({
        id,
        gatewayType: PaymentGatewayType.YOOKASSA,
        paymentId: transaction.paymentId,
        providerEventId: `provider-${id}`,
        eventStatus: providerStatus,
        status: PaymentWebhookLifecycleStatus.PROCESSING,
        rawPayload: {
          event: `payment.${providerStatus}`,
          object: { id: 'provider-payment-1', status: providerStatus },
        },
      });
      await service.reconcileWebhookEvent(id);
    },
  };
}
