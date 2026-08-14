import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Locale, UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/users';

describe('AdminUsersController', () => {
  it('exposes the current read-only admin users route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminUsersController), BASE_PATH);
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminUsersController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);

    // Read off the class instead of remembered here. The two routes described
    // below are not the whole controller: `resolveUser` and, more sharply,
    // `exportRegistrationCsv` — a bulk dump of registration IP/UA/UTM — are
    // also mounted on `admin/users`, and this spec never noticed either being
    // added. Pinning the set does not describe them, but it does mean the next
    // route cannot arrive in silence.
    assertRouteHandlers(AdminUsersController, [
      'listUsers',
      'exportRegistrationCsv',
      'searchUser',
      'resolveUser',
    ]);

    const listRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (list users)`;
    assertRoute(
      AdminUsersController.prototype.listUsers,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminUsersController.prototype.listUsers,
      { resource: 'users', action: 'view' },
      listRoute,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata('design:paramtypes', AdminUsersController.prototype, 'listUsers'),
      [AdminUserListQueryDto],
    );

    const searchRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, 'search')} (single-user lookup)`;
    assertRoute(
      AdminUsersController.prototype.searchUser,
      { method: RequestMethod.GET, path: 'search' },
      searchRoute,
    );
    assertRoutePermission(
      AdminUsersController.prototype.searchUser,
      { resource: 'users', action: 'view' },
      searchRoute,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata('design:paramtypes', AdminUsersController.prototype, 'searchUser'),
      [AdminUserSearchQueryDto],
    );

    // The rows above describe two of the four routes; this says all four are
    // gated on something. The two checks are not interchangeable: the
    // enumeration forces a new route to be noticed, but it is satisfied by
    // adding a name to the list — and a route that never gets a row here is one
    // `RbacGuard` waves through (`rbac.guard.ts:41`), open to any signed-in
    // admin rather than refused. On this controller that would be the bulk
    // registration IP/UA/UTM dump. No route here is exempt, hence no list.
    assertEveryRouteGuarded(AdminUsersController);
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
        lastSeenAt: null,
        webAccount: null,
      },
      subscription: null,
    };
    const controller = new AdminUsersController(
      {
        listUsers: async (query: unknown) => {
          calls.push(['list', query]);
          return listResult;
        },
        searchUser: async (query: unknown) => {
          calls.push(['search', query]);
          return searchResult;
        },
      } as never,
      // RegistrationExportService + PrismaService (export route deps; unused here)
      {} as never,
      {} as never,
    );
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
