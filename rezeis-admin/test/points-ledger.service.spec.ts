import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PointsLedgerService } from '../src/modules/points/services/points-ledger.service';

function row(id: string, minutesAgo: number) {
  return {
    id,
    delta: 5,
    balanceAfter: 10,
    source: 'CASHBACK',
    referenceKey: `tx-${id}`,
    details: { lines: [] },
    createdAt: new Date(Date.UTC(2026, 8, 2, 12, 0 - minutesAgo)),
  };
}

function makeService(rows: ReturnType<typeof row>[]) {
  const calls: unknown[] = [];
  const service = new PointsLedgerService({
    pointsLedgerEntry: {
      findMany: async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        calls.push(args);
        const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
        return rows.slice(start, start + args.take);
      },
    },
  } as never);
  return { service, calls };
}

describe('PointsLedgerService.listForUser', () => {
  it('asks for one row more than the page and turns its presence into the next cursor', async () => {
    const rows = [row('c', 0), row('b', 1), row('a', 2)];
    const { service, calls } = makeService(rows);

    const page = await service.listForUser({ userId: 'u1', limit: 2 });

    assert.equal((calls[0] as { take: number }).take, 3);
    assert.deepEqual(page.items.map((item) => item.id), ['c', 'b']);
    assert.equal(page.nextCursor, 'b', 'the last row the client holds');
    assert.equal(page.items[0]!.createdAt, '2026-09-02T12:00:00.000Z', 'dates travel as ISO strings');
  });

  it('continues after the cursor and reports the end with a null cursor', async () => {
    const rows = [row('c', 0), row('b', 1), row('a', 2)];
    const { service, calls } = makeService(rows);

    const page = await service.listForUser({ userId: 'u1', limit: 2, cursor: 'b' });

    const args = calls[0] as { cursor?: { id: string }; skip?: number };
    assert.deepEqual(args.cursor, { id: 'b' });
    assert.equal(args.skip, 1, 'the cursor row itself is not repeated');
    assert.deepEqual(page.items.map((item) => item.id), ['a']);
    assert.equal(page.nextCursor, null);
  });

  it('orders newest first with the id as the tie-break, and only for the one user', async () => {
    const { service, calls } = makeService([]);

    await service.listForUser({ userId: 'u1' });

    const args = calls[0] as { where: unknown; orderBy: unknown; take: number };
    assert.deepEqual(args.where, { userId: 'u1' });
    assert.deepEqual(args.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(args.take, 21, 'the default page is 20');
  });

  it('clamps the page size to 1..100 and ignores nonsense', async () => {
    const { service, calls } = makeService([]);

    await service.listForUser({ userId: 'u1', limit: 1000 });
    await service.listForUser({ userId: 'u1', limit: 0 });
    await service.listForUser({ userId: 'u1', limit: Number.NaN });

    assert.deepEqual(
      calls.map((args) => (args as { take: number }).take),
      [101, 2, 21],
    );
  });
});
