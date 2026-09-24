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
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { describeGatewayDataStatement } from '../src/modules/payments/utils/transaction-gateway-data.util';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

// Written against every `ADDON_*` stage off (the legacy path): these fakes
// do not stage the durable model's reads. Stages 1, 2 and 6 default ON since
// 24.09.2026, so the file says so instead of relying on the default.
pinAddOnStagesOffForThisFile();

/**
 * A RENEW drafted on the old plan and paid after the subscription was upgraded
 * buys days of the plan it is on NOW — its money divided by that plan's most
 * expensive day, floored, never more than it was priced for — and never puts
 * the subscription back on the old plan. The rule is
 * `paid-remainder-conversion.spec.ts`; this is fulfilment applying it.
 * PostgreSQL end to end: `renewal-priced-before-upgrade-postgres.spec.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

function plan(id: string, name: string, limits: { trafficLimit: number; deviceLimit: number }) {
  return {
    id,
    name,
    description: null,
    tag: null,
    type: PlanType.BOTH,
    icon: null,
    availability: PlanAvailability.ALL,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [`${id}-squad`],
    externalSquad: null,
    deletedAt: null,
    ...limits,
  };
}

const BASIC = plan('plan-basic', 'Базовый', { trafficLimit: 100, deviceLimit: 3 });
const PREMIUM = plan('plan-premium', 'Премиум', { trafficLimit: 500, deviceLimit: 5 });

function world(options: {
  /** When the renewal's checkout was drafted, in days before now. */
  readonly draftedDaysAgo: number;
  /** When the subscription was upgraded to Премиум — its `startedAt` — in days before now. */
  readonly upgradedDaysAgo: number;
  readonly currency?: Currency;
  readonly amount?: string;
  /**
   * Премиум archived to be REPLACED on renewal — the one state in which a
   * renewal checkout of a Премиум subscription prices another plan.
   */
  readonly premiumReplacedOnRenew?: boolean;
}) {
  const premium =
    options.premiumReplacedOnRenew === true
      ? { ...PREMIUM, isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW' }
      : PREMIUM;
  const writes: Array<Record<string, unknown>> = [];
  const gatewayDataWrites: Array<Record<string, unknown>> = [];
  const syncJobs: Array<Record<string, unknown>> = [];
  const emitted: Emitted[] = [];
  const subscription = {
    id: 'sub-1',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    remnawaveId: 'rw-1',
    startedAt: new Date(Date.now() - options.upgradedDaysAgo * DAY),
    expiresAt: new Date(Date.now() + 20 * DAY),
    trafficLimit: 500,
    deviceLimit: 5,
    internalSquads: ['plan-premium-squad'],
    externalSquad: null,
    planSnapshot: {
      id: 'plan-premium',
      name: 'Премиум',
      trafficLimit: 500,
      deviceLimit: 5,
      internalSquads: ['plan-premium-squad'],
      externalSquad: null,
      selectedDurationDays: 30,
    },
  };
  const tx = {
    $queryRaw: async (query: { readonly sql?: string }) => {
      const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
      // The plan-migration question: no migration moved this subscription.
      if (sql.includes('plan_migration_items')) return [];
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
        writes.push(data);
        return { ...subscription, ...data };
      },
    },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    // Not in the term model: no term row, so the renewal stays on the columns.
    subscriptionTerm: { findFirst: async () => null },
    plan: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === PREMIUM.id ? premium : BASIC) },
    planDuration: {
      findMany: async ({ where }: { where: { planId: string } }) =>
        where.planId === PREMIUM.id
          ? [
              { days: 30, isActive: true, prices: [{ currency: Currency.RUB, price: '650' }] },
              { days: 180, isActive: true, prices: [{ currency: Currency.RUB, price: '3000' }] },
            ]
          : [{ days: 30, isActive: true, prices: [{ currency: Currency.RUB, price: '200' }] }],
    },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        syncJobs.push(data);
        return { id: 'job-1', ...data };
      },
    },
    transaction: { update: async () => ({}) },
  };
  const record =
    (severity: string) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      emitted.push({ severity, type, message, metadata });
    };
  const service = new PaymentSubscriptionMutationService(
    {
      $transaction: async (run: (client: unknown) => unknown) => run(tx),
      transactionItem: { findMany: async () => [] },
      plan: { findUnique: async () => BASIC },
      user: {
        findUnique: async () => ({ isBlocked: false, purchaseDiscount: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      userPendingDiscount: { findMany: async () => [] },
    } as never,
    { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const renewal = {
    id: 'tx-renewal',
    paymentId: 'pay-renewal',
    userId: 'user-1',
    subscriptionId: 'sub-1',
    purchaseType: PurchaseType.RENEW,
    gatewayType: PaymentGatewayType.YOOKASSA,
    channel: PurchaseChannel.WEB,
    amount: { toString: () => options.amount ?? '200' },
    currency: options.currency ?? Currency.RUB,
    createdAt: new Date(Date.now() - options.draftedDaysAgo * DAY),
    planSnapshot: { id: 'plan-basic', selectedDurationDays: 30 },
    gatewayData: {},
    deviceTypes: [],
  };
  return {
    complete: () => service.applyCompletedTransaction(renewal as never),
    subscription,
    writes,
    gatewayDataWrites,
    syncJobs,
    emitted,
  };
}

function addedDays(w: ReturnType<typeof world>): number {
  const expiresAt = w.writes[0]?.['expiresAt'] as Date;
  return (expiresAt.getTime() - w.subscription.expiresAt.getTime()) / DAY;
}

describe('a renewal priced for the plan an upgrade has since left', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T12:00:00.000Z') });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('adds the days its 200 ₽ buy on Премиум — 9, not the 30 it was priced for — and keeps the plan', async () => {
    const w = world({ draftedDaysAgo: 3, upgradedDaysAgo: 2 });

    await w.complete();

    assert.equal(addedDays(w), 9);
    const write = w.writes[0]!;
    assert.equal('planSnapshot' in write, false, 'the upgrade’s snapshot is not touched');
    assert.equal('trafficLimit' in write || 'deviceLimit' in write || 'internalSquads' in write, false);
    assert.equal(w.syncJobs[0]?.['payload'] !== undefined, true);
    assert.equal((w.syncJobs[0]!['payload'] as Record<string, unknown>)['resetTraffic'], true, 'a period was bought');
  });

  it('records what it bought on the payment, and tells the operator on both cards', async () => {
    const w = world({ draftedDaysAgo: 3, upgradedDaysAgo: 2 });

    await w.complete();

    const provenance = w.gatewayDataWrites[0]?.['renewalPricedBeforeUpgrade'] as Record<string, unknown>;
    assert.equal(w.gatewayDataWrites[0]?.['transactionId'], 'tx-renewal');
    const line = (provenance['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(
      [line['subscriptionId'], line['paidPlanId'], line['currentPlanId'], line['paidDays'], line['days']],
      ['sub-1', 'plan-basic', 'plan-premium', 30, 9],
    );

    const completed = w.emitted.find((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED)!;
    assert.equal(completed.severity, 'WARNING');
    assert.equal(completed.message, 'Продление оплачено по цене тарифа, с которого подписку уже улучшили');
    assert.equal(completed.metadata['code'], 'RENEWAL_PRICED_BEFORE_UPGRADE');
    assert.equal(completed.metadata['planName'], 'Базовый', 'what was bought');
    assert.match(String(completed.metadata['note']), /\+9 дн\. вместо 30/);

    const renewed = w.emitted.find((event) => event.type === EVENT_TYPES.SUBSCRIPTION_RENEWED)!;
    assert.equal(renewed.metadata['planName'], 'Премиум', 'the plan it renewed');
    assert.equal(renewed.metadata['durationDays'], 9);
    assert.equal(renewed.metadata['renewalPricedForPlan'], 'Базовый');
    assert.equal(renewed.metadata['renewalPricedDays'], 30);
    assert.equal(renewed.metadata['renewalConvertedDays'], 9);
  });

  it('adds no day, starts no period and asks for a refund in a currency Премиум has no price in', async () => {
    const w = world({ draftedDaysAgo: 3, upgradedDaysAgo: 2, currency: Currency.USD, amount: '5' });

    await w.complete();

    // Nothing renewed, so nothing about the subscription moves: neither its
    // expiry nor its status (it used to be set ACTIVE, reviving an
    // expired subscription until now and lifting a LIMITED one).
    assert.deepEqual(w.writes[0], {}, 'no status, no expiry, no snapshot, no limit');
    assert.equal((w.syncJobs[0]!['payload'] as Record<string, unknown>)['resetTraffic'], undefined);
    const completed = w.emitted.find((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED)!;
    assert.match(String(completed.metadata['note']), /Верните деньги или продлите подписку вручную\./);
    assert.equal(
      w.emitted.some((event) => event.type === EVENT_TYPES.SUBSCRIPTION_RENEWED),
      false,
      'no «Подписка продлена» for a renewal that renewed nothing',
    );
  });

  it('converts a renewal drafted before any other move of the plan too — judged by plan identity', async () => {
    // «Назначить план» moves neither `startedAt` nor a migration row: the
    // subscription was put on Премиум after this Базовый renewal was drafted,
    // and Премиум renews as itself, so no checkout of it could have priced
    // Базовый. Before, the renewal put Базовый back and undid the assignment.
    const w = world({ draftedDaysAgo: 3, upgradedDaysAgo: 10 });

    await w.complete();

    assert.equal(addedDays(w), 9);
    assert.equal('planSnapshot' in w.writes[0]!, false, 'the operator’s plan stays');
    const provenance = w.gatewayDataWrites[0]?.['renewalPricedBeforeUpgrade'] as Record<string, unknown>;
    const line = (provenance['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([line['currentPlanId'], line['days'], line['cause']], ['plan-premium', 9, 'PLAN_CHANGE']);
    const completed = w.emitted.find((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED)!;
    assert.equal(completed.severity, 'WARNING');
    assert.equal(completed.message, 'Продление оплачено по цене тарифа, с которого подписку уже перевели');
    assert.equal(completed.metadata['code'], 'RENEWAL_PRICED_BEFORE_PLAN_CHANGE');
    assert.equal(
      completed.metadata['note'],
      'Продление тарифа «Базовый» на 30 дн. оплачено, когда подписку sub-1 уже перевели на «Премиум». ' +
        'Тариф, лимиты и сквады не менялись; оплата пересчитана по самому дорогому дню нового тарифа: ' +
        '+9 дн. вместо 30.',
    );
  });

  it('leaves a renewal drafted after the upgrade as it was: onto the plan it paid for, for its whole period', async () => {
    // Drafted after the last start: a renewal onto another plan on purpose —
    // Премиум is archived and renews onto Базовый.
    const w = world({ draftedDaysAgo: 1, upgradedDaysAgo: 2, premiumReplacedOnRenew: true });

    await w.complete();

    assert.equal(addedDays(w), 30);
    assert.equal((w.writes[0]!['planSnapshot'] as Record<string, unknown>)['id'], 'plan-basic');
    assert.deepEqual(w.gatewayDataWrites, []);
    const completed = w.emitted.find((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED)!;
    assert.equal(completed.severity, 'INFO');
  });
});
