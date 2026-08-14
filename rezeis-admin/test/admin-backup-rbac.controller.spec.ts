import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminBackupController } from '../src/modules/backup/controllers/admin-backup.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
} from './helpers/controller-routes';

describe('AdminBackupController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminBackupController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps backup routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBackupController), 'admin/backup');
    // Read off the class instead of hand-listed, so a backup endpoint added to
    // the controller fails here rather than slipping past an outdated list —
    // which is exactly how `settings` / `restore-upload` escaped this suite.
    assertRouteHandlers(AdminBackupController, [
      'create',
      'delete',
      'download',
      'getSettings',
      'list',
      'restore',
      'restoreUpload',
      'updateSettings',
    ]);
    // Noticing a new route is not the same as requiring it to be gated, and on
    // this controller the difference is the whole database. `RbacGuard` lets a
    // route with no `@RequirePermission` at any level through untouched
    // (`src/modules/rbac/guards/rbac.guard.ts:41`), so a ninth endpoint added
    // without the decorator would stream or overwrite production dumps for any
    // authenticated admin — no error, no 403, nothing to read in a log. Empty
    // list: every backup route is gated, and it stays that way by assertion.
    assertEveryRouteGuarded(AdminBackupController, []);

    const listRoute = 'GET admin/backup (list backups)';
    assertRoute(
      AdminBackupController.prototype.list,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.list,
      { resource: 'backups', action: 'view' },
      listRoute,
    );

    const createRoute = 'POST admin/backup (trigger dump)';
    assertRoute(
      AdminBackupController.prototype.create,
      { method: RequestMethod.POST, path: '/' },
      createRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.create,
      { resource: 'backups', action: 'create' },
      createRoute,
    );

    const getSettingsRoute = 'GET admin/backup/settings (read schedule)';
    assertRoute(
      AdminBackupController.prototype.getSettings,
      { method: RequestMethod.GET, path: 'settings' },
      getSettingsRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.getSettings,
      { resource: 'backups', action: 'view' },
      getSettingsRoute,
    );

    // `backups` declares no `edit` action (asserted below), so the settings
    // write reuses `create` — the only *grantable* write action on the
    // resource. `backups:edit` is not merely absent: `RbacService` rejects an
    // unknown (resource, action) pair when a role is saved, and the superadmin
    // seed is derived from the same catalog via `getAllPermissions()`, so no
    // custom role could ever hold it — the route would answer only to DEV and
    // superadmin. The web page gates this same form on `backups:create`
    // (`web/src/features/backup/backup-page.tsx`), so the stack is consistent.
    const updateSettingsRoute = 'PATCH admin/backup/settings (write schedule)';
    assertRoute(
      AdminBackupController.prototype.updateSettings,
      { method: RequestMethod.PATCH, path: 'settings' },
      updateSettingsRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.updateSettings,
      { resource: 'backups', action: 'create' },
      updateSettingsRoute,
    );

    const deleteRoute = 'DELETE admin/backup/:id (drop record and file)';
    assertRoute(
      AdminBackupController.prototype.delete,
      { method: RequestMethod.DELETE, path: ':id' },
      deleteRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.delete,
      { resource: 'backups', action: 'delete' },
      deleteRoute,
    );

    const restoreRoute = 'POST admin/backup/restore/:filename (restore from stored dump)';
    assertRoute(
      AdminBackupController.prototype.restore,
      { method: RequestMethod.POST, path: 'restore/:filename' },
      restoreRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.restore,
      { resource: 'backups', action: 'run' },
      restoreRoute,
    );

    const restoreUploadRoute = 'POST admin/backup/restore-upload (restore from uploaded dump)';
    assertRoute(
      AdminBackupController.prototype.restoreUpload,
      { method: RequestMethod.POST, path: 'restore-upload' },
      restoreUploadRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.restoreUpload,
      { resource: 'backups', action: 'run' },
      restoreUploadRoute,
    );

    const downloadRoute = 'GET admin/backup/download/:filename (stream dump)';
    assertRoute(
      AdminBackupController.prototype.download,
      { method: RequestMethod.GET, path: 'download/:filename' },
      downloadRoute,
    );
    assertRoutePermission(
      AdminBackupController.prototype.download,
      { resource: 'backups', action: 'view' },
      downloadRoute,
    );
  });

  it('declares high-risk backup permissions without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.backups, ['view', 'create', 'delete', 'run']);
    assert.equal(isValidPermission('backups', 'view'), true);
    assert.equal(isValidPermission('backups', 'create'), true);
    assert.equal(isValidPermission('backups', 'delete'), true);
    assert.equal(isValidPermission('backups', 'run'), true);
    // The catalog has no `backups:edit` — that absence is what forces
    // `PATCH settings` above onto `create`. Pinned here so introducing `edit`
    // has to be a deliberate edit of this spec and of the route it re-guards,
    // not a silent widening that leaves the endpoint on the old permission.
    assert.equal(isValidPermission('backups', 'edit'), false);

    const nonSuperadminSystemGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((permission) => permission.resource === 'backups');
    assert.deepStrictEqual(nonSuperadminSystemGrants, []);
  });
});
