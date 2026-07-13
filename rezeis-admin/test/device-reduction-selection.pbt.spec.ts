import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { selectDeviceReductionTargets } from '../src/modules/add-on-entitlements/domain/device-reduction-selection';

/**
 * Property-based invariants for the deterministic device-reduction selection.
 * A destructive saga depends on these holding for every possible panel state.
 */
describe('selectDeviceReductionTargets — properties', () => {
  const deviceArb = fc
    .uniqueArray(
      fc.record({
        hwid: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
        // Bounded epoch → deterministic, valid ISO strings.
        epoch: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      }),
      { selector: (d) => d.hwid, maxLength: 30 },
    )
    .map((rows) => rows.map((r) => ({ hwid: r.hwid, createdAt: new Date(r.epoch).toISOString() })));

  it('partitions the list exactly, with |targets| = overage and no overlap', () => {
    fc.assert(
      fc.property(deviceArb, fc.integer({ min: 0, max: 30 }), (devices, desiredLimit) => {
        const { overage, targets, retained } = selectDeviceReductionTargets(devices, desiredLimit);
        assert.equal(overage, Math.max(0, devices.length - desiredLimit));
        assert.equal(targets.length, overage);
        assert.equal(retained.length, devices.length - overage);
        const targetSet = new Set(targets.map((d) => d.hwid));
        const retainedSet = new Set(retained.map((d) => d.hwid));
        // Disjoint + cover all input hwids.
        for (const h of targetSet) assert.equal(retainedSet.has(h), false);
        assert.equal(targetSet.size + retainedSet.size, devices.length);
      }),
    );
  });

  it('never deletes more than the overage, and retained are the oldest', () => {
    fc.assert(
      fc.property(deviceArb, fc.integer({ min: 0, max: 30 }), (devices, desiredLimit) => {
        const { targets, retained } = selectDeviceReductionTargets(devices, desiredLimit);
        if (targets.length === 0 || retained.length === 0) return;
        // Every retained device is at least as old as every deleted device
        // (retention keeps the oldest; deletion removes the newest cut).
        const newestRetained = Math.max(...retained.map((d) => Date.parse(d.createdAt)));
        const oldestTarget = Math.min(...targets.map((d) => Date.parse(d.createdAt)));
        assert.equal(newestRetained <= oldestTarget, true);
      }),
    );
  });
});
