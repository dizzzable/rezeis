import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  PointsCashbackMode,
  PurchaseChannel,
} from '@prisma/client';

import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { PointsLedgerService } from '../src/modules/points/services/points-ledger.service';
import { InternalReferralsController } from '../src/modules/referrals/controllers/internal-referrals.controller';

/**
 * WHAT THE CABINET IS PROMISED.
 *
 * Three surfaces the subscriber's cabinet reads, pinned at the seam where the
 * panel answers rather than inside the services that compute:
 *
 *   • the points journal and the cashback flag on the referral summary,
 *   • the "+N points" a plan card advertises before the purchase,
 *   • the message the subscriber gets after one.
 *
 * The panel and the cabinet ship as separate images, so each of these has to
 * survive meeting the other half at a different version — which is why the
 * flags are always present rather than conditionally omitted.
 */

// ── The journal and the flag ─────────────────────────────────────────────────

function ledgerRow(id: string, minutesAgo: number) {
  return {
    id,
    delta: 13,
    balanceAfter: 18,
    source: 'CASHBACK',
    referenceKey: `tx-${id}`,
    details: { paidAmount: '180', paidCurrency: 'XTR', lines: [] },
    createdAt: new Date(Date.UTC(2026, 8, 2, 12, 0 - minutesAgo)),
  };
}

function internalController(input: {
  readonly user?: { id: string; points: number } | null;
  readonly pointsSettings?: unknown;
  readonly rows?: ReturnType<typeof ledgerRow>[];
}) {
  const findManyArgs: unknown[] = [];
  const rows = input.rows ?? [];
  const prisma = {
    user: { findUnique: async () => (input.user === undefined ? { id: 'user-1', points: 250 } : input.user) },
    referral: {
      count: async ({ where }: { readonly where: Record<string, unknown> }) => (where.qualifiedAt ? 2 : 5),
    },
    settings: {
      findUnique: async () => ({ referralSettings: {}, pointsSettings: input.pointsSettings ?? {} }),
    },
    pointsLedgerEntry: {
      findMany: async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        findManyArgs.push(args);
        const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor!.id) + (args.skip ?? 0) : 0;
        return rows.slice(start, start + args.take);
      },
    },
  };
  const controller = new InternalReferralsController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    new PointsLedgerService(prisma as never),
  );
  return { controller, findManyArgs };
}

describe('the cabinet reads the points journal', () => {
  it('pages it newest first and hands back a cursor for the rest', async () => {
    const { controller, findManyArgs } = internalController({
      rows: [ledgerRow('c', 0), ledgerRow('b', 1), ledgerRow('a', 2)],
    });

    const page = await controller.getPointsLedger('cmphfcr6i007v01jg0lcu653h', undefined, '2');

    assert.deepStrictEqual(page.items.map((item) => item.id), ['c', 'b']);
    assert.equal(page.nextCursor, 'b');
    assert.deepStrictEqual(
      (findManyArgs[0] as { where: unknown }).where,
      { userId: 'user-1' },
      'scoped to the caller, resolved from the userRef',
    );
    assert.equal(page.items[0]!.createdAt, '2026-09-02T12:00:00.000Z', 'dates travel as ISO strings');
  });

  it('continues from the cursor', async () => {
    const { controller, findManyArgs } = internalController({
      rows: [ledgerRow('c', 0), ledgerRow('b', 1), ledgerRow('a', 2)],
    });

    const page = await controller.getPointsLedger('cmphfcr6i007v01jg0lcu653h', 'b', '2');

    assert.deepStrictEqual(page.items.map((item) => item.id), ['a']);
    assert.equal(page.nextCursor, null);
    const args = findManyArgs[0] as { cursor?: { id: string }; skip?: number };
    assert.deepStrictEqual(args.cursor, { id: 'b' });
    assert.equal(args.skip, 1, 'the cursor row itself is not repeated');
  });

  it('answers an empty page for an unknown account rather than failing', async () => {
    // Every handler on this controller answers a neutral payload for a user
    // it cannot resolve; a cabinet mid-migration must not see an error card.
    const { controller, findManyArgs } = internalController({ user: null });

    assert.deepStrictEqual(await controller.getPointsLedger('cmphfcr6i007v01jg0lcu653h'), {
      items: [],
      nextCursor: null,
    });
    assert.equal(findManyArgs.length, 0);
  });
});

describe('the summary says whether purchases earn points', () => {
  it('is true only when the operator switched cashback on', async () => {
    const on = internalController({ pointsSettings: { cashback: { enabled: true, percent: 5 } } });
    const summary = (await on.controller.getSummary('cmphfcr6i007v01jg0lcu653h')) as {
      cashbackEnabled: boolean;
    };
    assert.equal(summary.cashbackEnabled, true);

    for (const settings of [{}, { cashback: {} }, { cashback: { enabled: false, percent: 5 } }]) {
      const off = internalController({ pointsSettings: settings });
      const answer = (await off.controller.getSummary('cmphfcr6i007v01jg0lcu653h')) as {
        cashbackEnabled: boolean;
      };
      assert.equal(answer.cashbackEnabled, false, JSON.stringify(settings));
    }
  });

  it('is present even for an account that does not exist, so absent means "an older panel"', async () => {
    const { controller } = internalController({ user: null });

    const summary = (await controller.getSummary('cmphfcr6i007v01jg0lcu653h')) as Record<string, unknown>;

    assert.equal('cashbackEnabled' in summary, true);
    assert.equal(summary['cashbackEnabled'], false);
  });
});

