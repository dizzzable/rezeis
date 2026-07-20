import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { AdConversionService } from '../src/modules/advertising/services/ad-conversion.service';
import { AdAttributionService } from '../src/modules/advertising/services/ad-attribution.service';
import { AdSignupBonusService } from '../src/modules/advertising/services/ad-signup-bonus.service';
import { AdMetricsService } from '../src/modules/advertising/services/ad-metrics.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import type { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

const DAY = 24 * 60 * 60 * 1000;

describe('AdConversionService.recordFirstPurchase', () => {
  function build(overrides: {
    acquisitionPlacementId: string | null;
    acquisitionAt: Date | null;
    windowDays?: number;
    createImpl?: () => Promise<unknown>;
  }) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      user: {
        findUnique: async () => ({
          acquisitionPlacementId: overrides.acquisitionPlacementId,
          acquisitionAt: overrides.acquisitionAt,
        }),
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
    } as unknown as PrismaService;
    return { service: new AdConversionService(prisma), created };
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
    await new AdConversionService(prisma).revertConversion('tx1');
    assert.equal(whereStatus, 'ATTRIBUTED');
  });
});

describe('AdAttributionService.recordClick', () => {
  function buildPrisma(opts: {
    placement: Record<string, unknown> | null;
    user?: { id: string } | null;
    updateCount?: number;
    onUpdateMany?: (args: unknown) => void;
  }) {
    return {
      adPlacement: { findUnique: async () => opts.placement },
      adClick: { create: async () => ({}) },
      user: {
        findUnique: async () => opts.user ?? null,
        updateMany: async (args: unknown) => {
          opts.onUpdateMany?.(args);
          return { count: opts.updateCount ?? 1 };
        },
      },
      partner: { findUnique: async () => ({ userId: 'partner-user', isActive: true }) },
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
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'COMPANY', partnerId: null, signupBonusType: 'NONE', signupBonus: null },
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

  it('attaches the partner chain for a PARTNER placement (self-guard ok)', async () => {
    let attached: { newUserId: string; referrerUserId: string } | null = null;
    const prisma = buildPrisma({
      placement: { id: 'p1', campaignId: 'c1', status: 'ACTIVE', ownerType: 'PARTNER', partnerId: 'partner1', signupBonusType: 'NONE', signupBonus: null },
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
      adClick: { count: async () => 100 },
      user: { findMany: async () => [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] },
      adConversion: {
        aggregate: async () => ({ _count: 15, _sum: { amount: 900000 } }), // 9000.00
        findMany: async () => [],
        findFirst: async () => ({ currency: 'RUB' }),
      },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma).getPlacementMetrics('p1');
    assert.equal(metrics.costMinor, 300000);
    assert.equal(metrics.revenueMinor, 900000);
    assert.equal(metrics.conversions, 15);
    assert.equal(metrics.cac, 20000); // 300000 / 15
    assert.equal(metrics.roas, 3); // 900000 / 300000
    assert.equal(metrics.roi, 2); // (900000-300000)/300000
  });

  it('uses partner commission as cost for a PARTNER placement', async () => {
    const prisma = {
      adPlacement: {
        findUnique: async () => ({ id: 'p1', ownerType: 'PARTNER', spendAmount: null, spendCurrency: null }),
      },
      adClick: { count: async () => 50 },
      user: { findMany: async () => [{ id: 'u1' }, { id: 'u2' }] },
      adConversion: {
        aggregate: async () => ({ _count: 2, _sum: { amount: 200000 } }),
        findMany: async () => [],
        findFirst: async () => ({ currency: 'RUB' }),
      },
      partnerTransaction: { aggregate: async () => ({ _sum: { earnedAmount: 50000 } }) },
    } as unknown as PrismaService;
    const metrics = await new AdMetricsService(prisma).getPlacementMetrics('p1');
    assert.equal(metrics.costMinor, 50000); // summed partner commission
    assert.equal(metrics.roas, 4); // 200000 / 50000
  });
});

describe('AdPlacementRequestService moderation', () => {
  // Lazy import to keep the heavier service out of the lighter test paths.
  async function load() {
    const mod = await import('../src/modules/advertising/services/ad-placement-request.service');
    return mod.AdPlacementRequestService;
  }
  const config = { botUsername: null, miniAppShortName: null, webBaseUrl: null } as never;

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
    const result = await new Svc(prisma, config).approve('r1', 'admin', {});
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
    const result = await new Svc(prisma, config).approve('r1', 'admin', { approvedWindowDays: 30 });
    assert.equal(result.request.status, 'COUNTERED');
    assert.equal(result.campaign, null);
    assert.equal(placements.length, 0);
  });

  it('accept from COUNTERED → ACTIVE with approved window', async () => {
    const prisma = mockTxPrisma({
      initialStatus: 'COUNTERED',
      platforms: ['TELEGRAM'],
      proposedWindowDays: 90,
      approvedWindowDays: 30,
    });
    const Svc = await load();
    const result = await new Svc(prisma, config).accept('r1', 'partner1');
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
    await assert.rejects(() => new Svc(prisma, config).accept('r1', 'other-partner'), /not found/i);
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
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config);
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
    botUsername: 'TestBot',
    miniAppShortName: null,
    webBaseUrl: 'https://app.example',
  } as never;

  it('createPlacement stores COMPANY spend and nulls PARTNER spend', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      adCampaign: { findUnique: async () => ({ id: 'c1' }) },
      adPlacement: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { ...args.data, id: `p${created.length}`, trackingCode: 'abc1234567', createdAt: new Date(), updatedAt: new Date(), promoCodeId: null, channel: null, partnerId: null, signupBonusType: 'NONE', signupBonus: null, status: 'ACTIVE' };
        },
      },
    } as unknown as PrismaService;
    const Svc = await load();
    const svc = new Svc(prisma, config);

    await svc.createPlacement({
      campaignId: 'c1',
      platform: 'YOUTUBE',
      ownerType: 'COMPANY',
      attributionWindowDays: 30,
      spendAmountMinor: 300000,
      spendCurrency: 'rub',
    } as never);
    assert.equal(created[0].spendAmount, 300000);
    assert.equal(created[0].spendCurrency, 'RUB');

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
    const svc = new Svc(prisma, config);

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
