import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { MoyNalogQueueService } from '../src/modules/payments/services/moy-nalog-queue.service';
import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';

/**
 * Safety invariant (autopay / off-session RENEW):
 *
 * A paid renewal must NOT extend or re-issue a subscription until the
 * provider callback (webhook SUCCESS) is reconciled.
 *
 * createCheckout may return providerStatus=succeeded + IMMEDIATE for
 * YooKassa saved-method charges — that response alone must leave the
 * draft PENDING and must never call applyCompletedTransaction.
 */

/** Strip // and /* *\/ comments so source pins ignore documentation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PRICED = {
  userId: 'user-1',
  currency: 'USD',
  total: '10.00',
  items: [
    {
      subscriptionId: 'sub-1',
      planId: 'plan-1',
      planName: 'Plan 1',
      durationDays: 30,
      currency: 'USD',
      amount: '10.00',
      discountPercent: 0,
      planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT' },
    },
  ],
};

function draftRow(data: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: TransactionStatus.PENDING,
    purchaseType: PurchaseType.RENEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: null as string | null,
    currency: Currency.USD,
    amount: { toString: () => '10.00', valueOf: () => 10 },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null as string | null,
    checkoutFingerprint: null,
    subscriptionId: null,
    items: [
      {
        subscriptionId: 'sub-1',
        planId: 'plan-1',
        durationDays: 30,
        addOnLines: null,
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

describe('renewal fulfillment only after payment callback', () => {
  describe('source pins (create path never fulfills paid drafts)', () => {
    const renewalSrc = readFileSync(
      join(__dirname, '../src/modules/payments/services/payments-renewal-checkout.service.ts'),
      'utf8',
    );
    const renewalCode = stripComments(renewalSrc);
    const providerSrc = readFileSync(
      join(__dirname, '../src/modules/payments/services/payment-provider-execution.service.ts'),
      'utf8',
    );
    const providerCode = stripComments(providerSrc);
    const autoRenewSrc = readFileSync(
      join(__dirname, '../src/modules/auto-renew/auto-renew.service.ts'),
      'utf8',
    );
    const autoRenewCode = stripComments(autoRenewSrc);

    it('renewal applyCompletedTransaction only inside amount<=0 branch', () => {
          const zeroIdx = renewalCode.indexOf('Number(transaction.amount) <= 0');
          assert.ok(zeroIdx > 0, 'expected zero-total branch');
          // Extract the if-body after the zero-total guard up to the next top-level
          // `const providerClaim` (paid path). apply must live inside that body.
          const bodyStart = renewalCode.indexOf('{', zeroIdx);
          assert.ok(bodyStart > zeroIdx);
          const paidMarker = renewalCode.indexOf('const providerClaim', bodyStart);
          assert.ok(paidMarker > bodyStart, 'expected paid-path marker after zero-total');
          const zeroBody = renewalCode.slice(bodyStart, paidMarker);
          assert.match(
            zeroBody,
            /applyCompletedTransaction/,
            'applyCompletedTransaction must be inside amount<=0 body',
          );
          const paidTail = renewalCode.slice(paidMarker);
          assert.equal(
            /applyCompletedTransaction/.test(paidTail),
            false,
            'paid path after providerClaim must not call applyCompletedTransaction',
          );
          const matches = renewalCode.match(/applyCompletedTransaction/g) ?? [];
          assert.equal(matches.length, 1);
        });

        it('paid createCheckout success path does not set transaction status', () => {
          const start = renewalCode.indexOf(
            'providerCheckout = await this.paymentProviderExecutionService.createCheckout',
          );
          assert.ok(start > 0);
          // Bound to the paid-path return that follows createCheckout (not file-wide last).
          const end = renewalCode.indexOf('return mapCheckoutResponse', start);
          assert.ok(end > start);
          const block = renewalCode.slice(start, end);
          assert.equal(
            /status:\s*TransactionStatus\.COMPLETED/.test(block),
            false,
            'paid create path must not write COMPLETED',
          );
          assert.equal(
            /applyCompletedTransaction/.test(block),
            false,
            'paid create path must not fulfill',
          );
          assert.match(block, /gatewayId:\s*providerCheckout\.gatewayId/);
          assert.match(block, /gatewayData:\s*providerCheckout\.gatewayData/);
          const updateMatch = block.match(
            /transaction\.update\(\{[\s\S]*?data:\s*\{([\s\S]*?)\}/,
          );
          assert.ok(updateMatch, 'post-create transaction.update must exist');
          assert.doesNotMatch(updateMatch[1]!, /\bstatus\b/);
        });

    it('provider create never fulfills subscriptions', () => {
      assert.equal(providerCode.includes('applyCompletedTransaction'), false);
      assert.match(providerCode, /providerMode = checkoutUrl !== null \? 'REDIRECT' : 'IMMEDIATE'/);
    });

    it('auto-renew never extends expiresAt (only EXPIRED status write)', () => {
      assert.equal(autoRenewCode.includes('applyCompletedTransaction'), false);
      // May mark EXPIRED after exhausted attempts — never bump expiresAt.
      assert.match(autoRenewCode, /status:\s*SubscriptionStatus\.EXPIRED/);
      assert.equal(
        /expiresAt:\s*(calculate|new Date|.*\+)/.test(autoRenewCode),
        false,
        'auto-renew must not compute a new expiresAt',
      );
    });

    it('no create-time providerStatus===succeeded → COMPLETED shortcut in src', () => {
      for (const src of [renewalCode, providerCode, autoRenewCode]) {
        assert.equal(
          /providerStatus\s*===\s*['"]succeeded['"]/.test(src),
          false,
          'must not complete on create-time providerStatus',
        );
      }
    });
  });

  describe('PaymentsRenewalCheckoutService: paid IMMEDIATE/succeeded create does not fulfill', () => {
    it('does not call applyCompletedTransaction and leaves transaction PENDING', async () => {
      const transactionUpdates: Array<Record<string, unknown>> = [];
      let applyCalls = 0;
      let providerCalls = 0;

      const prisma = {
        paymentGateway: {
          findUnique: async () => ({
            type: PaymentGatewayType.YOOKASSA,
            isActive: true,
            currency: Currency.USD,
            settings: { shopId: 'test-shop', apiKey: 'test-key' },
          }),
        },
        user: { findUnique: async () => ({ id: 'user-1' }) },
        transaction: {
          findFirst: async () => null,
          findMany: async () => [],
          findUnique: async () => null,
          create: async (args: { data: Record<string, unknown> }) =>
            draftRow({ ...args.data }),
          updateMany: async () => ({ count: 1 }),
          update: async (args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            transactionUpdates.push(args.data);
            return draftRow({
              ...args.data,
              status:
                (args.data.status as TransactionStatus | undefined) ??
                TransactionStatus.PENDING,
              gatewayId: (args.data.gatewayId as string | null | undefined) ?? 'yk_1',
              checkoutUrl: (args.data.checkoutUrl as string | null | undefined) ?? null,
            });
          },
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
        $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            transaction: {
              create: async (args: { data: Record<string, unknown> }) =>
                draftRow({ ...args.data }),
            },
            transactionItem: { createMany: async () => ({ count: 1 }) },
          }),
      };

      const renewal = { priceRenewalItems: async () => PRICED };
      const provider = {
        createCheckout: async () => {
          providerCalls += 1;
          return {
            gatewayId: 'yk_1',
            checkoutUrl: null,
            providerMode: 'IMMEDIATE',
            providerStatus: 'succeeded',
            gatewayData: {
              provider: 'YOOKASSA',
              providerStatus: 'succeeded',
              providerMode: 'IMMEDIATE',
              checkoutUrl: null,
            },
          };
        },
      };
      const mutation = {
        applyCompletedTransaction: async () => {
          applyCalls += 1;
          throw new Error(
            'applyCompletedTransaction must not run on paid create (IMMEDIATE/succeeded)',
          );
        },
      };
      const queue = {
        enqueue: async () => {
          throw new Error('profile sync must not run on paid create');
        },
      };
      const settings = {
        getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }),
      };
      const guard = { evaluate: () => null };
      const savedMethods = {
        resolveActiveForCharge: async () => ({
          id: 'spm-1',
          providerMethodId: 'pm_yoo_1',
        }),
      };

      const service = new PaymentsRenewalCheckoutService(
        prisma as never,
        renewal as never,
        provider as never,
        mutation as never,
        queue as never,
        settings as never,
        guard as never,
        savedMethods as never,
      );

      const result = await service.renewalCheckout({
        userId: 'user-1',
        subscriptionIds: ['sub-1'],
        gatewayType: PaymentGatewayType.YOOKASSA,
        expectedAmount: '10.00',
        expectedCurrency: Currency.USD,
        savedPaymentMethodId: 'spm-1',
      });

      assert.equal(providerCalls, 1);
      assert.equal(applyCalls, 0, 'must not fulfill on provider create');
      assert.equal(result.transactionStatus, TransactionStatus.PENDING);
      assert.equal(result.checkoutUrl, null);
      assert.equal(result.providerMode, 'IMMEDIATE');

      const statusUpdates = transactionUpdates.filter((d) => 'status' in d);
      assert.equal(
        statusUpdates.length,
        0,
        `paid create must not write status; got ${JSON.stringify(statusUpdates)}`,
      );
      const gatewayWrite = transactionUpdates.find((d) => d.gatewayId === 'yk_1');
      assert.ok(gatewayWrite, 'must persist real provider gatewayId');
      assert.equal(gatewayWrite!.checkoutUrl, null);
      assert.ok(gatewayWrite!.gatewayData);
    });
  });

  describe('PaymentReconciliationService — only SUCCESS fulfills', () => {
    it('webhook eventStatus=succeeded claims fulfillment via applyCompletedTransaction', async () => {
      const state = createReconState({
        eventStatus: 'succeeded',
        initialStatus: TransactionStatus.PENDING,
      });
      const service = createReconService(state);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(state.mutationCalls, ['tx-1']);
      assert.deepEqual(state.markProcessedCalls, ['event-1']);
      assert.equal(state.updatedStatus, TransactionStatus.COMPLETED);
    });

    it('webhook eventStatus=pending does not fulfill', async () => {
      const state = createReconState({
        eventStatus: 'pending',
        initialStatus: TransactionStatus.PENDING,
      });
      const service = createReconService(state);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(state.mutationCalls, []);
      assert.equal(state.updatedStatus, TransactionStatus.PENDING);
      assert.deepEqual(state.markProcessedCalls, ['event-1']);
    });

    it('webhook eventStatus=waiting_for_capture does not fulfill', async () => {
      const state = createReconState({
        eventStatus: 'waiting_for_capture',
        initialStatus: TransactionStatus.PENDING,
      });
      const service = createReconService(state);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(state.mutationCalls, []);
      assert.equal(state.updatedStatus, TransactionStatus.PENDING);
    });

    it('webhook eventStatus=canceled does not fulfill', async () => {
      const state = createReconState({
        eventStatus: 'canceled',
        initialStatus: TransactionStatus.PENDING,
      });
      const service = createReconService(state);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(state.mutationCalls, []);
      assert.equal(state.updatedStatus, TransactionStatus.CANCELED);
    });

    it('IMMEDIATE create-time gatewayData alone never triggers mutation without SUCCESS event', async () => {
      // Draft right after YooKassa off-session create: gatewayData says
      // providerStatus=succeeded, status still PENDING, no SUCCESS webhook.
      const state = createReconState({
        eventStatus: 'pending',
        initialStatus: TransactionStatus.PENDING,
        gatewayData: {
          provider: 'YOOKASSA',
          providerMode: 'IMMEDIATE',
          providerStatus: 'succeeded',
          checkoutUrl: null,
        },
      });
      const service = createReconService(state);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(
        state.mutationCalls,
        [],
        'create-time providerStatus=succeeded in gatewayData must not fulfill',
      );
    });
  });
});

// ─── recon test doubles (minimal; mirrors payment-reconciliation-notifications) ─

type ReconState = ReturnType<typeof createReconState>;

function createReconState(input: {
  readonly eventStatus: string;
  readonly initialStatus: TransactionStatus;
  readonly gatewayData?: Record<string, unknown>;
}) {
  const now = new Date('2026-07-16T15:04:50.000Z');
  return {
    event: {
      id: 'event-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      paymentId: 'payment-1',
      providerEventId: 'provider-event-1',
      eventStatus: input.eventStatus,
      status: PaymentWebhookLifecycleStatus.RECEIVED,
      attempts: 0,
      reconciliationAttempts: 0,
      replayCount: 0,
      lastError: null,
      lastReplayedAt: null,
      lastTransitionAt: now,
      payloadHash: 'hash',
      normalizedPayload: {},
      rawPayload: {},
      receivedAt: now,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    initialStatus: input.initialStatus,
    updatedStatus: null as TransactionStatus | null,
    gatewayData: input.gatewayData ?? {},
    mutationCalls: [] as string[],
    markProcessedCalls: [] as string[],
    markFailedCalls: [] as Array<[string, string]>,
    fulfilledAt: null as Date | null,
  };
}

function baseTransaction(state: ReconState, status: TransactionStatus) {
  return {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: 'sub-source',
    status,
    amount: 19900,
    currency: Currency.RUB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: 'yk_pay_1',
    gatewayData: state.gatewayData,
    checkoutUrl: null,
    purchaseType: PurchaseType.RENEW,
    channel: PurchaseChannel.WEB,
    planSnapshot: {},
    fulfilledAt: state.fulfilledAt,
    createdAt: new Date('2026-07-16T15:04:49.000Z'),
    updatedAt: new Date('2026-07-16T15:04:49.000Z'),
    idempotencyKey: 'auto-renew:sub-source:1:a1',
  };
}

function createReconService(state: ReconState): PaymentReconciliationService {
  const prismaService = {
    paymentWebhookEvent: {
      findUnique: async () => state.event,
    },
    transaction: {
      findUnique: async (args: { where: { id?: string; paymentId?: string } }) => {
        const status = state.updatedStatus ?? state.initialStatus;
        if (args.where.id === 'tx-1' || args.where.paymentId === 'payment-1') {
          return baseTransaction(state, status);
        }
        return null;
      },
      findFirst: async () => null,
      update: async (args: {
        where: { id: string };
        data: { status: TransactionStatus; gatewayData?: unknown };
      }) => {
        state.updatedStatus = args.data.status;
        return baseTransaction(state, args.data.status);
      },
      updateMany: async (args: {
        where: { id: string; fulfilledAt?: unknown };
        data: Record<string, unknown>;
      }) => {
        const isClaim = args.where.fulfilledAt === null;
        if (isClaim && state.fulfilledAt === null) {
          state.fulfilledAt = new Date();
          return { count: 1 };
        }
        if (!isClaim && state.fulfilledAt !== null) {
          state.fulfilledAt = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };

  const inbox = {
    incrementReconciliationAttempts: async () => undefined,
    markProcessing: async () => undefined,
    markProcessed: async (eventId: string) => {
      state.markProcessedCalls.push(eventId);
      return state.event;
    },
    markFailed: async (eventId: string, reason: string) => {
      state.markFailedCalls.push([eventId, reason]);
      return state.event;
    },
  };

  const mutation = {
    applyCompletedTransaction: async (tx: { id: string }) => {
      state.mutationCalls.push(tx.id);
      return { syncJobs: [{ id: 'sync-1' }] };
    },
  };

  return new PaymentReconciliationService(
    prismaService as unknown as PrismaService,
    inbox as unknown as PaymentWebhookInboxService,
    mutation as unknown as PaymentSubscriptionMutationService,
    { notifyWebhookFailed: async () => undefined } as unknown as PaymentOpsAlertService,
    { processPartnerEarning: async () => undefined } as unknown as PartnerEarningsService,
    { qualifyReferralAfterPurchase: async () => undefined } as unknown as ReferralQualificationService,
    { enqueue: async () => undefined } as unknown as ProfileSyncQueueService,
    { warn: () => undefined, info: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { enqueueRegisterIncome: async () => undefined } as unknown as MoyNalogQueueService,
    { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
  );
}
