import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdClickSurface, Prisma } from '@prisma/client';

import { AdConversionService } from '../src/modules/advertising/services/ad-conversion.service';
import { AdAttributionService } from '../src/modules/advertising/services/ad-attribution.service';
import { AdSignupBonusService } from '../src/modules/advertising/services/ad-signup-bonus.service';
import { AdMetricsService } from '../src/modules/advertising/services/ad-metrics.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import type { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

const DAY = 24 * 60 * 60 * 1000;
const reiwaAdvertisingLinks = {
  resolve: async () => ({
    adminReiwaBotUsername: 'ReiwaBot',
    miniAppShortName: null,
    webBaseUrl: 'https://reiwa.example',
  }),
} as never;

/**
 * FX stub. RUB (the default reporting base) passes through; USD converts at a
 * fixed rate so the tests can assert a real cross-currency total; anything else
 * has no rate, which must be reported as unconverted rather than as zero.
 */
const USD_RATE = 80;
function fxStub() {
  return {
    getBaseCurrency: () => 'RUB',
    toBaseMinor: async (amount: unknown, currency: string) => {
      const major = Number(amount);
      if (!Number.isFinite(major)) return null;
      if (currency.toUpperCase() === 'RUB') return { amountBaseMinor: Math.round(major * 100), rate: 1 };
      if (currency.toUpperCase() === 'USD')
        return { amountBaseMinor: Math.round(major * USD_RATE * 100), rate: USD_RATE };
      return null;
    },
  } as never;
}

