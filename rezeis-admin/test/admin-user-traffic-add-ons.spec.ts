/**
 * The user page's subscription card says which part of the traffic limit is
 * an add-on with an end of its own — «из них докупки: +50 ГБ до 01.10 03:20
 * (по Москве)» — so an operator never types a new total around it unknowingly.
 * The card reads it from `GET /admin/users/:telegramId`: per subscription,
 * `trafficAddOns` from the ACTIVE traffic entitlements; at the top,
 * `displayTimeZone`, the panel's «Часовой пояс».
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnEntitlementState, AddOnLifetime, AddOnType } from '@prisma/client';

import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import {
  summariseTrafficAddOns,
  type TrafficAddOnRow,
} from '../src/modules/users/utils/subscription-traffic-add-ons.util';

const GIB = 1024n ** 3n;
const RESET = new Date('2026-10-01T00:20:00.000Z');
const TAKE_OFF = new Date('2026-10-01T00:50:00.000Z');
const SUBSCRIPTION_END = new Date('2026-10-20T09:00:00.000Z');

const row = (over: Partial<TrafficAddOnRow>): TrafficAddOnRow => ({
  subscriptionId: 'sub-1',
  totalValue: 25n * GIB,
  lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
  expiresAt: TAKE_OFF,
  expiryEpoch: { plannedEndsAt: RESET },
  ...over,
});

describe('the add-on share of a traffic limit', () => {
  it('sums the add-ons that end together and names the reset a reset add-on ends with', () => {
    const shares = summariseTrafficAddOns([
      row({}),
      row({}),
      // Capped by the subscription's end: it ends with it, not at a reset.
      row({ totalValue: 5n * GIB, expiresAt: new Date('2026-09-30T12:00:00.000Z') }),
      row({ totalValue: 10n * GIB, lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END, expiresAt: SUBSCRIPTION_END, expiryEpoch: null }),
      // A row with no end sorts last.
      row({ totalValue: GIB / 2n, lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END, expiresAt: null, expiryEpoch: null }),
      row({ subscriptionId: 'sub-2', totalValue: 3n * GIB }),
    ]);
    assert.deepEqual(shares.get('sub-1'), {
      totalGb: 65.5,
      items: [
        { gb: 5, endsAt: '2026-09-30T12:00:00.000Z', resetAt: null },
        { gb: 50, endsAt: TAKE_OFF.toISOString(), resetAt: RESET.toISOString() },
        { gb: 10, endsAt: SUBSCRIPTION_END.toISOString(), resetAt: null },
        { gb: 0.5, endsAt: null, resetAt: null },
      ],
    });
    assert.deepEqual(shares.get('sub-2'), {
      totalGb: 3,
      items: [{ gb: 3, endsAt: TAKE_OFF.toISOString(), resetAt: RESET.toISOString() }],
    });
    assert.equal(shares.has('sub-3'), false, 'a subscription with no add-on has no share');
  });

  it('does not name a reset for an add-on half a minute off the reset + margin', () => {
    const share = summariseTrafficAddOns([row({ expiresAt: new Date(TAKE_OFF.getTime() - 30_000) })]).get('sub-1');
    assert.equal(share?.items[0]?.resetAt, null);
  });
});

function buildController(entitlements: readonly TrafficAddOnRow[], platformPolicy: unknown) {
  const queries: unknown[] = [];
  const controller = new AdminUserManagementController(
    {
      user: {
        findFirst: async () => ({
          id: 'user-1',
          telegramId: 123,
          acquisitionPlacementId: null,
          acquisitionAt: null,
          currentSubscriptionId: null,
          referralInviteSettings: null,
        }),
      },
      subscription: {
        findMany: async () => [
          { id: 'sub-1', expiresAt: SUBSCRIPTION_END, planSnapshot: {}, trafficLimit: 150 },
          { id: 'sub-2', expiresAt: SUBSCRIPTION_END, planSnapshot: {}, trafficLimit: 100 },
        ],
      },
      profileSyncJob: { findMany: async () => [] },
      transaction: { findMany: async () => [] },
      referral: { findFirst: async () => null, findMany: async () => [] },
      partner: { findUnique: async () => null },
      webAccount: { findFirst: async () => null },
      partnerReferral: { findFirst: async () => null },
      addOnEntitlement: {
        findMany: async (query: unknown) => {
          queries.push(query);
          return entitlements;
        },
      },
      settings: { findUnique: async () => (platformPolicy === undefined ? null : { platformPolicy }) },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getEffectiveLimitsForUser: async () => ({}) } as never,
    { getPanelUserOutcome: async () => ({ kind: 'missing' }) } as never,
    {} as never,
    { hasPermission: async () => false } as never,
    {} as never,
    {} as never,
    {} as never, // PlansAdminService
    undefined as never, // UserBlockService
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
    new PointsWalletService(),
    { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
  );
  return { controller, queries };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: null } as never;

describe('GET /admin/users/:telegramId — the card’s add-on line', () => {
  it('carries each subscription’s ACTIVE traffic add-ons and the operator’s zone', async () => {
    const { controller, queries } = buildController([row({ totalValue: 50n * GIB })], { timezone: 'Europe/Moscow' });
    const card = (await controller.getUser('123', ADMIN)) as unknown as {
      readonly displayTimeZone: string | null;
      readonly subscriptions: ReadonlyArray<{ readonly id: string; readonly trafficAddOns: unknown }>;
    };
    assert.equal(card.displayTimeZone, 'Europe/Moscow');
    assert.deepEqual(card.subscriptions.find((s) => s.id === 'sub-1')?.trafficAddOns, {
      totalGb: 50,
      items: [{ gb: 50, endsAt: TAKE_OFF.toISOString(), resetAt: RESET.toISOString() }],
    });
    assert.equal(card.subscriptions.find((s) => s.id === 'sub-2')?.trafficAddOns, null);
    // Only what the projection counts: ACTIVE traffic, of these subscriptions, in one query.
    assert.equal(queries.length, 1);
    assert.deepEqual((queries[0] as { where: unknown }).where, {
      subscriptionId: { in: ['sub-1', 'sub-2'] },
      state: AddOnEntitlementState.ACTIVE,
      type: AddOnType.EXTRA_TRAFFIC,
    });
  });

  it('says UTC by `null` when the operator set no zone', async () => {
    const { controller } = buildController([], undefined);
    const card = (await controller.getUser('123', ADMIN)) as unknown as { readonly displayTimeZone: string | null };
    assert.equal(card.displayTimeZone, null);
  });
});
