import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Locale, PlanType, SubscriptionStatus, UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
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
      personalDiscount: 0,
      purchaseDiscount: 5,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
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
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    },
    subscription: {
      id: 'subscription-1',
      status: SubscriptionStatus.ACTIVE,
      isTrial: false,
      plan: {
        name: 'Premium',
        type: PlanType.SUBSCRIPTION,
      },
      trafficLimit: 2048,
      deviceLimit: 3,
      configUrl: 'https://example.com/config',
      startedAt: '2026-04-01T00:00:00.000Z',
      expiresAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
    },
  };
}

describe('AdminUsersController', () => {
  it('exposes the shipped admin users search route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, AdminUsersController) as
      | string
      | undefined;
    const actualSearchPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.searchUser,
    ) as string | undefined;
    const actualSearchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.searchUser,
    ) as RequestMethod | undefined;
    const actualSearchParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'searchUser',
    ) as readonly unknown[] | undefined;
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, AdminUsersController) as
      | readonly unknown[]
      | undefined;
    assert.equal(actualControllerPath, 'admin/users');
    assert.equal(actualSearchPath, 'search');
    assert.equal(actualSearchMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualSearchParameterTypes, [AdminUserSearchQueryDto]);
    assert.deepStrictEqual(actualGuards, [AdminJwtAuthGuard]);
  });

  it('delegates search to the admin users service and returns the aggregated result unchanged', async () => {
    const searchCalls: AdminUserSearchQueryDto[] = [];
    const query = { telegramId: '123456789' } as AdminUserSearchQueryDto;
    const expectedResult = buildSearchResult();
    const adminUsersService = {
      searchUser: async (input: AdminUserSearchQueryDto): Promise<AdminUserSearchResultInterface> => {
        searchCalls.push(input);
        return expectedResult;
      },
    } as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualResult = await controller.searchUser(query);
    assert.deepStrictEqual(searchCalls, [query]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });
});