describe('AdConversionService.recordFirstPurchase', () => {
  function build(overrides: {
    acquisitionPlacementId: string | null;
    acquisitionAt: Date | null;
    windowDays?: number;
    /** Window frozen on the user at first touch (defaults to the placement's). */
    acquisitionWindowDays?: number | null;
    /** A COMPLETED transaction that predates the advertising touch. */
    earlierPurchase?: boolean;
    /** A COMPLETED but ZERO-amount transaction before the touch (promo, free add-on). */
    earlierZeroPurchase?: boolean;
    createImpl?: () => Promise<unknown>;
  }) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      user: {
        findUnique: async () => ({
          acquisitionPlacementId: overrides.acquisitionPlacementId,
          acquisitionAt: overrides.acquisitionAt,
          acquisitionWindowDays: overrides.acquisitionWindowDays ?? null,
        }),
      },
      transaction: {
        // Mirrors the real query: a zero-amount row is filtered out by
        // `amount: { gt: 0 }`, so the stub only answers when a PAID one is asked for.
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const wantsPaid = (args.where as { amount?: { gt?: number } }).amount?.gt === 0;
          if (overrides.earlierPurchase === true) return { id: 'older-tx' };
          if (overrides.earlierZeroPurchase === true) return wantsPaid ? null : { id: 'older-zero-tx' };
          return null;
        },
      },
      adPlacement: {
        findUnique: async () =>
          overrides.acquisitionPlacementId === null
            ? null
            : { id: 'p1', campaignId: 'c1', attributionWindowDays: overrides.windowDays ?? 30 },
      },
      adConversion: {
        create: overrides.createImpl ?? (async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return args.data;
        }),
      },
      adClick: {
        findFirst: async () => ({
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          utmContent: null,
          utmCreative: null,
        }),
      },
    } as unknown as PrismaService;
    return { service: new AdConversionService(prisma, fxStub()), created };
  }

  it('creates a conversion within the attribution window', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 1 * DAY),
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '299.50',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].amount, 29950);
    assert.equal(created[0].transactionId, 'tx1');
    assert.equal(created[0].placementId, 'p1');
  });

  // Revenue used to be `round(amount * 100)` in the payment's own currency, so a
  // dollar purchase was added to roubles as if it were roubles, and any crypto
  // amount (8 decimals) collapsed to 0. The rate is resolved once, at write time,
  // and stored — so tomorrow's rate cannot rewrite yesterday's payback.
  it('stores the converted amount and the rate that produced it', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 1 * DAY),
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '4.99',
      currency: 'USD',
      completedAt: new Date(),
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].amount, 499, 'the original amount is kept as booked');
    assert.equal(created[0].currency, 'USD');
    assert.equal(created[0].amountBase, 39920, '4.99 USD at 80 = 399.20 RUB');
    assert.equal(created[0].baseCurrency, 'RUB');
    assert.equal(Number(created[0].fxRate), 80, 'the rate used is stored alongside the amount');
  });

  it('records the conversion but no base amount when no rate is known', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 1 * DAY),
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '0.004',
      currency: 'BTC',
      completedAt: new Date(),
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].amountBase, null, 'unconverted, not zero');
    assert.equal(created[0].baseCurrency, null);
  });

  // Reading the window from the placement at payment time meant an operator who
  // widened 7 → 365 retroactively converted old renewals into ad revenue.
  it('judges the purchase against the window frozen at first touch', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 40 * DAY),
      windowDays: 365, // the placement was widened after the fact
      acquisitionWindowDays: 7, // what actually applied when the user arrived
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '100',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 0, 'a later window edit must not create revenue');
  });

  // Legacy attributions can point an existing paying customer at a placement;
  // their next renewal must not become that placement's first purchase.
  it('skips a customer who was already paying before the advertising touch', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 1 * DAY),
      earlierPurchase: true,
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '1200',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 0);
  });

  // The platform creates COMPLETED transactions worth 0 itself (100% promo, free
  // add-on, balance-funded purchase), and the rest of this patch treats those as
  // "no money moved". Counting one as an earlier purchase would reject not just
  // this conversion but every future one for that user, with no replay to recover.
  it('does not treat a zero-amount transaction as an earlier purchase', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 1 * DAY),
      earlierZeroPurchase: true,
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '1200',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 1, 'a 0 ₽ promo must not burn the placement forever');
  });

  it('skips when the purchase is outside the window (organic)', async () => {
    const { service, created } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(Date.now() - 40 * DAY),
      windowDays: 30,
    });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '100',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 0);
  });

  it('skips when the user has no advertising acquisition', async () => {
    const { service, created } = build({ acquisitionPlacementId: null, acquisitionAt: null });
    await service.recordFirstPurchase({
      id: 'tx1',
      userId: 'u1',
      amount: '100',
      currency: 'RUB',
      completedAt: new Date(),
    });
    assert.equal(created.length, 0);
  });

  it('is idempotent: a duplicate (P2002) never throws', async () => {
    const { service } = build({
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date(),
      createImpl: async () => {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        });
      },
    });
    await assert.doesNotReject(
      service.recordFirstPurchase({
        id: 'tx1',
        userId: 'u1',
        amount: '100',
        currency: 'RUB',
        completedAt: new Date(),
      }),
    );
  });

  it('revertConversion flips only ATTRIBUTED rows', async () => {
    let whereStatus: unknown = null;
    const prisma = {
      adConversion: {
        updateMany: async (args: { where: { status: string } }) => {
          whereStatus = args.where.status;
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;
    await new AdConversionService(prisma, fxStub()).revertConversion('tx1');
    assert.equal(whereStatus, 'ATTRIBUTED');
  });
});

describe('AdAttributionService.recordClick', () => {
  function buildPrisma(opts: {
    placement: Record<string, unknown> | null;
    user?: { id: string } | null;
    updateCount?: number;
    onUpdateMany?: (args: unknown) => void;
    /** Age of the account the touch lands on (defaults to brand-new). */
    accountCreatedAt?: Date;
    /** Placement the user is already attributed to, if any. */
    alreadyAcquiredBy?: string | null;
  }) {
    return {
      adPlacement: { findUnique: async () => opts.placement },
      adClick: { create: async () => ({}) },
      user: {
        findUnique: async () =>
          opts.user === null
            ? null
            : {
                ...(opts.user ?? { id: 'u1' }),
                createdAt: opts.accountCreatedAt ?? new Date(),
                acquisitionPlacementId: opts.alreadyAcquiredBy ?? null,
              },
        updateMany: async (args: unknown) => {
          opts.onUpdateMany?.(args);
          return { count: opts.updateCount ?? 1 };
        },
      },
      partner: { findUnique: async () => ({ userId: 'partner-user', isActive: true }) },
      partnerReferral: { findFirst: async () => null },
    } as unknown as PrismaService;
  }

  it('is a no-op for an unknown / inactive code', async () => {
    let clickCreated = false;
    const prisma = {
      adPlacement: { findUnique: async () => null },
      adClick: { create: async () => { clickCreated = true; return {}; } },
    } as unknown as PrismaService;
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({ code: 'nope' });
    assert.equal(clickCreated, false);
  });

  it('sets first-touch via updateMany guarded on acquisitionPlacementId=null', async () => {
    let whereArg: { acquisitionPlacementId: unknown } | null = null;
    const prisma = buildPrisma({
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'COMPANY', partnerId: null, signupBonusType: 'NONE', signupBonus: null, attributionWindowDays: 30, campaign: { status: 'ACTIVE' } },
      user: { id: 'u1' },
      onUpdateMany: (args) => {
        whereArg = (args as { where: { acquisitionPlacementId: unknown } }).where;
      },
    });
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'p1code',
      telegramId: '123',
    });
    assert.ok(whereArg !== null);
    assert.equal((whereArg as { acquisitionPlacementId: unknown }).acquisitionPlacementId, null);
  });

  // The web funnel is session-less on landing and has no telegram id at all.
  // Every recordClick test used to pass a telegramId, so nothing covered the
  // browser shape — which is how a web surface that recorded literally nothing
  // shipped with a green suite.
  it('records a WEB open for an anonymous browser landing (no telegram id, no user)', async () => {
    let createdData: Record<string, unknown> | null = null;
    let acquisitionTouched = false;
    const prisma = {
      adPlacement: {
        findUnique: async () => ({
          id: 'p1',
          campaignId: 'c1',
          status: 'ACTIVE',
          ownerType: 'COMPANY',
          partnerId: null,
          signupBonusType: 'NONE',
          signupBonus: null,
          campaign: { status: 'ACTIVE' },
        }),
      },
      adClick: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdData = args.data;
          return {};
        },
      },
      user: {
        findUnique: async () => null,
        updateMany: async () => {
          acquisitionTouched = true;
          return { count: 0 };
        },
      },
    } as unknown as PrismaService;
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      surface: AdClickSurface.WEB,
    });
    assert.ok(createdData !== null, 'an anonymous landing must still count as an open');
    const data = createdData as unknown as Record<string, unknown>;
    assert.equal(data['surface'], 'WEB');
    assert.equal(data['userId'], null);
    assert.equal(data['placementId'], 'p1');
    // Nothing to attribute yet — registration claims first-touch later.
    assert.equal(acquisitionTouched, false);
  });

  it('attributeOnly claims first-touch without recording a second open', async () => {
    let clickCreated = false;
    let updateData: Record<string, unknown> | null = null;
    const prisma = {
      adPlacement: {
        findUnique: async () => ({
          id: 'p1',
          campaignId: 'c1',
          status: 'ACTIVE',
          ownerType: 'COMPANY',
          partnerId: null,
          signupBonusType: 'NONE',
          signupBonus: null,
          campaign: { status: 'ACTIVE' },
        }),
      },
      adClick: {
        create: async () => {
          clickCreated = true;
          return {};
        },
      },
      user: {
        findUnique: async () => ({ id: 'u1' }),
        updateMany: async (args: { data: Record<string, unknown> }) => {
          updateData = args.data;
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      userId: 'u1',
      surface: AdClickSurface.WEB,
      isNewUser: true,
      attributeOnly: true,
    });
    assert.equal(clickCreated, false, 'the landing already counted this open');
    assert.ok(updateData !== null, 'the account must still be bound to the placement');
    assert.equal((updateData as unknown as Record<string, unknown>)['acquisitionPlacementId'], 'p1');
  });

  it('attaches the partner chain for a PARTNER placement (self-guard ok)', async () => {
    let attached: { newUserId: string; referrerUserId: string } | null = null;
    const prisma = buildPrisma({
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'PARTNER', partnerId: 'partner1', signupBonusType: 'NONE', signupBonus: null, campaign: { status: 'ACTIVE' } },
      user: { id: 'u1' },
      updateCount: 1,
    });
    const partner = {
      attachPartnerReferralChain: async (input: { newUserId: string; referrerUserId: string }) => {
        attached = input;
      },
    } as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({ code: 'c', telegramId: '1' });
    assert.deepEqual(attached, { newUserId: 'u1', referrerUserId: 'partner-user' });
  });

  // The one-partner-per-user rule lives in PartnerEarningsService, shared with the
  // referral and backfill paths (see partner-earnings.service.spec.ts). What the
  // ad path owes is delegation: it must route through that guard on the web
  // attribution shape too, not attach a chain of its own.
  // Advertising acquires NEW users. A campaign shown to an existing audience used
  // to book long-time customers as fresh registrations, which dragged CAC down and
  // pushed ROAS up by whatever share of the audience was already a customer.
  it('does not claim acquisition for a long-standing account', async () => {
    let updateCalled = false;
    const prisma = buildPrisma({
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'COMPANY', partnerId: null, signupBonusType: 'NONE', signupBonus: null, attributionWindowDays: 30, campaign: { status: 'ACTIVE' } },
      user: { id: 'u1' },
      accountCreatedAt: new Date(Date.now() - 200 * DAY),
      onUpdateMany: () => {
        updateCalled = true;
      },
    });
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      userId: 'u1',
      surface: AdClickSurface.WEB,
    });
    assert.equal(updateCalled, false, 'an existing customer is not a new acquisition');
  });

  it('freezes the placement window on the user at first touch', async () => {
    let updateData: Record<string, unknown> | null = null;
    const prisma = buildPrisma({
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'COMPANY', partnerId: null, signupBonusType: 'NONE', signupBonus: null, attributionWindowDays: 45, campaign: { status: 'ACTIVE' } },
      user: { id: 'u1' },
      onUpdateMany: (args) => {
        updateData = (args as { data: Record<string, unknown> }).data;
      },
    });
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      userId: 'u1',
      surface: AdClickSurface.WEB,
    });
    assert.ok(updateData !== null);
    assert.equal((updateData as unknown as Record<string, unknown>)['acquisitionWindowDays'], 45);
  });

  // An archived campaign used to keep accruing opens, handing out signup bonuses
  // and attaching partner chains, so spend continued after the operator believed
  // the campaign was closed.
  it('ignores a click when the campaign is not ACTIVE, even if the placement is', async () => {
    let clickCreated = false;
    const prisma = {
      adPlacement: {
        findUnique: async () => ({
          id: 'p1',
          campaignId: 'c1',
          status: 'ACTIVE',
          ownerType: 'COMPANY',
          partnerId: null,
          signupBonusType: 'NONE',
          signupBonus: null,
          attributionWindowDays: 30,
          campaign: { status: 'ARCHIVED' },
        }),
      },
      adClick: {
        create: async () => {
          clickCreated = true;
          return {};
        },
      },
    } as unknown as PrismaService;
    const partner = {} as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      userId: 'u1',
      surface: AdClickSurface.WEB,
    });
    assert.equal(clickCreated, false);
  });

  it('delegates the partner chain to the shared guard on a web attribution', async () => {
    let attached: unknown = null;
    const prisma = buildPrisma({
      placement: {
        id: 'p1',
        campaignId: 'c1',
        status: 'ACTIVE',
        ownerType: 'PARTNER',
        partnerId: 'partner-b',
        signupBonusType: 'NONE',
        signupBonus: null,
        campaign: { status: 'ACTIVE' },
      },
      user: { id: 'u1' },
      updateCount: 1,
    });
    const partner = {
      attachPartnerReferralChain: async (input: unknown) => {
        attached = input;
      },
    } as unknown as PartnerEarningsService;
    const bonus = { grantIfEligible: async () => {} } as unknown as AdSignupBonusService;
    await new AdAttributionService(prisma, partner, bonus).recordClick({
      code: 'WIcpYLNTs5',
      userId: 'u1',
      surface: AdClickSurface.WEB,
      attributeOnly: true,
    });
    assert.deepEqual(attached, { newUserId: 'u1', referrerUserId: 'partner-user' });
  });
});

