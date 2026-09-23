import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';

import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';

/**
 * «для автоматического списания» on a combined renewal (Platega, RollyPay) is
 * refused when the renewal is onto another plan — an archived plan's
 * replacement, a plan chosen at renewal. The subscription stays on its old
 * plan until the new plan's term begins (at the end of the current one when
 * terms are durable), and the sweep read that as "moved to another plan" and
 * cancelled the sign-up at the provider, nobody told. Refused before anything
 * is written, the refusal reaches the buyer, who pays the ordinary way.
 */

function build(options: { readonly currentPlanId: string | null; readonly renewalPlanId: string }) {
  const created: Array<Record<string, unknown>> = [];
  const guarded: Array<string | null> = [];
  const recorded: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const draftRow = (data: Record<string, unknown>) => ({
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'PLATEGA',
    gatewayId: null,
    currency: 'RUB',
    amount: { toString: () => '299.00' },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null,
    checkoutFingerprint: null,
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    ...data,
  });
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({
        type: 'PLATEGA',
        isActive: true,
        currency: 'RUB',
        settings: { merchantId: 'm-1', secret: 's-1', savePaymentMethod: true },
      }),
    },
    user: { findUnique: async () => ({ id: 'user-1' }), findFirst: async () => null },
    subscription: {
      // Asked for the subscription being renewed, and nothing else: a check
      // reading another row's plan would compare the wrong thing.
      findUnique: async ({ where }: { where: { id: string } }) => {
        assert.equal(where.id, 'sub-1', 'the plan is read from the subscription being renewed');
        return { planSnapshot: options.currentPlanId === null ? {} : { id: options.currentPlanId } };
      },
    },
    transaction: {
      findFirst: async () => null,
      findMany: async () => [],
      findUnique: async () => null,
      updateMany: async () => ({ count: 1 }),
      update: async (args: { data: Record<string, unknown> }) =>
        draftRow({ ...created[0], ...args.data, checkoutUrl: 'https://pay.platega.example/sub-1' }),
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
        planId: options.renewalPlanId,
        planName: options.renewalPlanId,
        durationDays: 30,
        currency: 'RUB',
        amount: '299.00',
        discountPercent: 0,
        discountSource: 'NONE',
        planSnapshot: { id: options.renewalPlanId, snapshotSource: 'RENEWAL_DRAFT' },
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
          gatewayId: 'sub-1',
          checkoutUrl: 'https://pay.platega.example/sub-1',
          providerMode: 'REDIRECT',
          providerStatus: 'PENDING',
          gatewayData: { checkoutUrl: 'https://pay.platega.example/sub-1' },
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
      assertNoLiveSubscriptionFor: async (id: string | null) => {
        guarded.push(id);
      },
      recordCheckout: async (transaction: Record<string, unknown>) => {
        recorded.push(transaction);
      },
    } as never,
    { info: () => undefined } as never,
  );
  const renew = () =>
    service.renewalCheckout({
      userId: 'user-1',
      subscriptionIds: ['sub-1'],
      gatewayType: 'PLATEGA' as never,
      expectedAmount: '299.00',
      expectedCurrency: 'RUB' as never,
      savePaymentMethodConsent: true,
    });
  return { renew, created, guarded, recorded, providerCalls: () => providerCalls };
}

describe('a combined renewal with «для автоматического списания»', () => {
  it('is refused onto another plan before any draft or provider subscription exists', async () => {
    const r = build({ currentPlanId: 'old-plan', renewalPlanId: 'new-plan' });

    await assert.rejects(r.renew(), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepEqual(
        [(error.getResponse() as { code?: unknown }).code, (error.getResponse() as { reason?: unknown }).reason],
        ['AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE', 'PLAN_CHANGE'],
      );
      return true;
    });
    assert.deepEqual(r.created, []);
    assert.equal(r.providerCalls(), 0);
    assert.deepEqual(r.recorded, []);
  });

  it('is made onto the plan the subscription is on, for that subscription', async () => {
    const r = build({ currentPlanId: 'plan-a', renewalPlanId: 'plan-a' });

    await r.renew();

    assert.deepEqual(r.guarded, ['sub-1']);
    assert.equal(r.providerCalls(), 1);
    assert.deepEqual(
      (r.created[0]?.planSnapshot as Record<string, unknown>)['providerSubscription'],
      { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-a', subscriptionId: 'sub-1' },
    );
  });

  it('is made for a subscription whose snapshot names no plan to compare with', async () => {
    const r = build({ currentPlanId: null, renewalPlanId: 'plan-a' });

    await r.renew();

    assert.equal(r.providerCalls(), 1);
  });
});
