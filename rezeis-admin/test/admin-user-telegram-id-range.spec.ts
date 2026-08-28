import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import { MAX_POSTGRES_BIGINT } from '../src/common/utils/postgres-bigint.util';

/**
 * `User.telegramId` is Postgres `int8`. Every value in this file is a decimal
 * string an operator can actually type into the admin panel.
 */
const IN_RANGE = '9223372036854775807';
const ONE_PAST = '9223372036854775808';
const PASTED_REFERENCE = '99999999999999999999999999';

/** What Postgres answers when an out-of-range value is bound to an `int8`. */
class NumericOutOfRangeError extends Error {
  public readonly code = '22003';

  public constructor(value: bigint) {
    super(`numeric field value out of range: ${value.toString()}`);
  }
}

/**
 * A `user` delegate that fails the way Postgres fails.
 *
 * A passive fake returning `null` for every input would let a regression that
 * re-binds an over-range `telegramId` pass as a clean 404 — the query it must
 * never issue would simply be answered "no rows". Throwing `22003` here is what
 * makes "no out-of-range value reached the database" an assertion rather than
 * an assumption: the tests below get the exception, not a 404.
 */
function postgresLikeUser(calls: unknown[], row: Record<string, unknown> | null = null) {
  const guard = (args: { readonly where?: Record<string, unknown> }) => {
    calls.push(args);
    const bound = args.where?.telegramId;
    if (typeof bound === 'bigint' && (bound > MAX_POSTGRES_BIGINT || bound < -(2n ** 63n))) {
      throw new NumericOutOfRangeError(bound);
    }
    return row;
  };
  return { findFirst: async (args: never) => guard(args), findUnique: async (args: never) => guard(args) };
}

const REQ = { headers: {}, socket: {} } as never;
const ADMIN = { id: 'admin-1' } as never;

/** Every `telegramId` this call bound, in order. */
function boundTelegramIds(calls: readonly unknown[]): unknown[] {
  return calls
    .map((call) => (call as { readonly where?: Record<string, unknown> }).where?.telegramId)
    .filter((value) => value !== undefined);
}

describe('AdminUserManagementController telegramId range', () => {
  function buildController(calls: unknown[], row: Record<string, unknown> | null = null) {
    return new AdminUserManagementController(
      { user: postgresLikeUser(calls, row) } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      {} as never, // PlansAdminService
      undefined as never,
    );
  }

  it('answers an over-range route param with 404 instead of reaching Postgres', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(() => controller.listUserOperations(PASTED_REFERENCE), NotFoundException);
    assert.deepStrictEqual(calls, [], 'no query may be issued for a value int8 cannot hold');
  });

  it('still binds the largest id int8 can hold', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(() => controller.listUserOperations(IN_RANGE), NotFoundException);
    assert.deepStrictEqual(boundTelegramIds(calls), [MAX_POSTGRES_BIGINT]);
  });

  it('does not bind the value one past that bound', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(() => controller.listUserOperations(ONE_PAST), NotFoundException);
    assert.deepStrictEqual(calls, []);
  });

  it('still resolves a CUID route param through the id branch', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls, { id: 'clv1abcdefghijklmnopqrstu' });

    // The handler runs on past the lookup into reads this fake does not stub,
    // so it still throws — but not a 404, and not after binding a telegramId.
    const error = await controller
      .listUserOperations('clv1abcdefghijklmnopqrstu')
      .then(() => null, (thrown: unknown) => thrown);
    assert.ok(!(error instanceof NotFoundException), 'the CUID branch must still resolve the user');
    assert.deepStrictEqual(calls, [{ where: { id: 'clv1abcdefghijklmnopqrstu' } }]);
  });

  it('skips the telegramId branch of identifier resolution when it overflows, and keeps the rest', async () => {
    const calls: unknown[] = [];
    const webAccountLookups: unknown[] = [];
    const controller = new AdminUserManagementController(
      {
        user: postgresLikeUser(calls, null),
        webAccount: {
          findFirst: async (args: unknown) => {
            webAccountLookups.push(args);
            return null;
          },
        },
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      {} as never, // PlansAdminService
      undefined as never,
    );
    // The route param resolves; the pasted referral identifier is the overflow.
    (controller as never as { prismaService: { user: { findFirst: unknown } } }).prismaService.user.findFirst =
      async (args: { readonly where?: Record<string, unknown> }) => {
        calls.push(args);
        const bound = args.where?.telegramId;
        if (typeof bound === 'bigint' && bound > MAX_POSTGRES_BIGINT) throw new NumericOutOfRangeError(bound);
        return bound === 42n ? { id: 'partner-user' } : null;
      };

    await assert.rejects(
      () => controller.attachPartnerReferral('42', { referralIdentifier: PASTED_REFERENCE }, ADMIN, REQ),
      /Referral user not found/,
    );
    // Only the partner route param was bound; the over-long identifier fell
    // through to the login and username branches, which still ran.
    assert.deepStrictEqual(boundTelegramIds(calls), [42n]);
    assert.equal(webAccountLookups.length, 1, 'the login branch must still be tried');
  });

  it('still resolves an in-range numeric referral identifier through telegramId', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);
    (controller as never as { prismaService: { user: { findFirst: unknown } } }).prismaService.user.findFirst =
      async (args: { readonly where?: Record<string, unknown> }) => {
        calls.push(args);
        const bound = args.where?.telegramId;
        if (typeof bound === 'bigint' && bound > MAX_POSTGRES_BIGINT) throw new NumericOutOfRangeError(bound);
        if (bound === 42n) return { id: 'partner-user' };
        if (bound === MAX_POSTGRES_BIGINT) return { id: 'partner-user' };
        return null;
      };

    // Resolves to the SAME user as the route param, which this endpoint refuses
    // with a 400 — reached only because the telegramId branch actually matched.
    await assert.rejects(
      () => controller.attachPartnerReferral('42', { referralIdentifier: IN_RANGE }, ADMIN, REQ),
      BadRequestException,
    );
    assert.deepStrictEqual(boundTelegramIds(calls), [42n, MAX_POSTGRES_BIGINT]);
  });

  it('rejects an over-range telegramId on create as a 400, not a Postgres 500', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(
      () => controller.createUser({ telegramId: PASTED_REFERENCE }, ADMIN, REQ),
      BadRequestException,
    );
    assert.deepStrictEqual(calls, []);
  });

  it('rejects a non-numeric telegramId on create, which BigInt used to throw on', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(() => controller.createUser({ telegramId: 'abc' }, ADMIN, REQ), BadRequestException);
    assert.deepStrictEqual(calls, []);
  });

  it('still accepts the ids it accepted before the guard, including a negative one', async () => {
    for (const [input, expected] of [
      [IN_RANGE, MAX_POSTGRES_BIGINT],
      ['-5', -5n],
    ] as const) {
      const calls: unknown[] = [];
      const created: unknown[] = [];
      const controller = new AdminUserManagementController(
        {
          user: {
            ...postgresLikeUser(calls),
            create: async (args: { readonly data: Record<string, unknown> }) => {
              created.push(args.data);
              return { id: 'user-1', telegramId: args.data.telegramId };
            },
          },
          adminAuditLog: { create: async () => undefined },
        } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        {} as never, // PlansAdminService
      undefined as never,
      );

      await controller.createUser({ telegramId: input }, ADMIN, REQ);
      assert.deepStrictEqual(boundTelegramIds(calls), [expected], `duplicate check for ${input}`);
      assert.equal((created[0] as { telegramId: bigint }).telegramId, expected);
    }
  });
});

