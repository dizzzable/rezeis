import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminFraudController } from '../src/modules/anti-fraud/controllers/admin-fraud.controller';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../src/modules/rbac/decorators/require-permission.decorator';
import { RBAC_ACTIONS, RBAC_RESOURCES } from '../src/modules/rbac/rbac.resources';

function permissionOf(method: string): readonly RequiredPermission[] {
  const proto = AdminFraudController.prototype as unknown as Record<string, unknown>;
  return (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[method] as object) ??
    []) as readonly RequiredPermission[];
}

describe('anti-fraud RBAC wiring', () => {
  it('registers the enforce action in the catalog and on the fraud_signals resource', () => {
    assert.ok(RBAC_ACTIONS.includes('enforce'));
    assert.ok(RBAC_RESOURCES.fraud_signals.includes('enforce'));
  });

  it('guards the enforce endpoint with fraud_signals:enforce', () => {
    assert.deepEqual(permissionOf('enforce'), [
      { resource: 'fraud_signals', action: 'enforce' },
    ]);
  });

  it('keeps read/resolve permissions on the other endpoints', () => {
    assert.deepEqual(permissionOf('listSignals'), [
      { resource: 'fraud_signals', action: 'view' },
    ]);
    assert.deepEqual(permissionOf('getTopOffenders'), [
      { resource: 'fraud_signals', action: 'view' },
    ]);
    assert.deepEqual(permissionOf('transition'), [
      { resource: 'fraud_signals', action: 'resolve' },
    ]);
  });

  /**
   * The suppression surface reuses the existing actions rather than minting a
   * new one, and the split matches the neighbours it sits between: reading what
   * is NOT being reported is `view`, and granting an exemption is the same
   * judgement as "Dismiss — false positive", which is `resolve`. `enforce`
   * stays reserved for the one destructive panel call.
   */
  it('reads the held-candidate and exemption lists with fraud_signals:view', () => {
    assert.deepEqual(permissionOf('getPending'), [
      { resource: 'fraud_signals', action: 'view' },
    ]);
    assert.deepEqual(permissionOf('listExemptions'), [
      { resource: 'fraud_signals', action: 'view' },
    ]);
  });

  it('gates granting and revoking an exemption behind fraud_signals:resolve', () => {
    assert.deepEqual(permissionOf('createExemption'), [
      { resource: 'fraud_signals', action: 'resolve' },
    ]);
    assert.deepEqual(permissionOf('revokeExemption'), [
      { resource: 'fraud_signals', action: 'resolve' },
    ]);
  });

  it('does not let a read-only role write an exemption', () => {
    // The failure this rules out is a new endpoint landing with `view`, which
    // would let anyone who can see the fraud queue switch a detector off for a
    // user. Asserted as an inequality so it survives an action being renamed.
    for (const method of ['createExemption', 'revokeExemption']) {
      const actions = permissionOf(method).map((p) => p.action);
      assert.ok(
        !actions.includes('view'),
        `${method} must not be reachable with read-only permission`,
      );
      assert.ok(actions.length > 0, `${method} must carry a permission at all`);
    }
  });
});
