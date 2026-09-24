import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
} from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { describeGatewayDataStatement } from '../src/modules/payments/utils/transaction-gateway-data.util';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

// Written against every `ADDON_*` stage off (the legacy path): these fakes
// do not stage the durable model's reads. Stages 1, 2 and 6 default ON since
// 24.09.2026, so the file says so instead of relying on the default.
pinAddOnStagesOffForThisFile();

/**
 * An UPGRADE adds what was left of the old plan to the new term, at payment:
 * `expiresAt = now + days + converted`, recorded on the upgrade's own row and
 * on «Подписка улучшена». The rule itself is `paid-remainder-conversion.spec.ts`;
 * this is the fulfilment writing it. PostgreSQL end to end:
 * `upgrade-paid-remainder-postgres.spec.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Emitted {
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}

function world(options: {
  /** The subscription's expiry, in days from now. */
  readonly expiresInDays: number;
  /** Earlier payments of the subscription, as fulfilment reads them. */
  readonly payments?: ReadonlyArray<Record<string, unknown>>;
  readonly selectedDurationDays?: number;
}) {
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const gatewayDataWrites: Array<Record<string, unknown>> = [];
  const paymentReads: Array<Record<string, unknown>> = [];
  const emitted: Emitted[] = [];
  const subscription = {
    id: 'sub-1',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    remnawaveId: 'rw-1',
    // Started by the Базовый payment below, ten days ago.
    startedAt: new Date(Date.now() - 10 * DAY),
    expiresAt: new Date(Date.now() + options.expiresInDays * DAY),
    trafficLimit: 100,
    deviceLimit: 3,
    planSnapshot: { id: 'plan-basic', trafficLimit: 100, deviceLimit: 3 },
  };
  const tx = {
    $queryRaw: async (query: { readonly sql?: string }) => {
      const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
      assert.match(sql, /FROM "subscriptions"/);
      assert.match(sql, /\bFOR\s+UPDATE\b/i);
      return [{ id: subscription.id }];
    },
    $executeRaw: async (statement: unknown) => {
      const described = describeGatewayDataStatement(statement);
      assert.ok(described, 'gatewayData is written through writeTransactionGatewayData');
      gatewayDataWrites.push({ transactionId: described.transactionId, ...described.merge });
      return 1;
    },
    subscription: {
      findUnique: async () => ({ ...subscription }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        subscriptionUpdates.push(data);
        return { ...subscription, ...data };
      },
    },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    // Not in the term model: the upgrade stays on the columns.
    subscriptionTerm: { findFirst: async () => null },
    transaction: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        paymentReads.push(where);
        // The subscription's own payments; no renewal here paid for several.
        return 'items' in where ? [] : (options.payments ?? []);
      },
      update: async () => ({}),
    },
    planDuration: {
      findMany: async () => [
        { days: 30, isActive: true, prices: [{ currency: Currency.RUB, price: '650' }] },
        { days: 180, isActive: true, prices: [{ currency: Currency.RUB, price: '3000' }] },
      ],
    },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'job-1', ...data }),
    },
  };
  const premium = {
    id: 'plan-premium',
    name: 'Премиум',
    description: null,
    tag: null,
    type: PlanType.BOTH,
    icon: null,
    availability: PlanAvailability.ALL,
    trafficLimit: 500,
    deviceLimit: 5,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    deletedAt: null,
  };
  const record = (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
    emitted.push({ type, metadata });
  };
  const service = new PaymentSubscriptionMutationService(
    {
      $transaction: async (run: (client: unknown) => unknown) => run(tx),
      transactionItem: { findMany: async () => [] },
      plan: { findUnique: async () => premium },
      user: {
        findUnique: async () => ({ isBlocked: false, purchaseDiscount: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      userPendingDiscount: { findMany: async () => [] },
    } as never,
    { info: record, warn: record, error: record } as never,
    {} as never,
    {} as never,
    // The real one: an upgrade aligns the term row it would rotate, and this
    // subscription has none.
    new SubscriptionTermService(),
    {} as never,
  );
  const upgrade = {
    id: 'tx-upgrade',
    paymentId: 'pay-upgrade',
    userId: 'user-1',
    subscriptionId: 'sub-1',
    purchaseType: PurchaseType.UPGRADE,
    gatewayType: PaymentGatewayType.YOOKASSA,
    channel: PurchaseChannel.WEB,
    amount: { toString: () => '650' },
    currency: Currency.RUB,
    planSnapshot: { id: 'plan-premium', selectedDurationDays: options.selectedDurationDays ?? 30 },
    deviceTypes: [],
  };
  return {
    complete: () => service.applyCompletedTransaction(upgrade as never),
    subscriptionUpdates,
    gatewayDataWrites,
    paymentReads,
    emitted,
  };
}

/** The Базовый plan's payment: 200 ₽ for 30 days, ten days ago — twenty left. */
function basicPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tx-basic',
    subscriptionId: 'sub-1',
    purchaseType: PurchaseType.NEW,
    status: 'COMPLETED',
    fulfilledAt: new Date(Date.now() - 10 * DAY),
    amount: '200',
    currency: Currency.RUB,
    planSnapshot: { id: 'plan-basic', selectedDurationDays: 30 },
    gatewayData: {},
    items: [],
    ...overrides,
  };
}

