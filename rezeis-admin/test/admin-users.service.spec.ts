import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Locale, UserRole } from '@prisma/client';

import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUserSearchResultInterface } from '../src/modules/users/interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

function buildSearchResult(): AdminUserSearchResultInterface {
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
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-01T01:00:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: '2026-04-01T01:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-16T00:00:00.000Z',
      },
    },
    subscription: null,
  };
}

describe('AdminUsersService', () => {
  it('delegates to the single internal aggregated lookup and returns the payload unchanged', async () => {
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const query = { email: 'user@example.com' } as AdminUserSearchQueryDto;
    const expectedResult = buildSearchResult();
    const internalUserService = {
      getSearchResult: async (input: AdminUserSearchQueryDto): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return expectedResult;
      },
    } as InternalUserService;
    const service = new AdminUsersService(internalUserService);
    const actualResult = await service.searchUser(query);
    assert.deepStrictEqual(getSearchResultCalls, [query]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });
});
