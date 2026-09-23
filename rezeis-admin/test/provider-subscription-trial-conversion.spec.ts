import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import {
  ProviderSubscriptionService,
  strandedReason,
  trialConversionOf,
} from '../src/modules/payments/services/provider-subscription.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * «для автоматического списания» (Platega, RollyPay) on the purchase that
 * converts a trial — an UPGRADE of it, priced like a new purchase.
 *
 * The provider subscription is recorded on the trial from the start: it is the
 * subscription every later charge renews. Until the first charge lands, though,
 * the trial is still on the trial's plan, and the sweep that cancels a provider
 * subscription whose VPN subscription "moved to another plan" read exactly that
 * as a move — it cancelled the sign-up at the provider within ten minutes,
 * before the payer had even confirmed it. These are the money paths of such a
 * sign-up: the sweep, the first charge and its replay, the renewals, a failure
 * and a cancellation.
 */

const TRIAL = 'trial-sub';
const CONVERSION = 'tx-conversion';
const DAY = 24 * 60 * 60 * 1000;

describe('strandedReason on a trial conversion', () => {
  const trial = { status: SubscriptionStatus.ACTIVE, planId: 'trial-plan' } as const;
  const reason = (
    subscription: Parameters<typeof strandedReason>[0]['subscription'],
    overrides: Partial<Parameters<typeof strandedReason>[0]> = {},
  ) => strandedReason({ userDeleted: false, userBlocked: false, subscription, planId: 'plan-1', ...overrides });

  it('does not read a trial awaiting its conversion as a move to another plan', () => {
    assert.equal(reason({ ...trial, trialConversion: 'PENDING' }), null);
    // Without the conversion it is what it looks like.
    assert.equal(reason(trial), 'subscription moved to another plan');
  });

  it('still stops for a deleted trial and for a blocked or deleted account', () => {
    assert.equal(
      reason({ status: SubscriptionStatus.DELETED, planId: 'trial-plan', trialConversion: 'PENDING' }),
      'subscription deleted',
    );
    assert.equal(reason({ ...trial, trialConversion: 'PENDING' }, { userBlocked: true }), 'account blocked');
    assert.equal(reason({ ...trial, trialConversion: 'PENDING' }, { userDeleted: true }), 'account deleted');
  });

  it('stops a sign-up whose trial was converted without its charge, even onto the same plan', () => {
    assert.equal(
      reason({ status: SubscriptionStatus.ACTIVE, planId: 'plan-1', trialConversion: 'LOST' }),
      'trial converted without its first charge',
    );
  });
});

describe('trialConversionOf', () => {
  // Fulfilled unless the case says otherwise: a paid checkout whose conversion landed.
  const checkout = (status: TransactionStatus, subscriptionId: string | null = TRIAL, fulfilledAt: Date | null = new Date()) => ({
    subscriptionId,
    status,
    fulfilledAt,
  });

  it('speaks only for a checkout that converts this very subscription', () => {
    assert.deepEqual(trialConversionOf(undefined, TRIAL, true), {});
    assert.deepEqual(trialConversionOf(checkout(TransactionStatus.PENDING, 'another-sub'), TRIAL, true), {});
    assert.deepEqual(trialConversionOf(checkout(TransactionStatus.PENDING), null, true), {});
  });

  it('holds the trial as awaiting its conversion until the flag clears, paid or not', () => {
    // Paid and still a trial: the fulfilment is in flight, or failed and waits for its retry.
    for (const status of [TransactionStatus.PENDING, TransactionStatus.COMPLETED]) {
      assert.deepEqual(trialConversionOf(checkout(status), TRIAL, true), { trialConversion: 'PENDING' });
    }
  });

  it('lets a conversion its own charge made be compared as any subscription is', () => {
    assert.deepEqual(trialConversionOf(checkout(TransactionStatus.COMPLETED), TRIAL, false), {});
  });

  it('calls the conversion lost when the trial is converted and that charge does not stand', () => {
    for (const status of [
      TransactionStatus.PENDING,
      TransactionStatus.CANCELED,
      TransactionStatus.FAILED,
      TransactionStatus.REFUNDED,
    ]) {
      assert.deepEqual(trialConversionOf(checkout(status), TRIAL, false), { trialConversion: 'LOST' }, status);
    }
  });

  it('calls it lost when its charge was paid and not applied yet, the trial converted by another payment', () => {
    // Paid, fulfilment failed and waiting for its retry — which will withhold it.
    assert.deepEqual(trialConversionOf(checkout(TransactionStatus.COMPLETED, TRIAL, null), TRIAL, false), {
      trialConversion: 'LOST',
    });
  });

  it('calls it lost when its charge was paid and withheld, another payment having converted the trial first', () => {
    // Settled like any payment — COMPLETED and fulfilled — and applied to nothing.
    const withheld = {
      ...checkout(TransactionStatus.COMPLETED),
      gatewayData: { conversionWithheldAt: '2026-09-23T10:00:00.000Z', trialConvertedByPaymentId: 'payment-first' },
    };
    assert.deepEqual(trialConversionOf(withheld, TRIAL, false), { trialConversion: 'LOST' });
  });
});

