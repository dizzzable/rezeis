import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { AdminAddOnEntitlementsController } from '../src/modules/add-on-entitlements/controllers/admin-add-on-entitlements.controller';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../src/modules/rbac/decorators/require-permission.decorator';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';

function permissionOf(method: (...args: never[]) => unknown): readonly RequiredPermission[] {
  return (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method) as RequiredPermission[]) ?? [];
}

describe('AdminAddOnEntitlementsController RBAC (T-013)', () => {
  it('declares the least-privilege remediation actions in the catalog', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.add_on_entitlements, ['view', 'run', 'resolve', 'enforce', 'moderate']);
    assert.equal(isValidPermission('add_on_entitlements', 'view'), true);
    assert.equal(isValidPermission('add_on_entitlements', 'enforce'), true);
    assert.equal(isValidPermission('add_on_entitlements', 'moderate'), true);
    assert.equal(isValidPermission('add_on_entitlements', 'delete'), false);
  });

  it('does not grant the surface to any default non-superadmin role (high-risk)', () => {
    const nonSuperadminGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((p) => p.resource === 'add_on_entitlements');
    assert.deepStrictEqual(nonSuperadminGrants, []);
  });

  it('guards both read endpoints with add_on_entitlements:view', () => {
    const proto = AdminAddOnEntitlementsController.prototype;
    assert.deepStrictEqual(permissionOf(proto.getMetrics), [{ resource: 'add_on_entitlements', action: 'view' }]);
    assert.deepStrictEqual(permissionOf(proto.inspectSubscription), [
      { resource: 'add_on_entitlements', action: 'view' },
    ]);
  });

  it('guards each mutating command with its distinct least-privilege permission', () => {
    const proto = AdminAddOnEntitlementsController.prototype;
    assert.deepStrictEqual(permissionOf(proto.retrySync), [{ resource: 'add_on_entitlements', action: 'run' }]);
    assert.deepStrictEqual(permissionOf(proto.reconcile), [{ resource: 'add_on_entitlements', action: 'resolve' }]);
    assert.deepStrictEqual(permissionOf(proto.acknowledgeIncident), [
      { resource: 'add_on_entitlements', action: 'resolve' },
    ]);
    assert.deepStrictEqual(permissionOf(proto.reverseEntitlement), [
      { resource: 'add_on_entitlements', action: 'enforce' },
    ]);
    assert.deepStrictEqual(permissionOf(proto.approveDevicePlan), [
      { resource: 'add_on_entitlements', action: 'moderate' },
    ]);
  });
});