describe('AdSignupBonusService.grantIfEligible', () => {
  it('skips NONE', async () => {
    let granted = false;
    const prisma = { subscription: { count: async () => 0 } } as unknown as PrismaService;
    const subs = { grantTrial: async () => { granted = true; return { subscriptionId: 's' }; } } as unknown as SubscriptionMutationsService;
    await new AdSignupBonusService(prisma, subs).grantIfEligible({ userId: 'u1', bonusType: 'NONE', bonusJson: null });
    assert.equal(granted, false);
  });

  it('skips when the user already has a subscription', async () => {
    let granted = false;
    const prisma = { subscription: { count: async () => 1 } } as unknown as PrismaService;
    const subs = { grantTrial: async () => { granted = true; return { subscriptionId: 's' }; } } as unknown as SubscriptionMutationsService;
    await new AdSignupBonusService(prisma, subs).grantIfEligible({ userId: 'u1', bonusType: 'TRIAL', bonusJson: null });
    assert.equal(granted, false);
  });

  it('grants a TRIAL via grantTrial for a new user', async () => {
    let grantInput: { userId: string; planId: string; durationDays: number } | null = null;
    const prisma = {
      subscription: { count: async () => 0 },
      user: { findUnique: async () => ({ createdAt: new Date() }) },
      plan: { findFirst: async () => ({ id: 'trial-plan', durations: [{ days: 7 }] }) },
    } as unknown as PrismaService;
    const subs = {
      grantTrial: async (input: { userId: string; planId: string; durationDays: number }) => {
        grantInput = input;
        return { subscriptionId: 's1' };
      },
    } as unknown as SubscriptionMutationsService;
    await new AdSignupBonusService(prisma, subs).grantIfEligible({
      userId: 'u1',
      bonusType: 'TRIAL',
      bonusJson: { trialDurationDays: 14 },
    });
    assert.deepEqual(grantInput, { userId: 'u1', planId: 'trial-plan', durationDays: 14 });
  });

  // The tracking code is printed in the advertisement, so "has no subscription"
  // let any dormant account collect a free paid plan — and inflate the
  // placement's registrations while doing it.
  it('skips a long-standing account whose subscription merely lapsed', async () => {
    let granted = false;
    const prisma = {
      subscription: { count: async () => 0 },
      user: { findUnique: async () => ({ createdAt: new Date(Date.now() - 200 * DAY) }) },
      plan: { findFirst: async () => ({ id: 'trial-plan', durations: [{ days: 7 }] }) },
    } as unknown as PrismaService;
    const subs = {
      grantTrial: async () => {
        granted = true;
        return { subscriptionId: 's1' };
      },
    } as unknown as SubscriptionMutationsService;
    await new AdSignupBonusService(prisma, subs).grantIfEligible({
      userId: 'u1',
      bonusType: 'TRIAL',
      bonusJson: { trialDurationDays: 14 },
    });
    assert.equal(granted, false, 'a dormant account is not a signup');
  });
});

