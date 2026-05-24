import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';
import { PartnerAccrualStrategy, PartnerRewardType, Prisma } from '@prisma/client';

import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';

const NULL_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface CalcInput {
  paymentAmount: number;
  level: number;
  globalPercent: number;
  individualPercent: number | null;
  individualFixed: number | null;
  useGlobal: boolean;
  rewardType: PartnerRewardType;
  gatewayCommission: number;
  taxPercent: number;
  autoCalculate: boolean;
}

/**
 * Drives the private `calculateEarning` indirectly by feeding a single
 * synthetic payer/edge through `processPartnerEarning` and observing
 * what the partner gets credited with.
 */
async function runCalculation(input: CalcInput): Promise<{
  earnedAmount: number;
  percent: string;
  source: string;
}> {
  const partner = {
    id: 'p1',
    userId: 'u1',
    isActive: true,
    useGlobalSettings: input.useGlobal,
    accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
    rewardType: input.rewardType,
    level1Percent: input.individualPercent !== null ? new Prisma.Decimal(input.individualPercent.toString()) : null,
    level2Percent: input.individualPercent !== null ? new Prisma.Decimal(input.individualPercent.toString()) : null,
    level3Percent: input.individualPercent !== null ? new Prisma.Decimal(input.individualPercent.toString()) : null,
    level1FixedAmount: input.individualFixed,
    level2FixedAmount: input.individualFixed,
    level3FixedAmount: input.individualFixed,
    balance: 0,
    totalEarned: 0,
  };

  const captured: Array<{ earnedAmount: number; percent: string; source: string }> = [];

  const fakePrisma = {
    settings: {
      findFirst: async () => ({
        partnerSettings: {
          enabled: true,
          levels: { LEVEL_1: input.globalPercent, LEVEL_2: input.globalPercent, LEVEL_3: input.globalPercent },
          gatewayCommissions: { TEST: input.gatewayCommission },
          taxPercent: input.taxPercent,
          autoCalculateCommission: input.autoCalculate,
        },
      }),
    },
    partnerReferral: {
      findMany: async () => [
        {
          partnerId: 'p1',
          referralUserId: 'payer',
          level: input.level,
          partner,
        },
      ],
      findFirst: async () => null,
      findUnique: async () => null,
      create: async () => undefined,
    },
    partnerTransaction: {
      findFirst: async () => null,
    },
    partner: {
      findUnique: async () => partner,
    },
    $transaction: async <T,>(callback: (txClient: Record<string, unknown>) => Promise<T>) =>
      callback({
        partnerTransaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            captured.push({
              earnedAmount: args.data.earnedAmount as number,
              percent: String(args.data.percent),
              source: String(args.data.description ?? ''),
            });
            return args.data;
          },
        },
        partner: {
          update: async () => undefined,
        },
      }),
  };

  const service = new PartnerEarningsService(fakePrisma as never, NULL_LOGGER as never, {
    notifyEarning: async () => undefined,
    notifyWithdrawalApproved: async () => undefined,
    notifyWithdrawalRejected: async () => undefined,
  } as never);
  await service.processPartnerEarning({
    payerUserId: 'payer',
    paymentAmountMinorUnits: input.paymentAmount,
    gatewayType: 'TEST',
    sourceTransactionId: 'tx-1',
  });
  return captured[0] ?? { earnedAmount: 0, percent: '0', source: 'none' };
}

describe('PartnerEarningsService — property-based invariants', () => {
  it('earned amount is always a non-negative integer ≤ payment amount', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 100_000_000 }), // payment in minor units
        fc.integer({ min: 1, max: 3 }), // level
        fc.integer({ min: 0, max: 100 }), // global percent
        fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: null }), // individual percent
        fc.boolean(), // useGlobal
        async (paymentAmount, level, globalPercent, individualPercent, useGlobal) => {
          const result = await runCalculation({
            paymentAmount,
            level,
            globalPercent,
            individualPercent,
            individualFixed: null,
            useGlobal,
            rewardType: PartnerRewardType.PERCENT,
            gatewayCommission: 0,
            taxPercent: 0,
            autoCalculate: false,
          });
          assert.ok(Number.isInteger(result.earnedAmount), `earned=${result.earnedAmount} not integer`);
          assert.ok(result.earnedAmount >= 0, `earned=${result.earnedAmount} negative`);
          assert.ok(
            result.earnedAmount <= paymentAmount,
            `earned=${result.earnedAmount} > payment=${paymentAmount}`,
          );
        },
      ),
      { numRuns: 80 },
    );
  });

  it('zero global percent + global settings produces zero earnings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 1, max: 3 }),
        async (paymentAmount, level) => {
          const result = await runCalculation({
            paymentAmount,
            level,
            globalPercent: 0,
            individualPercent: null,
            individualFixed: null,
            useGlobal: true,
            rewardType: PartnerRewardType.PERCENT,
            gatewayCommission: 0,
            taxPercent: 0,
            autoCalculate: false,
          });
          assert.equal(result.earnedAmount, 0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('individual fixed amount overrides percent calculation regardless of payment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 10_000_000 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (paymentAmount, level, fixed) => {
          const result = await runCalculation({
            paymentAmount,
            level,
            globalPercent: 50,
            individualPercent: null,
            individualFixed: fixed,
            useGlobal: false,
            rewardType: PartnerRewardType.FIXED,
            gatewayCommission: 0,
            taxPercent: 0,
            autoCalculate: false,
          });
          assert.equal(result.earnedAmount, fixed);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('autoCalculateCommission monotonically reduces earnings as commission rises', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_000_000, max: 100_000_000 }),
        fc.integer({ min: 1, max: 100 }), // global percent
        fc.integer({ min: 0, max: 50 }), // commission low
        fc.integer({ min: 51, max: 100 }), // commission high
        async (paymentAmount, globalPercent, commissionLow, commissionHigh) => {
          const low = await runCalculation({
            paymentAmount,
            level: 1,
            globalPercent,
            individualPercent: null,
            individualFixed: null,
            useGlobal: true,
            rewardType: PartnerRewardType.PERCENT,
            gatewayCommission: commissionLow,
            taxPercent: 0,
            autoCalculate: true,
          });
          const high = await runCalculation({
            paymentAmount,
            level: 1,
            globalPercent,
            individualPercent: null,
            individualFixed: null,
            useGlobal: true,
            rewardType: PartnerRewardType.PERCENT,
            gatewayCommission: commissionHigh,
            taxPercent: 0,
            autoCalculate: true,
          });
          assert.ok(
            high.earnedAmount <= low.earnedAmount,
            `commission${commissionHigh} earned=${high.earnedAmount} > commission${commissionLow} earned=${low.earnedAmount}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});
