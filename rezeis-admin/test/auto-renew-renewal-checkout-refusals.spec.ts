import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccessMode, PaymentGatewayType, Prisma, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import { renewalItemNotPriceable } from '../src/modules/subscriptions/services/subscription-renewal.service';

/**
 * AUTOPAY AGAINST THE REAL RENEWAL CHECKOUT — THE SEAM THE REFUSAL RULE READS.
 *
 * `AutoRenewService` treats a 4xx the checkout throws before any payment row
 * exists as final for this expiry (the subscription expires on schedule), and
 * anything else as a failure that may pass. `test/auto-renew.service.spec.ts`
 * pins that rule with exceptions built in the spec; this file asks the REAL
 * `PaymentsRenewalCheckoutService` instead, so a refusal that moved to another
 * status class, got wrapped, or began writing a row first shows up here.
 *
 * What autopay sends is fixed — one subscription, the saved YooKassa method's
 * gateway, channel WEB, an attempt key, no durations, plans, add-ons or expected
 * amount — so the refusals the checkout can raise before its draft are few:
 *
 *   final for the expiry   USER_BLOCKED (403) — the past-due pass does not filter
 *                          blocked owners; PAYMENT_GATEWAY_NOT_ACTIVE and
 *                          PAYMENT_GATEWAY_NOT_CONFIGURED (400);
 *                          RENEWAL_ITEM_NOT_PRICEABLE (400) and
 *                          RENEWAL_SUBSCRIPTION_NOT_FOUND (404) from pricing
 *   may pass               SERVICE_RESTRICTED (503), the only access-mode
 *                          rejection the renewal gate has
 *   cannot reach autopay   PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED (a charge method is
 *                          YooKassa only), RENEWAL_NO_ITEMS / MIXED_CURRENCY /
 *                          ADDON_* (one subscription, no add-ons), QUOTE_CHANGED
 *                          (no expected amount), and the checkout-flow codes
 *                          PAYMENT_DRAFT_PLAN_NOT_AVAILABLE (thrown only by
 *                          `PaymentsTransactionsService`, which the renewal
 *                          checkout never calls) and PLAN_SELECTION_REQUIRED
 *                          (a quote warning, never thrown)
 *
 * The control at the end proves the doubles are not inert: the same harness,
 * with the refusal moved past the draft, writes the attempt row and keeps the
 * subscription's remaining attempts.
 */

const PAST_DUE = new Date(Date.now() - 60_000);
const YOOKASSA_GATEWAY = {
  type: PaymentGatewayType.YOOKASSA,
  isActive: true,
  currency: 'RUB',
  settings: { shopId: 'shop-1', apiKey: 'key-1' },
};

const PRICED = {
  userId: 'user-1',
  currency: 'RUB',
  total: '199.00',
  items: [
    {
      subscriptionId: 'sub-1',
      planId: 'plan-1',
      planName: 'Plan 1',
      durationDays: 30,
      currency: 'RUB',
      amount: '199.00',
      discountPercent: 0,
      planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT' },
      addOnLines: [],
    },
  ],
};

interface Scenario {
  readonly userBlocked?: boolean;
  readonly accessMode?: AccessMode;
  readonly gateway?: Record<string, unknown> | null;
  readonly price?: () => Promise<typeof PRICED>;
  readonly withActiveForCharge?: () => Promise<never>;
}

interface TransactionRow {
  id: string;
  paymentId: string;
  userId: string;
  status: TransactionStatus;
  purchaseType: string;
  idempotencyKey: string | null;
  gatewayId: string | null;
  checkoutUrl: string | null;
  gatewayData: Record<string, unknown>;
  amount: Prisma.Decimal;
  currency: string;
  planSnapshot: Record<string, unknown>;
  checkoutFingerprint: string | null;
  createdAt: Date;
}

