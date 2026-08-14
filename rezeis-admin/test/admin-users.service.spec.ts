import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Locale, UserRole } from '@prisma/client';

import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

describe('AdminUsersService', () => {
  it('delegates single-user search to the current internal-user aggregate', async () => {
    const calls: unknown[] = [];
    const expected = buildSearchResult();
    const service = new AdminUsersService(
      {} as never,
      {
        getSearchResult: async (query: unknown) => {
          calls.push(query);
          return expected;
        },
      } as never,
    );
    const query = { login: 'user_login' };

    assert.equal(await service.searchUser(query), expected);
    assert.deepStrictEqual(calls, [query]);
  });

  it('lists users with default paging and maps BigInt ids to wire-safe strings', async () => {
    const transactionCalls: unknown[] = [];
    const userFindManyCalls: unknown[] = [];
    const userCountCalls: unknown[] = [];
    const service = new AdminUsersService(
      {
        $transaction: async (queries: unknown[]) => {
          transactionCalls.push(queries);
          return [
            [
              {
                id: 'user-1',
                telegramId: 123456789n,
                username: 'rezeis-user',
                email: 'user@example.com',
                name: 'Rezeis User',
                role: UserRole.USER,
                language: Locale.EN,
                isBlocked: false,
                createdAt: new Date('2026-04-01T00:00:00.000Z'),
                updatedAt: new Date('2026-04-16T00:00:00.000Z'),
                lastSeenAt: new Date('2026-04-16T09:30:00.000Z'),
                webAccount: null,
              },
              {
                id: 'user-2',
                telegramId: null,
                username: null,
                email: null,
                name: null,
                role: UserRole.USER,
                language: Locale.RU,
                isBlocked: true,
                createdAt: new Date('2026-04-02T00:00:00.000Z'),
                updatedAt: new Date('2026-04-17T00:00:00.000Z'),
                lastSeenAt: null,
                webAccount: { login: 'web-first-login' },
              },
            ],
            2,
          ];
        },
        user: {
          findMany: (args: unknown) => {
            userFindManyCalls.push(args);
            return { query: 'findMany' };
          },
          count: (args: unknown) => {
            userCountCalls.push(args);
            return { query: 'count' };
          },
        },
      } as never,
      {} as never,
    );

    assert.deepStrictEqual(await service.listUsers({}), {
      items: [
        {
          id: 'user-1',
          telegramId: '123456789',
          username: 'rezeis-user',
          email: 'user@example.com',
          name: 'Rezeis User',
          role: UserRole.USER,
          language: Locale.EN,
          isBlocked: false,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-16T00:00:00.000Z',
          login: null,
          lastSeenAt: '2026-04-16T09:30:00.000Z',
        },
        {
          id: 'user-2',
          telegramId: null,
          username: null,
          email: null,
          name: null,
          role: UserRole.USER,
          language: Locale.RU,
          isBlocked: true,
          createdAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
          login: 'web-first-login',
          lastSeenAt: null,
        },
      ],
      total: 2,
    });
    assert.equal(transactionCalls.length, 1);
    assert.deepStrictEqual(userFindManyCalls, [
      {
        where: {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 50,
        select: {
          id: true,
          telegramId: true,
          username: true,
          email: true,
          name: true,
          role: true,
          language: true,
          isBlocked: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          webAccount: { select: { login: true } },
        },
      },
    ]);
    assert.deepStrictEqual(userCountCalls, [{ where: {} }]);
  });

  it('builds current free-text filters for list search, including referral code and web login', async () => {
    const userFindManyCalls: unknown[] = [];
    const userCountCalls: unknown[] = [];
    const service = new AdminUsersService(
      {
        $transaction: async () => [[], 0],
        user: {
          findMany: (args: unknown) => {
            userFindManyCalls.push(args);
            return { query: 'findMany' };
          },
          count: (args: unknown) => {
            userCountCalls.push(args);
            return { query: 'count' };
          },
        },
      } as never,
      {} as never,
    );

    await service.listUsers({ search: ' 123456 ', limit: 10, offset: 20 });

    assert.deepStrictEqual(userFindManyCalls, [
      {
        where: {
          OR: [
            { id: { contains: '123456', mode: 'insensitive' } },
            { username: { contains: '123456', mode: 'insensitive' } },
            { email: { contains: '123456', mode: 'insensitive' } },
            { name: { contains: '123456', mode: 'insensitive' } },
            { referralCode: { contains: '123456', mode: 'insensitive' } },
            {
              webAccount: {
                is: {
                  OR: [
                    { login: { contains: '123456', mode: 'insensitive' } },
                    { email: { contains: '123456', mode: 'insensitive' } },
                  ],
                },
              },
            },
            {
              subscriptions: {
                some: {
                  id: { contains: '123456', mode: 'insensitive' },
                },
              },
            },
            { telegramId: 123456n },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 10,
        select: {
          id: true,
          telegramId: true,
          username: true,
          email: true,
          name: true,
          role: true,
          language: true,
          isBlocked: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          webAccount: { select: { login: true } },
        },
      },
    ]);
    assert.deepStrictEqual(userCountCalls, [
      {
        where: (userFindManyCalls[0] as { readonly where: unknown }).where,
      },
    ]);
  });

  it('drops the telegramId branch from list search when the digits overflow Postgres int8', async () => {
    const service = buildListSearchService();

    await service.listUsers({ search: '99999999999999999999999999' });

    assert.deepStrictEqual(
      listSearchOrClauses(service).filter((clause) => 'telegramId' in clause),
      [],
      'a 26-digit fragment cannot be an int8 telegramId, so the clause must never reach Prisma',
    );
  });

  it('keeps the telegramId branch for the largest id Postgres int8 can hold', async () => {
    const service = buildListSearchService();

    await service.listUsers({ search: '9223372036854775807' });

    assert.deepStrictEqual(
      listSearchOrClauses(service).filter((clause) => 'telegramId' in clause),
      [{ telegramId: 9223372036854775807n }],
    );
  });

  it('drops the telegramId branch one past the largest id Postgres int8 can hold', async () => {
    const service = buildListSearchService();

    await service.listUsers({ search: '9223372036854775808' });

    assert.deepStrictEqual(
      listSearchOrClauses(service).filter((clause) => 'telegramId' in clause),
      [],
    );
  });

  it('keeps every non-telegramId branch of list search when the digits overflow', async () => {
    const service = buildListSearchService();
    const overflowing = '99999999999999999999999999';

    await service.listUsers({ search: overflowing });

    assert.deepStrictEqual(listSearchOrClauses(service), [
      { id: { contains: overflowing, mode: 'insensitive' } },
      { username: { contains: overflowing, mode: 'insensitive' } },
      { email: { contains: overflowing, mode: 'insensitive' } },
      { name: { contains: overflowing, mode: 'insensitive' } },
      { referralCode: { contains: overflowing, mode: 'insensitive' } },
      {
        webAccount: {
          is: {
            OR: [
              { login: { contains: overflowing, mode: 'insensitive' } },
              { email: { contains: overflowing, mode: 'insensitive' } },
            ],
          },
        },
      },
      { subscriptions: { some: { id: { contains: overflowing, mode: 'insensitive' } } } },
    ]);
  });

  it('drops the telegramId branch when resolving an identifier that overflows int8', async () => {
    let capturedWhere: unknown;
    const service = new AdminUsersService(
      {
        user: {
          findFirst: (args: { where: unknown }) => {
            capturedWhere = args.where;
            return null;
          },
        },
      } as never,
      {} as never,
    );

    await assert.rejects(
      () => service.resolveUser({ identifier: '99999999999999999999999999' }),
      /User not found/,
    );
    const clauses = (capturedWhere as { readonly OR: ReadonlyArray<Record<string, unknown>> }).OR;
    assert.deepStrictEqual(
      clauses.filter((clause) => 'telegramId' in clause),
      [],
    );
    // The e-mail / login branches are untouched: the identifier is still looked
    // up everywhere it could legitimately match.
    assert.equal(clauses.length, 2);
  });

  it('resolves the largest id int8 can hold but not the one above it', async () => {
    const captured: unknown[] = [];
    const service = new AdminUsersService(
      {
        user: {
          findFirst: (args: { where: unknown }) => {
            captured.push(args.where);
            return null;
          },
        },
      } as never,
      {} as never,
    );

    await assert.rejects(() => service.resolveUser({ identifier: '9223372036854775807' }), /User not found/);
    await assert.rejects(() => service.resolveUser({ identifier: '9223372036854775808' }), /User not found/);

    const branchesFor = (index: number) =>
      (captured[index] as { readonly OR: ReadonlyArray<Record<string, unknown>> }).OR.filter(
        (clause) => 'telegramId' in clause,
      );
    assert.deepStrictEqual(branchesFor(0), [{ telegramId: 9223372036854775807n }]);
    assert.deepStrictEqual(branchesFor(1), []);
  });

  it('resolves an identifier to a single user with an OR of id / telegram / login / email branches', async () => {
    const findFirstCalls: unknown[] = [];
    const service = new AdminUsersService(
      {
        user: {
          findFirst: (args: unknown) => {
            findFirstCalls.push(args);
            return {
              id: 'clv1abcdefghijklmnopqrstu',
              telegramId: 123456789n,
              username: 'rezeis-user',
              name: 'Rezeis User',
              email: null,
              webAccount: { login: 'web-login', email: 'web@example.com' },
            };
          },
        },
      } as never,
      {} as never,
    );

    assert.deepStrictEqual(await service.resolveUser({ identifier: '  clv1abcdefghijklmnopqrstu  ' }), {
      id: 'clv1abcdefghijklmnopqrstu',
      label: 'Rezeis User · TG 123456789',
    });
    assert.deepStrictEqual(findFirstCalls, [
      {
        where: {
          OR: [
            { id: 'clv1abcdefghijklmnopqrstu' },
            { subscriptions: { some: { id: 'clv1abcdefghijklmnopqrstu' } } },
            { email: { equals: 'clv1abcdefghijklmnopqrstu', mode: 'insensitive' } },
            {
              webAccount: {
                is: {
                  OR: [
                    { login: { equals: 'clv1abcdefghijklmnopqrstu', mode: 'insensitive' } },
                    { loginNormalized: 'clv1abcdefghijklmnopqrstu' },
                    { email: { equals: 'clv1abcdefghijklmnopqrstu', mode: 'insensitive' } },
                    { emailNormalized: 'clv1abcdefghijklmnopqrstu' },
                  ],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          telegramId: true,
          username: true,
          name: true,
          email: true,
          webAccount: { select: { login: true, email: true } },
        },
      },
    ]);
  });

  it('matches a numeric identifier against telegramId and prefers login when no name is set', async () => {
    let capturedWhere: unknown;
    const service = new AdminUsersService(
      {
        user: {
          findFirst: (args: { where: unknown }) => {
            capturedWhere = args.where;
            return {
              id: 'user-2',
              telegramId: 555n,
              username: null,
              name: null,
              email: null,
              webAccount: { login: 'only-login', email: null },
            };
          },
        },
      } as never,
      {} as never,
    );

    assert.deepStrictEqual(await service.resolveUser({ identifier: '555' }), {
      id: 'user-2',
      label: 'only-login · TG 555',
    });
    assert.deepStrictEqual(capturedWhere, {
      OR: [
        { telegramId: 555n },
        { email: { equals: '555', mode: 'insensitive' } },
        {
          webAccount: {
            is: {
              OR: [
                { login: { equals: '555', mode: 'insensitive' } },
                { loginNormalized: '555' },
                { email: { equals: '555', mode: 'insensitive' } },
                { emailNormalized: '555' },
              ],
            },
          },
        },
      ],
    });
  });

  it('throws NotFoundException when no user matches the identifier', async () => {
    const service = new AdminUsersService(
      { user: { findFirst: async () => null } } as never,
      {} as never,
    );

    await assert.rejects(() => service.resolveUser({ identifier: 'nobody@example.com' }), /User not found/);
  });
});

/** Captured `user.findMany` args, keyed by the service instance that produced them. */
const listSearchCalls = new WeakMap<AdminUsersService, unknown[]>();

/** A service whose only job is to record the where-clause `listUsers` builds. */
function buildListSearchService(): AdminUsersService {
  const calls: unknown[] = [];
  const service = new AdminUsersService(
    {
      $transaction: async () => [[], 0],
      user: {
        findMany: (args: unknown) => {
          calls.push(args);
          return { query: 'findMany' };
        },
        count: () => ({ query: 'count' }),
      },
    } as never,
    {} as never,
  );
  listSearchCalls.set(service, calls);
  return service;
}

function listSearchOrClauses(service: AdminUsersService): ReadonlyArray<Record<string, unknown>> {
  const calls = listSearchCalls.get(service) ?? [];
  assert.equal(calls.length, 1, 'expected exactly one findMany call');
  const where = (calls[0] as { readonly where: { readonly OR?: ReadonlyArray<Record<string, unknown>> } })
    .where;
  assert.ok(where.OR, 'expected a search where-clause with an OR array');
  return where.OR;
}

function buildSearchResult() {
  return {
    session: {
      id: 'user-1',
      telegramId: '123456789',
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 10,
      purchaseDiscount: 5,
      points: 42,
      maxSubscriptions: 3,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      onboardingCompleted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      lastSeenAt: null,
      webAccount: null,
    },
    subscription: null,
  };
}