// ── The badge on the plan card ───────────────────────────────────────────────

function catalogPlan(input: { readonly cashbackMode: PointsCashbackMode; readonly cashbackPercent?: number | null }) {
  return {
    id: 'plan-1',
    orderIndex: 1,
    name: 'Premium',
    description: null,
    tag: null,
    icon: null,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: PlanAvailability.ALL,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: {},
    cashbackMode: input.cashbackMode,
    cashbackPercent: input.cashbackPercent ?? null,
    createdAt: new Date('2026-04-19T10:00:00.000Z'),
    updatedAt: new Date('2026-04-19T10:00:00.000Z'),
    durations: [
      {
        id: 'duration-1',
        planId: 'plan-1',
        days: 90,
        cashbackPoints: 40,
        prices: [
          { id: 'p1', planDurationId: 'duration-1', currency: Currency.RUB, price: { toString: () => '300' } },
        ],
      },
    ],
  };
}

function catalogService(input: {
  readonly plan: ReturnType<typeof catalogPlan>;
  readonly cashback: { enabled: boolean; percent: number; defaultCurrency: Currency };
  readonly partnerActive?: boolean;
  readonly anonymous?: boolean;
}) {
  const prisma = {
    paymentGateway: {
      findMany: async () => [
        { id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, isActive: true, orderIndex: 1 },
      ],
    },
    plan: { findMany: async () => [input.plan] },
    user: { findUnique: async () => ({ id: 'user-1', purchaseDiscount: 0, personalDiscount: 0 }) },
    subscription: { findFirst: async () => null, count: async () => 0 },
    trialClaim: { aggregate: async () => ({ _sum: { units: 0 } }), findMany: async () => [] },
    transaction: { findFirst: async () => null },
    referral: { findFirst: async () => null },
    partner: { findUnique: async () => (input.partnerActive === true ? { isActive: true } : null) },
    userPendingDiscount: { findMany: async () => [] },
    partnerReferral: { findFirst: async () => null },
  };
  const service = new PlanCatalogService(prisma as never, new PricingService(), {
    loadConfig: async () => input.cashback,
  } as never);
  return service.getCatalogPlans({
    channel: PurchaseChannel.WEB,
    ...(input.anonymous === true ? {} : { userId: 'user-1' }),
  });
}

const CASHBACK_ON = { enabled: true, percent: 5, defaultCurrency: Currency.RUB };

describe('the plan card advertises what the purchase will pay', () => {
  it('computes the percent of the shown price, in the default currency', async () => {
    const plans = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.INHERIT }),
      cashback: CASHBACK_ON,
    });

    assert.equal(plans[0]?.durations[0]?.cashbackPoints, 15, '5% of 300 RUB');
  });

  it('follows the plan\'s own rule over the global one', async () => {
    const percent = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.PERCENT, cashbackPercent: 10 }),
      cashback: CASHBACK_ON,
    });
    assert.equal(percent[0]?.durations[0]?.cashbackPoints, 30);

    const fixed = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.FIXED }),
      cashback: CASHBACK_ON,
    });
    assert.equal(fixed[0]?.durations[0]?.cashbackPoints, 40, 'the duration\'s own points, whatever the price');

    const excluded = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.NONE }),
      cashback: CASHBACK_ON,
    });
    assert.equal(excluded[0]?.durations[0]?.cashbackPoints, 0, 'an excluded plan advertises nothing');
  });

  it('promises nothing while the global switch is off', async () => {
    const plans = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.FIXED }),
      cashback: { enabled: false, percent: 5, defaultCurrency: Currency.RUB },
    });

    assert.equal(plans[0]?.durations[0]?.cashbackPoints, 0);
  });

  it('tells an active partner they earn nothing, apart from earning zero', async () => {
    // `null`, not `0`: the partner is paid in money and the cabinet hides the
    // badge entirely, rather than showing a plan that pays "0 points".
    const plans = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.INHERIT }),
      cashback: CASHBACK_ON,
      partnerActive: true,
    });

    assert.equal(plans[0]?.durations[0]?.cashbackPoints, null);
  });

  it('shows the badge to a signed-out browser, who is nobody\'s partner yet', async () => {
    const plans = await catalogService({
      plan: catalogPlan({ cashbackMode: PointsCashbackMode.INHERIT }),
      cashback: CASHBACK_ON,
      anonymous: true,
    });

    assert.equal(plans[0]?.durations[0]?.cashbackPoints, 15);
  });
});