function harness(scenario: Scenario) {
  const subscription = {
    id: 'sub-1',
    userId: 'user-1',
    expiresAt: PAST_DUE,
    isTrial: false,
    status: SubscriptionStatus.ACTIVE as SubscriptionStatus,
  };
  const transactions: TransactionRow[] = [];
  const priced: string[] = [];
  let providerCalls = 0;

  const matches = (row: TransactionRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);

  const prisma = {
    subscription: {
      findMany: async () => (subscription.status === SubscriptionStatus.ACTIVE ? [{ ...subscription }] : []),
      updateMany: async (args: { where: { id: { in: string[] }; status: SubscriptionStatus } }) => {
        if (args.where.id.in.includes(subscription.id) && subscription.status === args.where.status) {
          subscription.status = SubscriptionStatus.EXPIRED;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    user: {
      // The block check every checkout path runs first.
      findFirst: async () => ({ isBlocked: scenario.userBlocked === true }),
    },
    paymentGateway: {
      findUnique: async () => (scenario.gateway === undefined ? YOOKASSA_GATEWAY : scenario.gateway),
    },
    transaction: {
      findMany: async (args: { where: { idempotencyKey?: { startsWith: string } } }) => {
        const prefix = args.where.idempotencyKey?.startsWith;
        // Autopay's attempt count reads by key prefix; the checkout's reusable
        // draft lookup has no key filter and finds nothing to reuse here.
        if (prefix === undefined) return [];
        return transactions.filter((row) => row.idempotencyKey?.startsWith(prefix) === true);
      },
      findFirst: async (args: { where: { userId: string; idempotencyKey: string } }) =>
        transactions.find((row) => row.userId === args.where.userId && row.idempotencyKey === args.where.idempotencyKey) ?? null,
      findUnique: async (args: { where: { id: string } }) => transactions.find((row) => row.id === args.where.id) ?? null,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = transactions.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            const row: TransactionRow = {
              id: `tx-${transactions.length + 1}`,
              paymentId: `pay-${transactions.length + 1}`,
              gatewayId: null,
              checkoutUrl: null,
              gatewayData: {},
              createdAt: new Date(),
              ...(args.data as Omit<TransactionRow, 'id' | 'paymentId' | 'gatewayId' | 'checkoutUrl' | 'gatewayData' | 'createdAt'>),
            };
            transactions.push(row);
            return { ...row };
          },
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
      }),
  };

  const checkout = new PaymentsRenewalCheckoutService(
    prisma as never,
    {
      priceRenewalItems: async (input: { subscriptionIds: readonly string[] }) => {
        priced.push(...input.subscriptionIds);
        return scenario.price === undefined ? PRICED : scenario.price();
      },
      assertRenewalPolicy: async () => undefined,
    } as never,
    {
      createCheckout: async () => {
        providerCalls += 1;
        throw new Error('no provider call is expected in these cases');
      },
    } as never,
    {} as never,
    {} as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: scenario.accessMode ?? AccessMode.PUBLIC }) } as never,
    new AccessModeGuard(),
    {
      withActiveForCharge:
        scenario.withActiveForCharge ??
        (async () => {
          throw new Error('the saved method must not be charged in a pre-draft refusal case');
        }),
    } as never,
    {} as never, { recordCheckout: async () => undefined } as never,
    { info: () => undefined } as never,
  );

  const checkoutCalls: string[] = [];
  const autopay = new AutoRenewService(
    prisma as never,
    { create: async () => undefined } as never,
    {
      renewalCheckout: async (input: Parameters<PaymentsRenewalCheckoutService['renewalCheckout']>[0]) => {
        checkoutCalls.push(input.idempotencyKey ?? '');
        return checkout.renewalCheckout(input);
      },
    } as never,
    { findPreferredForCharge: async () => ({ id: 'method-1', gatewayType: PaymentGatewayType.YOOKASSA }) } as never,
    { build: async () => ({}) } as never,
    { requiresPlanSelection: async () => false } as never,
    { info: () => undefined } as never,
  );

  return {
    autopay,
    checkoutCalls,
    transactions,
    priced,
    providerCalls: () => providerCalls,
    status: () => subscription.status,
  };
}

describe('autopay over the real renewal checkout: a refusal before any payment exists', () => {
  const finalForTheExpiry: ReadonlyArray<readonly [string, Scenario]> = [
    ['a blocked owner (USER_BLOCKED)', { userBlocked: true }],
    ['the gateway switched off (PAYMENT_GATEWAY_NOT_ACTIVE)', { gateway: { ...YOOKASSA_GATEWAY, isActive: false } }],
    ['no gateway row at all (PAYMENT_GATEWAY_NOT_ACTIVE)', { gateway: null }],
    ['a gateway missing its credentials (PAYMENT_GATEWAY_NOT_CONFIGURED)', { gateway: { ...YOOKASSA_GATEWAY, settings: { shopId: 'shop-1' } } }],
    [
      'a renewal that cannot be priced (RENEWAL_ITEM_NOT_PRICEABLE)',
      {
        price: async () => {
          throw renewalItemNotPriceable();
        },
      },
    ],
    [
      'a subscription gone from under it (RENEWAL_SUBSCRIPTION_NOT_FOUND)',
      {
        price: async () => {
          throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
        },
      },
    ],
  ];

  for (const [what, scenario] of finalForTheExpiry) {
    it(`expires on schedule, asked once and with no payment written, for ${what}`, async () => {
      const h = harness(scenario);

      await h.autopay.markExpiredSubscriptions();

      assert.equal(h.status(), SubscriptionStatus.EXPIRED, 'held ACTIVE past its date for a retry that cannot succeed');
      assert.deepEqual(h.transactions, [], 'the refusal came after a payment row, so this case pins nothing');
      assert.equal(h.providerCalls(), 0);

      await h.autopay.markExpiredSubscriptions();
      assert.equal(h.checkoutCalls.length, 1, 'the refused renewal was asked for again');
    });
  }

  it('keeps the subscription ACTIVE and asks again while the service is RESTRICTED (a 503 that may pass)', async () => {
    const h = harness({ accessMode: AccessMode.RESTRICTED });

    await h.autopay.markExpiredSubscriptions();
    await h.autopay.markExpiredSubscriptions();

    assert.equal(h.status(), SubscriptionStatus.ACTIVE);
    assert.equal(h.checkoutCalls.length, 2);
    assert.deepEqual(h.priced, [], 'the restricted gate let the renewal reach pricing');
  });

  it('control: a refusal AFTER the draft writes its attempt row and keeps the remaining attempts', async () => {
    const h = harness({
      withActiveForCharge: async () => {
        throw new BadRequestException('SAVED_PAYMENT_METHOD_NOT_ACTIVE');
      },
    });

    await h.autopay.markExpiredSubscriptions();

    assert.equal(h.status(), SubscriptionStatus.ACTIVE, 'a recorded attempt was treated as a final refusal');
    assert.deepEqual(
      h.transactions.map((row) => [row.idempotencyKey?.replace(/^auto-renew:sub-1:\d+:/, ''), row.status]),
      [['a1', TransactionStatus.FAILED]],
      'the real checkout did not record the attempt it refused',
    );

    await h.autopay.markExpiredSubscriptions();
    assert.deepEqual(
      h.checkoutCalls.map((key) => key.replace(/^auto-renew:sub-1:\d+:/, '')),
      ['a1', 'a2'],
      'the next attempt was not made',
    );
  });
});
