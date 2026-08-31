import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
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
};

class EnabledMonthEligibilityService extends AddOnEligibilityService {
  protected getResetCapabilities(): ResetCapabilityMap {
    return { MONTH: 'ENABLED' };
  }
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
  const Service = options.enabledMonth ? EnabledMonthEligibilityService : AddOnEligibilityService;
  return { service: new Service(prisma as never, {} as never), stats };
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

  it('fallback withholds UNTIL_NEXT_RESET even when capability is ENABLED if the snapshot strategy is NO_RESET', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: null, catalog: [nextReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
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
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [trafficAddOn, deviceAddOn] });
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

  it('offers a device add-on with UNTIL_NEXT_RESET when the plan has a reset cycle and capability is ENABLED (device one-time-until-reset)', async () => {
    // A device add-on CAN be reset-scoped: the reset epoch is the profile's
    // monthly refresh boundary (extra devices are removed on it). Offered when
    // the strategy has a boundary (MONTH here) and the capability is ENABLED.
    const deviceReset: CatalogAddOn = { ...deviceAddOn, id: 'a-device-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [deviceReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    assert.equal(result.addOns[0]!.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
  });

  it('withholds a device add-on carrying UNTIL_NEXT_RESET when the plan is NO_RESET (no cycle to reset on)', async () => {
    const deviceReset: CatalogAddOn = { ...deviceAddOn, id: 'a-device-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const term: Term = { ...financeTerm, trafficResetStrategy: 'NO_RESET' };
    const { service } = build({ status: 'ACTIVE', term, catalog: [deviceReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
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

  it('withholds UNTIL_SUBSCRIPTION_END when the term is open-ended (no end date)', async () => {
    const term: Term = { ...financeTerm, endsAt: null };
    const { service } = build({ status: 'ACTIVE', term, catalog: [trafficAddOn] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
  });

  it('withholds UNTIL_NEXT_RESET while the reset capability is DISABLED (default)', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset] });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 0);
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
    delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
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

  it('offers UNTIL_NEXT_RESET with the next reset epoch as expiry when the capability is ENABLED', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    const reset = result.addOns[0]!;
    assert.equal(reset.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
    // MONTH strategy → epoch ends at the first of the next UTC month after now.
    // Asserted non-null first: `expiresAt` became nullable for `RESET_TRAFFIC`,
    // which grants nothing and so has no lifetime — a GRANT must still carry
    // one, and a null here would mean the lifetime resolver was skipped.
    const expiresAt = reset.eligibility.expiresAt;
    assert.ok(expiresAt !== null, 'a grant must carry an expiry');
    assert.ok(expiresAt.endsWith('T00:00:00.000Z'));
    assert.match(expiresAt, /-01T00:00:00\.000Z$/);
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