describe('AdMetricsService.getPlacementMetrics', () => {
  it('computes CAC / ROAS / ROI for a COMPANY placement', async () => {
    const prisma = {
      adPlacement: {
        findUnique: async () => ({
          id: 'p1',
          ownerType: 'COMPANY',
          spendAmount: 300000, // 3000.00
          spendCurrency: 'RUB',
        }),
      },
      adClick: {
        count: async () => 100,
        groupBy: async () => [
          { _count: 60, utmSource: 'vk', utmMedium: 'cpc', utmCampaign: 'july' },
          { _count: 40, utmSource: null, utmMedium: null, utmCampaign: null },
        ],
      },
      user: { findMany: async () => [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] },
      adConversion: {
        // amountBase, not amount: revenue is summed in the reporting currency.
        groupBy: async () => [{ _count: 15, _sum: { amountBase: 900000 }, utmSource: 'source' }],
        findMany: async () => [],
        count: async () => 0,
      },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma, fxStub()).getPlacementMetrics('p1');
    assert.equal(metrics.costMinor, 300000);
    assert.equal(metrics.revenueMinor, 900000);
    assert.equal(metrics.conversions, 15);
    assert.equal(metrics.cac, 20000); // 300000 / 15
    assert.equal(metrics.roas, 3); // 900000 / 300000
    assert.equal(metrics.roi, 2); // (900000-300000)/300000
    // Merged: opens come from the clicks, conversions and revenue from purchases.
    // The row with traffic and no purchase is the point of the breakdown.
    assert.deepEqual(metrics.utmBreakdown, [
      { utmSource: 'source', opens: 0, conversions: 15, revenueMinor: 900000 },
      { utmSource: 'vk', utmMedium: 'cpc', utmCampaign: 'july', opens: 60, conversions: 0, revenueMinor: 0 },
      { opens: 40, conversions: 0, revenueMinor: 0 },
    ]);
    assert.equal(metrics.currency, 'RUB', 'one reporting currency, not the budget label');
    assert.equal(metrics.unconvertedConversions, 0);
  });

  // A budget booked in another currency used to divide straight into rouble
  // revenue: 500 USD stored as 50 000 minor units made ROAS ~90x too high.
  it('converts a foreign-currency budget into the reporting currency', async () => {
    const prisma = {
      adPlacement: {
        findUnique: async () => ({
          id: 'p1',
          ownerType: 'COMPANY',
          spendAmount: 50000, // 500.00 USD
          spendCurrency: 'USD',
        }),
      },
      adClick: { count: async () => 10, groupBy: async () => [] },
      user: { findMany: async () => [{ id: 'u1' }] },
      adConversion: {
        groupBy: async () => [{ _count: 1, _sum: { amountBase: 4000000 }, utmSource: null }],
        findMany: async () => [],
        count: async () => 0,
      },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma, fxStub()).getPlacementMetrics('p1');
    assert.equal(metrics.costMinor, 4000000, '500 USD at 80 = 40 000 RUB');
    assert.equal(metrics.roas, 1, 'comparable numerator and denominator');
  });

  // Conversions whose currency has no known rate must not be silently counted as
  // zero revenue — the operator is told how many are missing instead.
  it('reports unconverted conversions instead of folding them in as zero', async () => {
    const prisma = {
      adPlacement: {
        findUnique: async () => ({ id: 'p1', ownerType: 'COMPANY', spendAmount: 100000, spendCurrency: 'RUB' }),
      },
      adClick: { count: async () => 5, groupBy: async () => [] },
      user: { findMany: async () => [{ id: 'u1' }] },
      adConversion: {
        groupBy: async () => [{ _count: 3, _sum: { amountBase: 150000 }, utmSource: null }],
        findMany: async () => [],
        count: async () => 2,
      },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma, fxStub()).getPlacementMetrics('p1');
    assert.equal(metrics.revenueMinor, 150000);
    assert.equal(metrics.unconvertedConversions, 2);
    // SUM(amountBase) skips NULL, so dividing by all 3 conversions would understate
    // the average by a third. Only the 1 converted row belongs in the denominator.
    assert.equal(metrics.avgFirstPaymentMinor, 150000);
    // ARPU is withheld entirely rather than shown a third too low: an operator
    // budgets against this number.
    assert.equal(metrics.arpuMinor, null);
  });

  // A partner promotes at their own expense and earns through the partner
  // program: the platform books no advertising cost for them. Treating their
  // commission as cost made it grow with every renewal while revenue stayed
  // frozen on the first purchase, so a profitable channel read as a loss.
  it('books zero cost for a PARTNER placement and leaves the ratios undefined', async () => {
    let commissionQueried = false;
    const prisma = {
      adPlacement: {
        findUnique: async () => ({ id: 'p1', ownerType: 'PARTNER', spendAmount: null, spendCurrency: null }),
      },
      adClick: { count: async () => 50, groupBy: async () => [] },
      user: { findMany: async () => [{ id: 'u1' }, { id: 'u2' }] },
      adConversion: {
        groupBy: async () => [{ _count: 2, _sum: { amountBase: 200000 }, utmSource: null }],
        findMany: async () => [],
        count: async () => 0,
      },
      partnerTransaction: {
        aggregate: async () => {
          commissionQueried = true;
          return { _sum: { earnedAmount: 50000 } };
        },
      },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma, fxStub()).getPlacementMetrics('p1');
    assert.equal(metrics.costMinor, 0);
    assert.equal(commissionQueried, false, 'partner commission is not an advertising cost');
    assert.equal(metrics.revenueMinor, 200000, 'revenue is still tracked');
    assert.equal(metrics.roas, null, 'no spend means no return-on-spend to show');
    assert.equal(metrics.roi, null);
    assert.equal(metrics.cac, null);
  });
});

