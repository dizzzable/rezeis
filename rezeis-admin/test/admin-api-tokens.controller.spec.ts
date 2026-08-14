import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminApiTokensController } from '../src/modules/api-tokens/controllers/admin-api-tokens.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import { API_TOKEN_JWT_AUDIENCE } from '../src/modules/auth/constants/api-token-auth.constants';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
} from './helpers/controller-routes';

describe('AdminApiTokensController', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminApiTokensController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps API token routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminApiTokensController), 'admin/api-tokens');
    // The route set is read off the class, not remembered here. Without this a
    // fourth endpoint — an unrevoke, a rotate, a usage report — passes this
    // spec untouched, `@RequirePermission` or not, and the test that exists to
    // prove every API-token route is gated proves it only of the three routes
    // someone typed out in 2026.
    assertRouteHandlers(AdminApiTokensController, ['list', 'create', 'delete']);
    // …and enumerating them forces the fourth endpoint to be NOTICED, not to be
    // gated. Those are different guarantees. `RbacGuard` returns `true` for a
    // route carrying no `@RequirePermission` at any level
    // (`src/modules/rbac/guards/rbac.guard.ts:41`), so a forgotten decorator on
    // a token-issuing route is not a 403 — it is an endpoint that mints
    // long-lived API credentials for every authenticated admin, silently. The
    // list is empty because nothing here is deliberately ungated; an entry
    // appearing in it is a decision someone has to write down.
    assertEveryRouteGuarded(AdminApiTokensController, []);

    const listRoute = 'GET admin/api-tokens (list tokens)';
    assertRoute(
      AdminApiTokensController.prototype.list,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminApiTokensController.prototype.list,
      { resource: 'api_tokens', action: 'view' },
      listRoute,
    );

    const createRoute = 'POST admin/api-tokens (issue token)';
    assertRoute(
      AdminApiTokensController.prototype.create,
      { method: RequestMethod.POST, path: '/' },
      createRoute,
    );
    assertRoutePermission(
      AdminApiTokensController.prototype.create,
      { resource: 'api_tokens', action: 'create' },
      createRoute,
    );

    const deleteRoute = 'DELETE admin/api-tokens/:tokenId (revoke token)';
    assertRoute(
      AdminApiTokensController.prototype.delete,
      { method: RequestMethod.DELETE, path: ':tokenId' },
      deleteRoute,
    );
    assertRoutePermission(
      AdminApiTokensController.prototype.delete,
      { resource: 'api_tokens', action: 'delete' },
      deleteRoute,
    );
  });

  it('declares api_tokens permissions in the catalog without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.api_tokens, ['view', 'create', 'delete']);
    assert.equal(isValidPermission('api_tokens', 'view'), true);
    assert.equal(isValidPermission('api_tokens', 'create'), true);
    assert.equal(isValidPermission('api_tokens', 'delete'), true);
    assert.equal(isValidPermission('api_tokens', 'edit'), false);
  });

  it('delegates list, create, and delete to ApiTokensService', async () => {
    const calls: unknown[] = [];
    const controller = new AdminApiTokensController({
      list: async () => {
        calls.push('list');
        return [{ id: 'token-1', name: 'Reiwa', audience: API_TOKEN_JWT_AUDIENCE, prefix: 'abc', createdBy: 'admin-1', lastUsedAt: null, expiresAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-06-03T00:00:00.000Z' }];
      },
      create: async (input: unknown) => {
        calls.push(['create', input]);
        return { id: 'token-2', name: 'Monitor', token: 'secret-token', prefix: 'secret', expiresAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-06-03T00:00:00.000Z' };
      },
      delete: async (tokenId: string) => {
        calls.push(['delete', tokenId]);
      },
    } as never);
    const admin = currentAdmin();

    assert.deepStrictEqual(await controller.list(), [
      { id: 'token-1', name: 'Reiwa', audience: API_TOKEN_JWT_AUDIENCE, prefix: 'abc', createdBy: 'admin-1', lastUsedAt: null, expiresAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-06-03T00:00:00.000Z' },
    ]);
    assert.deepStrictEqual(await controller.create({ name: 'Monitor' }, admin), {
      id: 'token-2',
      name: 'Monitor',
      token: 'secret-token',
      prefix: 'secret',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-06-03T00:00:00.000Z',
    });
    await controller.delete('token-2');
    assert.deepStrictEqual(calls, [
      'list',
      ['create', { name: 'Monitor', createdBy: 'admin-1' }],
      ['delete', 'token-2'],
    ]);
  });
});

function currentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'root',
    email: null,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
}
