import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PointsCashbackMode, Prisma, PurchaseType } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PointsCashbackService } from '../src/modules/points/services/points-cashback.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

/**
 * One user row, one ledger, a catalogue of plans and add-ons, one settings
 * row — the way the hook finds them. The wallet is real; the fake models the
 * statements it issues the way the wallet spec's fake does.
 */
interface World {
  readonly user: { id: string; points: number };
  readonly partnerActive: boolean;
  readonly settings: { pointsSettings: unknown; defaultCurrency: Currency } | null;
  readonly items: Array<Record<string, unknown>>;
  readonly plans: Array<Record<string, unknown>>;
  readonly addOns: Array<Record<string, unknown>>;
  readonly ledger: Array<Record<string, unknown>>;
  readonly events: Array<{ level: string; type: string; message: string; metadata: unknown }>;
  readonly logged: string[];
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    user: { id: 'u1', points: 5 },
    partnerActive: false,
    settings: { pointsSettings: { cashback: { enabled: true, percent: 5 } }, defaultCurrency: Currency.RUB },
    items: [],
    plans: [
      {
        id: 'plan-1',
        name: 'Premium',
        cashbackMode: PointsCashbackMode.INHERIT,
        cashbackPercent: null,
        durations: [
          {
            days: 90,
            cashbackPoints: null,
            prices: [
              { currency: Currency.RUB, price: new Prisma.Decimal('300') },
              { currency: Currency.XTR, price: new Prisma.Decimal('200') },
            ],
          },
          { days: 30, cashbackPoints: 40, prices: [{ currency: Currency.RUB, price: new Prisma.Decimal('100') }] },
        ],
      },
    ],
    addOns: [
      {
        id: 'ao-1',
        name: 'Extra 10 GB',
        cashbackMode: PointsCashbackMode.FIXED,
        cashbackPercent: null,
        cashbackPoints: 20,
        prices: [{ currency: Currency.RUB, price: new Prisma.Decimal('50') }],
      },
    ],
    ledger: [],
    events: [],
    logged: [],
    ...overrides,
  };
}

function makeService(world: World): PointsCashbackService {
  const model = {
    partner: { findUnique: async () => (world.partnerActive ? { isActive: true } : null) },
    settings: { findFirst: async () => world.settings },
    transactionItem: { findMany: async () => world.items },
    plan: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        world.plans.filter((plan) => args.where.id.in.includes(plan['id'] as string)),
    },
    addOn: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        world.addOns.filter((addOn) => args.where.id.in.includes(addOn['id'] as string)),
    },
    user: {
      updateMany: async (args: {
        where: { id: string; points?: number | { gte?: number } };
        data: { points: { increment?: number; decrement?: number } };
      }) => {
        if (args.where.id !== world.user.id) return { count: 0 };
        const cond = args.where.points;
        if (typeof cond === 'number' && world.user.points !== cond) return { count: 0 };
        if (typeof cond === 'object' && cond?.gte !== undefined && world.user.points < cond.gte) return { count: 0 };
        world.user.points += (args.data.points.increment ?? 0) - (args.data.points.decrement ?? 0);
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) =>
        args.where.id === world.user.id
          ? args.select?.['points']
            ? { points: world.user.points }
            : { id: world.user.id }
          : null,
    },
    pointsLedgerEntry: {
      findUnique: async (args: {
        where: { source_referenceKey: { source: string; referenceKey: string } };
        select?: Record<string, boolean>;
      }) => {
        const key = args.where.source_referenceKey;
        const row = world.ledger.find((entry) => entry['source'] === key.source && entry['referenceKey'] === key.referenceKey);
        return row ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `ledger-${world.ledger.length + 1}`, ...args.data };
        world.ledger.push(row);
        return { id: row.id };
      },
    },
  };
  const prisma = {
    ...model,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(model),
  };
  const events = {
    info: (type: string, _category: string, message: string, metadata: unknown) =>
      world.events.push({ level: 'info', type, message, metadata }),
    warn: (type: string, _category: string, message: string, metadata: unknown) =>
      world.events.push({ level: 'warn', type, message, metadata }),
    error: () => undefined,
  };
  const service = new PointsCashbackService(prisma as never, new PointsWalletService(), events as never);
  (service as unknown as { logger: unknown }).logger = {
    log: () => undefined,
    warn: (message: string) => world.logged.push(`warn: ${message}`),
    error: (message: string) => world.logged.push(`error: ${message}`),
    debug: (message: string) => world.logged.push(`debug: ${message}`),
    verbose: () => undefined,
  };
  return service;
}

function planPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    userId: 'u1',
    amount: new Prisma.Decimal('180'),
    currency: Currency.XTR,
    purchaseType: PurchaseType.NEW,
    planSnapshot: { id: 'plan-1', name: 'Premium', selectedDurationDays: 90 },
    ...overrides,
  };
}

describe('PointsCashbackService.creditForTransaction — one subscription', () => {
  it('credits floor(amount in the default currency × percent) and journals the line', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase() as never);

    assert.deepEqual(outcome, { credited: true, points: 13, balanceAfter: 18, entryId: 'ledger-1' });
    assert.equal(world.user.points, 18);
    const row = world.ledger[0]!;
    assert.equal(row['source'], 'CASHBACK');
    assert.equal(row['referenceKey'], 'tx-1');
    assert.equal(row['delta'], 13);
    const details = row['details'] as { lines: Array<Record<string, unknown>>; paidAmount: string; defaultCurrency: string };
    assert.equal(details.paidAmount, '180');
    assert.equal(details.defaultCurrency, 'RUB');
    assert.deepEqual(details.lines, [
      {
        kind: 'PLAN',
        id: 'plan-1',
        name: 'Premium',
        durationDays: 90,
        amount: '180',
        currency: 'XTR',
        mode: 'INHERIT',
        effective: 'PERCENT',
        percent: 5,
        base: '270',
        points: 13,
        skipped: null,
      },
    ]);
    assert.deepEqual(
      world.events.map((event) => [event.level, event.type]),
      [['info', EVENT_TYPES.POINTS_CASHBACK_CREDITED]],
    );
    assert.deepEqual(
      (world.events[0]!.metadata as Record<string, unknown>)['points'],
      13,
    );
  });

  it('credits once: a second run for the same transaction is told and does nothing', async () => {
    const world = makeWorld();
    const service = makeService(world);
    await service.creditForTransaction(planPurchase() as never);

    const again = await service.creditForTransaction(planPurchase() as never);

    assert.equal(again.credited, false);
    assert.equal((again as { reason: string }).reason, 'ALREADY_CREDITED');
    assert.equal(world.user.points, 18, 'no second credit');
    assert.equal(world.ledger.length, 1);
    assert.equal(world.events.length, 1, 'no second event');
  });

  it('pays an active partner nothing', async () => {
    const world = makeWorld({ partnerActive: true });
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase() as never);

    assert.deepEqual(outcome, { credited: false, reason: 'PARTNER' });
    assert.equal(world.ledger.length, 0);
    assert.equal(world.events.length, 0);
  });

  it('pays nothing for a payment of nothing', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase({ amount: new Prisma.Decimal('0') }) as never);

    assert.deepEqual(outcome, { credited: false, reason: 'NOTHING_PAID' });
    assert.equal(world.ledger.length, 0);
  });

  it('pays nothing while the global switch is off, and stays quiet about it', async () => {
    const world = makeWorld({
      settings: { pointsSettings: {}, defaultCurrency: Currency.RUB },
    });
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase() as never);

    assert.equal(outcome.credited, false);
    assert.equal((outcome as { reason: string }).reason, 'NO_POINTS');
    assert.equal(world.ledger.length, 0);
    assert.equal(world.events.length, 0, 'the operator chose this; no card');
  });

  it('reports a plan with no price in the default currency, so the operator can fix it', async () => {
    const world = makeWorld();
    (world.plans[0]!['durations'] as Array<Record<string, unknown>>)[0]!['prices'] = [
      { currency: Currency.XTR, price: new Prisma.Decimal('200') },
    ];
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase() as never);

    assert.equal(outcome.credited, false);
    assert.equal(world.ledger.length, 0);
    assert.deepEqual(
      world.events.map((event) => [event.level, event.type]),
      [['warn', EVENT_TYPES.POINTS_CASHBACK_SKIPPED]],
    );
    const metadata = world.events[0]!.metadata as { lines: Array<{ id: string; reason: string }> };
    assert.deepEqual(metadata.lines, [{ kind: 'PLAN', id: 'plan-1', name: 'Premium', currency: 'XTR', reason: 'NO_DEFAULT_PRICE' }]);
  });

  it('reports a plan that is gone from the catalogue instead of throwing', async () => {
    const world = makeWorld({ plans: [] });
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase() as never);

    assert.equal(outcome.credited, false);
    assert.equal(world.events[0]!.type, EVENT_TYPES.POINTS_CASHBACK_SKIPPED);
    const metadata = world.events[0]!.metadata as { lines: Array<{ reason: string }> };
    assert.equal(metadata.lines[0]!.reason, 'MISSING_CATALOG');
  });

  it('FIXED takes the purchased duration\'s points and ignores the amount', async () => {
    const world = makeWorld();
    world.plans[0]!['cashbackMode'] = PointsCashbackMode.FIXED;
    const service = makeService(world);

    const outcome = await service.creditForTransaction(
      planPurchase({
        amount: new Prisma.Decimal('100'),
        currency: Currency.RUB,
        planSnapshot: { id: 'plan-1', name: 'Premium', selectedDurationDays: 30 },
      }) as never,
    );

    assert.equal(outcome.credited, true);
    assert.equal((outcome as { points: number }).points, 40);
  });
});

