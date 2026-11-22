import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability, PlanType, SubscriptionStatus, TrafficLimitStrategy } from '@prisma/client';

import {
  BUNDLE_GRANT_KEY,
  BUNDLE_RENEWAL_KEY,
  bundleVisiblePlanId,
  findBundleMemberPlan,
  findBundleSoldAs,
  findBundleSoldForMarker,
  liveBundleSubscriptions,
  readBundleGrant,
  readBundleMarker,
  readBundleRenewal,
  withBundleMarker,
} from '../src/modules/merge-links/utils/bundle-snapshot.util';

/**
 * THE CONTRACT OF A MERGED TARIFF
 * ───────────────────────────────
 * A bundle is sold as ONE product over several subscriptions. The two keys
 * written into every subscription it mints, and the provenance a payment keeps
 * of what it bought and renewed, are what make that true — every reader of them
 * lives in a different module (fulfilment, quoting, autopay, refunds), so the
 * shapes are pinned here once.
 */

const MEMBER_LIMITED = {
  id: 'plan-limited',
  name: 'Лимитка',
  description: '50 ГБ',
  tag: 'FEATURED' as never,
  icon: 'gauge',
  type: PlanType.BOTH,
  availability: PlanAvailability.ALL,
  trafficLimit: 50,
  trafficLimitStrategy: TrafficLimitStrategy.MONTH,
  deviceLimit: 1,
  internalSquads: ['squad-limited'],
  externalSquad: null,
  orderIndex: 1,
};

const MEMBER_UNLIMITED = {
  id: 'plan-unlimited',
  name: 'Безлимит',
  description: null,
  tag: null,
  icon: null,
  type: PlanType.BOTH,
  availability: PlanAvailability.ALL,
  trafficLimit: null,
  trafficLimitStrategy: TrafficLimitStrategy.NO_RESET,
  deviceLimit: 3,
  internalSquads: ['squad-unlimited'],
  externalSquad: 'external-1',
  orderIndex: 2,
};

const BUNDLE_ROW = {
  id: 'bundle-1',
  name: 'Объеденёнка',
  description: 'оба тарифа',
  isActive: true,
  planId: 'plan-merged',
  members: [
    // Deliberately out of display order to prove the reader sorts them.
    { planId: MEMBER_UNLIMITED.id, isVisibleInApp: false, plan: MEMBER_UNLIMITED },
    { planId: MEMBER_LIMITED.id, isVisibleInApp: false, plan: MEMBER_LIMITED },
  ],
};

describe('bundle marker', () => {
  it('writes and reads the two keys, leaving the member plan untouched', () => {
    const snapshot = withBundleMarker({ id: 'plan-limited', trafficLimit: 50 }, {
      bundleId: 'bundle-1',
      bundlePlanId: 'plan-merged',
    });

    assert.equal(snapshot['id'], 'plan-limited');
    assert.deepStrictEqual(readBundleMarker(snapshot), {
      bundleId: 'bundle-1',
      bundlePlanId: 'plan-merged',
    });
  });

  it('answers null for an ordinary subscription, an unreadable one, or half a marker', () => {
    assert.equal(readBundleMarker({ id: 'plan-1' }), null);
    assert.equal(readBundleMarker(null), null);
    assert.equal(readBundleMarker('nope'), null);
    assert.equal(readBundleMarker([1, 2]), null);
    assert.equal(readBundleMarker({ bundleId: 'bundle-1' }), null);
    assert.equal(readBundleMarker({ bundlePlanId: 'plan-merged' }), null);
    assert.equal(readBundleMarker({ bundleId: '', bundlePlanId: 'plan-merged' }), null);
  });
});

