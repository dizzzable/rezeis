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

// Default fallback columns: a finite subscription with a plan snapshot that
// carries the plan id + a NO_RESET strategy (so only UNTIL_SUBSCRIPTION_END
// add-ons can be offered from the fallback baseline).
const defaultSubColumns: SubColumns = {
  trafficLimit: 100,
  deviceLimit: 3,
  expiresAt: new Date('2026-03-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'NO_RESET' },
};

function build(options: {
  status?: string | null; // null → subscription missing
  term?: Term | null;
  catalog?: CatalogAddOn[];
  enabledMonth?: boolean;
  sub?: Partial<SubColumns>;
  ownerUserId?: string; // the subscription's owner (default 'user-1')
  telegramUser?: { id: string } | null; // user.findFirst(byTelegramId) result
}) {
  const columns: SubColumns = { ...defaultSubColumns, ...options.sub };
  const ownerUserId = options.ownerUserId ?? 'user-1';
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
    user: {
      findFirst: async () =>
        options.telegramUser === undefined ? { id: ownerUserId } : options.telegramUser,
    },
    addOn: {
      findMany: async () => options.catalog ?? [],
    },
  };
  const Service = options.enabledMonth ? EnabledMonthEligibilityService : AddOnEligibilityService;
  return { service: new Service(prisma as never) };
}

const financeTerm: Term = {
  id: 'term-1',
  planId: 'plan-a',
  endsAt: new Date('2026-03-01T00:00:00.000Z'),
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
    assert.equal(traffic.eligibility.expiresAt, '2026-03-01T00:00:00.000Z');
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

  it('fallback offers UNTIL_NEXT_RESET when the snapshot strategy is MONTH and capability ENABLED', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({
      status: 'ACTIVE',
      term: null,
      catalog: [nextReset],
      enabledMonth: true,
      sub: { planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'MONTH' } },
    });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    assert.equal(result.addOns[0]!.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
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
    assert.equal(traffic.eligibility.expiresAt, '2026-03-01T00:00:00.000Z');
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

  it('offers UNTIL_NEXT_RESET with the next reset epoch as expiry when the capability is ENABLED', async () => {
    const nextReset: CatalogAddOn = { ...trafficAddOn, id: 'a-reset', lifetime: 'UNTIL_NEXT_RESET' };
    const { service } = build({ status: 'ACTIVE', term: financeTerm, catalog: [nextReset], enabledMonth: true });
    const result = await service.listForSubscription('sub-1');
    assert.equal(result.addOns.length, 1);
    const reset = result.addOns[0]!;
    assert.equal(reset.eligibility.explanationCode, 'ELIGIBLE_UNTIL_NEXT_RESET');
    // MONTH strategy → epoch ends at the first of the next UTC month after now.
    assert.ok(reset.eligibility.expiresAt.endsWith('T00:00:00.000Z'));
    assert.match(reset.eligibility.expiresAt, /-01T00:00:00\.000Z$/);
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