interface World {
  readonly service: ProviderSubscriptionService;
  readonly row: () => ProviderSubscription;
  readonly subscription: { id: string; status: SubscriptionStatus; isTrial: boolean; planId: string; expiresAt: Date | null };
  readonly transactions: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  readonly events: Array<{ providerEventId: string; paymentId: string }>;
  readonly jobs: Array<{ name: string; data: Record<string, unknown> }>;
  /** Every POST to the provider — a cancellation. */
  readonly posts: string[];
  /** The order the sweep read subscriptions and checkouts in. */
  readonly reads: string[];
  setProvider(state: Record<string, unknown>): void;
  /** The conversion lands: the checkout is paid, then fulfilment moves the trial onto `planId`. */
  convert(planId?: string): void;
  /** Lands the conversion right after the sweep's first read of either kind. */
  convertDuringTheSweep(): void;
}

/**
 * One provider subscription recorded by a trial's conversion: planId `plan-1`,
 * 299 RUB a month, bound to the trial, its first charge completing the UPGRADE
 * checkout `tx-conversion`.
 */
function world(options: {
  readonly row?: Partial<ProviderSubscription>;
  readonly subscription?: Partial<World['subscription']>;
  /** The checkout's purchase type; an older binding put ADDITIONAL rows on a trial. */
  readonly checkoutPurchaseType?: PurchaseType;
  readonly checkoutStatus?: TransactionStatus;
  readonly userBlocked?: boolean;
} = {}): World {
  let row: ProviderSubscription = {
    id: 'ps-1',
    userId: 'user-1',
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId: 'sub-1',
    status: ProviderSubscriptionStatus.PENDING,
    providerStatus: null,
    subscriptionId: TRIAL,
    planId: 'plan-1',
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    listAmount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    intervalUnit: 'month',
    intervalCount: 1,
    firstTransactionId: CONVERSION,
    appliedChargeCount: 0,
    nextChargeAt: null,
    lastChargeAt: null,
    lastSyncedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...options.row,
  };
  const subscription: World['subscription'] = {
    id: TRIAL,
    status: SubscriptionStatus.ACTIVE,
    isTrial: true,
    planId: 'trial-plan',
    expiresAt: new Date(Date.now() + 3 * DAY),
    ...options.subscription,
  };
  const transactions: Array<Record<string, unknown>> = [
    {
      id: CONVERSION,
      paymentId: 'payment-conversion',
      userId: 'user-1',
      purchaseType: options.checkoutPurchaseType ?? PurchaseType.UPGRADE,
      status: options.checkoutStatus ?? TransactionStatus.PENDING,
      subscriptionId: TRIAL,
      fulfilledAt: null,
      idempotencyKey: null,
    },
  ];
  const checkout = transactions[0]!;
  const items: Array<Record<string, unknown>> = [];
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown> }> = [];
  const posts: string[] = [];
  const reads: string[] = [];
  let provider: Record<string, unknown> = {};
  let raceArmed = false;

  const convert = (planId = 'plan-1') => {
    checkout.status = TransactionStatus.COMPLETED;
    checkout.fulfilledAt = new Date();
    subscription.isTrial = false;
    subscription.planId = planId;
    subscription.expiresAt = new Date(Date.now() + 30 * DAY);
  };
  const landRaceAfterRead = () => {
    if (!raceArmed) return;
    raceArmed = false;
    convert();
  };

  const findTransaction = (where: Record<string, unknown>) => {
    if (typeof where.id === 'string') return transactions.find((t) => t.id === where.id) ?? null;
    const key = where.userId_idempotencyKey as { userId: string; idempotencyKey: string } | undefined;
    return key === undefined
      ? null
      : (transactions.find((t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey) ?? null);
  };

  const prisma = {
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
    },
    providerSubscription: {
      findMany: async ({ where }: { where: { status?: { in?: ProviderSubscriptionStatus[] } } }) =>
        where.status?.in === undefined || where.status.in.includes(row.status)
          ? [{ ...row, user: row.userId === null ? null : { isBlocked: options.userBlocked === true } }]
          : [],
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === row.id && where.userId === row.userId ? row : null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== row.id) return { count: 0 };
        // A charge's bump of the applied count.
        if ('appliedChargeCount' in where && where.appliedChargeCount !== row.appliedChargeCount) return { count: 0 };
        // Who cancelled it, never over a refund's mark (`recordCancelledBy`).
        if ('OR' in where && row.cancelledBy === 'REFUND') return { count: 0 };
        row = { ...row, ...data } as ProviderSubscription;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data } as ProviderSubscription;
        return row;
      },
    },
    subscription: {
      findMany: async ({ where, select }: { where: { id: { in: string[] } }; select: Record<string, boolean> }) => {
        reads.push('subscriptions');
        const found = where.id.in.includes(subscription.id)
          ? [
              selected(select, {
                id: subscription.id,
                status: subscription.status,
                isTrial: subscription.isTrial,
                planSnapshot: { id: subscription.planId },
              }),
            ]
          : [];
        landRaceAfterRead();
        return found;
      },
      findUnique: async ({ select }: { select: Record<string, boolean> }) =>
        selected(select, { expiresAt: subscription.expiresAt, isTrial: subscription.isTrial }),
    },
    transaction: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => findTransaction(where),
      // The sweep's read of the checkouts: honours the ids, the purchase type
      // and the fields it asks for.
      findMany: async ({
        where,
        select,
      }: {
        where: { id: { in: string[] }; purchaseType?: PurchaseType };
        select: Record<string, boolean>;
      }) => {
        reads.push('checkouts');
        const found = transactions
          .filter((t) => where.id.in.includes(t.id as string))
          .filter((t) => where.purchaseType === undefined || t.purchaseType === where.purchaseType)
          .map((t) => selected(select, t));
        landRaceAfterRead();
        return found;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: `tx-${transactions.length + 1}`, paymentId: `payment-${transactions.length + 1}`, ...data };
            transactions.push(created);
            return created;
          },
        },
        transactionItem: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            items.push(data);
            return data;
          },
        },
      }),
  };
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: { providerEventId: string; paymentId: string; payloadHash: string } }) => {
      const existing = events.find((event) => event.providerEventId === envelope.providerEventId);
      if (existing !== undefined && existing.payloadHash === envelope.payloadHash) {
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push({ providerEventId: envelope.providerEventId, paymentId: envelope.paymentId, payloadHash: envelope.payloadHash });
      return {
        event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.PLATEGA },
        duplicate: false,
      };
    },
    markEnqueued: async () => undefined,
    markFailed: async () => undefined,
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>) => {
      jobs.push({ name, data });
    },
  };
  const http = {
    get: () => of({ data: provider }),
    post: (url: string) => {
      posts.push(url);
      return of({ data: { subscriptionId: row.providerSubscriptionId, status: 'cancelled' } });
    },
  };
  return {
    service: new ProviderSubscriptionService(prisma as never, http as never, inbox as never, queue as never),
    row: () => row,
    subscription,
    transactions,
    items,
    events,
    jobs,
    posts,
    reads,
    setProvider: (state) => {
      provider = state;
    },
    convert,
    convertDuringTheSweep: () => {
      raceArmed = true;
    },
  };
}

