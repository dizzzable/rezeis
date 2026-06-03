import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminConfigPortabilityController } from '../src/modules/config-portability/controllers/admin-config-portability.controller';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';

describe('AdminConfigPortabilityController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminConfigPortabilityController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps config portability routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminConfigPortabilityController), 'admin/config');
    assertRoute(AdminConfigPortabilityController.prototype.listSections, 'sections', RequestMethod.GET, 'view');
    assertRoute(AdminConfigPortabilityController.prototype.exportConfig, 'export', RequestMethod.GET, 'export');
    assertRoute(AdminConfigPortabilityController.prototype.importConfig, 'import', RequestMethod.POST, 'import');
  });

  it('declares config portability permissions without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.config_portability, ['view', 'export', 'import']);
    assert.equal(isValidPermission('config_portability', 'view'), true);
    assert.equal(isValidPermission('config_portability', 'export'), true);
    assert.equal(isValidPermission('config_portability', 'import'), true);

    const nonSuperadminSystemGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((permission) => permission.resource === 'config_portability');
    assert.deepStrictEqual(nonSuperadminSystemGrants, []);
  });
});

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'config_portability', action },
  ]);
}