describe('PointsCashbackService.creditForTransaction — the other two shapes', () => {
  it('a combined renewal is one line per item plus one per paid add-on line', async () => {
    const world = makeWorld({
      items: [
        {
          planId: 'plan-1',
          durationDays: 30,
          amount: new Prisma.Decimal('100'),
          currency: Currency.RUB,
          planSnapshot: { name: 'Premium' },
          addOnLines: [
            { addOnId: 'ao-1', unitAmount: '50', receiptName: 'Extra 10 GB', catalogRevision: 1 },
            { addOnId: 'ao-1', unitAmount: 'not-a-number-and-no-id' },
            { unitAmount: '50' },
          ],
        },
      ],
    });
    const service = makeService(world);

    const outcome = await service.creditForTransaction(
      planPurchase({ purchaseType: PurchaseType.RENEW, amount: new Prisma.Decimal('150'), currency: Currency.RUB, planSnapshot: {} }) as never,
    );

    // plan-1 for 30 days: INHERIT → 5% of 100 = 5; add-on: FIXED 20. The entry
    // with an unreadable amount and the one without an id are left out — a
    // hook that runs after the money moved does not throw over a field.
    assert.equal(outcome.credited, true);
    assert.equal((outcome as { points: number }).points, 25);
    const details = world.ledger[0]!['details'] as { lines: Array<Record<string, unknown>> };
    assert.deepEqual(
      details.lines.map((line) => [line['kind'], line['id'], line['name'], line['effective'], line['points']]),
      [
        ['PLAN', 'plan-1', 'Premium', 'PERCENT', 5],
        ['ADD_ON', 'ao-1', 'Extra 10 GB', 'FIXED', 20],
      ],
    );
  });

  it('a standalone add-on purchase is one add-on line', async () => {
    const world = makeWorld();
    world.addOns[0]!['cashbackMode'] = PointsCashbackMode.PERCENT;
    world.addOns[0]!['cashbackPercent'] = 10;
    const service = makeService(world);

    const outcome = await service.creditForTransaction(
      planPurchase({
        purchaseType: PurchaseType.ADDITIONAL,
        amount: new Prisma.Decimal('50'),
        currency: Currency.RUB,
        planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'ao-1', name: 'Extra 10 GB', addOnType: 'EXTRA_TRAFFIC' },
      }) as never,
    );

    assert.equal(outcome.credited, true);
    assert.equal((outcome as { points: number }).points, 5);
    const details = world.ledger[0]!['details'] as { lines: Array<Record<string, unknown>> };
    assert.equal(details.lines[0]!['kind'], 'ADD_ON');
    assert.equal(details.lines[0]!['effective'], 'PERCENT');
  });

  it('a snapshot naming neither a plan nor an add-on earns nothing and does not throw', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const outcome = await service.creditForTransaction(planPurchase({ planSnapshot: {} }) as never);

    assert.equal(outcome.credited, false);
    assert.equal(world.ledger.length, 0);
    assert.ok(world.logged.some((line) => line.includes('names no plan and no add-on')));
  });
});

