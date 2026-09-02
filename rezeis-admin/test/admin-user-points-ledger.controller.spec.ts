import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { PointsLedgerService } from '../src/modules/points/services/points-ledger.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * GET /admin/users/:telegramId/points/ledger — the journal the user card
 * shows. The controller resolves the account, the ledger service pages the
 * rows; this pins the seam between them: the user's id (not the Telegram id)
 * goes to the query, the cursor and limit travel through untouched, and an
 * unknown account is a 404 before any row is read.
 */
function makeController(input: { readonly user: { id: string } | null; readonly rows: Array<Record<string, unknown>> }) {
  const findManyArgs: unknown[] = [];
  const prisma = {
    user: {
      findFirst: async () => input.user,
      findUnique: async () => input.user,
    },
    pointsLedgerEntry: {
      findMany: async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        findManyArgs.push(args);
        const start = args.cursor ? input.rows.findIndex((row) => row['id'] === args.cursor!.id) + (args.skip ?? 0) : 0;
        return input.rows.slice(start, start + args.take);
      },
    },
  };
  const controller = new AdminUserManagementController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // PlansAdminService
    undefined as never, // UserBlockService
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
    new PointsWalletService(),
    new PointsLedgerService(prisma as never),
  );
  return { controller, findManyArgs };
}

function row(id: string, minutesAgo: number, delta: number, balanceAfter: number, source: string) {
  return {
    id,
    delta,
    balanceAfter,
    source,
    referenceKey: `ref-${id}`,
    details: { note: id },
    createdAt: new Date(Date.UTC(2026, 8, 2, 12, 0 - minutesAgo)),
  };
}

describe('GET /admin/users/:telegramId/points/ledger', () => {
  it('pages the journal for the resolved account, newest first, with a cursor for the rest', async () => {
    const rows = [row('c', 0, 13, 18, 'CASHBACK'), row('b', 1, -100, 5, 'EXCHANGE'), row('a', 2, 105, 105, 'OPENING_BALANCE')];
    const { controller, findManyArgs } = makeController({ user: { id: 'user-1' }, rows });

    const page = await controller.listPointsLedger('1000', undefined, '2');

    assert.deepEqual(
      page.items.map((item) => [item.id, item.delta, item.balanceAfter, item.source, item.createdAt]),
      [
        ['c', 13, 18, 'CASHBACK', '2026-09-02T12:00:00.000Z'],
        ['b', -100, 5, 'EXCHANGE', '2026-09-02T11:59:00.000Z'],
      ],
    );
    assert.equal(page.nextCursor, 'b');
    const args = findManyArgs[0] as { where: unknown; take: number };
    assert.deepEqual(args.where, { userId: 'user-1' }, 'the account id, not the Telegram id, scopes the query');
    assert.equal(args.take, 3);
  });

  it('continues from the cursor and reports the end', async () => {
    const rows = [row('c', 0, 13, 18, 'CASHBACK'), row('b', 1, -100, 5, 'EXCHANGE'), row('a', 2, 105, 105, 'OPENING_BALANCE')];
    const { controller, findManyArgs } = makeController({ user: { id: 'user-1' }, rows });

    const page = await controller.listPointsLedger('1000', 'b', '2');

    assert.deepEqual(page.items.map((item) => item.id), ['a']);
    assert.equal(page.nextCursor, null);
    const args = findManyArgs[0] as { cursor?: { id: string }; skip?: number };
    assert.deepEqual(args.cursor, { id: 'b' });
    assert.equal(args.skip, 1);
  });

  it('treats an empty cursor as the first page and a missing limit as the default', async () => {
    const { controller, findManyArgs } = makeController({ user: { id: 'user-1' }, rows: [] });

    await controller.listPointsLedger('1000', '', undefined);

    const args = findManyArgs[0] as { cursor?: unknown; take: number };
    assert.equal(args.cursor, undefined);
    assert.equal(args.take, 21);
  });

  it('answers 404 for an unknown account before reading a single row', async () => {
    const { controller, findManyArgs } = makeController({ user: null, rows: [] });

    await assert.rejects(() => controller.listPointsLedger('1000', undefined, undefined), NotFoundException);
    assert.equal(findManyArgs.length, 0);
  });
});
