import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability, PlanType, Prisma, SubscriptionStatus, TrafficLimitStrategy } from '@prisma/client';

import {
  buildMigratedPlanSnapshot,
  computePlanMigration,
  describeMigrationOwnership,
  diffLimits,
  numericColumnsFromProjection,
  pushesToRemnawave,
  type MigrationSubscriptionState,
  type MigrationTargetPlan,
} from '../src/modules/plans/migrations/plan-migration-compute.util';
import { GIB_BYTES } from '../src/modules/add-on-entitlements/domain/cutover-baseline';
import {
  NO_RECORDED_ADD_ONS,
  resolveInheritedPlanLimitRefresh,
  resolvePlanLimitOwnership,
  type RecordedAddOnContribution,
} from '../src/modules/subscriptions/services/plan-inherited-limits.util';

/**
 * The one computation the preview and the move share. Every case builds P's
 * snapshot the way a purchase writes it, then moves the row to Q, and reads the
 * result the way the SPA and the database would.
 */

const SQUAD_A = '11111111-1111-1111-1111-111111111111';
const SQUAD_B = '22222222-2222-2222-2222-222222222222';
const SQUAD_C = '33333333-3333-3333-3333-333333333333';
const EXTERNAL_P = '44444444-4444-4444-4444-444444444444';
const EXTERNAL_Q = '55555555-5555-5555-5555-555555555555';

/** P as a purchase snapshot records it, plus the keys a move must keep. */
function snapshotOfP(overrides: Record<string, unknown> = {}): Prisma.JsonObject {
  return {
    id: 'plan-p',
    name: 'Plan P',
    description: 'old',
    tag: 'P_TAG',
    type: 'BOTH',
    icon: 'rocket',
    trafficLimit: 100,
    deviceLimit: 3,
    trafficLimitStrategy: 'MONTH',
    internalSquads: [SQUAD_A, SQUAD_B],
    externalSquad: EXTERNAL_P,
    selectedDurationDays: 90,
    purchaseType: 'NEW',
    amount: '499',
    currency: 'RUB',
    gatewayType: 'YOOKASSA',
    snapshotSource: 'PAYMENT_COMPLETION',
    ...overrides,
  } as Prisma.JsonObject;
}

function planQ(overrides: Partial<MigrationTargetPlan> = {}): MigrationTargetPlan {
  return {
    id: 'plan-q',
    name: 'Plan Q',
    deletedAt: null,
    description: 'new',
    tag: 'Q_TAG',
    type: PlanType.TRAFFIC,
    icon: 'star',
    availability: PlanAvailability.ALL,
    trialSettings: {},
    trafficLimit: 50,
    deviceLimit: 2,
    trafficLimitStrategy: TrafficLimitStrategy.WEEK,
    internalSquads: [SQUAD_C],
    externalSquad: EXTERNAL_Q,
    ...overrides,
  };
}

/** A subscription whose four columns still equal what P gave it. */
function onP(overrides: Partial<MigrationSubscriptionState> = {}): MigrationSubscriptionState {
  return {
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    remnawaveId: '9001',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [SQUAD_A, SQUAD_B],
    externalSquad: EXTERNAL_P,
    planSnapshot: snapshotOfP(),
    ...overrides,
  };
}

function move(
  subscription: MigrationSubscriptionState,
  options: {
    readonly target?: MigrationTargetPlan;
    readonly recorded?: RecordedAddOnContribution;
    readonly targetRenewable?: boolean;
    readonly pendingRenewalForSource?: boolean;
  } = {},
) {
  return computePlanMigration({
    subscription,
    target: options.target ?? planQ(),
    recorded: options.recorded ?? NO_RECORDED_ADD_ONS,
    targetRenewable: options.targetRenewable ?? true,
    pendingRenewalForSource: options.pendingRenewalForSource ?? false,
  });
}

/** Ownership of the row AS THE MOVE LEAVES IT, by the renewal's own reader. */
function ownershipAfter(
  result: ReturnType<typeof move>,
  recorded: RecordedAddOnContribution = NO_RECORDED_ADD_ONS,
) {
  return resolvePlanLimitOwnership({
    current: result.after,
    planSnapshot: result.planSnapshot,
    recorded,
  }).ownership;
}