describe('PointsCashbackService.reverseForTransaction', () => {
  it('takes back what was credited, floored at zero, and journals the shortfall', async () => {
    const world = makeWorld();
    const service = makeService(world);
    await service.creditForTransaction(planPurchase() as never); // +13 → 18
    world.user.points = 4; // the customer spent most of it in the meantime

    const outcome = await service.reverseForTransaction('tx-1');

    assert.deepEqual(outcome, { reversed: true, credited: 13, debited: 4, shortfall: 9 });
    assert.equal(world.user.points, 0);
    const row = world.ledger[1]!;
    assert.equal(row['source'], 'CASHBACK_REVERSED');
    assert.equal(row['referenceKey'], 'tx-1');
    assert.equal(row['delta'], -4);
    assert.deepEqual(row['details'], {
      transactionId: 'tx-1',
      credited: 13,
      creditedEntryId: 'ledger-1',
      requested: 13,
      applied: 4,
      shortfall: 9,
    });
    assert.deepEqual(
      world.events.map((event) => event.type),
      [EVENT_TYPES.POINTS_CASHBACK_CREDITED, EVENT_TYPES.POINTS_CASHBACK_REVERSED],
    );
  });

  it('reverses once: a replayed refund is told and touches nothing', async () => {
    const world = makeWorld();
    const service = makeService(world);
    await service.creditForTransaction(planPurchase() as never);
    await service.reverseForTransaction('tx-1');

    const again = await service.reverseForTransaction('tx-1');

    assert.deepEqual(again, { reversed: false, reason: 'ALREADY_REVERSED' });
    assert.equal(world.ledger.length, 2);
    assert.equal(world.user.points, 5, '18 − 13, and not a point more');
  });

  it('has nothing to reverse for a purchase that was never credited', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const outcome = await service.reverseForTransaction('tx-never');

    assert.deepEqual(outcome, { reversed: false, reason: 'NOT_CREDITED' });
    assert.equal(world.ledger.length, 0);
  });
});

describe('PointsCashbackService — best effort', () => {
  it('a failing credit is logged and never thrown at the checkout', async () => {
    const world = makeWorld();
    const service = makeService(world);
    (service as unknown as { prismaService: { partner: { findUnique: () => Promise<never> } } }).prismaService.partner.findUnique =
      async () => {
        throw new Error('database away');
      };

    await service.creditForTransactionBestEffort(planPurchase() as never);

    assert.ok(world.logged.some((line) => line.startsWith('error:') && line.includes('database away')));
  });

  it('a failing reversal is logged and never thrown at the refund', async () => {
    const world = makeWorld();
    const service = makeService(world);
    (service as unknown as { prismaService: { pointsLedgerEntry: { findUnique: () => Promise<never> } } }).prismaService.pointsLedgerEntry.findUnique =
      async () => {
        throw new Error('ledger away');
      };

    await service.reverseForTransactionBestEffort('tx-1');

    assert.ok(world.logged.some((line) => line.startsWith('error:') && line.includes('ledger away')));
  });
});
