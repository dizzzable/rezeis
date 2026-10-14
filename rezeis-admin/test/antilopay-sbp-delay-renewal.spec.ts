import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { autopayNotAvailable } from '../src/modules/payments/utils/provider-subscription-terms.util';

/**
 * «Отсрочка первого списания по СБП» on a renewal: the renewal page signs a
 * payer up for Antilopay's SBP autopay too, and its draft carries the delay the
 * payer was shown — or none, or a refusal when the panel would not give it now.
 */

const SEVEN_DAYS = { count: 7, unit: 'DAY', days: 7 } as const;
const GATEWAY_SETTINGS = {
  projectIdentificator: 'project-1',
  secretId: 'secret-1',
  privateKey: 'k',
  publicKey: 'p',
  autopayCardApproved: true,
  autopaySbpApproved: true,
  sbpDelayCount: 7,
  sbpDelayUnit: 'DAY',
};

function build(settle: (asked: Record<string, unknown>) => Promise<unknown>) {
  const created: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const draftRow = (data: Record<string, unknown>) => ({
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'ANTILOPAY',
    gatewayId: null,
    currency: 'RUB',
    amount: { toString: () => '299.00' },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null,
    checkoutFingerprint: null,
    createdAt: new Date('2026-10-14T10:00:00.000Z'),
    ...data,
  });
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({ type: 'ANTILOPAY', isActive: true, currency: 'RUB', settings: GATEWAY_SETTINGS }),
    },
    user: { findUnique: async () => ({ id: 'user-1' }), findFirst: async () => null },
    subscription: { findUnique: async () => ({ planSnapshot: { id: 'plan-1' } }) },
    transaction: {
      findFirst: async () => null,
      findMany: async () => [],
      findUnique: async () => null,
      updateMany: async () => ({ count: 1 }),
      update: async (args: { data: Record<string, unknown> }) =>
        draftRow({ ...created[created.length - 1], ...args.data, checkoutUrl: 'https://gate.antilopay.com/payment/APAY-1' }),
    },
    transactionItem: { createMany: async () => ({ count: 1 }) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return draftRow(args.data);
          },
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
      }),
  };
  const priced = {
    userId: 'user-1',
    currency: 'RUB',
    total: '299.00',
    items: [
      {
        subscriptionId: 'sub-1',
        planId: 'plan-1',
        planName: 'plan-1',
        durationDays: 30,
        currency: 'RUB',
        amount: '299.00',
        discountPercent: 0,
        discountSource: 'NONE',
        planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT' },
        addOnLines: [],
      },
    ],
  };
  const service = new PaymentsRenewalCheckoutService(
    prisma as never,
    { priceRenewalItems: async () => priced, assertRenewalPolicy: async () => undefined } as never,
    {
      createCheckout: async () => {
        providerCalls += 1;
        return {
          gatewayId: 'APAY-1',
          checkoutUrl: 'https://gate.antilopay.com/payment/APAY-1',
          providerMode: 'REDIRECT',
          providerStatus: 'PENDING',
          gatewayData: { checkoutUrl: 'https://gate.antilopay.com/payment/APAY-1' },
        };
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { resolveActiveForCharge: async () => null } as never,
    { runPostFulfillmentHooksBestEffort: async () => undefined } as never,
    {
      assertNoLiveSubscriptionFor: async () => undefined,
      recordCheckout: async () => undefined,
      settleAntilopayDelay: async (asked: Record<string, unknown>) => {
        settled.push(asked);
        return settle(asked);
      },
    } as never,
    { info: () => undefined } as never,
  );
  const renew = (extra: Record<string, unknown> = {}) =>
    service.renewalCheckout({
      userId: 'user-1',
      subscriptionIds: ['sub-1'],
      gatewayType: 'ANTILOPAY' as never,
      expectedAmount: '299.00',
      expectedCurrency: 'RUB' as never,
      savePaymentMethodConsent: true,
      autopayMethod: 'SBP',
      ...extra,
    });
  return { renew, created, settled, providerCalls: () => providerCalls };
}

const terms = (created: Array<Record<string, unknown>>): Record<string, unknown> | undefined =>
  (created[0]?.['planSnapshot'] as Record<string, unknown> | undefined)?.['providerSubscription'] as
    | Record<string, unknown>
    | undefined;

describe('a renewal signed up with a delay of the first SBP charge', () => {
  it('puts the delay the payer was shown into the draft\'s terms, and marks the draft apart from one without', async () => {
    const withDelay = build(async () => SEVEN_DAYS);
    const audience = { can: () => true } as never;
    await withDelay.renew({ autopayDelayCount: 7, autopayDelayUnit: 'DAY', audience });
    assert.deepEqual(terms(withDelay.created)?.['delay'], SEVEN_DAYS);
    assert.equal(terms(withDelay.created)?.['method'], 'SBP');
    assert.equal(withDelay.settled.length, 1);
    assert.equal(withDelay.settled[0]?.['audience'], audience);
    assert.equal(withDelay.settled[0]?.['userId'], 'user-1');
    assert.deepEqual(withDelay.settled[0]?.['shown'], { kind: 'SHOWN', delay: SEVEN_DAYS });

    const without = build(async () => null);
    await without.renew({ audience });
    assert.equal(terms(without.created)?.['delay'], undefined);
    assert.equal(without.settled.length, 0, 'nothing shown, nothing asked');
    // A link made for a payer who was told nothing is charged now is never handed to one who was told so.
    assert.notEqual(withDelay.created[0]?.['checkoutFingerprint'], without.created[0]?.['checkoutFingerprint']);
  });

  it('refuses the renewal, and makes no draft, when the delay the payer saw is gone', async () => {
    const run = build(async () => {
      throw autopayNotAvailable('DELAY_CHANGED');
    });
    await assert.rejects(
      run.renew({ autopayDelayCount: 7, autopayDelayUnit: 'DAY', audience: { can: () => true } as never }),
      (error: BadRequestException) => (error.getResponse() as { reason?: string }).reason === 'DELAY_CHANGED',
    );
    assert.equal(run.created.length, 0);
    assert.equal(run.providerCalls(), 0);
  });

  it('refuses a delay named on a renewal that is no autopay sign-up', async () => {
    const run = build(async () => SEVEN_DAYS);
    await assert.rejects(
      run.renew({ autopayDelayCount: 7, autopayDelayUnit: 'DAY', savePaymentMethodConsent: undefined }),
      (error: BadRequestException) => (error.getResponse() as { reason?: string }).reason === 'DELAY_CHANGED',
    );
    assert.equal(run.created.length, 0);
  });

  it('gives a card sign-up no delay in its terms', async () => {
    const run = build(async () => null);
    await run.renew({ autopayMethod: 'CARD' });
    assert.equal(terms(run.created)?.['delay'], undefined);
    assert.equal(terms(run.created)?.['method'], 'CARD');
  });
});