describe('inherited limits take the target plan, individual ones are kept', () => {
  it('moves every inherited field to Q and keeps nothing', () => {
    const result = move(onP());

    assert.deepEqual(result.ownership, {
      trafficLimit: 'INHERITED',
      deviceLimit: 'INHERITED',
      squads: 'INHERITED',
      internalSquads: 'INHERITED',
      externalSquad: 'INHERITED',
    });
    assert.deepEqual(result.after, {
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: [SQUAD_C],
      externalSquad: EXTERNAL_Q,
      isTrial: false,
    });
    assert.deepEqual(result.kept, []);
  });

  it('keeps an individually raised traffic limit and moves the rest', () => {
    const result = move(onP({ trafficLimit: 150 }));

    assert.equal(result.ownership.trafficLimit, 'INDIVIDUAL');
    assert.equal(result.after.trafficLimit, 150, 'the operator-set traffic limit must survive the move');
    assert.equal(result.after.deviceLimit, 2);
    assert.deepEqual(result.kept, ['trafficLimit']);
    assert.deepEqual(result.individualKeys, ['trafficLimit']);
    assert.equal(result.planSnapshot['trafficLimit'], 100, 'a kept key keeps its old snapshot value');
    assert.equal(result.planSnapshot['deviceLimit'], 2, 'a moved key records what Q gives');
  });

  it('keeps an individual device limit even when it is LOWER than Q', () => {
    const result = move(onP({ deviceLimit: 1 }), { target: planQ({ deviceLimit: 6 }) });

    assert.equal(result.ownership.deviceLimit, 'INDIVIDUAL');
    assert.equal(result.after.deviceLimit, 1);
    assert.deepEqual(result.kept, ['deviceLimit']);
    assert.equal(result.warnings.includes('FEWER_DEVICES'), false);
  });

  it('keeps individual internal squads and still moves an inherited external squad', () => {
    const result = move(onP({ internalSquads: [SQUAD_B] }));

    assert.equal(result.ownership.internalSquads, 'INDIVIDUAL');
    assert.equal(result.ownership.externalSquad, 'INHERITED');
    assert.equal(result.ownership.squads, 'INDIVIDUAL');
    assert.deepEqual(result.after.internalSquads, [SQUAD_B]);
    assert.equal(result.after.externalSquad, EXTERNAL_Q);
    assert.deepEqual(result.kept, ['squads']);
  });

  it('keeps an individual external squad', () => {
    const result = move(onP({ externalSquad: null }));

    assert.equal(result.ownership.externalSquad, 'INDIVIDUAL');
    assert.equal(result.after.externalSquad, null);
    assert.deepEqual(result.after.internalSquads, [SQUAD_C]);
    assert.deepEqual(result.kept, ['squads']);
  });

  it('reads a reordered but identical squad list as inherited', () => {
    const result = move(onP({ internalSquads: [SQUAD_B, SQUAD_A] }));
    assert.equal(result.ownership.internalSquads, 'INHERITED');
    assert.deepEqual(result.after.internalSquads, [SQUAD_C]);
  });

  it('leaves the row reading INHERITED for moved fields and INDIVIDUAL for kept ones', () => {
    // "INDIVIDUAL fields get Q's value in the snapshot while the column stays,
    // so they remain INDIVIDUAL by the resolver's rule" — checked against the
    // resolver itself rather than restated.
    const result = move(onP({ deviceLimit: 7, externalSquad: null }));
    assert.deepEqual(ownershipAfter(result), {
      trafficLimit: 'INHERITED',
      deviceLimit: 'OVERRIDDEN',
      internalSquads: 'INHERITED',
      externalSquad: 'OVERRIDDEN',
    });
  });

  it('keeps an individual value individual even when it equals Q’s own value', () => {
    // P gives 3 devices, the operator set 5, Q also gives 5. Writing Q's 5 into
    // the snapshot would make column == snapshot and hand the field to Q.
    const result = move(onP({ deviceLimit: 5 }), { target: planQ({ deviceLimit: 5 }) });
    assert.equal(result.ownership.deviceLimit, 'INDIVIDUAL');
    assert.equal(result.after.deviceLimit, 5);
    assert.deepEqual(result.kept, ['deviceLimit']);
    assert.equal(result.planSnapshot['deviceLimit'], 3, 'the old snapshot value stays');
    assert.equal(ownershipAfter(result).deviceLimit, 'OVERRIDDEN');
  });

  it('survives a later edit of Q carried by a renewal — the refresh leaves the individual value alone', () => {
    const result = move(onP({ deviceLimit: 5, internalSquads: [SQUAD_A] }), {
      target: planQ({ deviceLimit: 5, internalSquads: [SQUAD_A] }),
    });
    assert.deepEqual(result.kept, ['deviceLimit', 'squads']);

    // The operator later lowers Q to 3 devices and changes its squads; the
    // subscription renews on Q through the renewal's own refresh.
    const editedQ = { trafficLimit: 50, deviceLimit: 3, internalSquads: [SQUAD_C], externalSquad: EXTERNAL_Q };
    const refresh = resolveInheritedPlanLimitRefresh({
      current: result.after,
      planSnapshot: result.planSnapshot,
      plan: editedQ,
      recorded: NO_RECORDED_ADD_ONS,
    });
    assert.equal(refresh.ownership.deviceLimit, 'OVERRIDDEN');
    assert.equal('deviceLimit' in refresh.columns, false, 'the renewal must not write the plan’s 3 over the operator’s 5');
    assert.equal('internalSquads' in refresh.columns, false, 'nor the plan’s squads over the operator’s');
    assert.equal(refresh.columns.trafficLimit, 50, 'an inherited field still follows Q');
    assert.equal(refresh.columns.externalSquad, EXTERNAL_Q);
  });
});

