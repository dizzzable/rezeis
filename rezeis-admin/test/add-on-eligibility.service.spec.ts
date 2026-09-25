import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { ResetCapabilityMap } from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

type CatalogAddOn = {
  id: string;
  revision: number;
  name: string;
  description: string | null;
  type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  icon: string | null;
  value: number;
  lifetime: 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';
  applicablePlanIds: string[];
  prices: Array<{ currency: string; price: string }>;
};

type Term = {
  id: string;
  planId: string | null;
  endsAt: Date | null;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  trafficResetStrategy: string;
  resetAnchorAt: Date | null;
};

type SubColumns = {
  trafficLimit: number | null;
  deviceLimit: number;
  expiresAt: Date | null;
  createdAt: Date;
  planSnapshot: unknown;
  /** The Remnawave profile's `createdAt` the panel stored (P2); absent = never heard. */
  remnawaveProfileCreatedAt?: Date | null;
};

class EnabledMonthEligibilityService extends AddOnEligibilityService {
  protected getResetCapabilities(): ResetCapabilityMap {
    return { MONTH: 'ENABLED' };
  }
}

class EnabledRollingEligibilityService extends AddOnEligibilityService {
  protected getResetCapabilities(): ResetCapabilityMap {
    return { MONTH_ROLLING: 'ENABLED' };
  }
}

/** «Докупка трафика до сброса» switched OFF — ON by default since 25.09.2026. */
class Stage4OffEligibilityService extends AddOnEligibilityService {
  protected getResetCapabilities(): ResetCapabilityMap {
    return {};
  }
}

