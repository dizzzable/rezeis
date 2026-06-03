import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminApiTokensController } from '../src/modules/api-tokens/controllers/admin-api-tokens.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RBAC_RESOURCES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import { API_TOKEN_JWT_AUDIENCE } from '../src/modules/auth/constants/api-token-auth.constants';

describe('AdminApiTokensController', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminApiTokensController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps API token routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminApiTokensController), 'admin/api-tokens');
    assertRoute(AdminApiTokensController.prototype.list, '/', RequestMethod.GET, 'view');
    assertRoute(AdminApiTokensController.prototype.create, '/', RequestMethod.POST, 'create');
    assertRoute(AdminApiTokensController.prototype.delete, ':tokenId', RequestMethod.DELETE, 'delete');
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

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'api_tokens', action },
  ]);
}

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
