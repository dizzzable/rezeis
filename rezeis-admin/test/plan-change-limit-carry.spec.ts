import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NO_RECORDED_ADD_ONS,
  resolvePlanChangeLimitCarry,
  type QuantityLimits,
  type RecordedAddOnContribution,
} from '../src/modules/subscriptions/services/plan-inherited-limits.util';

/**
 * `resolvePlanChangeLimitCarry` — what a plan change writes into the two
 * quantity columns: the new plan's values plus whatever the subscription held
 * ABOVE its old plan. The Postgres spec
 * (`plan-change-keeps-limits-above-plan-postgres.spec.ts`) proves the writers
 * use it and what reaches the panel; this pins every branch of the rule.
 */

const GIB = 1024n * 1024n * 1024n;
/** Plan A, the one the subscription is on. */
const OLD: QuantityLimits = { trafficLimit: 100, deviceLimit: 3 };
/** Plan B, the one it moves onto. */
const NEW: QuantityLimits = { trafficLimit: 500, deviceLimit: 5 };

function snapshotOf(limits: { trafficLimit: unknown; deviceLimit: unknown }): Record<string, unknown> {
  return { id: 'plan-a', ...limits, internalSquads: [], externalSquad: null };
}

function carry(
  current: QuantityLimits,
  options: {
    readonly plan?: QuantityLimits;
    readonly snapshot?: unknown;
    readonly recorded?: RecordedAddOnContribution;
  } = {},
) {
  return resolvePlanChangeLimitCarry({
    current,
    planSnapshot: options.snapshot === undefined ? snapshotOf(OLD) : options.snapshot,
    plan: options.plan ?? NEW,
    recorded: options.recorded ?? NO_RECORDED_ADD_ONS,
  });
}

const NOTHING = { trafficLimitGb: 0, deviceLimit: 0, unlimitedTraffic: false, unlimitedDevices: false };