/** A double of S4-sync's read-once helper: what it answers, and every call. */
function profileFactsDouble(answer: Date | null) {
  const calls: string[] = [];
  return {
    calls,
    readProfileCreatedAtOnce: async (subscriptionId: string) => {
      calls.push(subscriptionId);
      return answer;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The end of a term window that is still OPEN, expressed relative to the wall
 * clock rather than as a literal.
 *
 * `resolveAddOnLifetimeGrant` refuses an `UNTIL_SUBSCRIPTION_END` add-on whose
 * window has already closed — the intake
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`) requires
 * `endsAt > now` before it will bind the entitlement to that window and
 * otherwise falls through to the PERMANENT legacy increment, so an offer made
 * on a closed window sells a bounded good and delivers an unbounded one.
 *
 * These fixtures used to carry a literal `2026-03-01`, which described a live
 * subscription on the day they were written and a two-months-expired one
 * afterwards. Every "is it offered" assertion below therefore drifted into
 * asserting that an EXPIRED term still sells, without anyone editing them.
 * Anchoring the window to `Date.now()` is what stops that happening again.
 */
const LIVE_TERM_ENDS_AT = new Date(Date.now() + 60 * DAY_MS);

// Default fallback columns: a finite subscription with a plan snapshot that
// carries the plan id + a NO_RESET strategy (so only UNTIL_SUBSCRIPTION_END
// add-ons can be offered from the fallback baseline).
const defaultSubColumns: SubColumns = {
  trafficLimit: 100,
  deviceLimit: 3,
  expiresAt: LIVE_TERM_ENDS_AT,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'NO_RESET' },
};

/**
 * The projection row the previous recompute left behind. Its recorded
 * contribution is the only quantity that may be subtracted back out of the
 * mirrored limit columns before they are compared with the stored snapshot.
 */
type Projection = {
  activeTrafficContributionBytes: bigint;
  activeDeviceContribution: number;
};

function build(options: {
  status?: string | null; // null → subscription missing
  term?: Term | null;
  catalog?: CatalogAddOn[];
  enabledMonth?: boolean;
  sub?: Partial<SubColumns>;
  projection?: Projection | null; // null → no projection row yet
  ownerUserId?: string; // the subscription's owner (default 'user-1')
  telegramUser?: { id: string } | null; // user.findFirst(byTelegramId) result
  enabledRolling?: boolean; // «до сброса» on for MONTH_ROLLING only
  stage4Off?: boolean; // «Докупка трафика до сброса» switched off
  profileFacts?: ReturnType<typeof profileFactsDouble>;
}) {
  const columns: SubColumns = { ...defaultSubColumns, ...options.sub };
  const ownerUserId = options.ownerUserId ?? 'user-1';
  const stats = { projectionReads: 0 };
  const prisma = {
    subscription: {
      findUnique: async () =>
        options.status === null
          ? null
          : { id: 'sub-1', userId: ownerUserId, status: options.status ?? 'ACTIVE', ...columns },
    },
    subscriptionTerm: {
      findFirst: async () => options.term ?? null,
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => {
        stats.projectionReads += 1;
        return options.projection ?? null;
      },
    },
    user: {
      findFirst: async () =>
        options.telegramUser === undefined ? { id: ownerUserId } : options.telegramUser,
    },
    addOn: {
      findMany: async () => options.catalog ?? [],
    },
  };
  const Service = options.stage4Off
    ? Stage4OffEligibilityService
    : options.enabledRolling
      ? EnabledRollingEligibilityService
      : options.enabledMonth
        ? EnabledMonthEligibilityService
        : AddOnEligibilityService;
  return {
    service: new Service(prisma as never, {} as never, undefined, undefined, options.profileFacts as never),
    stats,
  };
}

const financeTerm: Term = {
  id: 'term-1',
  planId: 'plan-a',
  endsAt: LIVE_TERM_ENDS_AT,
  baseTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
  baseDeviceLimit: 3,
  trafficResetStrategy: 'MONTH',
  resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
};

const trafficAddOn: CatalogAddOn = {
  id: 'a-traffic',
  revision: 2,
  name: '50 GB',
  description: 'more traffic',
  type: 'EXTRA_TRAFFIC',
  icon: '📶',
  value: 50,
  lifetime: 'UNTIL_SUBSCRIPTION_END',
  applicablePlanIds: [],
  prices: [{ currency: 'USD', price: '2.00' }],
};

const deviceAddOn: CatalogAddOn = {
  id: 'a-device',
  revision: 1,
  name: '+1 device',
  description: null,
  type: 'EXTRA_DEVICES',
  icon: null,
  value: 1,
  lifetime: 'UNTIL_SUBSCRIPTION_END',
  applicablePlanIds: [],
  prices: [{ currency: 'USD', price: '1.00' }],
};

describe('AddOnEligibilityService.listForSubscription', () => {
  it('throws NotFound for a missing subscription', async () => {
    const { service } = build({ status: null });
    await assert.rejects(() => service.listForSubscription('sub-1'), (e: unknown) => e instanceof NotFoundException);
  });

  it('returns EMPTY for a non-active subscription', async () => {
    const { service } = build({ status: 'EXPIRED', term: financeTerm, catalog: [trafficAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.availability, 'EMPTY');
    assert.equal(result.target, null);
    assert.deepEqual(result.addOns, []);
  });

  it('falls back to the subscription baseline when there is no active term (finite → offered, termId empty)', async () => {
    const { service } = build({ status: 'ACTIVE', term: null, catalog: [trafficAddOn, deviceAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.availability, 'AVAILABLE');
    // planId comes from planSnapshot.id; termId is the empty sentinel.
    assert.deepEqual(result.target, { subscriptionId: 'sub-1', termId: '', planId: 'plan-a' });
    assert.equal(result.addOns.length, 2);
    const traffic = result.addOns.find((a) => a.id === 'a-traffic');
    assert.ok(traffic);
    // Fallback expiry = subscription.expiresAt (mirrors the term the cutover would create).
    assert.equal(traffic.eligibility.expiresAt, LIVE_TERM_ENDS_AT.toISOString());
    assert.equal(traffic.eligibility.explanationCode, 'ELIGIBLE_UNTIL_SUBSCRIPTION_END');
  });

  it('fallback withholds EXTRA_DEVICES when the subscription is unlimited devices (deviceLimit <= 0)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 0 },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
    assert.equal(result.availability, 'EMPTY');
  });

  it('fallback withholds EXTRA_TRAFFIC when the subscription has unlimited traffic (trafficLimit null)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [trafficAddOn],
      sub: { trafficLimit: null },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('fallback withholds UNTIL_SUBSCRIPTION_END when the subscription has no expiry (open-ended)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [trafficAddOn],
      sub: { expiresAt: null },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('fallback sells a NO_RESET plan\'s traffic «до конца подписки» once stage 4 is on, whatever the row says', async () => {
    // P12: a plan that never resets has no reset to end at, so its traffic
    // lasts until the subscription ends — the row's «до следующего сброса»
    // used to withhold it for good.
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: null, catalog: [nextReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    const offered = result.addOns[0]!;
    assert.equal(offered.lifetime, 'UNTIL_SUBSCRIPTION_END');
    assert.equal(offered.eligibility.expiresAt, LIVE_TERM_ENDS_AT.toISOString());
    assert.equal(offered.eligibility.endsBound, 'subscription_end');
    assert.equal(offered.eligibility.nextResetAt, null);
    assert.equal(offered.eligibility.resetSoon, false);
  });

  it('fallback withholds UNTIL_NEXT_RESET without a durable ACTIVE term even when capability is ENABLED', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [nextReset],
      enabledMonth: true,
      sub: { planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'MONTH' } },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
    assert.equal(result.availability, 'EMPTY');
  });

  it('fallback yields empty planId when the snapshot has no id (add-ons scoped to a plan are excluded)', async () => {
    const scoped: CatalogAddOn = { ...trafficAddOn, applicablePlanIds: ['plan-a'] };
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [scoped],
      sub: { planSnapshot: {} },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
    assert.equal(result.target?.planId, '');
  });

  it('offers a finite-baseline UNTIL_SUBSCRIPTION_END add-on with the term end as expiry', async () => {
    // Stage 4 off: with it on (the default) this traffic ends at the reset.
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn, deviceAddOn], stage4Off: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.availability, 'AVAILABLE');
    assert.deepEqual(result.target, { subscriptionId: 'sub-1', termId: 'term-1', planId: 'plan-a' });
    assert.equal(result.addOns.length, 2);
    const traffic = result.addOns.find((a) => a.id === 'a-traffic');
    assert.ok(traffic);
    assert.equal(traffic.revision, 2);
    assert.equal(traffic.icon, '📶');
    assert.equal(traffic.eligibility.activation, 'NOW');
    assert.equal(traffic.eligibility.expiresAt, LIVE_TERM_ENDS_AT.toISOString());
    assert.equal(traffic.eligibility.explanationCode, 'ELIGIBLE_UNTIL_SUBSCRIPTION_END');
    assert.deepEqual(traffic.prices, [{ currency: 'USD', price: '2.00' }]);
  });

  it('withholds EXTRA_TRAFFIC when the traffic baseline is unlimited', async () => {
    const term: Term = { ...financeTerm, baseTrafficLimitBytes: null };
    const { service } = build({ status: 'ACTIVE', term, catalog: [trafficAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.availability, 'EMPTY');
    assert.equal(result.addOns.length, 0);
  });

  it('withholds EXTRA_DEVICES when the device baseline is unlimited (null)', async () => {
    const term: Term = { ...financeTerm, baseDeviceLimit: null };
    const { service } = build({ status: 'ACTIVE', term, catalog: [deviceAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('offers a device add-on «до конца подписки» even when its row says UNTIL_NEXT_RESET and the plan resets', async () => {
    // P3: a device slot that ended at a traffic reset would be taken away at
    // every reset (with automatic cleanup, the newest device deleted). Devices
    // always last until the end of the subscription.
    const deviceReset: CatalogAddOn = { ...deviceAddOn, id: 'a-device-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [deviceReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    const offered = result.addOns[0]!;
    assert.equal(offered.lifetime, 'UNTIL_SUBSCRIPTION_END');
    assert.equal(offered.eligibility.explanationCode, 'ELIGIBLE_UNTIL_SUBSCRIPTION_END');
    assert.equal(offered.eligibility.expiresAt, LIVE_TERM_ENDS_AT.toISOString());
    assert.equal(offered.eligibility.endsBound, 'subscription_end');
    assert.equal(offered.eligibility.nextResetAt, null);
  });

  it('offers a device add-on «до конца подписки» on a NO_RESET plan too, whatever its row says', async () => {
    const deviceReset: CatalogAddOn = { ...deviceAddOn, id: 'a-device-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const term: Term = { ...financeTerm, trafficResetStrategy: 'NO_RESET' };
    const { service } = build({ status: 'ACTIVE', term, catalog: [deviceReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    assert.equal(result.addOns[0]!.lifetime, 'UNTIL_SUBSCRIPTION_END');
    assert.equal(result.addOns[0]!.eligibility.expiresAt, LIVE_TERM_ENDS_AT.toISOString());
  });

  it('withholds EXTRA_DEVICES when a persisted term stores a non-positive device baseline (0/negative = unlimited)', async () => {
    for (const bad of [0, -1]) {
      const term: Term = { ...financeTerm, baseDeviceLimit: bad };
      const { service } = build({ status: 'ACTIVE', term, catalog: [deviceAddOn] });
      const result = await service.listForSubscription('sub-1');
      assert.equal(result.addOns.length, 0, `deviceLimit ${bad} must be treated as unlimited`);
    }
  });

  it('withholds EXTRA_TRAFFIC when a persisted term stores a negative byte baseline (anomaly)', async () => {
    const term: Term = { ...financeTerm, baseTrafficLimitBytes: -1n };
    const { service } = build({ status: 'ACTIVE', term, catalog: [trafficAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('withholds UNTIL_NEXT_RESET (never throws) when an ENABLED boundary term has a null reset anchor', async () => {
    const term: Term = { ...financeTerm, resetAnchorAt: null };
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term, catalog: [nextReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  // ── P2 / W7 test 8, the offer's side: MONTH_ROLLING counts from the profile ─
  // Remnawave resets a MONTH_ROLLING profile at 00:10 UTC on the day of the
  // month it was created (`reset-schedule-parity.spec.ts`). The profile here
  // was created on a 10th, over a year ago, so its next reset is a 10th, 00:10
  // UTC — a date no other anchor this spec uses would give.
  const rollingTerm: Term = { ...financeTerm, trafficResetStrategy: 'MONTH_ROLLING', resetAnchorAt: null };
  const profileCreatedAt = new Date('2025-03-10T15:00:00.000Z');

  it('a MONTH_ROLLING term without an anchor: the offer reads the profile createdAt ONCE and sells «до сброса» from it', async () => {
    const facts = profileFactsDouble(profileCreatedAt);
    const { service } = build({
      status: 'ACTIVE',
      term: rollingTerm,
      catalog: [trafficAddOn],
      enabledRolling: true,
      profileFacts: facts,
    });
    const result = await service.listForSubscription('sub-1');
    assert.deepEqual(facts.calls, ['sub-1']);
    assert.equal(result.addOns.length, 1);
    const offered = result.addOns[0]!;
    assert.equal(offered.lifetime, 'UNTIL_NEXT_RESET');
    assert.equal(offered.eligibility.endsBound, 'reset');
    assert.match(offered.eligibility.nextResetAt ?? '', /-10T00:10:00\.000Z$/);
  });

  it('a MONTH_ROLLING term whose anchor stays unknown after the one read: traffic is withheld, never sold «до конца подписки»', async () => {
    const facts = profileFactsDouble(null);
    const { service } = build({
      status: 'ACTIVE',
      term: rollingTerm,
      catalog: [trafficAddOn, deviceAddOn],
      enabledRolling: true,
      profileFacts: facts,
    });
    const result = await service.listForSubscription('sub-1');
    assert.deepEqual(facts.calls, ['sub-1']);
    assert.deepEqual(
      result.addOns.map((addOn) => addOn.id),
      ['a-device'],
      'only the device add-on, which does not end at a reset',
    );
  });

  it('the profile createdAt the panel stored is used as it is, with no read', async () => {
    const facts = profileFactsDouble(null);
    const { service } = build({
      status: 'ACTIVE',
      term: rollingTerm,
      catalog: [trafficAddOn],
      enabledRolling: true,
      profileFacts: facts,
      sub: { remnawaveProfileCreatedAt: profileCreatedAt },
    });
    const result = await service.listForSubscription('sub-1');
    assert.deepEqual(facts.calls, []);
    assert.equal(result.addOns.length, 1);
    assert.match(result.addOns[0]!.eligibility.nextResetAt ?? '', /-10T00:10:00\.000Z$/);
  });

  it('reads nothing when the read would decide nothing', async () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly options: Parameters<typeof build>[0] }> = [
      {
        name: 'the term already carries its anchor',
        options: { term: { ...rollingTerm, resetAnchorAt: profileCreatedAt }, catalog: [trafficAddOn], enabledRolling: true },
      },
      { name: 'only devices on sale', options: { term: rollingTerm, catalog: [deviceAddOn], enabledRolling: true } },
      {
        name: 'traffic on sale for another plan only',
        options: {
          term: rollingTerm,
          catalog: [{ ...trafficAddOn, applicablePlanIds: ['plan-z'] }],
          enabledRolling: true,
        },
      },
      { name: '«до сброса» not sold for MONTH_ROLLING', options: { term: rollingTerm, catalog: [trafficAddOn], enabledMonth: true } },
      { name: 'a calendar strategy', options: { term: financeTerm, catalog: [trafficAddOn], enabledRolling: true } },
      {
        name: 'a calendar term without an anchor',
        options: { term: { ...financeTerm, resetAnchorAt: null }, catalog: [trafficAddOn], enabledRolling: true },
      },
      {
        // The no-term fallback withholds «до сброса» anyway: there is no term
        // to bind its reset to.
        name: 'no durable term yet',
        options: {
          term: null,
          catalog: [trafficAddOn],
          enabledRolling: true,
          sub: { planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'MONTH_ROLLING' } },
        },
      },
    ];
    for (const { name, options } of cases) {
      const facts = profileFactsDouble(profileCreatedAt);
      const { service } = build({ status: 'ACTIVE', ...options, profileFacts: facts });
      const result = await service.listForSubscription('sub-1');
      assert.deepEqual(facts.calls, [], name);
      if (name === 'the term already carries its anchor') {
        assert.match(result.addOns[0]?.eligibility.nextResetAt ?? '', /-10T00:10:00\.000Z$/, name);
      }
    }
  });

  it('withholds UNTIL_SUBSCRIPTION_END when the term is open-ended (no end date)', async () => {
    const term: Term = { ...financeTerm, endsAt: null };
    const { service } = build({ status: 'ACTIVE', term, catalog: [trafficAddOn], stage4Off: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('withholds UNTIL_NEXT_RESET while the reset capability is DISABLED (stage 4 switched off)', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset], stage4Off: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('sells traffic «до сброса» by default: nothing set on the page or in .env (production seam, since 25.09.2026)', async () => {
    const saved = new Map(
      ['ADDON_RESET_EXPIRY_DAY', 'ADDON_RESET_EXPIRY_WEEK', 'ADDON_RESET_EXPIRY_MONTH', 'ADDON_RESET_EXPIRY_MONTH_ROLLING', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'].map(
        (name) => [name, process.env[name]] as const,
      ),
    );
    for (const name of saved.keys()) delete process.env[name];
    try {
      const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn] });
      const result = await service.listForSubscription('sub-1');
      assert.equal(result.addOns.length, 1);
      assert.equal(result.addOns[0]!.lifetime, 'UNTIL_NEXT_RESET');
      assert.equal(result.addOns[0]!.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // ── Cross-flag offer↔fulfillment guard (production getResetCapabilities seam) ─
  // The real seam reads the rollout env: a reset-scoped add-on may only be
  // OFFERED when directPurchase is ON (the intake that honors the reset-epoch
  // expiry). Reset flag ON + directPurchase OFF must WITHHOLD the offer, else
  // eligibility advertises a one-time-until-reset service that the money path
  // (permanent legacy increment) would deliver forever. Uses the un-subclassed
  // base service so the production `getResetCapabilities()` runs against env.
  it('withholds UNTIL_NEXT_RESET when reset capability is ENABLED but directPurchase is OFF (offer cannot be fulfilled)', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset] });
    const prevReset = process.env.ADDON_RESET_EXPIRY_MONTH;
    const prevDirect = process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
    process.env.ADDON_RESET_EXPIRY_MONTH = 'true';
    // Explicitly OFF: unset is ON since the 24.09.2026 flip.
    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'false';
    try {
      const result = await service.listForSubscription('sub-1');
      assert.equal(result.addOns.length, 0, 'reset-scoped add-on is withheld when directPurchase is OFF');
      assert.equal(result.availability, 'EMPTY');
    } finally {
      if (prevReset === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH;
      else process.env.ADDON_RESET_EXPIRY_MONTH = prevReset;
      if (prevDirect === undefined) delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
      else process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = prevDirect;
    }
  });

  it('offers UNTIL_NEXT_RESET (production seam) when BOTH reset capability and directPurchase are ON', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset] });
    const prevReset = process.env.ADDON_RESET_EXPIRY_MONTH;
    const prevDirect = process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
    process.env.ADDON_RESET_EXPIRY_MONTH = 'true';
    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'true';
    try {
      const result = await service.listForSubscription('sub-1');
      assert.equal(result.addOns.length, 1, 'both flags on → reset-scoped add-on is offered');
      assert.equal(result.addOns[0]!.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
    } finally {
      if (prevReset === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH;
      else process.env.ADDON_RESET_EXPIRY_MONTH = prevReset;
      if (prevDirect === undefined) delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
      else process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = prevDirect;
    }
  });

  it('offers traffic until Remnawave\'s next reset, taken off half an hour after it, when the capability is ENABLED', async () => {
    // The row says «до конца подписки»: with stage 4 on, traffic on a plan
    // that resets is sold until the reset whatever the row says (P12).
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    const reset = result.addOns[0]!;
    assert.equal(reset.lifetime, 'UNTIL_NEXT_RESET');
    assert.equal(reset.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
    assert.equal(reset.eligibility.endsBound, 'reset');
    // MONTH → Remnawave resets on the 1st at 00:20 (UTC here), and the panel
    // takes the add-on off at 00:50. Asserted non-null first: `expiresAt`
    // became nullable for `RESET_TRAFFIC`, which grants nothing and so has no
    // lifetime — a GRANT must still carry one.
    const expiresAt = reset.eligibility.expiresAt;
    const nextResetAt = reset.eligibility.nextResetAt;
    assert.ok(expiresAt !== null, 'a grant must carry an expiry');
    assert.ok(nextResetAt !== null, 'a reset add-on names its reset');
    assert.match(nextResetAt, /-01T00:20:00\.000Z$/);
    assert.equal(Date.parse(expiresAt) - Date.parse(nextResetAt), 30 * 60 * 1000);
    assert.equal(reset.eligibility.resetSoon, Date.parse(nextResetAt) - Date.now() < DAY_MS);
  });

  it('ends a reset add-on at the subscription\'s end when that comes first, and says so', async () => {
    // P5. The subscription ends in two hours; the MONTH reset is on the 1st.
    const endsSoon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { service } = build({
      status: 'ACTIVE',
      term: { ...financeTerm, endsAt: endsSoon },
      catalog: [trafficAddOn],
      enabledMonth: true,
      sub: { expiresAt: endsSoon },
    });
    const result = await service.listForSubscription('sub-1');
    const offered = result.addOns[0]!;
    const nextResetAt = offered.eligibility.nextResetAt;
    assert.ok(nextResetAt !== null);
    if (Date.parse(nextResetAt) + 30 * 60 * 1000 > endsSoon.getTime()) {
      assert.equal(offered.eligibility.expiresAt, endsSoon.toISOString());
      assert.equal(offered.eligibility.endsBound, 'subscription_end');
      assert.equal(offered.eligibility.explanationCode, 'ELIGIBLE_UNTIL_SUBSCRIPTION_END_BEFORE_RESET');
      assert.equal(offered.eligibility.resetSoon, false, 'the reset does not end it, so it warns of nothing');
    } else {
      // Only in the last hours before a 1st, 00:50: the reset comes first.
      assert.equal(offered.eligibility.endsBound, 'reset');
    }
  });

  it('warns before payment when the reset that ends the add-on is less than a day away (DAY: always)', async () => {
    class EnabledDayEligibilityService extends AddOnEligibilityService {
      protected getResetCapabilities(): ResetCapabilityMap {
        return { DAY: 'ENABLED' };
      }
    }
    const prisma = {
      subscription: {
        findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...defaultSubColumns }),
      },
      subscriptionTerm: { findFirst: async () => ({ ...financeTerm, trafficResetStrategy: 'DAY' }) },
      subscriptionEffectiveProjection: { findUnique: async () => null },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      addOn: { findMany: async () => [trafficAddOn] },
    };
    const result = await new EnabledDayEligibilityService(prisma as never, {} as never).listForSubscription('sub-1');
    const offered = result.addOns[0]!;
    assert.equal(offered.eligibility.endsBound, 'reset');
    assert.match(offered.eligibility.nextResetAt ?? '', /T00:05:00\.000Z$/);
    assert.equal(offered.eligibility.resetSoon, true);
  });

  it('does not warn of a reset that does not end the add-on: a DAY add-on the subscription\'s end cuts short', async () => {
    class EnabledDayEligibilityService extends AddOnEligibilityService {
      protected getResetCapabilities(): ResetCapabilityMap {
        return { DAY: 'ENABLED' };
      }
    }
    // Ends before the next 00:05 (UTC) whatever the hour: a minute from now.
    const endsFirst = new Date(Date.now() + 60 * 1000);
    const prisma = {
      subscription: {
        findUnique: async () => ({
          id: 'sub-1',
          userId: 'user-1',
          status: 'ACTIVE',
          ...defaultSubColumns,
          expiresAt: endsFirst,
        }),
      },
      subscriptionTerm: {
        findFirst: async () => ({ ...financeTerm, trafficResetStrategy: 'DAY', endsAt: endsFirst }),
      },
      subscriptionEffectiveProjection: { findUnique: async () => null },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      addOn: { findMany: async () => [trafficAddOn] },
    };
    const result = await new EnabledDayEligibilityService(prisma as never, {} as never).listForSubscription('sub-1');
    const offered = result.addOns[0]!;
    assert.equal(offered.eligibility.endsBound, 'subscription_end');
    assert.ok(offered.eligibility.nextResetAt !== null, 'the reset is still named');
    assert.equal(offered.eligibility.resetSoon, false);
  });

  it('computes the reset in «Часовой пояс Remnawave» and names the operator\'s display zone', async () => {
    const prisma = {
      subscription: {
        findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...defaultSubColumns }),
      },
      subscriptionTerm: { findFirst: async () => financeTerm },
      subscriptionEffectiveProjection: { findUnique: async () => null },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      addOn: { findMany: async () => [trafficAddOn] },
    };
    const switches = {
      flags: async () => ({ ...resolveAddOnRolloutFlags({}, {}), remnawaveTimeZone: 'Europe/Moscow' }),
    };
    const settings = { getPlatformBranding: async () => ({ timezone: 'Asia/Yekaterinburg' }) };
    const result = await new EnabledMonthEligibilityService(
      prisma as never,
      {} as never,
      switches as never,
      settings as never,
    ).listForSubscription('sub-1');
    // The 1st, 00:20 by Moscow is 21:20 UTC on the last day of the month before.
    const nextResetAt = result.addOns[0]!.eligibility.nextResetAt ?? '';
    assert.match(nextResetAt, /T21:20:00\.000Z$/);
    const day = new Date(Date.parse(nextResetAt) + 3 * 60 * 60 * 1000).getUTCDate();
    assert.equal(day, 1, 'the 1st by Moscow');
    assert.equal(result.displayTimeZone, 'Asia/Yekaterinburg');
  });

  it('sends no display zone when none is set or the settings cannot be read (the dates are then UTC)', async () => {
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn] });
    assert.equal((await service.listForSubscription('sub-1')).displayTimeZone, null);
    const prisma = {
      subscription: {
        findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...defaultSubColumns }),
      },
      subscriptionTerm: { findFirst: async () => financeTerm },
      subscriptionEffectiveProjection: { findUnique: async () => null },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      addOn: { findMany: async () => [trafficAddOn] },
    };
    const broken = { getPlatformBranding: async () => Promise.reject(new Error('settings row unreadable')) };
    const result = await new AddOnEligibilityService(prisma as never, {} as never, undefined, broken as never)
      .listForSubscription('sub-1');
    assert.equal(result.displayTimeZone, null);
    assert.equal(result.addOns.length, 1, 'the listing itself does not fail');
  });

  it('respects plan applicability (excludes add-ons scoped to other plans)', async () => {
    const otherPlan: CatalogAddOn = { ...trafficAddOn, id: 'a-other', applicablePlanIds: ['plan-z'] };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [otherPlan] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  // ── Ownership scoping (IDOR guard) ─────────────────────────────────────────
  it('returns the catalog when the owner userId matches', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      ownerUserId: 'user-1',
    });
    const result = await service.listForSubscription('sub-1', { userId: 'user-1' });
    assert.equal(result.availability, 'AVAILABLE');
  });

  it('throws NotFound when the caller userId does not own the subscription', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      ownerUserId: 'user-1',
    });
    await assert.rejects(
      () => service.listForSubscription('sub-1', { userId: 'intruder' }),
      (e: unknown) => e instanceof NotFoundException,
    );
  });

  it('resolves ownership by telegramId and throws NotFound when no user matches', async () => {
    const ok = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      ownerUserId: 'user-1',
      telegramUser: { id: 'user-1' },
    });
    const result = await ok.service.listForSubscription('sub-1', { telegramId: '42' });
    assert.equal(result.availability, 'AVAILABLE');

    const missing = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      ownerUserId: 'user-1',
      telegramUser: null,
    });
    await assert.rejects(
      () => missing.service.listForSubscription('sub-1', { telegramId: '999' }),
      (e: unknown) => e instanceof NotFoundException,
    );
  });

  it('throws NotFound (fail-closed) for an empty identity object and a non-numeric telegramId', async () => {
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn] });
    await assert.rejects(
      () => service.listForSubscription('sub-1', {}),
      (e: unknown) => e instanceof NotFoundException,
    );
    await assert.rejects(
      () => service.listForSubscription('sub-1', { telegramId: 'not-a-number' }),
      (e: unknown) => e instanceof NotFoundException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The offer and the fulfillment must agree about what "unlimited" means
// ─────────────────────────────────────────────────────────────────────────────
//
// A term is minted from the plan and never mutated, while an operator can
// configure ONE customer from the admin Users page afterwards and that value is
// preserved rather than reset. Judging the offer against the term alone
// therefore sells an add-on that changes nothing: unlimited is ABSORBING, so the
// projection's `addDeviceLimit(null, …)` / `addTrafficLimit(null, …)` swallow
// the whole contribution while the term's finite number still reads as
// extendable.
//
// Both directions are pinned deliberately. Refusing every overridden field would
// be just as wrong — it would freeze a paid upgrade out — so each "withholds"
// test has a matching "still offers" test that fails if the override test is
// inverted, and an unreadable snapshot gets its own, because UNDECIDABLE
// resolves toward the PLAN and not toward the column.
describe('AddOnEligibilityService — an individually-configured limit decides the offer', () => {
  /** A stored snapshot carrying all four inherited keys, i.e. a DECIDABLE one. */
  function decidableSnapshot(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'plan-a',
      trafficLimitStrategy: 'NO_RESET',
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      ...patch,
    };
  }

  /** A snapshot an import left behind: readable, but carrying no limit keys. */
  const unreadableLimits = { id: 'plan-a', trafficLimitStrategy: 'NO_RESET' };

  const ids = (result: { readonly addOns: readonly { readonly id: string }[] }): string[] =>
    result.addOns.map((addOn) => addOn.id);

  // ── OVERRIDDEN toward unlimited → the add-on is refused ────────────────────

  it('withholds EXTRA_DEVICES when the operator granted unlimited devices while the term still says 3', async () => {
    const { service, stats } = build({
      status: 'ACTIVE',
      term: financeTerm, // baseDeviceLimit 3 — what the customer BOUGHT
      catalog: [trafficAddOn, deviceAddOn],
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot() },
    });

    const result = await service.listForSubscription('sub-1');

    // Only the DEVICE add-on is withheld. Asserting the surviving traffic offer
    // keeps this from passing for the wrong reason — a blanket EMPTY would
    // satisfy a bare length check just as well.
    assert.deepEqual(ids(result), ['a-traffic']);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(stats.projectionReads, 1, 'the recorded add-on contribution must actually be read');
  });

  it('withholds EXTRA_TRAFFIC when the operator granted unlimited traffic while the term still says 100 GiB', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm, // baseTrafficLimitBytes 100 GiB
      catalog: [trafficAddOn, deviceAddOn],
      sub: { trafficLimit: null, planSnapshot: decidableSnapshot() },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-device']);
  });

  // ── INHERITED → the term the customer paid for still governs ───────────────

  it('still offers EXTRA_DEVICES when an unlimited column is merely what the plan gave (INHERITED)', async () => {
    // Column 0 AND snapshot 0: nobody adjusted this row, so the term governs and
    // the add-on really does land on top of it. Reading this as an override
    // would refuse an upgrade the customer is already paying for.
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot({ deviceLimit: 0 }) },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-device']);
  });

  it('still offers EXTRA_TRAFFIC when an unlimited column is merely what the plan gave (INHERITED)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      sub: { trafficLimit: null, planSnapshot: decidableSnapshot({ trafficLimit: null }) },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-traffic']);
  });

  it('still offers EXTRA_DEVICES when the operator RAISED a finite limit (an override is not a refusal)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 12, planSnapshot: decidableSnapshot() },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-device']);
  });

  it('still offers EXTRA_TRAFFIC when the operator RAISED a finite limit (an override is not a refusal)', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      sub: { trafficLimit: 250, planSnapshot: decidableSnapshot() },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-traffic']);
  });

  // ── UNDECIDABLE is not OVERRIDDEN ──────────────────────────────────────────

  it('leaves the term baseline in force for an unreadable snapshot, so an imported row is still offered devices', async () => {
    // Imported/legacy rows carry a snapshot with none of the four limit keys.
    // That is UNDECIDABLE and it resolves toward the PLAN; collapsing it into
    // OVERRIDDEN would refuse a paid upgrade on the strength of a column nobody
    // can attribute to an operator.
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 0, planSnapshot: unreadableLimits },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-device']);
  });

  it('leaves the term baseline in force for an unreadable snapshot, so an imported row is still offered traffic', async () => {
    const { service } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [trafficAddOn],
      sub: { trafficLimit: null, planSnapshot: unreadableLimits },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-traffic']);
  });

  // ── The inputs are the projection's, not a convenient stand-in ─────────────

  it('reads the projection’s recorded contribution instead of assuming zero', async () => {
    // Column 8 = plan 3 + a live +5 device add-on; the columns were mirrored
    // from that projection row, so its 5 is the only quantity that may be taken
    // back out before the comparison. It cannot change TODAY's answer —
    // unlimited-ness survives no subtraction, and this offer is the only thing
    // eligibility derives from the baseline — so what is pinned here is the READ
    // itself: substituting a hard 0 would be a second, divergent derivation of a
    // baseline the projection also computes, and the two would part company the
    // day eligibility starts using the number.
    const { service, stats } = build({
      status: 'ACTIVE',
      term: financeTerm,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 8, planSnapshot: decidableSnapshot() },
      projection: { activeTrafficContributionBytes: 0n, activeDeviceContribution: 5 },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), ['a-device']);
    assert.equal(stats.projectionReads, 1, 'a hard 0 in place of the row is a second derivation');
  });

  // ── The fallback path already reads the operator's own columns ─────────────

  it('reads no projection row on the no-term fallback, where the columns ARE the baseline', async () => {
    const { service, stats } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [deviceAddOn],
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot() },
    });

    const result = await service.listForSubscription('sub-1');

    assert.deepEqual(ids(result), []);
    assert.equal(stats.projectionReads, 0, 'the pre-cutover path must not pay for a query it cannot use');
  });
});
