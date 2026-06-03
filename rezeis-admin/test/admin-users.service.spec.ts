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
            { webAccount: { is: { login: { contains: '123456', mode: 'insensitive' } } } },
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
        },
      },
    ]);
    assert.deepStrictEqual(userCountCalls, [
      {
        where: (userFindManyCalls[0] as { readonly where: unknown }).where,
      },
    ]);
  });
});

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
      webAccount: null,
    },
    subscription: null,
  };
}
