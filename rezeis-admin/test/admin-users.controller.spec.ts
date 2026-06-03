import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Locale, UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';

describe('AdminUsersController', () => {
  it('exposes the current read-only admin users route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminUsersController), 'admin/users');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminUsersController), [AdminJwtAuthGuard]);

    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminUsersController.prototype.listUsers), '/');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminUsersController.prototype.listUsers), RequestMethod.GET);
    assert.deepStrictEqual(
      Reflect.getMetadata('design:paramtypes', AdminUsersController.prototype, 'listUsers'),
      [AdminUserListQueryDto],
    );

    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminUsersController.prototype.searchUser), 'search');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminUsersController.prototype.searchUser), RequestMethod.GET);
    assert.deepStrictEqual(
      Reflect.getMetadata('design:paramtypes', AdminUsersController.prototype, 'searchUser'),
      [AdminUserSearchQueryDto],
    );
  });

  it('delegates list and search reads to AdminUsersService unchanged', async () => {
    const calls: unknown[] = [];
    const listResult = {
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
      ],
      total: 1,
    };
    const searchResult = {
      session: {
        id: 'user-1',
        telegramId: '123456789',
        username: 'rezeis-user',
        name: 'Rezeis User',
        email: 'user@example.com',
        role: UserRole.USER,
        language: Locale.EN,
        personalDiscount: 0,
        purchaseDiscount: 0,
        points: 0,
        maxSubscriptions: 1,
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
    const controller = new AdminUsersController({
      listUsers: async (query: unknown) => {
        calls.push(['list', query]);
        return listResult;
      },
      searchUser: async (query: unknown) => {
        calls.push(['search', query]);
        return searchResult;
      },
    } as never);
    const listQuery = { search: 'user', limit: 25, offset: 0 };
    const searchQuery = { login: 'user_login' };

    assert.equal(await controller.listUsers(listQuery), listResult);
    assert.equal(await controller.searchUser(searchQuery), searchResult);
    assert.deepStrictEqual(calls, [
      ['list', listQuery],
      ['search', searchQuery],
    ]);
  });
});
