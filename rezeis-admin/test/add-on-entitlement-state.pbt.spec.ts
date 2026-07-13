import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import {
  EntitlementCommand,
  EntitlementState,
  EntitlementStateError,
  transitionEntitlementState,
} from '../src/modules/add-on-entitlements/domain/add-on-entitlement-state';

const states: EntitlementState[] = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'EXPIRING',
  'EXPIRED',
  'REVERSED',
  'REMEDIATION_REQUIRED',
];
const commands: EntitlementCommand[] = [
  'ACTIVATE',
  'BEGIN_EXPIRY',
  'COMPLETE_EXPIRY',
  'REMEDIATE',
  'REVERSE',
];

describe('add-on entitlement state machine properties', () => {
  it('is deterministic and preserves event invariants for every state/command pair', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<EntitlementState>(...states),
        fc.constantFrom<EntitlementCommand>(...commands),
        (state, command) => {
          let first: ReturnType<typeof transitionEntitlementState> | null = null;
          let error: unknown = null;

          try {
            first = transitionEntitlementState(state, command);
          } catch (candidate) {
            error = candidate;
          }

          if (error !== null) {
            assert.equal(first, null);
            assert.ok(error instanceof EntitlementStateError);
            assert.equal(error.code, 'INVALID_TRANSITION');
            assert.throws(() => transitionEntitlementState(state, command), EntitlementStateError);
            return;
          }

          assert.ok(first);
          const repeated = transitionEntitlementState(state, command);
          assert.deepEqual(first, repeated);

          if (first.changed) {
            assert.ok(first.event);
            assert.equal(first.event.from, state);
            assert.equal(first.event.to, first.state);
            assert.equal(first.event.command, command);
          } else {
            assert.equal(first.state, state);
            assert.equal(first.event, null);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
