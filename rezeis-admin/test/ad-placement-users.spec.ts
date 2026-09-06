import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdMetricsService } from '../src/modules/advertising/services/ad-metrics.service';

/**
 * Which people an advertisement actually brought
 * ══════════════════════════════════════════════
 * An operator running ads reported that a campaign shows no list of the users
 * who came from it. They were right, and the shape of it is worth recording:
 * the list was never missing from the data. `getPlacementMetrics` has always
 * run this exact query and then written `registrations = acquiredUsers.length`
 * — the rows reached memory on every request and were reduced to an integer
 * before anything above the service could see them.
 *
 * ── Why `acquisition_placement_id` and not `ad_clicks.user_id` ───────────
 *
 * `AdClick.userId` looks like the natural join and is a trap. On the web
 * funnel the click is recorded ANONYMOUSLY when the visitor lands, and the
 * account is bound later through the cookie with `attributeOnly`, which
 * writes no second click. So that column is NULL for the entire web audience
 * — the very audience a web advertisement brings. `User.acquisitionPlacementId`
 * is stamped once, never overwritten, and indexed.
 */

interface Recorded {
  readonly userWhere: Array<Record<string, unknown>>;
  readonly conversionWhere: Array<Record<string, unknown>>;
  readonly args: Array<Record<string, unknown>>;
}

function buildService(opts: {
  readonly users: Array<Record<string, unknown>>;
  readonly total?: number;
  readonly paidUserIds?: readonly string[];
}) {
  const calls: Recorded = { userWhere: [], conversionWhere: [], args: [] };
  const prisma = {
    user: {
      count: async (args: { where: Record<string, unknown> }) => {
        calls.userWhere.push(args.where);
        return opts.total ?? opts.users.length;
      },
      findMany: async (args: Record<string, unknown>) => {
        calls.args.push(args);
        calls.userWhere.push(args.where as Record<string, unknown>);
        return opts.users;
      },
    },
    adConversion: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.conversionWhere.push(args.where);
        return (opts.paidUserIds ?? []).map((userId) => ({ userId }));
      },
    },
  };
  const service = new AdMetricsService(prisma as never, {} as never);
  return { service, calls };
}

function person(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-1',
    telegramId: 42n,
    username: 'ann',
    name: 'Ann',
    acquisitionAt: new Date('2026-09-01T10:00:00.000Z'),
    createdAt: new Date('2026-09-01T09:59:00.000Z'),
    ...overrides,
  };
}

describe('AdMetricsService.listPlacementUsers', () => {
  it('reads the edge that survives every surface', async () => {
    const { service, calls } = buildService({ users: [person()] });
    await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    for (const where of calls.userWhere) {
      assert.deepEqual(where, { acquisitionPlacementId: 'p-1' });
    }
  });

  it('returns the person, not just a count', async () => {
    const { service } = buildService({ users: [person()] });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'u-1');
    assert.equal(result.items[0].username, 'ann');
  });

  it('renders the Telegram id as a string', async () => {
    // It is a BigInt in the row and JSON cannot carry one; serialising it
    // unconverted throws at the edge rather than at the query.
    const { service } = buildService({ users: [person({ telegramId: 9007199254740993n })] });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(result.items[0].telegramId, '9007199254740993');
  });

  it('carries a web-only customer, who has no Telegram id at all', async () => {
    // The audience a WEB advertisement brings. A list keyed on Telegram would
    // drop exactly them.
    const { service } = buildService({ users: [person({ telegramId: null, username: null })] });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(result.items[0].telegramId, null);
    assert.equal(result.items[0].id, 'u-1');
  });

  it('marks the ones who went on to pay', async () => {
    // "Registered" and "paid" are different questions, and an advertisement
    // is buying the second one.
    const { service, calls } = buildService({
      users: [person(), person({ id: 'u-2', username: 'bob' })],
      paidUserIds: ['u-2'],
    });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(result.items[0].converted, false);
    assert.equal(result.items[1].converted, true);
    assert.equal(calls.conversionWhere[0].status, 'ATTRIBUTED');
    assert.equal(calls.conversionWhere[0].placementId, 'p-1');
  });

  it('asks about conversions once, not once per row', async () => {
    const { service, calls } = buildService({
      users: Array.from({ length: 25 }, (_, i) => person({ id: `u-${i}` })),
    });
    await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(calls.conversionWhere.length, 1);
  });

  it('asks about conversions not at all on an empty page', async () => {
    const { service, calls } = buildService({ users: [] });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.deepEqual(result.items, []);
    assert.equal(calls.conversionWhere.length, 0);
  });

  it('pages, and reports a total larger than the page', async () => {
    const { service, calls } = buildService({ users: [person()], total: 340 });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 50 });
    assert.equal(result.total, 340);
    assert.equal(calls.args[0].take, 25);
    assert.equal(calls.args[0].skip, 50);
  });

  it('puts the newest arrival first', async () => {
    // Somebody checking on a running advertisement wants today's arrivals,
    // not March's.
    const { service, calls } = buildService({ users: [person()] });
    await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.deepEqual(calls.args[0].orderBy, [{ acquisitionAt: 'desc' }, { id: 'desc' }]);
  });

  it('falls back to the registration time when the stamp is missing', async () => {
    // `acquisitionAt` is null on rows that predate the column; the row must
    // still carry a date the screen can print.
    const { service } = buildService({ users: [person({ acquisitionAt: null })] });
    const result = await service.listPlacementUsers('p-1', { limit: 25, offset: 0 });
    assert.equal(result.items[0].acquisitionAt, null);
    assert.equal(result.items[0].createdAt, '2026-09-01T09:59:00.000Z');
  });
});
