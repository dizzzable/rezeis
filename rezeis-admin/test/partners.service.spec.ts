import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PartnersService } from '../src/modules/partners/services/partners.service';

const NULL_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NULL_NOTIFICATIONS = {
  notifyEarning: async () => undefined,
  notifyWithdrawalApproved: async () => undefined,
  notifyWithdrawalRejected: async () => undefined,
};

// Relative, not a literal date. A `2026-03-01` fixture in this repo was live
// when written and quietly turned into an expired-subscription assertion five
// months later while staying green.
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNED_UP_AT = new Date(Date.now() - 30 * DAY_MS);

function makeFakePartner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'u1',
    user: { id: 'u1', name: 'Alice', username: 'alice', telegramId: BigInt(1234567), createdAt: SIGNED_UP_AT },
    balance: 10000,
    totalEarned: 50000,
    totalWithdrawn: 20000,
    isActive: true,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: null,
    level2Percent: null,
    level3Percent: null,
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    createdAt: SIGNED_UP_AT,
    updatedAt: SIGNED_UP_AT,
    _count: { referrals: 5 },
    ...overrides,
  };
}

/**
 * Prisma double that records every delegate it is asked for. The point is the
 * NEGATIVE assertion: `referral` and `partnerReferral` are wired up and would
 * answer, so "activation never asked for them" is a real observation rather
 * than an accident of an incomplete stub.
 */
function recordingPrisma(seedActive: boolean) {
  const touched: string[] = [];
  const client = {
    partner: {
      findUnique: async () => {
        touched.push('partner.findUnique');
        return makeFakePartner({ isActive: seedActive });
      },
      update: async (args: { data: { isActive: boolean } }) => {
        touched.push('partner.update');
        return makeFakePartner({ isActive: args.data.isActive });
      },
      create: async () => {
        touched.push('partner.create');
        return makeFakePartner();
      },
    },
    referral: {
      findMany: async () => {
        touched.push('referral.findMany');
        return [{ referredId: 'invited-before-activation' }];
      },
    },
    partnerReferral: {
      findFirst: async () => {
        touched.push('partnerReferral.findFirst');
        return null;
      },
      findUnique: async () => {
        touched.push('partnerReferral.findUnique');
        return null;
      },
      create: async () => {
        touched.push('partnerReferral.create');
        return {};
      },
    },
  };
  return { client, touched };
}

function recordingEvents() {
  const emitted: Array<{ type: string; category: string; message: string; metadata: unknown }> = [];
  return {
    emitted,
    events: {
      info: (type: string, category: string, message: string, metadata: unknown) =>
        emitted.push({ type, category, message, metadata }),
      warn: (type: string, category: string, message: string, metadata: unknown) =>
        emitted.push({ type, category, message, metadata }),
      error: () => undefined,
    },
  };
}

describe('PartnersService', () => {
  it('lists partners with totalEarned desc by default', async () => {
    const seen: { orderBy: unknown; take: number; skip: number }[] = [];
    const service = new PartnersService(
      {
        partner: {
          findMany: async (args: { orderBy: unknown; take: number; skip: number }) => {
            seen.push(args);
            return [makeFakePartner()];
          },
        },
      } as never,
      NULL_EVENTS as never,
      NULL_NOTIFICATIONS as never,
    );
    const result = await service.listPartners({} as never);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.referralsCount, 5);
    assert.deepEqual(seen[0]?.orderBy, [{ totalEarned: 'desc' }, { createdAt: 'desc' }]);
  });

  it('applies free-text search to user name/username/telegramId', async () => {
    const seen: { where: unknown }[] = [];
    const service = new PartnersService(
      {
        partner: {
          findMany: async (args: { where: unknown }) => {
            seen.push(args);
            return [];
          },
        },
      } as never,
      NULL_EVENTS as never,
      NULL_NOTIFICATIONS as never,
    );
    await service.listPartners({ search: '1234567' } as never);
    assert.ok(seen[0]?.where);
    const where = seen[0]?.where as { user: { OR: unknown[] } };
    assert.ok(Array.isArray(where.user.OR));
    assert.equal(where.user.OR.length, 3); // name, username, telegramId
  });

  // The owner's rule: partner earnings count ONLY from the moment of
  // activation. Activation used to walk the partner's existing `Referral`
  // graph and mint a `PartnerReferral` edge for every person invited before
  // that, which made those people's FUTURE payments pay the partner too. The
  // spec that stood here asserted the opposite — that the backfill ran.
  it('activation does not build edges from the existing referral graph', async () => {
    const { client, touched } = recordingPrisma(false);
    const service = new PartnersService(client as never, NULL_EVENTS as never, NULL_NOTIFICATIONS as never);

    const updated = await service.togglePartnerStatus('p1');

    assert.equal(updated.isActive, true);
    assert.deepEqual(
      touched,
      ['partner.findUnique', 'partner.update'],
      'activation must read the partner row and nothing else — no referral graph walk, no edge write',
    );
  });

  it('deactivation does not build edges either', async () => {
    const { client, touched } = recordingPrisma(true);
    const service = new PartnersService(client as never, NULL_EVENTS as never, NULL_NOTIFICATIONS as never);

    const updated = await service.togglePartnerStatus('p1');

    assert.equal(updated.isActive, false);
    assert.deepEqual(touched, ['partner.findUnique', 'partner.update']);
  });

  // A message describing work that no longer happens is a lying artifact. The
  // old event reported "backfilled N referral edge(s)" and carried
  // attached/considered counters that can now only ever be zero.
  it('reports activation without backfill counters', async () => {
    const { client } = recordingPrisma(false);
    const { events, emitted } = recordingEvents();
    const service = new PartnersService(client as never, events as never, NULL_NOTIFICATIONS as never);

    await service.togglePartnerStatus('p1');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'partner.activated');
    assert.equal(emitted[0]?.message, 'Partner activated');
    assert.deepEqual(
      emitted[0]?.metadata,
      { partnerId: 'p1', userId: 'u1' },
      'no attached/considered counters: there is no backfill to count',
    );
  });

  it('reports deactivation', async () => {
    const { client } = recordingPrisma(true);
    const { events, emitted } = recordingEvents();
    const service = new PartnersService(client as never, events as never, NULL_NOTIFICATIONS as never);

    await service.togglePartnerStatus('p1');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'partner.deactivated');
    assert.equal(emitted[0]?.message, 'Partner deactivated');
  });
});