describe('the recorded add-on share rides on top of the target plan', () => {
  const addOns: RecordedAddOnContribution = {
    activeTrafficContributionBytes: 20n * GIB_BYTES,
    activeDeviceContribution: 2,
  };

  it('moves an inherited base and keeps the add-on share in the column', () => {
    const result = move(onP({ trafficLimit: 120, deviceLimit: 5 }), { recorded: addOns });

    assert.equal(result.ownership.trafficLimit, 'INHERITED');
    assert.equal(result.ownership.deviceLimit, 'INHERITED');
    assert.equal(result.after.trafficLimit, 70, 'Q 50 GiB + the 20 GiB add-on');
    assert.equal(result.after.deviceLimit, 4, 'Q 2 devices + the 2-device add-on');
    assert.equal(result.planSnapshot['trafficLimit'], 50, 'the snapshot carries Q alone, never the add-on');
    assert.equal(result.planSnapshot['deviceLimit'], 2);
    assert.deepEqual(ownershipAfter(result, addOns), {
      trafficLimit: 'INHERITED',
      deviceLimit: 'INHERITED',
      internalSquads: 'INHERITED',
      externalSquad: 'INHERITED',
    });
  });

  it('keeps an individual base with its add-on share untouched', () => {
    const result = move(onP({ trafficLimit: 220 }), { recorded: addOns });
    assert.equal(result.ownership.trafficLimit, 'INDIVIDUAL');
    assert.equal(result.after.trafficLimit, 220);
    assert.equal(ownershipAfter(result, addOns).trafficLimit, 'OVERRIDDEN');
  });

  it('adds the share to Q for an UNKNOWN field too', () => {
    const snapshot = snapshotOfP();
    delete (snapshot as Record<string, unknown>)['deviceLimit'];
    const result = move(onP({ deviceLimit: 9, planSnapshot: snapshot }), { recorded: addOns });

    assert.equal(result.ownership.deviceLimit, 'UNKNOWN');
    assert.equal(result.after.deviceLimit, 4, 'Q 2 + the recorded 2-device share');
    assert.ok(result.warnings.includes('UNKNOWN_LIMIT_TAKES_TARGET'));
  });

  it('lets an unlimited target absorb the share', () => {
    const result = move(onP({ trafficLimit: 120, deviceLimit: 5 }), {
      recorded: addOns,
      target: planQ({ trafficLimit: null, deviceLimit: -1 }),
    });
    assert.equal(result.after.trafficLimit, null);
    assert.equal(result.after.deviceLimit, -1);
  });
});

