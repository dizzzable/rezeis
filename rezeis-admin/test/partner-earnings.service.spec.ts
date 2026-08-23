import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PartnerAccrualStrategy, PartnerRewardType, Prisma } from '@prisma/client';

import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';

const NULL_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NULL_NOTIFICATIONS = {
  notifyEarning: async () => undefined,
  notifyWithdrawalApproved: async () => undefined,
  notifyWithdrawalRejected: async () => undefined,
};

interface PartnerSeed {
  id: string;
  userId: string;
  isActive: boolean;
  useGlobalSettings: boolean;
  accrualStrategy: PartnerAccrualStrategy;
  rewardType: PartnerRewardType;
  level1Percent?: Prisma.Decimal | null;
  level2Percent?: Prisma.Decimal | null;
  level3Percent?: Prisma.Decimal | null;
  level1FixedAmount?: number | null;
  level2FixedAmount?: number | null;
  level3FixedAmount?: number | null;
  level1AccrualStrategy?: PartnerAccrualStrategy | null;
  level2AccrualStrategy?: PartnerAccrualStrategy | null;
  level3AccrualStrategy?: PartnerAccrualStrategy | null;
  balance?: number;
  totalEarned?: number;
}

interface ReferralEdgeSeed {
  partnerId: string;
  referralUserId: string;
  level: number;
}

function fakePrisma(opts: {
  settings: Record<string, unknown>;
  partners: ReadonlyArray<PartnerSeed>;
  edges: ReadonlyArray<ReferralEdgeSeed>;
  existingTransactions?: ReadonlyArray<{
    partnerId: string;
    sourceTransactionId: string | null;
    referralUserId: string;
  }>;
  /** When true, partnerTransaction.create throws P2002 (unique sourceKey race). */
  createThrowsUnique?: boolean;
}) {
  const createdTransactions: Array<Record<string, unknown>> = [];
  const partnerById = new Map(opts.partners.map((p) => [p.id, { ...p, balance: p.balance ?? 0, totalEarned: p.totalEarned ?? 0 }]));
  const existing = [...(opts.existingTransactions ?? [])];

  const tx = {
    partnerTransaction: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (opts.createThrowsUnique === true) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        createdTransactions.push(args.data);
        existing.push({
          partnerId: args.data.partnerId as string,
          sourceTransactionId: (args.data.sourceTransactionId as string | null) ?? null,
          referralUserId: args.data.referralUserId as string,
        });
        return args.data;
      },
    },
    partner: {
      update: async (args: {
        where: { id: string };
        data: { balance: { increment: number }; totalEarned: { increment: number } };
      }) => {
        const partner = partnerById.get(args.where.id);
        if (!partner) throw new Error('Partner not seeded');
        partner.balance += args.data.balance.increment;
        partner.totalEarned += args.data.totalEarned.increment;
        return partner;
      },
    },
  };

  return {
    state: { createdTransactions, partnerById },
    client: {
      settings: {
        findFirst: async () => ({ partnerSettings: opts.settings }),
      },
      partnerReferral: {
        findMany: async () =>
          opts.edges.map((edge) => ({
            partnerId: edge.partnerId,
            referralUserId: edge.referralUserId,
            level: edge.level,
            partner: partnerById.get(edge.partnerId),
          })),
        findFirst: async () => null,
        findUnique: async () => null,
        create: async () => undefined,
      },
      partnerTransaction: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const partnerId = args.where.partnerId as string;
          const sourceTx = args.where.sourceTransactionId as string | null | undefined;
          const referralUserId = args.where.referralUserId as string | undefined;
          for (const candidate of existing) {
            if (candidate.partnerId !== partnerId) continue;
            if (sourceTx !== undefined && candidate.sourceTransactionId !== sourceTx) continue;
            if (referralUserId !== undefined && candidate.referralUserId !== referralUserId) continue;
            return { id: 'existing' };
          }
          return null;
        },
      },
      partner: {
        findUnique: async (args: { where: { userId?: string; id?: string } }) => {
          if (args.where.userId !== undefined) {
            for (const partner of partnerById.values()) {
              if (partner.userId === args.where.userId) return partner;
            }
            return null;
          }
          if (args.where.id !== undefined) {
            return partnerById.get(args.where.id) ?? null;
          }
          return null;
        },
      },
      $transaction: async <T,>(callback: (txClient: typeof tx) => Promise<T>) => callback(tx),
    },
  };
}

