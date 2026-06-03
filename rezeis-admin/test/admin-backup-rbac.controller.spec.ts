import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminBackupController } from '../src/modules/backup/controllers/admin-backup.controller';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';

describe('AdminBackupController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminBackupController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps backup routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBackupController), 'admin/backup');
    assertRoute(AdminBackupController.prototype.list, '/', RequestMethod.GET, 'view');
    assertRoute(AdminBackupController.prototype.create, '/', RequestMethod.POST, 'create');
    assertRoute(AdminBackupController.prototype.delete, ':id', RequestMethod.DELETE, 'delete');
    assertRoute(AdminBackupController.prototype.restore, 'restore/:filename', RequestMethod.POST, 'run');
    assertRoute(AdminBackupController.prototype.download, 'download/:filename', RequestMethod.GET, 'view');
  });

  it('declares high-risk backup permissions without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.backups, ['view', 'create', 'delete', 'run']);
    assert.equal(isValidPermission('backups', 'view'), true);
    assert.equal(isValidPermission('backups', 'create'), true);
    assert.equal(isValidPermission('backups', 'delete'), true);
    assert.equal(isValidPermission('backups', 'run'), true);

    const nonSuperadminSystemGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((permission) => permission.resource === 'backups');
    assert.deepStrictEqual(nonSuperadminSystemGrants, []);
  });
});

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'backups', action },
  ]);
}
