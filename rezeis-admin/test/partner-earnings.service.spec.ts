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
}) {
  const createdTransactions: Array<Record<string, unknown>> = [];
  const partnerById = new Map(opts.partners.map((p) => [p.id, { ...p, balance: p.balance ?? 0, totalEarned: p.totalEarned ?? 0 }]));
  const existing = [...(opts.existingTransactions ?? [])];

  const tx = {
    partnerTransaction: {
      create: async (args: { data: Record<string, unknown> }) => {
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