describe('unlimited encodings', () => {
  it('reads traffic null as unlimited: finite Q is LESS_TRAFFIC, unlimited Q is not', () => {
    const fromUnlimited = move(
      onP({ trafficLimit: null, planSnapshot: snapshotOfP({ trafficLimit: null }) }),
    );
    assert.equal(fromUnlimited.ownership.trafficLimit, 'INHERITED');
    assert.equal(fromUnlimited.after.trafficLimit, 50);
    assert.ok(fromUnlimited.warnings.includes('LESS_TRAFFIC'));

    const toUnlimited = move(onP(), { target: planQ({ trafficLimit: null }) });
    assert.equal(toUnlimited.after.trafficLimit, null);
    assert.equal(toUnlimited.warnings.includes('LESS_TRAFFIC'), false);
  });

  it('reads 0 GiB as a finite budget, not unlimited', () => {
    const result = move(onP(), { target: planQ({ trafficLimit: 0 }) });
    assert.equal(result.after.trafficLimit, 0);
    assert.ok(result.warnings.includes('LESS_TRAFFIC'));
  });

  it('reads devices <= 0 as unlimited on both sides of FEWER_DEVICES', () => {
    const fromUnlimited = move(onP({ deviceLimit: -1, planSnapshot: snapshotOfP({ deviceLimit: -1 }) }));
    assert.equal(fromUnlimited.after.deviceLimit, 2);
    assert.ok(fromUnlimited.warnings.includes('FEWER_DEVICES'), 'unlimited → 2 is fewer devices');

    const zeroToUnlimited = move(onP({ deviceLimit: 0, planSnapshot: snapshotOfP({ deviceLimit: 0 }) }), {
      target: planQ({ deviceLimit: -1 }),
    });
    assert.equal(zeroToUnlimited.after.deviceLimit, -1);
    assert.equal(zeroToUnlimited.warnings.includes('FEWER_DEVICES'), false);

    const toUnlimited = move(onP(), { target: planQ({ deviceLimit: 0 }) });
    assert.equal(toUnlimited.warnings.includes('FEWER_DEVICES'), false);

    const more = move(onP(), { target: planQ({ deviceLimit: 5 }) });
    assert.equal(more.warnings.includes('FEWER_DEVICES'), false);
  });
});

describe('UNKNOWN ownership takes the target plan', () => {
  it('moves every field of a row whose snapshot is not an object', () => {
    for (const planSnapshot of [null, [], 'x', {}] as Prisma.JsonValue[]) {
      const result = move(onP({ planSnapshot }));
      assert.equal(result.ownership.trafficLimit, 'UNKNOWN', JSON.stringify(planSnapshot));
      assert.equal(result.ownership.squads, 'UNKNOWN');
      assert.deepEqual(result.after, {
        trafficLimit: 50,
        deviceLimit: 2,
        internalSquads: [SQUAD_C],
        externalSquad: EXTERNAL_Q,
        isTrial: false,
      });
      assert.deepEqual(result.kept, []);
      assert.ok(result.warnings.includes('UNKNOWN_LIMIT_TAKES_TARGET'));
      assert.equal(result.planSnapshot['id'], 'plan-q');
    }
  });

  it('does not warn when an UNKNOWN field already holds Q’s value', () => {
    const result = move(
      onP({
        trafficLimit: 50,
        deviceLimit: 2,
        internalSquads: [SQUAD_C],
        externalSquad: EXTERNAL_Q,
        planSnapshot: { id: 'plan-p', importRecordId: 'imp-1' },
      }),
    );
    assert.equal(result.ownership.trafficLimit, 'UNKNOWN');
    assert.equal(result.warnings.includes('UNKNOWN_LIMIT_TAKES_TARGET'), false);
    assert.deepEqual(result.limitChanges, {});
  });
});