describe('findBundleSoldAs / findSoldBundleForMarker', () => {
  it('finds the bundle by its own plan row, in display order, and answers null for an ordinary plan', async () => {
    const asks: unknown[] = [];
    const client = {
      planBundle: {
        findFirst: async (args: unknown) => {
          asks.push((args as { where: unknown }).where);
          return BUNDLE_ROW as never;
        },
      },
    };

    const bundle = await findBundleSoldAs(client as never, 'plan-merged');
    assert.deepStrictEqual(asks, [{ planId: 'plan-merged' }]);
    assert.equal(bundle?.id, 'bundle-1');
    assert.equal(bundle?.planId, 'plan-merged');
    // Display order: the limited member was declared second and comes first.
    assert.deepStrictEqual(
      bundle?.members.map((member) => member.planId),
      ['plan-limited', 'plan-unlimited'],
    );

    await findBundleSoldAs(
      { planBundle: { findFirst: async () => null } } as never,
      'plan-ordinary',
    );
  });

  it('treats a bundle without its own plan row as not sold', async () => {
    const bundle = await findBundleSoldAs(
      { planBundle: { findFirst: async () => ({ ...BUNDLE_ROW, planId: null }) } } as never,
      'plan-merged',
    );
    assert.equal(bundle, null);
  });

  it('reads a marker only while the grouping is still on sale and still owns that plan', async () => {
    let where: unknown;
    const client = {
      planBundle: {
        findFirst: async (args: unknown) => {
          where = (args as { where: unknown }).where;
          return BUNDLE_ROW as never;
        },
      },
    };

    const bundle = await findBundleSoldForMarker(client as never, {
      bundleId: 'bundle-1',
      bundlePlanId: 'plan-merged',
    });
    assert.deepStrictEqual(where, {
      id: 'bundle-1',
      planId: 'plan-merged',
      isActive: true,
    });
    assert.equal(bundle?.id, 'bundle-1');

    const gone = await findBundleSoldForMarker(
      { planBundle: { findFirst: async () => null } } as never,
      { bundleId: 'bundle-1', bundlePlanId: 'plan-merged' },
    );
    assert.equal(gone, null);
  });
});

describe('bundleVisiblePlanId / findBundleMemberPlan', () => {
  it('faces the LIMITED member even when the operator pinned the unlimited one', () => {
    // The owner's rule (14.11.2026): an app that reads «unlimited» hides the
    // limit the customer has to watch, so the unlimited plan is never the face.
    const bundle = {
      id: 'bundle-1',
      name: 'Объеденёнка',
      description: null,
      isActive: true,
      planId: 'plan-merged',
      members: [
        { planId: MEMBER_UNLIMITED.id, isVisibleInApp: true, plan: { ...MEMBER_UNLIMITED, orderIndex: 1 } },
        { planId: MEMBER_LIMITED.id, isVisibleInApp: false, plan: { ...MEMBER_LIMITED, orderIndex: 2 } },
      ],
    };
    assert.equal(bundleVisiblePlanId(bundle), MEMBER_LIMITED.id);
    assert.equal(findBundleMemberPlan(bundle, MEMBER_UNLIMITED.id)?.id, MEMBER_UNLIMITED.id);
    assert.equal(findBundleMemberPlan(bundle, 'plan-outsider'), null);
  });

  it('honours an explicit visible member when it still has a limit, and falls back to the first member', () => {
    const pinned = {
      id: 'bundle-2',
      name: 'b',
      description: null,
      isActive: true,
      planId: 'plan-merged-2',
      members: [
        { planId: MEMBER_LIMITED.id, isVisibleInApp: true, plan: { ...MEMBER_LIMITED, orderIndex: 1 } },
        { planId: MEMBER_UNLIMITED.id, isVisibleInApp: false, plan: { ...MEMBER_UNLIMITED, orderIndex: 2 } },
      ],
    };
    assert.equal(bundleVisiblePlanId(pinned), MEMBER_LIMITED.id);

    const allUnlimited = {
      ...pinned,
      members: [
        { planId: MEMBER_UNLIMITED.id, isVisibleInApp: false, plan: { ...MEMBER_UNLIMITED, orderIndex: 2 } },
      ],
    };
    assert.equal(bundleVisiblePlanId(allUnlimited), MEMBER_UNLIMITED.id);
    assert.equal(bundleVisiblePlanId({ ...pinned, members: [] }), null);
  });
});