/** Only the fields a `select` asks for, as Prisma returns them. */
function selected(select: Record<string, boolean> | undefined, row: Record<string, unknown>): Record<string, unknown> {
  if (select === undefined) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key] === true));
}

const PLATEGA_CANCEL = 'https://app.platega.io/subscription/sub-1/cancel';

describe('the sweep and a trial conversion', () => {
  it('leaves a sign-up alone while its trial waits for the first charge', async () => {
    const w = world();

    assert.equal(await w.service.cancelStranded(), 0);

    assert.deepEqual(w.posts, []);
    assert.equal(w.row().status, ProviderSubscriptionStatus.PENDING);
  });

  it('leaves it alone while that charge is paid and the conversion is still on its way', async () => {
    // Paid, fulfilment in flight — or failed, and waiting for its retry.
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 }, checkoutStatus: TransactionStatus.COMPLETED });

    assert.equal(await w.service.cancelStranded(), 0);
    assert.deepEqual(w.posts, []);
  });

  it('leaves the subscription its charge converted alone', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convert();

    assert.equal(await w.service.cancelStranded(), 0);
    assert.deepEqual(w.posts, []);
  });

  it('leaves it alone when the conversion lands between the two reads', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convertDuringTheSweep();

    assert.equal(await w.service.cancelStranded(), 0);

    // Subscriptions first: a trial seen converted comes with its charge already paid.
    assert.deepEqual(w.reads, ['subscriptions', 'checkouts']);
    assert.deepEqual(w.posts, []);
  });

  it('cancels, at the provider, a sign-up whose trial another purchase converted onto another plan', async () => {
    const w = world({ checkoutStatus: TransactionStatus.CANCELED });
    w.subscription.isTrial = false;
    w.subscription.planId = 'plan-2';

    assert.equal(await w.service.cancelStranded(), 1);

    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
    assert.equal(w.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.row().cancelledBy, 'SYSTEM');
  });

  it('cancels one whose trial another purchase converted onto the very same plan', async () => {
    // Confirmed later, its first charge would convert the subscription again:
    // the term paid for would start over, and a second autopay would follow.
    const w = world();
    w.subscription.isTrial = false;
    w.subscription.planId = 'plan-1';

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });

  it('cancels one whose converting charge was refunded', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convert();
    w.transactions[0]!.status = TransactionStatus.REFUNDED;

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });

  it('cancels one whose charge was paid and not applied yet, another payment having converted the trial', async () => {
    // Paid, fulfilment waiting for its retry, which will withhold it. Left
    // live, its later charges would renew a subscription it never bought.
    const w = world({
      row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 },
      checkoutStatus: TransactionStatus.COMPLETED,
    });
    w.subscription.isTrial = false;
    w.subscription.planId = 'plan-1';

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });

  it('cancels one whose charge was withheld, another payment having converted the trial first', async () => {
    // Settled like any payment and applied to nothing: only the withheld mark
    // tells it from a conversion that stands.
    const w = world({
      row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 },
      checkoutStatus: TransactionStatus.COMPLETED,
    });
    w.transactions[0]!.fulfilledAt = new Date();
    w.transactions[0]!.gatewayData = {
      conversionWithheldAt: '2026-09-23T10:00:00.000Z',
      trialConvertedByPaymentId: 'payment-first',
    };
    w.subscription.isTrial = false;
    w.subscription.planId = 'plan-1';

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });

  it('still cancels a sign-up an older checkout bound to a trial it never converts', async () => {
    // An ADDITIONAL used to be recorded on the buyer's latest subscription —
    // a trial, for a trial holder. Its charges would renew a trial, which no
    // renewal may: nothing here may keep such a row alive.
    const w = world({ checkoutPurchaseType: PurchaseType.ADDITIONAL });

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });

  it('still cancels a pending conversion for a blocked account', async () => {
    const w = world({ userBlocked: true });

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
  });
});

