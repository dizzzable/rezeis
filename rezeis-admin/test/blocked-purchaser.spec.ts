import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';

import { assertPurchaserNotBlocked } from '../src/modules/payments/utils/blocked-purchaser.util';

/**
 * A blocked account must not be able to start a payment, and must not be
 * charged for one it never started.
 *
 * ── The one that actually happened ───────────────────────────────────────
 *
 * Blocking switched the VPN off and left autopay running. The renewal
 * scheduler has no session and no screen in front of it — it reads
 * subscriptions out of the table and charges a saved card — so a banned
 * customer kept paying, every renewal, for a service the ban had just taken
 * away. That path is fixed in `AutoRenewService`'s QUERY (the charge is never
 * attempted) rather than by this refusal, and the reason is asserted at the
 * bottom of this file.
 */

function buildPrisma(rows: ReadonlyArray<Record<string, unknown>>) {
  const queries: Array<Record<string, unknown>> = [];
  return {
    queries,
    prisma: {
      user: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          queries.push(args.where);
          const [id] = Object.values(args.where);
          return (
            rows.find(
              (row) => row.id === id || row.telegramId === id,
            ) ?? null
          );
        },
      },
    },
  };
}

describe('refusing a payment for a blocked account', () => {
  it('refuses by reiwa id', async () => {
    const { prisma } = buildPrisma([{ id: 'user-1', isBlocked: true }]);
    await assert.rejects(
      () => assertPurchaserNotBlocked(prisma as never, { userId: 'user-1' }),
      (err: unknown) =>
        err instanceof ForbiddenException &&
        (err.getResponse() as { code?: string }).code === 'USER_BLOCKED',
    );
  });

  it('refuses by telegram id', async () => {
    // The Telegram-only flows resolve this way and would otherwise slip past a
    // check written for reiwa ids alone.
    const { prisma } = buildPrisma([{ telegramId: 123n, isBlocked: true }]);
    await assert.rejects(
      () => assertPurchaserNotBlocked(prisma as never, { telegramId: '123' }),
      (err: unknown) => err instanceof ForbiddenException,
    );
  });

  it('lets an ordinary customer through', async () => {
    // The control. A refusal that fired for everybody would satisfy both
    // assertions above and would close every checkout in the product.
    const { prisma } = buildPrisma([{ id: 'user-1', isBlocked: false }]);
    await assertPurchaserNotBlocked(prisma as never, { userId: 'user-1' });
  });

  it('says nothing about an account it cannot find', async () => {
    // The caller's own resolution raises a far better error a few lines later.
    // Throwing here would replace "user not found" with "account is blocked",
    // which is both wrong and a worse thing to tell somebody.
    const { prisma } = buildPrisma([]);
    await assertPurchaserNotBlocked(prisma as never, { userId: 'ghost' });
  });

  it('spends no query when there is no identity to check', async () => {
    const { prisma, queries } = buildPrisma([]);
    await assertPurchaserNotBlocked(prisma as never, {});
    await assertPurchaserNotBlocked(prisma as never, { userId: '', telegramId: null });
    assert.deepStrictEqual(queries, []);
  });

  it('does not turn a non-numeric telegram id into a 500', async () => {
    // `BigInt('abc')` throws. A raw crash out of a safety check is worse than
    // the request it was meant to refuse.
    const { prisma, queries } = buildPrisma([]);
    await assertPurchaserNotBlocked(prisma as never, { telegramId: 'not-a-number' });
    assert.deepStrictEqual(queries, []);
  });
});

describe('autopay never attempts a blocked owner', () => {
  it('filters them out in the candidate query', async () => {
    // Asserted on the QUERY rather than on a downstream refusal, and that is
    // the point: a refusal thrown later would still burn an attempt against
    // the retry budget and still notify the customer about a payment problem
    // they cannot act on. The charge has to not happen at all.
    const { AutoRenewService } = await import(
      '../src/modules/auto-renew/auto-renew.service'
    );
    const wheres: Array<Record<string, unknown>> = [];
    const service = new AutoRenewService(
      {
        subscription: {
          findMany: async (args: { where: Record<string, unknown> }) => {
            wheres.push(args.where);
            return [];
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.processAutopayCharges();

    assert.equal(wheres.length, 1);
    assert.deepStrictEqual(wheres[0]['user'], { isBlocked: false });
  });
});