describe('a plan change keeps what the subscription held above its old plan', () => {
  it('carries a legacy add-on — a raw increment above the old plan — onto the new plan', () => {
    const outcome = carry({ trafficLimit: 150, deviceLimit: 5 });

    assert.deepEqual(outcome.columns, { trafficLimit: 550, deviceLimit: 7 });
    assert.deepEqual(outcome.carried, { ...NOTHING, trafficLimitGb: 50, deviceLimit: 2 });
  });

  it('carries nothing for a subscription exactly on its plan', () => {
    const outcome = carry(OLD);

    assert.deepEqual(outcome.columns, NEW);
    assert.deepEqual(outcome.carried, NOTHING);
  });

  it('does not carry a limit lowered below the old plan — only a positive difference carries', () => {
    const outcome = carry({ trafficLimit: 60, deviceLimit: 2 });

    assert.deepEqual(outcome.columns, NEW, 'the new plan, not the new plan minus the cut');
    assert.deepEqual(outcome.carried, NOTHING);
  });

  it('decides each resource on its own', () => {
    assert.deepEqual(carry({ trafficLimit: 150, deviceLimit: 2 }).columns, { trafficLimit: 550, deviceLimit: 5 });
    assert.deepEqual(carry({ trafficLimit: 60, deviceLimit: 4 }).columns, { trafficLimit: 500, deviceLimit: 6 });
  });

  it('leaves an unlimited new plan unlimited, in the plan’s own encoding, and adds nothing to it', () => {
    for (const unlimitedDevices of [-1, 0]) {
      const outcome = carry(
        { trafficLimit: 150, deviceLimit: 5 },
        { plan: { trafficLimit: null, deviceLimit: unlimitedDevices } },
      );
      assert.deepEqual(outcome.columns, { trafficLimit: null, deviceLimit: unlimitedDevices });
      assert.deepEqual(outcome.carried, NOTHING, 'nothing is "kept above" unlimited');
    }
  });

  it('decides the unlimited target per resource: the finite one still carries', () => {
    const outcome = carry({ trafficLimit: 150, deviceLimit: 5 }, { plan: { trafficLimit: null, deviceLimit: 5 } });

    assert.deepEqual(outcome.columns, { trafficLimit: null, deviceLimit: 7 });
    assert.deepEqual(outcome.carried, { ...NOTHING, deviceLimit: 2 });
  });

  it('keeps an operator’s UNLIMITED over a finite old plan unlimited — what a renewal does with it', () => {
    const outcome = carry({ trafficLimit: null, deviceLimit: 0 });

    assert.deepEqual(outcome.columns, { trafficLimit: null, deviceLimit: 0 });
    assert.deepEqual(outcome.carried, { ...NOTHING, unlimitedTraffic: true, unlimitedDevices: true });
    // The column's own encoding survives: `-1` stays `-1`.
    assert.equal(carry({ trafficLimit: 100, deviceLimit: -1 }).columns.deviceLimit, -1);
  });

  it('measures nothing above an old plan that was itself unlimited', () => {
    const unlimitedOld = snapshotOf({ trafficLimit: null, deviceLimit: -1 });

    // On the unlimited plan as it gave it: nothing above it, the new plan applies.
    assert.deepEqual(carry({ trafficLimit: null, deviceLimit: -1 }, { snapshot: unlimitedOld }).columns, NEW);
    // Cut down to a finite number by hand: a lowered limit, which does not carry.
    assert.deepEqual(carry({ trafficLimit: 60, deviceLimit: 2 }, { snapshot: unlimitedOld }).columns, NEW);
  });

  it('adds the recorded add-on share back exactly once, on top of an operator’s raise', () => {
    const recorded = { activeTrafficContributionBytes: 50n * GIB, activeDeviceContribution: 2 };

    // The columns mirror base + recorded: on the plan otherwise.
    const onPlan = carry({ trafficLimit: 150, deviceLimit: 5 }, { recorded });
    assert.deepEqual(onPlan.columns, { trafficLimit: 550, deviceLimit: 7 }, '600 / 9 would count the add-on twice');
    assert.deepEqual(onPlan.carried, { ...NOTHING, trafficLimitGb: 50, deviceLimit: 2 });

    // An operator raised the base by 20 GB and 1 device besides.
    const raised = carry({ trafficLimit: 170, deviceLimit: 6 }, { recorded });
    assert.deepEqual(raised.columns, { trafficLimit: 570, deviceLimit: 8 });
  });

  it('carries the paid share even when the operator lowered the base under it', () => {
    const recorded = { activeTrafficContributionBytes: 50n * GIB, activeDeviceContribution: 2 };

    const outcome = carry({ trafficLimit: 130, deviceLimit: 4 }, { recorded });

    assert.deepEqual(outcome.columns, { trafficLimit: 550, deviceLimit: 7 });
  });

  it('measures nothing against a snapshot that cannot say what the old plan gave', () => {
    for (const snapshot of [{ id: 'plan-a' }, snapshotOf({ trafficLimit: '100', deviceLimit: 'three' }), null]) {
      assert.deepEqual(
        carry({ trafficLimit: 150, deviceLimit: 5 }, { snapshot }).columns,
        NEW,
        `snapshot ${JSON.stringify(snapshot)}`,
      );
    }
    // …though a recorded, paid share is still carried: it is known without the plan.
    const recorded = { activeTrafficContributionBytes: 50n * GIB, activeDeviceContribution: 2 };
    assert.deepEqual(carry({ trafficLimit: 150, deviceLimit: 5 }, { snapshot: { id: 'plan-a' }, recorded }).columns, {
      trafficLimit: 550,
      deviceLimit: 7,
    });
  });

  it('refuses a fractional recorded traffic share rather than rounding it into the limit', () => {
    const recorded = { activeTrafficContributionBytes: GIB + GIB / 2n, activeDeviceContribution: 0 };

    assert.equal(carry({ trafficLimit: 100, deviceLimit: 3 }, { recorded }).columns.trafficLimit, 500);
  });
});