describe('the charges of a trial conversion', () => {
  const nextCharge = () => new Date(Date.now() + 30 * DAY).toISOString();

  it('settles the first charge on the conversion checkout, once however often it is looked at', async () => {
    const w = world();
    w.setProvider({ status: 'Active', nextChargeAt: nextCharge(), chargeMetrics: { chargesSuccess: 1 } });

    await w.service.syncRow(w.row());
    await w.service.syncRow(w.row());

    // The UPGRADE checkout is what the first charge pays for: its fulfilment
    // converts the trial. No renewal is made for it.
    assert.deepEqual(
      w.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-1:charge:1', 'payment-conversion']],
    );
    assert.deepEqual(w.jobs.map((job) => job.name), [PAYMENT_RECONCILIATION_JOB]);
    assert.equal(w.transactions.length, 1);
    assert.equal(w.row().appliedChargeCount, 1);
    assert.equal(w.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(w.row().subscriptionId, TRIAL);
  });

  it('renews the converted subscription with each later charge, at the sum the payer agreed to, once', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convert();
    w.setProvider({ status: 'Active', nextChargeAt: nextCharge(), chargeMetrics: { chargesSuccess: 2 } });

    await w.service.syncRow(w.row());
    await w.service.syncRow(w.row());

    assert.equal(w.transactions.length, 2);
    const renewal = w.transactions[1]!;
    assert.equal(renewal.purchaseType, PurchaseType.RENEW);
    assert.equal(renewal.channel, PurchaseChannel.WEB);
    assert.equal(renewal.idempotencyKey, 'provider-subscription:ps-1:charge:2');
    assert.equal(String(renewal.amount), '299');
    assert.deepEqual(
      w.items.map((item) => [item.subscriptionId, item.planId]),
      [[TRIAL, 'plan-1']],
    );
    assert.deepEqual(
      w.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-1:charge:2', 'payment-2']],
    );
    assert.equal(w.row().appliedChargeCount, 2);
  });

  it('renews nothing when the provider reports a failed charge, and keeps the term already paid', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convert();
    const paidUntil = w.subscription.expiresAt;
    w.setProvider({ status: 'SUBSCRIPTION_PAST_DUE', chargeMetrics: { chargesSuccess: 1 } });

    await w.service.syncRow(w.row());

    assert.equal(w.row().status, ProviderSubscriptionStatus.PAST_DUE);
    assert.equal(w.transactions.length, 1);
    assert.deepEqual(w.events, []);
    assert.equal(w.subscription.expiresAt, paidUntil);
  });

  it('delivers nothing when the payer cancels before the first charge', async () => {
    const w = world();
    w.setProvider({ status: 'Cancelled', chargeMetrics: { chargesSuccess: 0 } });

    await w.service.syncRow(w.row());

    assert.equal(w.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.row().cancelledBy, 'PROVIDER');
    assert.deepEqual(w.events, []);
    assert.equal(w.subscription.isTrial, true);
  });

  it('stops at the provider when the customer turns it off in «Способы оплаты»', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 } });
    w.convert();

    await w.service.cancelForCustomer('user-1', 'ps-1');

    assert.deepEqual(w.posts, [PLATEGA_CANCEL]);
    assert.equal(w.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.row().cancelledBy, 'CUSTOMER');
  });
});