describe('squads removed', () => {
  it('warns when an internal squad disappears or the external squad changes', () => {
    assert.ok(move(onP()).warnings.includes('SQUADS_REMOVED'));
    const externalOnly = move(onP(), { target: planQ({ internalSquads: [SQUAD_A, SQUAD_B, SQUAD_C] }) });
    assert.ok(externalOnly.warnings.includes('SQUADS_REMOVED'), 'P external squad replaced');
  });

  it('does not warn when Q only adds squads', () => {
    const result = move(
      onP({ externalSquad: null, planSnapshot: snapshotOfP({ externalSquad: null }) }),
      { target: planQ({ internalSquads: [SQUAD_B, SQUAD_A, SQUAD_C] }) },
    );
    assert.equal(result.after.externalSquad, EXTERNAL_Q);
    assert.equal(result.warnings.includes('SQUADS_REMOVED'), false);
  });
});

describe('a trial becomes a regular subscription', () => {
  it('clears isTrial and says so', () => {
    const result = move(onP({ isTrial: true }));
    assert.equal(result.before.isTrial, true);
    assert.equal(result.after.isTrial, false);
    assert.ok(result.warnings.includes('TRIAL_BECOMES_REGULAR'));
  });

  it('never SETS the flag, even for a target that is (wrongly) a trial plan', () => {
    const result = move(onP({ isTrial: false }), {
      target: planQ({ availability: PlanAvailability.TRIAL }),
    });
    assert.equal(result.after.isTrial, false);
    assert.equal(result.warnings.includes('TRIAL_BECOMES_REGULAR'), false);
  });
});

describe('what reaches Remnawave now', () => {
  it('pushes only linked ACTIVE and LIMITED rows; everything else is LOCAL_ONLY', () => {
    const cases: Array<[SubscriptionStatus, string | null, boolean]> = [
      [SubscriptionStatus.ACTIVE, '1', true],
      [SubscriptionStatus.LIMITED, '1', true],
      [SubscriptionStatus.EXPIRED, '1', false],
      [SubscriptionStatus.DISABLED, '1', false],
      [SubscriptionStatus.ACTIVE, null, false],
    ];
    for (const [status, remnawaveId, pushes] of cases) {
      const result = move(onP({ status, remnawaveId }));
      assert.equal(result.pushesToRemnawave, pushes, `${status}/${remnawaveId}`);
      assert.equal(pushesToRemnawave({ status, remnawaveId }), pushes);
      assert.equal(result.warnings.includes('LOCAL_ONLY'), !pushes, `${status}/${remnawaveId}`);
    }
  });

  it('passes the renewal flags through as warnings', () => {
    const result = move(onP(), { targetRenewable: false, pendingRenewalForSource: true });
    assert.ok(result.warnings.includes('TARGET_NOT_RENEWABLE'));
    assert.ok(result.warnings.includes('PENDING_RENEWAL_FOR_SOURCE'));
    const clean = move(onP(), { target: planQ({ internalSquads: [SQUAD_A, SQUAD_B], externalSquad: EXTERNAL_P, trafficLimit: 100, deviceLimit: 3 }) });
    assert.deepEqual(clean.warnings, []);
  });
});