describe('AdminUserSubscriptionsController telegramId range', () => {
  function buildController(calls: unknown[]) {
    return new AdminUserSubscriptionsController(
      { user: postgresLikeUser(calls) } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it('answers an over-range route param with 404 instead of reaching Postgres', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(
      () => controller.giveSubscription(PASTED_REFERENCE, { planId: 'plan-1', durationDays: 30 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepStrictEqual(calls, []);
  });

  it('still binds the largest id int8 can hold', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(
      () => controller.giveSubscription(IN_RANGE, { planId: 'plan-1', durationDays: 30 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepStrictEqual(boundTelegramIds(calls), [MAX_POSTGRES_BIGINT]);
  });
});

describe('AdminUserWebController telegramId range', () => {
  function buildController(calls: unknown[], row: Record<string, unknown> | null = null) {
    return new AdminUserWebController(
      { user: postgresLikeUser(calls, row) } as never,
      undefined as never,
      undefined as never,
    );
  }

  it('answers an over-range route param with 404 instead of reaching Postgres', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls);

    await assert.rejects(() => controller.resetWebPassword(PASTED_REFERENCE, ADMIN, REQ), NotFoundException);
    assert.deepStrictEqual(calls, []);
  });

  it('rejects an over-range binding body as a 400, not a Postgres 500', async () => {
    const calls: unknown[] = [];
    // Nineteen digits, so `BindTelegramIdDto`'s `^\d{1,19}$` admits it; still
    // larger than int8. This is the case the DTO pattern looks like it covers.
    const nineteenDigitsOverflowing = '9999999999999999999';
    assert.equal(nineteenDigitsOverflowing.length, 19);
    const controller = buildController(calls, { id: 'user-1', telegramId: 42n });

    await assert.rejects(
      () => controller.bindTelegramId('42', { telegramId: nineteenDigitsOverflowing }, ADMIN, REQ),
      BadRequestException,
    );
    // Only the route-param lookup ran; the out-of-range id never reached a query.
    assert.deepStrictEqual(boundTelegramIds(calls), [42n]);
  });

  it('still binds the largest id int8 can hold', async () => {
    const calls: unknown[] = [];
    const updates: unknown[] = [];
    const controller = new AdminUserWebController(
      {
        user: {
          ...postgresLikeUser(calls, { id: 'user-1', telegramId: 42n }),
          update: async (args: unknown) => {
            updates.push(args);
            return { id: 'user-1' };
          },
        },
        adminAuditLog: { create: async () => undefined },
      } as never,
      undefined as never,
      undefined as never,
    );

    assert.deepStrictEqual(await controller.bindTelegramId('42', { telegramId: IN_RANGE }, ADMIN, REQ), {
      telegramId: IN_RANGE,
      changed: true,
    });
    assert.deepStrictEqual(boundTelegramIds(calls), [42n, MAX_POSTGRES_BIGINT]);
    assert.equal(updates.length, 1);
  });

  it('still rejects zero as a non-positive id', async () => {
    const calls: unknown[] = [];
    const controller = buildController(calls, { id: 'user-1', telegramId: 42n });

    await assert.rejects(
      () => controller.bindTelegramId('42', { telegramId: '0' }, ADMIN, REQ),
      /must be positive/,
    );
  });
});
