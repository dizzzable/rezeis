import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminConfigPortabilityController } from '../src/modules/config-portability/controllers/admin-config-portability.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
} from './helpers/controller-routes';

describe('AdminConfigPortabilityController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminConfigPortabilityController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps config portability routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminConfigPortabilityController), 'admin/config');
    // Pinned against the class, not against memory. This controller reads and
    // writes whole configuration sections, so an endpoint added here without a
    // `@RequirePermission` hands the entire config out to any authenticated
    // admin; a hand-kept list of three cannot notice a fourth.
    assertRouteHandlers(AdminConfigPortabilityController, [
      'listSections',
      'exportConfig',
      'importConfig',
    ]);
    // The comment above says a hand-kept list of three cannot notice a fourth.
    // True — and noticing it still would not require it to be GATED, which is
    // the property that matters here. `RbacGuard` passes an undecorated route
    // through (`src/modules/rbac/guards/rbac.guard.ts:41`), so a fourth
    // endpoint added without `@RequirePermission` would hand the export payload
    // — which carries webhook secrets, per the catalog comment on
    // `config_portability` — to every authenticated admin. The list is empty:
    // no route on this controller is deliberately left open.
    assertEveryRouteGuarded(AdminConfigPortabilityController, []);

    const sectionsRoute = 'GET admin/config/sections (list export sections)';
    assertRoute(
      AdminConfigPortabilityController.prototype.listSections,
      { method: RequestMethod.GET, path: 'sections' },
      sectionsRoute,
    );
    assertRoutePermission(
      AdminConfigPortabilityController.prototype.listSections,
      { resource: 'config_portability', action: 'view' },
      sectionsRoute,
    );

    const exportRoute = 'GET admin/config/export (download config payload)';
    assertRoute(
      AdminConfigPortabilityController.prototype.exportConfig,
      { method: RequestMethod.GET, path: 'export' },
      exportRoute,
    );
    assertRoutePermission(
      AdminConfigPortabilityController.prototype.exportConfig,
      { resource: 'config_portability', action: 'export' },
      exportRoute,
    );

    const importRoute = 'POST admin/config/import (apply config payload)';
    assertRoute(
      AdminConfigPortabilityController.prototype.importConfig,
      { method: RequestMethod.POST, path: 'import' },
      importRoute,
    );
    assertRoutePermission(
      AdminConfigPortabilityController.prototype.importConfig,
      { resource: 'config_portability', action: 'import' },
      importRoute,
    );
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