describe('PartnerEarningsService', () => {
  it('does nothing when partner program is disabled', async () => {
    const fake = fakePrisma({
      settings: { enabled: false, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 0);
  });

  it('credits global percent earning to active partner', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 1);
    assert.equal((fake.state.createdTransactions[0] as { earnedAmount: number }).earnedAmount, 1000);
    // Deterministic sourceKey enables the unique-index race guard.
    assert.equal(
      (fake.state.createdTransactions[0] as { sourceKey: string }).sourceKey,
      'runtime:p1:tx-1',
    );
  });

  it('does not double-credit when a concurrent accrual wins the unique race (P2002)', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
          balance: 500,
          totalEarned: 500,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
      createThrowsUnique: true,
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    // Must resolve (idempotent no-op), not throw.
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    // Balance untouched — the racing create rolled back the increment.
    assert.equal(fake.state.partnerById.get('p1')?.balance, 500);
    assert.equal(fake.state.partnerById.get('p1')?.totalEarned, 500);
  });

  it('uses individual fixed amount when reward type is FIXED', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: false,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.FIXED,
          level1FixedAmount: 5000,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 1);
    assert.equal((fake.state.createdTransactions[0] as { earnedAmount: number }).earnedAmount, 5000);
  });

  it('uses individual percent override when partner has its own settings', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: false,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
          level1Percent: new Prisma.Decimal('25.00'),
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 1);
    assert.equal((fake.state.createdTransactions[0] as { earnedAmount: number }).earnedAmount, 2500);
  });

  it('honours an EXPLICIT individual 0% (does not fall back to the global percent)', async () => {
    // Regression: an individual level percent of 0 (partner earns nothing at
    // this level) was treated like "unset" and wrongly paid the GLOBAL 10%.
    // With useGlobalSettings=false + level1Percent=0 the partner must earn 0.
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: false,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
          level1Percent: new Prisma.Decimal('0'),
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    // Individual 0% → 0 earned → no partner transaction credited.
    assert.equal(fake.state.createdTransactions.length, 0);
  });

  it('skips inactive partners', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: false,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 0);
  });

  it('respects ONCE_PER_USER accrual strategy on second payment', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: false,
          accrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
          rewardType: PartnerRewardType.PERCENT,
          level1Percent: new Prisma.Decimal('10.00'),
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
      existingTransactions: [
        { partnerId: 'p1', sourceTransactionId: 'tx-old', referralUserId: 'payer' },
      ],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-2',
    });
    assert.equal(fake.state.createdTransactions.length, 0);
  });

  it('is idempotent on (partnerId, sourceTransactionId)', async () => {
    const fake = fakePrisma({
      settings: { enabled: true, levels: { LEVEL_1: 10 } },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
      existingTransactions: [
        { partnerId: 'p1', sourceTransactionId: 'tx-1', referralUserId: 'payer' },
      ],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: null,
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 0);
  });

  it('subtracts gateway commission and tax when autoCalculateCommission is on', async () => {
    const fake = fakePrisma({
      settings: {
        enabled: true,
        levels: { LEVEL_1: 10 },
        gatewayCommissions: { YOOKASSA: 5 },
        taxPercent: 6,
        autoCalculateCommission: true,
      },
      partners: [
        {
          id: 'p1',
          userId: 'u1',
          isActive: true,
          useGlobalSettings: true,
          accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          rewardType: PartnerRewardType.PERCENT,
        },
      ],
      edges: [{ partnerId: 'p1', referralUserId: 'payer', level: 1 }],
    });
    const service = new PartnerEarningsService(fake.client as never, NULL_LOGGER as never, NULL_NOTIFICATIONS as never);
    await service.processPartnerEarning({
      payerUserId: 'payer',
      paymentAmountMinorUnits: 10000,
      gatewayType: 'YOOKASSA',
      sourceTransactionId: 'tx-1',
    });
    assert.equal(fake.state.createdTransactions.length, 1);
    // 10000 * 0.95 * 0.94 * 0.10 = 893
    const earned = (fake.state.createdTransactions[0] as { earnedAmount: number }).earnedAmount;
    assert.ok(earned >= 890 && earned <= 894, `expected ~893, got ${earned}`);
  });
});