describe('AdMetricsService.getPlacementChartData', () => {
  it('includes today, so an event lands on the chart the day it happens', async () => {
    const now = new Date();
    const prisma = {
      adClick: { findMany: async () => [{ occurredAt: now }] },
      user: { findMany: async () => [{ acquisitionAt: now }] },
    } as unknown as PrismaService;
    const data = await new AdMetricsService(prisma, fxStub()).getPlacementChartData('p1', 14);
    assert.equal(data.length, 14);
    const last = data[data.length - 1];
    assert.equal(last?.date, now.toISOString().slice(0, 10));
    assert.equal(last?.opens, 1);
    assert.equal(last?.registrations, 1);
    // The window used to end yesterday, so today's rows matched no bucket and
    // were dropped by the lookup — a flat zero chart on the day of the test.
    assert.equal(
      data.reduce((sum, point) => sum + point.opens, 0),
      1,
    );
  });
});

/**
 * Notification sink. Moderation used to change a status and tell the partner
 * nothing at all, so these calls are part of the contract now.
 */
const moderationNotices: Array<{ type: string; payload: Record<string, unknown> }> = [];
const notificationsStub = {
  create: async (input: { type: string; payload: Record<string, unknown> }) => {
    moderationNotices.push({ type: input.type, payload: input.payload });
  },
} as never;