describe('the snapshot is merged, never rebuilt', () => {
  it('keeps selectedDurationDays, import and payment keys, and writes Q over P', () => {
    const stored = snapshotOfP({ importRecordId: 'imp-7', importedFrom: 'remnashop' });
    const snapshot = move(onP({ planSnapshot: stored })).planSnapshot;

    assert.equal(snapshot['selectedDurationDays'], 90, 'renewal picks its duration from this key');
    assert.equal(snapshot['importRecordId'], 'imp-7');
    assert.equal(snapshot['importedFrom'], 'remnashop');
    assert.equal(snapshot['amount'], '499');
    assert.equal(snapshot['currency'], 'RUB');
    assert.equal(snapshot['gatewayType'], 'YOOKASSA');
    assert.equal(snapshot['snapshotSource'], 'PAYMENT_COMPLETION');
    assert.deepEqual(
      {
        id: snapshot['id'],
        name: snapshot['name'],
        description: snapshot['description'],
        tag: snapshot['tag'],
        type: snapshot['type'],
        icon: snapshot['icon'],
        trafficLimitStrategy: snapshot['trafficLimitStrategy'],
        trafficLimit: snapshot['trafficLimit'],
        deviceLimit: snapshot['deviceLimit'],
        internalSquads: snapshot['internalSquads'],
        externalSquad: snapshot['externalSquad'],
      },
      {
        id: 'plan-q',
        name: 'Plan Q',
        description: 'new',
        tag: 'Q_TAG',
        type: 'TRAFFIC',
        icon: 'star',
        trafficLimitStrategy: 'WEEK',
        trafficLimit: 50,
        deviceLimit: 2,
        internalSquads: [SQUAD_C],
        externalSquad: EXTERNAL_Q,
      },
    );
    assert.equal('planId' in snapshot, false, 'planId is written only where it already exists');
    assert.equal('availability' in snapshot, false);
    assert.equal('trialSettings' in snapshot, false);
  });

  it('rewrites planId, availability and trialSettings only where the snapshot carries them', () => {
    const stored = snapshotOfP({ planId: 'plan-p', availability: 'TRIAL', trialSettings: { free: true } });
    const snapshot = buildMigratedPlanSnapshot(stored, planQ({ trialSettings: { maxClaims: 2 } }));
    assert.equal(snapshot['planId'], 'plan-q', 'a re-imported row left on planId P would still count as on P');
    assert.equal(snapshot['availability'], 'ALL');
    assert.deepEqual(snapshot['trialSettings'], { maxClaims: 2 });
  });

  it('does not alias the target’s squad array', () => {
    const target = planQ();
    const snapshot = buildMigratedPlanSnapshot(snapshotOfP(), target);
    (snapshot['internalSquads'] as string[]).push('mutated');
    assert.deepEqual(target.internalSquads, [SQUAD_C]);
  });
});

describe('numeric columns after a term rotation', () => {
  it('mirrors the projection and keeps the unlimited spelling the computation chose', () => {
    assert.deepEqual(
      numericColumnsFromProjection({ desiredTrafficLimitBytes: 70n * GIB_BYTES, desiredDeviceLimit: 4 }, { deviceLimit: 4 }),
      { trafficLimit: 70, deviceLimit: 4 },
    );
    assert.deepEqual(
      numericColumnsFromProjection({ desiredTrafficLimitBytes: null, desiredDeviceLimit: null }, { deviceLimit: -1 }),
      { trafficLimit: null, deviceLimit: -1 },
    );
    assert.deepEqual(
      numericColumnsFromProjection({ desiredTrafficLimitBytes: 0n, desiredDeviceLimit: null }, { deviceLimit: 0 }),
      { trafficLimit: 0, deviceLimit: 0 },
    );
    assert.deepEqual(
      numericColumnsFromProjection({ desiredTrafficLimitBytes: null, desiredDeviceLimit: null }, { deviceLimit: 5 }),
      { trafficLimit: null, deviceLimit: 0 },
    );
    assert.deepEqual(
      numericColumnsFromProjection({ desiredTrafficLimitBytes: null, desiredDeviceLimit: 3 }, { deviceLimit: 4 }),
      { trafficLimit: null, deviceLimit: 3 },
      'the projection wins over the preview arithmetic when the live ledger moved',
    );
  });
});

describe('the audit diff lists only the keys that change', () => {
  it('compares squads as sets and omits unchanged fields', () => {
    assert.deepEqual(
      diffLimits(
        { trafficLimit: 10, deviceLimit: 2, internalSquads: [SQUAD_A, SQUAD_B], externalSquad: null },
        { trafficLimit: 10, deviceLimit: 3, internalSquads: [SQUAD_B, SQUAD_A], externalSquad: EXTERNAL_Q },
      ),
      { deviceLimit: { from: 2, to: 3 }, externalSquad: { from: null, to: EXTERNAL_Q } },
    );
    const moved = move(onP({ trafficLimit: 150 }));
    assert.deepEqual(Object.keys(moved.limitChanges).sort(), ['deviceLimit', 'externalSquad', 'internalSquads']);
  });
});

describe('ownership for the listing', () => {
  it('is the same verdict the move reaches', () => {
    const subscription = onP({ trafficLimit: 150, planSnapshot: snapshotOfP({ externalSquad: undefined }) });
    const listed = describeMigrationOwnership(subscription, NO_RECORDED_ADD_ONS);
    assert.deepEqual(listed, move(subscription).ownership);
    assert.equal(listed.trafficLimit, 'INDIVIDUAL');
  });
});