describe('PartnerEarningsService.attachPartnerReferralChain', () => {
  function build(existingL1: { partnerId: string } | null) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      partner: {
        findUnique: async () => ({ id: 'partner-b', isActive: true }),
      },
      partnerReferral: {
        findFirst: async (args: { where: Record<string, unknown> }) =>
          args.where['level'] === 1 ? existingL1 : null,
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return args.data;
        },
      },
    };
    const service = new PartnerEarningsService(
      prisma as never,
      NULL_LOGGER as never,
      NULL_NOTIFICATIONS as never,
    );
    return { service, created };
  }

  // Money: processPartnerEarning pays EVERY edge it finds for a payer, on every
  // payment. A second level-1 edge from a different partner therefore doubles the
  // commission on one payment, forever — and the composite unique key
  // (partnerId, referralUserId) does not stop it.
  it('refuses a second level-1 chain when the user already belongs to another partner', async () => {
    const { service, created } = build({ partnerId: 'partner-a' });
    const attached = await service.attachPartnerReferralChain({
      newUserId: 'u1',
      referrerUserId: 'partner-b-user',
    });
    assert.equal(attached, false);
    assert.deepEqual(created, [], 'a second level-1 edge would double the commission');
  });

  it('still attaches when the user has no partner attribution yet', async () => {
    const { service, created } = build(null);
    const attached = await service.attachPartnerReferralChain({
      newUserId: 'u1',
      referrerUserId: 'partner-b-user',
    });
    assert.equal(attached, true);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.['level'], 1);
    assert.equal(created[0]?.['partnerId'], 'partner-b');
  });

  it('stays idempotent when the same partner chain is re-run', async () => {
    const { service, created } = build({ partnerId: 'partner-b' });
    const attached = await service.attachPartnerReferralChain({
      newUserId: 'u1',
      referrerUserId: 'partner-b-user',
    });
    assert.equal(attached, true, 're-running the same chain must not report a conflict');
    // findUnique returns null in this stub, so the upsert proceeds; in production
    // it short-circuits. What matters is that the same partner is never refused.
    assert.equal(created.length, 1);
  });
});

// ---------------------------------------------------------------------------
//  Per-level accrual strategy
//
//  The rates were already per level; the MODE was not. These tests pin the
//  mode to the level, and - first and most important - pin that a partner
//  nobody has configured per level keeps behaving exactly as it did before
//  the columns existed.
//
//  Every run below is a SECOND payment: the payer already has one accrual
//  row for the partner. "Already paid once" is a ROW, never a timestamp -
//  there is no date anywhere in these fixtures to go stale.
// ---------------------------------------------------------------------------

const PAYER = 'payer';
const PAYMENT = 10_000;
/** 10% at every level, so a credited accrual is always exactly 1000. */
const GLOBAL_LEVELS = { LEVEL_1: 10, LEVEL_2: 10, LEVEL_3: 10 };
const EXPECTED_EARNING = 1000;

function seedPartner(over: Partial<PartnerSeed> & { id: string }): PartnerSeed {
  return {
    userId: `user-${over.id}`,
    isActive: true,
    useGlobalSettings: true,
    accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
    rewardType: PartnerRewardType.PERCENT,
    level1Percent: new Prisma.Decimal('10.00'),
    level2Percent: new Prisma.Decimal('10.00'),
    level3Percent: new Prisma.Decimal('10.00'),
    ...over,
  };
}

