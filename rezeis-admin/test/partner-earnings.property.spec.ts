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

/**
 * Runs a SECOND payment: the payer already holds one accrual row against this
 * partner. Whether they get credited again is exactly what the accrual mode
 * decides and nothing else here varies, so the boolean IS the resolved mode.
 *
 * "Already paid once" is a ROW, not a timestamp - no dates in this fixture.
 */
async function secondPaymentAccrues(input: {
  level: number;
  settings: Record<string, unknown>;
  partner?: Partial<{
    useGlobalSettings: boolean;
    accrualStrategy: PartnerAccrualStrategy;
    level1AccrualStrategy: PartnerAccrualStrategy | null;
    level2AccrualStrategy: PartnerAccrualStrategy | null;
    level3AccrualStrategy: PartnerAccrualStrategy | null;
  }>;
}): Promise<boolean> {
  const partner = {
    id: 'p1',
    userId: 'u1',
    isActive: true,
    useGlobalSettings: true,
    accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
    rewardType: PartnerRewardType.PERCENT,
    level1Percent: new Prisma.Decimal('10.00'),
    level2Percent: new Prisma.Decimal('10.00'),
    level3Percent: new Prisma.Decimal('10.00'),
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    level1AccrualStrategy: null,
    level2AccrualStrategy: null,
    level3AccrualStrategy: null,
    balance: 0,
    totalEarned: 0,
    ...input.partner,
  };

  let created = 0;
  const fakePrisma = {
    settings: { findFirst: async () => ({ partnerSettings: input.settings }) },
    partnerReferral: {
      findMany: async () => [
        { partnerId: 'p1', referralUserId: 'payer', level: input.level, partner },
      ],
      findFirst: async () => null,
      findUnique: async () => null,
      create: async () => undefined,
    },
    partnerTransaction: {
      // Two different probes reach this stub. The idempotency probe is keyed on
      // the source transaction (a fresh one here) and must miss; the
      // ON_FIRST_PAYMENT probe is keyed on the payer and must find the earlier
      // accrual.
      findFirst: async (args: { where: Record<string, unknown> }) =>
        args.where.referralUserId === 'payer' ? { id: 'earlier-accrual' } : null,
    },
    partner: { findUnique: async () => partner },
    $transaction: async <T,>(callback: (txClient: Record<string, unknown>) => Promise<T>) =>
      callback({
        partnerTransaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            created += 1;
            return args.data;
          },
        },
        partner: { update: async () => undefined },
      }),
  };

  const service = new PartnerEarningsService(fakePrisma as never, NULL_LOGGER as never, {
    notifyEarning: async () => undefined,
    notifyWithdrawalApproved: async () => undefined,
    notifyWithdrawalRejected: async () => undefined,
  } as never);
  await service.processPartnerEarning({
    payerUserId: 'payer',
    paymentAmountMinorUnits: 10_000,
    gatewayType: null,
    sourceTransactionId: 'tx-second',
  });
  return created > 0;
}

const GLOBAL_LEVELS = { LEVEL_1: 10, LEVEL_2: 10, LEVEL_3: 10 };
const RECOGNISED_MODES = new Set(['ON_EACH_PAYMENT', 'ON_FIRST_PAYMENT', 'ONCE_PER_USER']);

describe('PartnerEarningsService - per-level accrual invariants', () => {
  // The deploy-safety property, stated as a property: whatever the level and
  // whatever the partner-wide mode, a partner with all three per-level columns
  // NULL answers exactly what the partner-wide column alone used to answer.
  it('a partner with no per-level column always resolves to its partner-wide accrualStrategy', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom(
          PartnerAccrualStrategy.ON_EACH_PAYMENT,
          PartnerAccrualStrategy.ONCE_PER_USER,
        ),
        async (level, partnerWide) => {
          const accrued = await secondPaymentAccrues({
            level,
            settings: { enabled: true, levels: GLOBAL_LEVELS },
            partner: { useGlobalSettings: false, accrualStrategy: partnerWide },
          });
          assert.equal(
            accrued,
            partnerWide === PartnerAccrualStrategy.ON_EACH_PAYMENT,
            `L${level}: an unconfigured level must answer exactly what accrualStrategy=${partnerWide} answers`,
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  // The global map is operator-typed JSON. Anything that is not one of the
  // three recognised spellings must fall through to the legacy flat key rather
  // than become a mode of its own.
  it('an unrecognised global per-level value never overrides the legacy flat key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.string(),
        fc.constantFrom('ON_EACH_PAYMENT', 'ON_FIRST_PAYMENT'),
        async (level, junk, legacy) => {
          fc.pre(!RECOGNISED_MODES.has(junk.trim().toUpperCase()));
          const accrued = await secondPaymentAccrues({
            level,
            settings: {
              enabled: true,
              levels: GLOBAL_LEVELS,
              accrualStrategies: { [`LEVEL_${level}`]: junk },
              accrualStrategy: legacy,
            },
          });
          assert.equal(
            accrued,
            legacy === 'ON_EACH_PAYMENT',
            `LEVEL_${level}=${JSON.stringify(junk)} is not a mode, so the answer must come from the legacy flat accrualStrategy=${legacy}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
