import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EntitlementStateError,
  transitionEntitlementState,
} from '../src/modules/add-on-entitlements/domain/add-on-entitlement-state';

describe('add-on entitlement state machine', () => {
  it('activates a scheduled entitlement and emits one transition event', () => {
    assert.deepEqual(
      transitionEntitlementState('PENDING_ACTIVATION', 'ACTIVATE'),
      {
        state: 'ACTIVE',
        changed: true,
        event: { from: 'PENDING_ACTIVATION', to: 'ACTIVE', command: 'ACTIVATE' },
      },
    );
  });

  it('makes duplicate activation idempotent without emitting another event', () => {
    assert.deepEqual(transitionEntitlementState('ACTIVE', 'ACTIVATE'), {
      state: 'ACTIVE',
      changed: false,
      event: null,
    });
  });

  it('runs expiry through EXPIRING before EXPIRED', () => {
    assert.deepEqual(transitionEntitlementState('ACTIVE', 'BEGIN_EXPIRY'), {
      state: 'EXPIRING',
      changed: true,
      event: { from: 'ACTIVE', to: 'EXPIRING', command: 'BEGIN_EXPIRY' },
    });
    assert.deepEqual(transitionEntitlementState('EXPIRING', 'COMPLETE_EXPIRY'), {
      state: 'EXPIRED',
      changed: true,
      event: { from: 'EXPIRING', to: 'EXPIRED', command: 'COMPLETE_EXPIRY' },
    });
    assert.deepEqual(transitionEntitlementState('EXPIRED', 'COMPLETE_EXPIRY'), {
      state: 'EXPIRED',
      changed: false,
      event: null,
    });
  });

  it('routes recoverable lifecycle failures to remediation idempotently', () => {
    assert.deepEqual(transitionEntitlementState('PENDING_ACTIVATION', 'REMEDIATE'), {
      state: 'REMEDIATION_REQUIRED',
      changed: true,
      event: {
        from: 'PENDING_ACTIVATION',
        to: 'REMEDIATION_REQUIRED',
        command: 'REMEDIATE',
      },
    });
    assert.deepEqual(transitionEntitlementState('REMEDIATION_REQUIRED', 'REMEDIATE'), {
      state: 'REMEDIATION_REQUIRED',
      changed: false,
      event: null,
    });
  });

  it('allows explicit compensation reversal from every non-terminal service state', () => {
    assert.equal(transitionEntitlementState('PENDING_ACTIVATION', 'REVERSE').state, 'REVERSED');
    assert.equal(transitionEntitlementState('ACTIVE', 'REVERSE').state, 'REVERSED');
    assert.equal(transitionEntitlementState('EXPIRING', 'REVERSE').state, 'REVERSED');
    assert.equal(transitionEntitlementState('EXPIRED', 'REVERSE').state, 'REVERSED');
    assert.deepEqual(transitionEntitlementState('REVERSED', 'REVERSE'), {
      state: 'REVERSED',
      changed: false,
      event: null,
    });
  });

  it('rejects illegal transitions without changing the previous state', () => {
    assert.throws(
      () => transitionEntitlementState('PENDING_ACTIVATION', 'COMPLETE_EXPIRY'),
      (error: unknown) =>
        error instanceof EntitlementStateError && error.code === 'INVALID_TRANSITION',
    );
    assert.throws(
      () => transitionEntitlementState('REVERSED', 'ACTIVATE'),
      (error: unknown) =>
        error instanceof EntitlementStateError && error.code === 'INVALID_TRANSITION',
    );
    assert.throws(
      () => transitionEntitlementState('REMEDIATION_REQUIRED', 'ACTIVATE'),
      (error: unknown) =>
        error instanceof EntitlementStateError && error.code === 'INVALID_TRANSITION',
    );
  });
});