/** The payer has already paid these partners once, via an earlier transaction. */
function alreadyPaidOnce(
  ...partnerIds: ReadonlyArray<string>
): ReadonlyArray<{ partnerId: string; sourceTransactionId: string | null; referralUserId: string }> {
  return partnerIds.map((partnerId) => ({
    partnerId,
    sourceTransactionId: 'tx-first',
    referralUserId: PAYER,
  }));
}

async function runSecondPayment(input: {
  settings: Record<string, unknown>;
  partners: ReadonlyArray<PartnerSeed>;
  edges: ReadonlyArray<ReferralEdgeSeed>;
}): Promise<{
  rows: ReadonlyArray<Record<string, unknown>>;
  balanceOf: (partnerId: string) => number;
}> {
  const fake = fakePrisma({
    settings: input.settings,
    partners: input.partners,
    edges: input.edges,
    existingTransactions: alreadyPaidOnce(...input.partners.map((p) => p.id)),
  });
  const service = new PartnerEarningsService(
    fake.client as never,
    NULL_LOGGER as never,
    NULL_NOTIFICATIONS as never,
  );
  await service.processPartnerEarning({
    payerUserId: PAYER,
    paymentAmountMinorUnits: PAYMENT,
    gatewayType: null,
    sourceTransactionId: 'tx-second',
  });
  return {
    rows: fake.state.createdTransactions,
    balanceOf: (partnerId: string) => fake.state.partnerById.get(partnerId)?.balance ?? -1,
  };
}

function rowFor(
  rows: ReadonlyArray<Record<string, unknown>>,
  partnerId: string,
): Record<string, unknown> | null {
  return rows.find((row) => (row.partnerId as string) === partnerId) ?? null;
}