describe('AdPlacementRequestService moderation', () => {
  // Lazy import to keep the heavier service out of the lighter test paths.
  async function load() {
    const mod = await import('../src/modules/advertising/services/ad-placement-request.service');
    return mod.AdPlacementRequestService;
  }
  const config = { adminReiwaBotUsername: null, miniAppShortName: null, webBaseUrl: null } as never;

  function activeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'r1',
      partnerId: 'partner1',
      platforms: ['TELEGRAM', 'YOUTUBE'],
      channel: 'chan',
      notes: null,
      proposedWindowDays: 30,
      approvedWindowDays: 30,
      selfFundedBudgetNote: null,
      status: 'ACTIVE',
      reviewedBy: 'admin',
      reviewedAt: new Date(),
      campaignId: 'cmp1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function mockTxPrisma(opts: {
    initialStatus: string;
    partnerId?: string;
    platforms?: string[];
    proposedWindowDays?: number;
    approvedWindowDays?: number | null;
  }) {
    const placements: Array<Record<string, unknown>> = [];
    let status = opts.initialStatus;
    let claimCount = 0;
    const partnerId = opts.partnerId ?? 'partner1';
    const platforms = opts.platforms ?? ['TELEGRAM', 'YOUTUBE'];
    const proposedWindowDays = opts.proposedWindowDays ?? 30;
    const approvedWindowDays = opts.approvedWindowDays ?? 30;

    const tx = {
      adPlacementRequest: {
        updateMany: async (args: {
          where: { id?: string; status?: string; partnerId?: string };
          data: { status?: string };
        }) => {
          if (args.where.status !== undefined && args.where.status !== status) {
            return { count: 0 };
          }
          if (args.where.partnerId !== undefined && args.where.partnerId !== partnerId) {
            return { count: 0 };
          }
          claimCount += 1;
          status = args.data.status ?? status;
          return { count: 1 };
        },
        findUniqueOrThrow: async () =>
          activeRow({
            partnerId,
            platforms,
            proposedWindowDays,
            approvedWindowDays,
            status,
          }),
        findUnique: async () =>
          activeRow({
            partnerId,
            platforms,
            proposedWindowDays,
            approvedWindowDays,
            status,
          }),
        update: async () =>
          activeRow({
            partnerId,
            platforms,
            proposedWindowDays,
            approvedWindowDays,
            status: 'ACTIVE',
          }),
      },
      partner: { findUnique: async () => ({ id: partnerId }) },
      adCampaign: {
        create: async () => ({ id: 'cmp1', name: 'x', status: 'ACTIVE', notes: null, createdBy: null, createdAt: new Date(), updatedAt: new Date() }),
        findUnique: async () => ({
          id: 'cmp1',
          name: 'x',
          status: 'ACTIVE',
          notes: null,
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          placements: [],
        }),
      },
      adPlacement: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          placements.push(args.data);
          return args.data;
        },
      },
    };

    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({
          id: 'r1',
          partnerId,
          platforms,
          channel: 'chan',
          notes: null,
          proposedWindowDays,
          approvedWindowDays,
          status: opts.initialStatus,
          reviewedBy: opts.initialStatus === 'COUNTERED' ? 'admin' : null,
        }),
        updateMany: tx.adPlacementRequest.updateMany,
        findUniqueOrThrow: tx.adPlacementRequest.findUniqueOrThrow,
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      _placements: placements,
      _claimCount: () => claimCount,
    } as unknown as PrismaService & {
      _placements: Array<Record<string, unknown>>;
      _claimCount: () => number;
    };
    return prisma;
  }

  it('approves as-is → ACTIVE and creates one placement per platform', async () => {
    const prisma = mockTxPrisma({ initialStatus: 'PENDING' });
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).approve('r1', 'admin', {});
    assert.equal(result.request.status, 'ACTIVE');
    assert.equal(prisma._placements.length, 2);
    assert.equal(prisma._placements[0].ownerType, 'PARTNER');
    assert.equal(prisma._placements[0].attributionWindowDays, 30);
  });

  it('counters with a different window → COUNTERED, no placements yet', async () => {
    let status = 'PENDING';
    const placements: unknown[] = [];
    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({
          id: 'r1',
          partnerId: 'p',
          platforms: ['TELEGRAM'],
          channel: null,
          notes: null,
          proposedWindowDays: 90,
          status,
          reviewedBy: null,
        }),
        updateMany: async (args: { where: { status?: string }; data: { status?: string } }) => {
          if (args.where.status !== status) return { count: 0 };
          status = args.data.status ?? status;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({
          id: 'r1',
          partnerId: 'p',
          platforms: ['TELEGRAM'],
          channel: null,
          notes: null,
          proposedWindowDays: 90,
          approvedWindowDays: 30,
          selfFundedBudgetNote: null,
          status: 'COUNTERED',
          reviewedBy: 'admin',
          reviewedAt: new Date(),
          campaignId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      adPlacement: {
        create: async () => {
          placements.push({});
          return {};
        },
      },
    } as unknown as PrismaService;
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).approve('r1', 'admin', { approvedWindowDays: 30 });
    assert.equal(result.request.status, 'COUNTERED');
    assert.equal(result.campaign, null);
    assert.equal(placements.length, 0);
  });

  // The operator's note used to be written into `notes` — the PARTNER's own
  // message — so a counter-offer erased the request it was answering. And the
  // partner was never told the status changed at all.
  it('keeps the partner message intact, stores the decision separately and notifies', async () => {
    moderationNotices.length = 0;
    let status = 'PENDING';
    let written: Record<string, unknown> | null = null;
    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({
          id: 'r1',
          partnerId: 'partner1',
          platforms: ['TELEGRAM'],
          channel: null,
          notes: 'my channel has 20k subscribers',
          proposedWindowDays: 90,
          status,
          reviewedBy: null,
        }),
        updateMany: async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
          if (args.where.status !== status) return { count: 0 };
          written = args.data;
          status = (args.data['status'] as string) ?? status;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({
          id: 'r1',
          partnerId: 'partner1',
          platforms: ['TELEGRAM'],
          channel: null,
          notes: 'my channel has 20k subscribers',
          proposedWindowDays: 90,
          approvedWindowDays: 30,
          selfFundedBudgetNote: null,
          reviewNotes: 'window shortened for a first run',
          status: 'COUNTERED',
          reviewedBy: 'admin',
          reviewedAt: new Date(),
          campaignId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      partner: { findUnique: async () => ({ userId: 'partner-user-1' }) },
    } as unknown as PrismaService;
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).approve(
      'r1',
      'admin',
      { approvedWindowDays: 30, notes: 'window shortened for a first run' },
    );
    assert.ok(written !== null);
    const data = written as unknown as Record<string, unknown>;
    assert.equal(data['reviewNotes'], 'window shortened for a first run');
    assert.equal(data['notes'], undefined, "the partner's own message must not be touched");
    assert.equal(result.request.notes, 'my channel has 20k subscribers');
    assert.deepEqual(
      moderationNotices.map((n) => n.type),
      ['advertising.request_countered'],
    );
    assert.equal(moderationNotices[0]?.payload['reviewNotes'], 'window shortened for a first run');
  });

  it('rejects with a reason and tells the partner', async () => {
    moderationNotices.length = 0;
    let status = 'PENDING';
    let written: Record<string, unknown> | null = null;
    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({ id: 'r1', partnerId: 'partner1', status, reviewedBy: null }),
        updateMany: async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
          if (args.where.status !== status) return { count: 0 };
          written = args.data;
          status = (args.data['status'] as string) ?? status;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({
          id: 'r1',
          partnerId: 'partner1',
          platforms: ['TELEGRAM'],
          channel: null,
          notes: null,
          proposedWindowDays: 30,
          approvedWindowDays: null,
          selfFundedBudgetNote: null,
          reviewNotes: 'channel audience does not match',
          status: 'REJECTED',
          reviewedBy: 'admin',
          reviewedAt: new Date(),
          campaignId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      partner: { findUnique: async () => ({ userId: 'partner-user-1' }) },
    } as unknown as PrismaService;
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).reject(
      'r1',
      'admin',
      'channel audience does not match',
    );
    assert.equal(result.status, 'REJECTED');
    assert.equal(
      (written as unknown as Record<string, unknown>)['reviewNotes'],
      'channel audience does not match',
    );
    assert.deepEqual(
      moderationNotices.map((n) => n.type),
      ['advertising.request_rejected'],
    );
  });

  it('accept from COUNTERED → ACTIVE with approved window', async () => {
    const prisma = mockTxPrisma({
      initialStatus: 'COUNTERED',
      platforms: ['TELEGRAM'],
      proposedWindowDays: 90,
      approvedWindowDays: 30,
    });
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).accept('r1', 'partner1');
    assert.equal(result.request.status, 'ACTIVE');
    assert.equal(prisma._placements.length, 1);
    assert.equal(prisma._placements[0].attributionWindowDays, 30);
    assert.equal(prisma._placements[0].ownerType, 'PARTNER');
  });

  it('accept wrong partner → not found', async () => {
    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({
          id: 'r1',
          partnerId: 'partner1',
          platforms: ['TELEGRAM'],
          status: 'COUNTERED',
          approvedWindowDays: 30,
          proposedWindowDays: 90,
        }),
      },
    } as unknown as PrismaService;
    const Svc = await load();
    await assert.rejects(() => new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub).accept('r1', 'other-partner'), /not found/i);
  });

  it('second concurrent accept claim loses → no duplicate placements', async () => {
    let status = 'COUNTERED';
    const placements: unknown[] = [];
    const tx = {
      adPlacementRequest: {
        updateMany: async (args: { where: { status?: string } }) => {
          if (args.where.status !== status) return { count: 0 };
          status = 'ACTIVE';
          return { count: 1 };
        },
        findUniqueOrThrow: async () => activeRow({ platforms: ['TELEGRAM'], status: 'ACTIVE' }),
        update: async () => activeRow({ platforms: ['TELEGRAM'], status: 'ACTIVE' }),
      },
      partner: { findUnique: async () => ({ id: 'partner1' }) },
      adCampaign: {
        create: async () => ({ id: 'cmp1' }),
        findUnique: async () => ({
          id: 'cmp1',
          name: 'x',
          status: 'ACTIVE',
          notes: null,
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          placements: [],
        }),
      },
      adPlacement: {
        findUnique: async () => null,
        create: async (args: { data: unknown }) => {
          placements.push(args.data);
          return args.data;
        },
      },
    };
    const prisma = {
      adPlacementRequest: {
        findUnique: async () => ({
          id: 'r1',
          partnerId: 'partner1',
          platforms: ['TELEGRAM'],
          status: 'COUNTERED',
          approvedWindowDays: 30,
          proposedWindowDays: 90,
          reviewedBy: 'admin',
        }),
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      partner: { findUnique: async () => ({ id: 'partner1' }) },
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config, reiwaAdvertisingLinks, notificationsStub);
    const first = await svc.accept('r1', 'partner1');
    assert.equal(first.request.status, 'ACTIVE');
    assert.equal(placements.length, 1);
    await assert.rejects(() => svc.accept('r1', 'partner1'), /not available for activation/i);
    assert.equal(placements.length, 1);
  });
});