function writtenTerm(update: Record<string, unknown> | undefined): number {
  assert.ok(update, 'the subscription was written');
  const startedAt = update['startedAt'] as Date;
  const expiresAt = update['expiresAt'] as Date;
  return (expiresAt.getTime() - startedAt.getTime()) / DAY;
}

describe('an upgrade adds the paid remainder of the old plan', () => {
  // One `now` for the fixtures and for fulfilment, so «20 days left» is 20 to
  // the millisecond and the provenance can be read exactly.
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T12:00:00.000Z') });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('ends the new term `now + days + converted`: 200 ₽ with 20 days left is 6 more days of Премиум', async () => {
    const w = world({ expiresInDays: 20, payments: [basicPayment()] });

    await w.complete();

    assert.equal(writtenTerm(w.subscriptionUpdates[0]), 36, '30 bought + 6 converted, from the same `now`');
    // Read for THIS subscription in two reads, each on its own index — its own
    // payments, and the renewals that paid for it among others — never one
    // `OR` over both, which PostgreSQL answers with a scan of every payment.
    assert.deepEqual(w.paymentReads, [
      { subscriptionId: 'sub-1', fulfilledAt: { not: null } },
      { fulfilledAt: { not: null }, items: { some: { subscriptionId: 'sub-1' } } },
    ]);
  });

  it('records where the days came from on the upgrade’s own row', async () => {
    const w = world({ expiresInDays: 20, payments: [basicPayment()] });

    await w.complete();

    assert.equal(w.gatewayDataWrites.length, 1);
    const write = w.gatewayDataWrites[0]!;
    assert.equal(write['transactionId'], 'tx-upgrade');
    const provenance = write['paidRemainderConversion'] as Record<string, unknown>;
    assert.equal(provenance['days'], 6);
    assert.equal(provenance['remainingPaidDays'], 20);
    assert.deepEqual(provenance['sources'], [
      { transactionId: 'tx-basic', overlapDays: '20.0000', value: '133.33', currency: 'RUB', days: '6.1538' },
    ]);
  });

  it('puts the days on «Подписка улучшена», with their sources, for the audit row and the card', async () => {
    const w = world({ expiresInDays: 20, payments: [basicPayment()] });

    await w.complete();

    const upgraded = w.emitted.find((event) => event.type === EVENT_TYPES.SUBSCRIPTION_UPGRADED);
    assert.ok(upgraded, JSON.stringify(w.emitted.map((event) => event.type)));
    assert.equal(upgraded.metadata['paidRemainderDays'], 6);
    assert.deepEqual(upgraded.metadata['paidRemainderSources'], [
      { transactionId: 'tx-basic', overlapDays: '20.0000', value: '133.33', currency: 'RUB', days: '6.1538' },
    ]);
    assert.equal(upgraded.metadata['durationDays'], 30, 'the term bought stays the term bought');
  });

  it('adds nothing, records nothing and says nothing when no paid chunk is left — a trial, free days', async () => {
    const w = world({ expiresInDays: 20, payments: [] });

    await w.complete();

    assert.equal(writtenTerm(w.subscriptionUpdates[0]), 30);
    assert.deepEqual(w.gatewayDataWrites, []);
    const upgraded = w.emitted.find((event) => event.type === EVENT_TYPES.SUBSCRIPTION_UPGRADED);
    assert.equal(upgraded?.metadata['paidRemainderDays'], undefined);
  });

  it('records a paid chunk that converted to nothing: checked, not skipped', async () => {
    // Paid in a currency the new plan has no price in.
    const w = world({ expiresInDays: 20, payments: [basicPayment({ currency: Currency.USD, amount: '5' })] });

    await w.complete();

    assert.equal(writtenTerm(w.subscriptionUpdates[0]), 30);
    const provenance = w.gatewayDataWrites[0]?.['paidRemainderConversion'] as Record<string, unknown>;
    assert.equal(provenance['days'], 0);
    const upgraded = w.emitted.find((event) => event.type === EVENT_TYPES.SUBSCRIPTION_UPGRADED);
    assert.equal(upgraded?.metadata['paidRemainderDays'], 0);
  });

  it('leaves an unlimited term unlimited', async () => {
    const w = world({ expiresInDays: 20, payments: [basicPayment()], selectedDurationDays: -1 });

    await w.complete();

    assert.equal(w.subscriptionUpdates[0]?.['expiresAt'], null);
  });

  it('does not count the upgrade being fulfilled, which the claim has already stamped', async () => {
    const w = world({
      expiresInDays: 20,
      payments: [
        basicPayment(),
        basicPayment({
          id: 'tx-upgrade',
          purchaseType: PurchaseType.UPGRADE,
          fulfilledAt: new Date(),
          amount: '650',
          planSnapshot: { id: 'plan-premium', selectedDurationDays: 30 },
        }),
      ],
    });

    await w.complete();

    assert.equal(writtenTerm(w.subscriptionUpdates[0]), 36);
  });
});