describe('PartnerEarningsService - per-level accrual strategy', () => {
  // -- THE DEPLOY-SAFETY PROPERTY --------------------------------------------
  // Nothing else in this change matters if this one fails. Three new columns
  // arrive NULL on every live partner row; NULL means "inherit the
  // partner-wide `accrualStrategy`". So on the day this ships every existing
  // partner must accrue exactly what it accrued the day before, at all three
  // levels, in both modes. Assert the credited ROW, not just a count: a wrong
  // level or a wrong amount is the same defect as a missing row.
  it('DEPLOY SAFETY: an individual partner with no per-level column behaves exactly as it does today', async () => {
    for (const level of [1, 2, 3]) {
      // ON_EACH_PAYMENT, per-level columns untouched -> still pays a second time.
      const each = await runSecondPayment({
        settings: { enabled: true, levels: GLOBAL_LEVELS },
        partners: [
          seedPartner({
            id: 'p1',
            useGlobalSettings: false,
            accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
          }),
        ],
        edges: [{ partnerId: 'p1', referralUserId: PAYER, level }],
      });
      const eachRow = rowFor(each.rows, 'p1');
      assert.notEqual(
        eachRow,
        null,
        `L${level}: an unconfigured ON_EACH_PAYMENT partner must still be credited on a second payment`,
      );
      assert.equal(each.rows.length, 1, `L${level}: exactly one accrual expected`);
      assert.equal(eachRow?.level, level, `L${level}: accrual must be recorded at the edge level`);
      assert.equal(
        eachRow?.earnedAmount,
        EXPECTED_EARNING,
        `L${level}: the amount must not move either`,
      );
      assert.equal(eachRow?.referralUserId, PAYER, `L${level}: credited against the payer`);
      assert.equal(eachRow?.sourceKey, 'runtime:p1:tx-second', `L${level}: race guard key intact`);
      assert.equal(each.balanceOf('p1'), EXPECTED_EARNING, `L${level}: balance credited`);

      // ONCE_PER_USER, per-level columns untouched -> still pays nothing twice.
      const once = await runSecondPayment({
        settings: { enabled: true, levels: GLOBAL_LEVELS },
        partners: [
          seedPartner({
            id: 'p1',
            useGlobalSettings: false,
            accrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
          }),
        ],
        edges: [{ partnerId: 'p1', referralUserId: PAYER, level }],
      });
      assert.deepEqual(
        once.rows,
        [],
        `L${level}: an unconfigured ONCE_PER_USER partner must still be skipped on a second payment`,
      );
      assert.equal(once.balanceOf('p1'), 0, `L${level}: balance untouched`);
    }
  });

  it('DEPLOY SAFETY: a global-settings partner with no per-level global config behaves exactly as it does today', async () => {
    for (const level of [1, 2, 3]) {
      // The only accrual key an install may have is the flat `accrualStrategy`.
      for (const [flat, shouldAccrue] of [
        ['ON_EACH_PAYMENT', true],
        ['ON_FIRST_PAYMENT', false],
        [undefined, true], // absent key: the engine has always defaulted to every payment
      ] as ReadonlyArray<readonly [string | undefined, boolean]>) {
        const settings: Record<string, unknown> = { enabled: true, levels: GLOBAL_LEVELS };
        if (flat !== undefined) settings.accrualStrategy = flat;
        const run = await runSecondPayment({
          settings,
          partners: [seedPartner({ id: 'p1', useGlobalSettings: true })],
          edges: [{ partnerId: 'p1', referralUserId: PAYER, level }],
        });
        const row = rowFor(run.rows, 'p1');
        if (shouldAccrue) {
          assert.notEqual(row, null, `L${level} / accrualStrategy=${flat}: must still be credited`);
          assert.equal(row?.level, level, `L${level} / accrualStrategy=${flat}: wrong level recorded`);
          assert.equal(
            row?.earnedAmount,
            EXPECTED_EARNING,
            `L${level} / accrualStrategy=${flat}: amount moved`,
          );
        } else {
          assert.deepEqual(
            run.rows,
            [],
            `L${level} / accrualStrategy=${flat}: must still be skipped on a second payment`,
          );
        }
      }
    }
  });

  // -- The owner's case ------------------------------------------------------
  it('L1 pays on every payment while L2 pays only on the first, from ONE configuration', async () => {
    // The same settings object is given to both partners. What differs is the
    // LEVEL each one sits at in the chain, and that alone decides whether the
    // second payment pays. The partner-wide `accrualStrategy` is deliberately
    // the opposite of the L1 column, so this also pins that the per-level
    // column beats the partner-wide one.
    const perLevelConfig = {
      useGlobalSettings: false,
      accrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
      level1AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
      level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
    } as const;

    const run = await runSecondPayment({
      settings: { enabled: true, levels: GLOBAL_LEVELS },
      partners: [
        seedPartner({ id: 'p1', ...perLevelConfig }),
        seedPartner({ id: 'p2', ...perLevelConfig }),
      ],
      edges: [
        { partnerId: 'p1', referralUserId: PAYER, level: 1 },
        { partnerId: 'p2', referralUserId: PAYER, level: 2 },
      ],
    });

    const l1 = rowFor(run.rows, 'p1');
    assert.notEqual(l1, null, "level 1 is ON_EACH_PAYMENT, so the second payment must pay");
    assert.equal(l1?.level, 1, 'the L1 accrual must be recorded at level 1');
    assert.equal(l1?.earnedAmount, EXPECTED_EARNING, 'L1 amount');
    assert.equal(l1?.referralUserId, PAYER, 'L1 accrual is credited against the payer');
    assert.equal(
      rowFor(run.rows, 'p2'),
      null,
      "level 2 is ONCE_PER_USER and this payer already paid, so level 2 must NOT pay",
    );
    assert.equal(run.rows.length, 1, 'exactly one of the two levels may accrue here');
    assert.equal(run.balanceOf('p1'), EXPECTED_EARNING, 'L1 balance credited');
    assert.equal(run.balanceOf('p2'), 0, 'L2 balance untouched');
  });

  // -- Individual vs global --------------------------------------------------
  it('individual per-level settings beat the global per-level settings', async () => {
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        accrualStrategies: { LEVEL_2: 'ON_EACH_PAYMENT' },
      },
      partners: [
        seedPartner({
          id: 'p2',
          useGlobalSettings: false,
          level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        }),
      ],
      edges: [{ partnerId: 'p2', referralUserId: PAYER, level: 2 }],
    });
    assert.deepEqual(
      run.rows,
      [],
      "the global map says ON_EACH_PAYMENT for LEVEL_2, but useGlobalSettings=false so the partner's own ONCE_PER_USER wins",
    );
  });

  it('useGlobalSettings=true ignores the partner columns and takes the global per-level value', async () => {
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        accrualStrategies: { LEVEL_2: 'ON_EACH_PAYMENT' },
      },
      partners: [
        seedPartner({
          id: 'p2',
          useGlobalSettings: true,
          // Both of these are set to the opposite mode and must be ignored.
          accrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
          level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        }),
      ],
      edges: [{ partnerId: 'p2', referralUserId: PAYER, level: 2 }],
    });
    const row = rowFor(run.rows, 'p2');
    assert.notEqual(
      row,
      null,
      "useGlobalSettings=true must read accrualStrategies.LEVEL_2, not the partner's own columns",
    );
    assert.equal(row?.level, 2, 'accrual recorded at level 2');
    assert.equal(row?.earnedAmount, EXPECTED_EARNING, 'global 10% of 10000');
  });

  it('useGlobalSettings=true resolves each level independently from the global map', async () => {
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        accrualStrategies: {
          LEVEL_1: 'ON_EACH_PAYMENT',
          LEVEL_2: 'ON_FIRST_PAYMENT',
          LEVEL_3: 'ON_EACH_PAYMENT',
        },
      },
      partners: [
        seedPartner({ id: 'p1' }),
        seedPartner({ id: 'p2' }),
        seedPartner({ id: 'p3' }),
      ],
      edges: [
        { partnerId: 'p1', referralUserId: PAYER, level: 1 },
        { partnerId: 'p2', referralUserId: PAYER, level: 2 },
        { partnerId: 'p3', referralUserId: PAYER, level: 3 },
      ],
    });
    assert.equal(rowFor(run.rows, 'p1')?.level, 1, 'LEVEL_1 is ON_EACH_PAYMENT');
    assert.equal(rowFor(run.rows, 'p2'), null, 'LEVEL_2 is ON_FIRST_PAYMENT');
    assert.equal(rowFor(run.rows, 'p3')?.level, 3, 'LEVEL_3 is ON_EACH_PAYMENT');
    assert.equal(run.rows.length, 2, 'only levels 1 and 3 may accrue');
  });

  // -- Fallbacks -------------------------------------------------------------
  it('a level missing from the global map falls back to the legacy flat `accrualStrategy` key', async () => {
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        accrualStrategies: { LEVEL_1: 'ON_EACH_PAYMENT' }, // LEVEL_2 deliberately absent
        accrualStrategy: 'ON_FIRST_PAYMENT',
      },
      partners: [seedPartner({ id: 'p1' }), seedPartner({ id: 'p2' })],
      edges: [
        { partnerId: 'p1', referralUserId: PAYER, level: 1 },
        { partnerId: 'p2', referralUserId: PAYER, level: 2 },
      ],
    });
    assert.equal(
      rowFor(run.rows, 'p1')?.level,
      1,
      'LEVEL_1 is present in accrualStrategies and says ON_EACH_PAYMENT',
    );
    assert.equal(
      rowFor(run.rows, 'p2'),
      null,
      "LEVEL_2 is absent from accrualStrategies, so level 2 falls back by name to the legacy flat `accrualStrategy` key (ON_FIRST_PAYMENT) and must not pay a second time",
    );
  });

  it('the legacy flat global `accrualStrategy` key still drives every level', async () => {
    // An install that predates `accrualStrategies` has only this key. If the
    // fallback were dropped, that operator would silently flip from "first
    // payment only" back to "every payment" the moment this ships.
    for (const level of [1, 2, 3]) {
      const first = await runSecondPayment({
        settings: { enabled: true, levels: GLOBAL_LEVELS, accrualStrategy: 'ON_FIRST_PAYMENT' },
        partners: [seedPartner({ id: 'p1' })],
        edges: [{ partnerId: 'p1', referralUserId: PAYER, level }],
      });
      assert.deepEqual(
        first.rows,
        [],
        `L${level}: the legacy flat accrualStrategy=ON_FIRST_PAYMENT must still suppress the second payment`,
      );

      // Positive control, so "no rows" above cannot pass for an unrelated reason.
      const each = await runSecondPayment({
        settings: { enabled: true, levels: GLOBAL_LEVELS, accrualStrategy: 'ON_EACH_PAYMENT' },
        partners: [seedPartner({ id: 'p1' })],
        edges: [{ partnerId: 'p1', referralUserId: PAYER, level }],
      });
      assert.equal(
        rowFor(each.rows, 'p1')?.earnedAmount,
        EXPECTED_EARNING,
        `L${level}: the same legacy key set to ON_EACH_PAYMENT must still pay`,
      );
    }
  });

  it('a flat per-level global key is honoured over the legacy flat key', async () => {
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        level2AccrualStrategy: 'ON_FIRST_PAYMENT', // SPA flat payload, mirrors level2Percent
        accrualStrategy: 'ON_EACH_PAYMENT',
      },
      partners: [seedPartner({ id: 'p1' }), seedPartner({ id: 'p2' })],
      edges: [
        { partnerId: 'p1', referralUserId: PAYER, level: 1 },
        { partnerId: 'p2', referralUserId: PAYER, level: 2 },
      ],
    });
    assert.equal(
      rowFor(run.rows, 'p1')?.level,
      1,
      'level 1 has no flat per-level key, so it takes the legacy accrualStrategy=ON_EACH_PAYMENT',
    );
    assert.equal(
      rowFor(run.rows, 'p2'),
      null,
      'level2AccrualStrategy=ON_FIRST_PAYMENT must win over the legacy flat key',
    );
  });

  it('an empty or unrecognised global level value falls through instead of becoming a mode', async () => {
    for (const junk of ["", "   ", "on_first", "ONCE", "true", "1"]) {
      const run = await runSecondPayment({
        settings: {
          enabled: true,
          levels: GLOBAL_LEVELS,
          accrualStrategies: { LEVEL_2: junk },
          accrualStrategy: 'ON_FIRST_PAYMENT',
        },
        partners: [seedPartner({ id: 'p2' })],
        edges: [{ partnerId: 'p2', referralUserId: PAYER, level: 2 }],
      });
      assert.deepEqual(
        run.rows,
        [],
        `LEVEL_2=${JSON.stringify(junk)} is not a mode, so level 2 must fall through to the legacy flat accrualStrategy (ON_FIRST_PAYMENT)`,
      );
    }
  });

  it('ONCE_PER_USER is accepted in the global map as an alias for ON_FIRST_PAYMENT', async () => {
    // The panel reuses the per-partner enum control for the global defaults,
    // so the Prisma spelling can arrive here.
    const run = await runSecondPayment({
      settings: {
        enabled: true,
        levels: GLOBAL_LEVELS,
        accrualStrategies: { LEVEL_1: 'ONCE_PER_USER' },
        accrualStrategy: 'ON_EACH_PAYMENT',
      },
      partners: [seedPartner({ id: 'p1' })],
      edges: [{ partnerId: 'p1', referralUserId: PAYER, level: 1 }],
    });
    assert.deepEqual(
      run.rows,
      [],
      "ONCE_PER_USER in the global map must mean ON_FIRST_PAYMENT, not fall through to the legacy ON_EACH_PAYMENT",
    );
  });
});