describe('a replayed first charge of a trial conversion', () => {
  /**
   * The reconciliation worker settling the notification
   * `ProviderSubscriptionService.enqueueSettlement` hands it for charge 1: a
   * CONFIRMED for the conversion's UPGRADE checkout. The fulfilment and the
   * post-payment hooks are counted; fulfilment converts the trial.
   */
  function reconciliation() {
    const checkout: Record<string, unknown> = {
      id: CONVERSION,
      paymentId: 'payment-conversion',
      userId: 'user-1',
      subscriptionId: TRIAL,
      fulfilledAt: null,
      status: TransactionStatus.PENDING,
      isTest: false,
      purchaseType: PurchaseType.UPGRADE,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.PLATEGA,
      currency: Currency.RUB,
      amount: new Prisma.Decimal('299'),
      paymentAsset: null,
      planSnapshot: {
        id: 'plan-1',
        selectedDurationDays: 30,
        purchaseType: PurchaseType.UPGRADE,
        providerSubscription: { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-1', subscriptionId: TRIAL },
      },
      gatewayId: 'sub-1',
      gatewayData: null,
      deviceTypes: [],
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      updatedAt: new Date('2026-09-23T10:00:00.000Z'),
    };
    const notification = (id: string) => ({
      id,
      gatewayType: PaymentGatewayType.PLATEGA,
      paymentId: 'payment-conversion',
      providerEventId: 'subscription:sub-1:charge:1',
      eventStatus: 'CONFIRMED',
      status: PaymentWebhookLifecycleStatus.ENQUEUED,
      rawPayload: {
        source: 'PROVIDER_SUBSCRIPTION',
        status: 'CONFIRMED',
        subscriptionId: 'sub-1',
        chargeNumber: 1,
        paymentId: 'payment-conversion',
      },
    });
    const conversions: string[] = [];
    const partnerHooks: string[] = [];
    const processed: string[] = [];
    const failed: string[] = [];
    const prisma: Record<string, unknown> = {
      paymentWebhookEvent: { findUnique: async ({ where }: { where: { id: string } }) => notification(where.id) },
      transaction: {
        findUnique: async () => ({ ...checkout }),
        findFirst: async () => null,
        // The fulfilment claim: only while nothing is fulfilled yet.
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if ('fulfilledAt' in where && where.fulfilledAt === null && checkout.fulfilledAt !== null) return { count: 0 };
          Object.assign(checkout, data);
          return { count: 1 };
        },
      },
      trialClaim: { updateMany: async () => ({ count: 0 }) },
      $executeRaw: executeGatewayDataWrites({
        currentGatewayData: () => checkout.gatewayData,
        update: async ({ data }) => Object.assign(checkout, data),
      }),
    };
    prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);
    const service = new PaymentReconciliationService(
      prisma as never,
      {
        incrementReconciliationAttempts: async () => undefined,
        markProcessing: async () => undefined,
        markProcessed: async (id: string) => {
          processed.push(id);
        },
        markFailed: async (id: string) => {
          failed.push(id);
          return notification(id);
        },
      } as never,
      {
        applyCompletedTransaction: async (transaction: { id: string; purchaseType: PurchaseType }) => {
          conversions.push(`${transaction.id}:${transaction.purchaseType}`);
          return { syncJobs: [] };
        },
      } as never,
      { notifyWebhookFailed: async () => undefined } as never,
      {
        processPartnerEarning: async (input: { sourceTransactionId: string }) => {
          partnerHooks.push(input.sourceTransactionId);
        },
      } as never,
      { qualifyReferralAfterPurchase: async () => null } as never,
      { enqueue: async () => undefined } as never,
      { warn: () => undefined, info: () => undefined, error: () => undefined, emit: () => undefined } as never,
      { enqueueRegisterIncome: async () => undefined } as never,
      { recordFirstPurchase: async () => undefined } as never,
      { upsertFromYookassaPayment: async () => undefined } as never,
      { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
      { creditForTransactionBestEffort: async () => null } as never,
      { create: async () => 'notification-1' } as never,
    );
    return { service, checkout, conversions, partnerHooks, processed, failed };
  }

  it('converts the trial once: a second notification of the same charge finds it settled', async () => {
    const r = reconciliation();

    await r.service.reconcileWebhookEvent('event-1');
    await r.service.reconcileWebhookEvent('event-replay');

    assert.deepEqual(r.conversions, [`${CONVERSION}:${PurchaseType.UPGRADE}`]);
    assert.equal(r.checkout.status, TransactionStatus.COMPLETED);
    // Nothing paid twice either: the partner's commission ran once.
    assert.deepEqual(r.partnerHooks, [CONVERSION]);
    assert.deepEqual(r.processed, ['event-1', 'event-replay']);
    assert.deepEqual(r.failed, []);
  });

  it('converts it once when two notifications of that charge are settled at the same time', async () => {
    const r = reconciliation();

    await Promise.all([r.service.reconcileWebhookEvent('event-1'), r.service.reconcileWebhookEvent('event-2')]);

    assert.deepEqual(r.conversions, [`${CONVERSION}:${PurchaseType.UPGRADE}`]);
    assert.deepEqual(r.failed, []);
  });
});
