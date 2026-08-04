import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import {
  RBAC_RESOURCES,
  SYSTEM_ROLES,
  getAllPermissions,
  isValidPermission,
} from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

describe('payment_gateways:view_secrets', () => {
  it('is a distinct action on top of the ordinary gateway permissions', () => {
    // `view` and `edit` must survive: managing gateways — listing, enabling,
    // reordering, fixing a VAT code — cannot require the elevated permission.
    assert.deepStrictEqual(RBAC_RESOURCES.payment_gateways, ['view', 'view_secrets', 'edit']);
    assert.equal(isValidPermission('payment_gateways', 'view_secrets'), true);
    assert.equal(isValidPermission('payment_gateways', 'view'), true);
    assert.equal(isValidPermission('payment_gateways', 'edit'), true);
  });

  it('is part of the catalog superadmin is seeded from', () => {
    const permissions = getAllPermissions();
    assert.equal(
      permissions.some((p) => p.resource === 'payment_gateways' && p.action === 'view_secrets'),
      true,
    );
  });

  it('is granted to no system role by default, including finance', () => {
    // Same call as `payments:refund`: high-blast-radius actions are assigned
    // explicitly by the operator, never inherited from a job title. Finance
    // configures gateways; it does not need to read back the keys already set.
    for (const role of SYSTEM_ROLES) {
      assert.equal(
        role.permissions.some(
          (p) => p.resource === 'payment_gateways' && p.action === 'view_secrets',
        ),
        false,
        `system role ${role.name} must not be seeded with payment_gateways:view_secrets`,
      );
    }

    const finance = SYSTEM_ROLES.find((role) => role.name === 'finance');
    // …while the ordinary gateway management permissions stay intact.
    assert.equal(
      finance?.permissions.some((p) => p.resource === 'payment_gateways' && p.action === 'view'),
      true,
    );
    assert.equal(
      finance?.permissions.some((p) => p.resource === 'payment_gateways' && p.action === 'edit'),
      true,
    );
  });

  it('is withheld from a legacy bare-ADMIN that inherits the whole resource', () => {
    // `payment_gateways` is on the legacy allowlist and a bare ADMIN inherits
    // EVERY action of an allowed resource, so without an explicit denial the
    // new action would have handed every pre-RBAC admin the plaintext keys —
    // the exact exposure it exists to close.
    const service = new RbacService({} as never);
    const legacyAdmin = { id: 'admin-1', role: UserRole.ADMIN, rbacRoleId: null };

    return Promise.all([
      service.hasPermission(legacyAdmin, 'payment_gateways', 'view_secrets'),
      service.hasPermission(legacyAdmin, 'payment_gateways', 'view'),
      service.hasPermission(legacyAdmin, 'payment_gateways', 'edit'),
    ]).then(([canViewSecrets, canView, canEdit]) => {
      assert.equal(canViewSecrets, false);
      // The day-to-day surface is untouched.
      assert.equal(canView, true);
      assert.equal(canEdit, true);
    });
  });
});