describe('AdvertisingCampaignService spend / status', () => {
  async function load() {
    const mod = await import('../src/modules/advertising/services/advertising-campaign.service');
    return mod.AdvertisingCampaignService;
  }
  const config = {
    adminReiwaBotUsername: 'TestBot',
    miniAppShortName: null,
    webBaseUrl: 'https://app.example',
  } as never;

  // The tracking code is printed in live creatives. Deleting the row took the
  // code with it, so every later click on paid advertising was dropped as
  // "placement not found" — and the UI reported "archived" either way.
  it('deletePlacement never deletes, even for an untouched placement', async () => {
    let deleted = 0;
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      adPlacement: {
        findUnique: async () => ({ id: 'p1', status: 'ACTIVE' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return { id: 'p1' };
        },
        delete: async () => {
          deleted += 1;
          return { id: 'p1' };
        },
      },
    } as unknown as PrismaService;
    const Svc = await load();
    const result = await new Svc(prisma, config, reiwaAdvertisingLinks).deletePlacement('p1');
    assert.equal(deleted, 0, 'a tracking code in a paid creative must survive');
    assert.deepEqual(updates, [{ status: 'ARCHIVED' }]);
    assert.deepEqual(result, { archived: true }, 'the UI must not be told it deleted something');
  });

  it('createPlacement stores COMPANY spend and nulls PARTNER spend', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      adCampaign: { findUnique: async () => ({ id: 'c1' }) },
      partner: { findUnique: async () => ({ id: 'partner1' }) },
      adPlacement: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { ...args.data, id: `p${created.length}`, trackingCode: 'abc1234567', createdAt: new Date(), updatedAt: new Date(), promoCodeId: null, channel: null, partnerId: null, signupBonusType: 'NONE', signupBonus: null, status: 'ACTIVE' };
        },
      },
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config, reiwaAdvertisingLinks);

    const companyPlacement = await svc.createPlacement({
      campaignId: 'c1',
      platform: 'YOUTUBE',
      ownerType: 'COMPANY',
      attributionWindowDays: 30,
      spendAmountMinor: 300000,
      spendCurrency: 'rub',
    } as never);
    assert.equal(created[0].spendAmount, 300000);
    assert.equal(created[0].spendCurrency, 'RUB');
    assert.deepEqual(companyPlacement.links, {
      botStart: 'https://t.me/ReiwaBot?start=ad_abc1234567',
      miniAppStart: null,
      miniAppWeb: 'https://reiwa.example/?campaign=ad_abc1234567',
    });

    await svc.createPlacement({
      campaignId: 'c1',
      platform: 'TELEGRAM',
      ownerType: 'PARTNER',
      partnerId: 'partner1',
      attributionWindowDays: 30,
      spendAmountMinor: 999999,
      spendCurrency: 'USD',
    } as never);
    assert.equal(created[1].spendAmount, null);
    assert.equal(created[1].spendCurrency, null);
  });

  it('rejects a PARTNER placement when the partner is missing or unknown', async () => {
    const prisma = {
      adCampaign: { findUnique: async () => ({ id: 'c1' }) },
      partner: { findUnique: async () => null },
      adPlacement: { findUnique: async () => null, create: async () => ({}) },
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config, reiwaAdvertisingLinks);

    await assert.rejects(
      () =>
        svc.createPlacement({
          campaignId: 'c1',
          platform: 'TELEGRAM',
          ownerType: 'PARTNER',
          partnerId: 'unknown',
          attributionWindowDays: 30,
        } as never),
      /Partner not found/i,
    );
    await assert.rejects(
      () =>
        svc.createPlacement({
          campaignId: 'c1',
          platform: 'TELEGRAM',
          ownerType: 'PARTNER',
          attributionWindowDays: 30,
        } as never),
      /requires a partner/i,
    );
  });

  it('updatePlacement nulls PARTNER spend (even legacy non-null) and applies COMPANY spend/status', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      adPlacement: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === 'partner-p') {
            // Legacy bad row: PARTNER still holding a budget that must be scrubbed.
            return { id: 'partner-p', ownerType: 'PARTNER', campaignId: 'c1', platform: 'TELEGRAM', channel: null, partnerId: 'p1', trackingCode: 'codepart01', attributionWindowDays: 30, promoCodeId: null, spendAmount: 50000, spendCurrency: 'USD', signupBonusType: 'NONE', signupBonus: null, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
          }
          return { id: 'company-p', ownerType: 'COMPANY', campaignId: 'c1', platform: 'YOUTUBE', channel: 'x', partnerId: null, trackingCode: 'codecomp01', attributionWindowDays: 30, promoCodeId: null, spendAmount: 100, spendCurrency: 'RUB', signupBonusType: 'NONE', signupBonus: null, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: args.where.id, ...args.data });
          return {
            id: args.where.id,
            ownerType: args.where.id === 'partner-p' ? 'PARTNER' : 'COMPANY',
            campaignId: 'c1',
            platform: 'TELEGRAM',
            channel: args.data.channel ?? null,
            partnerId: null,
            trackingCode: 'code000001',
            attributionWindowDays: args.data.attributionWindowDays ?? 30,
            promoCodeId: null,
            spendAmount: args.data.spendAmount ?? null,
            spendCurrency: args.data.spendCurrency ?? null,
            signupBonusType: 'NONE',
            signupBonus: null,
            status: args.data.status ?? 'ACTIVE',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config, reiwaAdvertisingLinks);

    await svc.updatePlacement('partner-p', {
      spendAmountMinor: 99999,
      spendCurrency: 'EUR',
      status: 'PAUSED',
    } as never);
    const partnerUpdate = updates.find((u) => u.id === 'partner-p')!;
    assert.equal(partnerUpdate.spendAmount, null);
    assert.equal(partnerUpdate.spendCurrency, null);
    assert.equal(partnerUpdate.status, 'PAUSED');

    await svc.updatePlacement('company-p', {
      spendAmountMinor: 450000,
      spendCurrency: 'rub',
      status: 'PAUSED',
    } as never);
    const companyUpdate = updates.find((u) => u.id === 'company-p')!;
    assert.equal(companyUpdate.spendAmount, 450000);
    assert.equal(companyUpdate.spendCurrency, 'RUB');
    assert.equal(companyUpdate.status, 'PAUSED');
  });
});