describe('liveBundleSubscriptions', () => {
  it('reads the customer’s live profiles of ONE bundle, by marker and never by plan', async () => {
    let where: unknown;
    let orderBy: unknown;
    const client = {
      subscription: {
        findMany: async (args: { where: unknown; orderBy: unknown }) => {
          where = args.where;
          orderBy = args.orderBy;
          return [];
        },
      },
    };

    await liveBundleSubscriptions(client as never, 'user-1', 'bundle-1');
    assert.deepStrictEqual(where, {
      userId: 'user-1',
      status: { not: SubscriptionStatus.DELETED },
      planSnapshot: { path: ['bundleId'], equals: 'bundle-1' },
    });
    assert.deepStrictEqual(orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('payment provenance', () => {
  it('reads which profiles a merged PURCHASE created', () => {
    const gatewayData = {
      [BUNDLE_GRANT_KEY]: {
        bundleId: 'bundle-1',
        bundleName: 'Объеденёнка',
        bundlePlanId: 'plan-merged',
        subscriptionIds: ['sub-a', 'sub-b'],
        at: '2026-11-14T00:00:00.000Z',
      },
    };
    assert.deepStrictEqual(readBundleGrant(gatewayData), {
      bundleId: 'bundle-1',
      subscriptionIds: ['sub-a', 'sub-b'],
    });
    assert.equal(readBundleGrant({}), null);
    assert.equal(readBundleGrant(null), null);
    assert.equal(readBundleGrant({ [BUNDLE_GRANT_KEY]: { bundleId: 'bundle-1' } }), null);
    assert.equal(
      readBundleGrant({ [BUNDLE_GRANT_KEY]: { bundleId: 'bundle-1', subscriptionIds: [] } }),
      null,
    );
  });

  it('reads the profiles a merged RENEWAL extended, with the days each got', () => {
    const gatewayData = {
      [BUNDLE_RENEWAL_KEY]: {
        lines: [
          { bundleId: 'bundle-1', bundleName: 'Объеденёнка', days: 30, subscriptionIds: ['sub-a', 'sub-b'] },
          { bundleId: 'bundle-2', bundleName: 'second', days: 30, subscriptionIds: ['sub-c'] },
        ],
        at: '2026-11-14T00:00:00.000Z',
      },
    };
    assert.deepStrictEqual(readBundleRenewal(gatewayData), {
      lines: [
        { bundleId: 'bundle-1', days: 30, subscriptionIds: ['sub-a', 'sub-b'] },
        { bundleId: 'bundle-2', days: 30, subscriptionIds: ['sub-c'] },
      ],
    });
  });

  it('drops unreadable lines instead of failing the refund that reads them', () => {
    const gatewayData = {
      [BUNDLE_RENEWAL_KEY]: {
        lines: [
          { bundleId: 'bundle-1', days: 30, subscriptionIds: ['sub-a'] },
          { bundleId: '', days: 30, subscriptionIds: ['sub-b'] },
          { bundleId: 'bundle-2', days: 0, subscriptionIds: ['sub-c'] },
          { bundleId: 'bundle-3', days: 30.5, subscriptionIds: ['sub-d'] },
          { bundleId: 'bundle-4', days: 30, subscriptionIds: [] },
          { bundleId: 'bundle-5', days: 30, subscriptionIds: [null, 7, 'sub-e'] },
        ],
      },
    };
    assert.deepStrictEqual(readBundleRenewal(gatewayData), {
      lines: [
        { bundleId: 'bundle-1', days: 30, subscriptionIds: ['sub-a'] },
        { bundleId: 'bundle-5', days: 30, subscriptionIds: ['sub-e'] },
      ],
    });
    assert.equal(readBundleRenewal({ [BUNDLE_RENEWAL_KEY]: { lines: [] } }), null);
    assert.equal(readBundleRenewal({}), null);
  });
});
