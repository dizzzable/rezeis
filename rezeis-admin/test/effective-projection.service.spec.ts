import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';

import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';

type Term = {
  id: string;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
};
type Contribution = { type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'; totalValue: bigint };
type Projection = {
  id: string;
  baselineTermId: string;
  desiredRevision: bigint;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  activeTrafficContributionBytes: bigint;
  activeDeviceContribution: number;
  desiredTrafficLimitBytes: bigint | null;
  desiredDeviceLimit: number | null;
  state: string;
};

/**
 * The subscription row the recompute reads to decide which limit fields the
 * OPERATOR owns. The default is the shape a fresh row actually has —
 * `planSnapshot` defaults to `{}` in the schema — which carries none of the
 * four keys and is therefore UNDECIDABLE, leaving the term baseline in force.
 */
type SubscriptionRow = {
  trafficLimit: number | null;
  deviceLimit: number;
  planSnapshot: unknown;
};

function build(options: {
  status?: 'ACTIVE' | 'DELETED';
  activeTerms?: Term[];
  contributions?: Contribution[];
  existing?: Projection | null;
  subscription?: SubscriptionRow | null;
}) {
  const creates: Array<{ data: Record<string, unknown> }> = [];
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const stats = { subscriptionReads: 0 };
  let queryRawCall = 0;
  const tx = {
    $queryRaw: async () => {
      queryRawCall += 1;
      // 1st raw query: subscription lock; 2nd: active term(s).
      if (queryRawCall === 1) {
        return [{ id: 'sub-1', status: options.status ?? 'ACTIVE' }];
      }
      return options.activeTerms ?? [{ id: 'term-1', baseTrafficLimitBytes: null, baseDeviceLimit: null }];
    },
    subscription: {
      findUnique: async () => {
        stats.subscriptionReads += 1;
        if (options.subscription === null) return null;
        return (
          options.subscription ?? { trafficLimit: null, deviceLimit: 0, planSnapshot: {} }
        );
      },
    },
    addOnEntitlement: {
      findMany: async () => options.contributions ?? [],
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => options.existing ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        creates.push(args);
        return args.data;
      },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...(options.existing ?? {}), ...args.data };
      },
    },
  };
  return { service: new EffectiveProjectionService(), tx, creates, updates, stats };
}

/** A projection row as the previous recompute left it. */
function priorProjection(patch: Partial<Projection> = {}): Projection {
  return {
    id: 'proj-1',
    baselineTermId: 'term-1',
    desiredRevision: 4n,
    baseTrafficLimitBytes: null,
    baseDeviceLimit: 3,
    activeTrafficContributionBytes: 0n,
    activeDeviceContribution: 0,
    desiredTrafficLimitBytes: null,
    desiredDeviceLimit: 3,
    state: 'PENDING',
    ...patch,
  };
}

describe('EffectiveProjectionService.recomputeInTransaction', () => {
  it('creates a shadow baseline projection at revision 0 for an unlimited-traffic term', async () => {
    const { service, tx, creates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: null, baseDeviceLimit: 3 }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: 2n }],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.desiredRevision, 0n);
    assert.equal(result.state, 'SHADOW');
    assert.equal(result.changed, true);
    // Unlimited traffic base is absorbing → stays unlimited despite no traffic add-ons.
    assert.equal(result.desiredTrafficLimitBytes, null);
    // Devices: base 3 + 2 contributed = 5.
    assert.equal(result.desiredDeviceLimit, 5);
    assert.equal(result.activeDeviceContribution, 2);
    assert.equal(result.activeTrafficContributionBytes, 0n);
    assert.equal(creates.length, 1);
    assert.equal((creates[0]!.data as { desiredRevision: bigint }).desiredRevision, 0n);
  });

  it('sums finite traffic contributions in bytes on top of the baseline', async () => {
    const gb = 1024n * 1024n * 1024n;
    const { service, tx } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n * gb, baseDeviceLimit: 5 }],
      contributions: [
        { type: 'EXTRA_TRAFFIC', totalValue: 50n * gb },
        { type: 'EXTRA_TRAFFIC', totalValue: 10n * gb },
      ],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.desiredTrafficLimitBytes, 160n * gb);
    assert.equal(result.activeTrafficContributionBytes, 60n * gb);
    assert.equal(result.desiredDeviceLimit, 5);
  });

  it('is value-idempotent: identical desired state does not advance the revision', async () => {
    const existing: Projection = {
      id: 'proj-1',
      baselineTermId: 'term-1',
      desiredRevision: 7n,
      baseTrafficLimitBytes: 100n,
      baseDeviceLimit: 2,
      activeTrafficContributionBytes: 50n,
      activeDeviceContribution: 1,
      desiredTrafficLimitBytes: 150n,
      desiredDeviceLimit: 3,
      state: 'SHADOW',
    };
    const { service, tx, updates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: 2 }],
      contributions: [
        { type: 'EXTRA_TRAFFIC', totalValue: 50n },
        { type: 'EXTRA_DEVICES', totalValue: 1n },
      ],
      existing,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.changed, false);
    assert.equal(result.desiredRevision, 7n);
    assert.equal(updates.length, 0);
  });

  it('advances the revision by one when the desired state changes', async () => {
    const existing: Projection = {
      id: 'proj-1',
      baselineTermId: 'term-1',
      desiredRevision: 7n,
      baseTrafficLimitBytes: 100n,
      baseDeviceLimit: 2,
      activeTrafficContributionBytes: 0n,
      activeDeviceContribution: 0,
      desiredTrafficLimitBytes: 100n,
      desiredDeviceLimit: 2,
      state: 'SHADOW',
    };
    const { service, tx, updates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: 2 }],
      contributions: [{ type: 'EXTRA_TRAFFIC', totalValue: 50n }],
      existing,
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.changed, true);
    assert.equal(result.desiredRevision, 8n);
    assert.equal(result.desiredTrafficLimitBytes, 150n);
    assert.equal(result.state, 'PENDING');
    assert.equal(updates.length, 1);
    assert.equal((updates[0]!.data as { desiredRevision: bigint }).desiredRevision, 8n);
  });

  it('rejects recompute when the subscription is deleted', async () => {
    const { service, tx } = build({ status: 'DELETED' });
    await assert.rejects(
      () => service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' }),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects recompute when there is no single active term', async () => {
    const { service, tx } = build({ activeTerms: [] });
    await assert.rejects(
      () => service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' }),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('keeps a finite device baseline unlimited when the baseline is unlimited (null absorbs)', async () => {
    const { service, tx } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: null }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: 3n }],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    // Device baseline unlimited → adding device add-ons cannot make it finite.
    assert.equal(result.desiredDeviceLimit, null);
    assert.equal(result.activeDeviceContribution, 3);
  });
});

/**
 * The baseline is "what THIS subscription is entitled to before add-ons", not
 * "what the plan hands down". An operator can configure one customer from the
 * admin Users page while that customer keeps being billed for the tariff plan;
 * the term is minted from the plan, so a projection that took the term baseline
 * unconditionally handed the plan's number back the moment the term activated —
 * and the versioned sync worker reads `desired*` off THIS row
 * (`ProfileSyncProcessor.tryVersionedDesiredStateWrite`), so the reverted number
 * was pushed into the panel and the customer lost the devices.
 *
 * Every number below is deliberately distinct from every other and from the
 * value each opposite mistake would produce (plan 3, operator 12, add-on 5 →
 * 17; the plan-wins bug reads 8, the double-count bug reads 13, the
 * baseline-not-applied bug reads 3), so no two contradictory outcomes can
 * satisfy the same assertion.
 */
describe('EffectiveProjectionService baseline honours operator overrides', () => {
  const PLAN_DEVICES = 3;
  const OPERATOR_DEVICES = 12;
  const ADD_ON_DEVICES = 5n;

  /** A stored snapshot that carries all four keys, i.e. a DECIDABLE one. */
  function planSnapshot(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'plan-1',
      trafficLimit: 100,
      deviceLimit: PLAN_DEVICES,
      internalSquads: ['squad-a'],
      externalSquad: null,
      ...patch,
    };
  }

  it('an operator-raised device limit is the baseline, so an add-on layers on top (12 + 5 = 17)', async () => {
    const { service, tx, updates, stats } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: PLAN_DEVICES }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: ADD_ON_DEVICES }],
      subscription: { trafficLimit: null, deviceLimit: OPERATOR_DEVICES, planSnapshot: planSnapshot() },
      existing: priorProjection({ baseDeviceLimit: PLAN_DEVICES, desiredDeviceLimit: PLAN_DEVICES }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(stats.subscriptionReads, 1, 'the recompute must actually read the subscription');
    assert.equal(result.baseDeviceLimit, OPERATOR_DEVICES);
    assert.equal(result.desiredDeviceLimit, 17);
    assert.notEqual(result.desiredDeviceLimit, 8, 'deriving 8 means the plan baseline took the override back');

    // The PERSISTED row is the one the versioned push reads, so assert it and
    // not only the returned value.
    assert.equal(updates.length, 1);
    const written = updates[0]!.data as { baseDeviceLimit: number | null; desiredDeviceLimit: number | null };
    assert.equal(written.baseDeviceLimit, OPERATOR_DEVICES);
    assert.equal(written.desiredDeviceLimit, 17);
  });

  it('a subscription that was never individually adjusted still takes the plan baseline', async () => {
    // The plan now gives 4 and the column still reads 3, which is what the
    // stored snapshot says the plan gave — INHERITED, so the term wins.
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: 4 }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: ADD_ON_DEVICES }],
      subscription: { trafficLimit: null, deviceLimit: PLAN_DEVICES, planSnapshot: planSnapshot() },
      existing: priorProjection({ baseDeviceLimit: PLAN_DEVICES, desiredDeviceLimit: PLAN_DEVICES }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseDeviceLimit, 4, 'a never-adjusted column must not freeze the plan out');
    assert.equal(result.desiredDeviceLimit, 9);
    assert.notEqual(result.desiredDeviceLimit, 8, 'deriving 8 means the column was treated as an override');
  });

  it('removes the contribution the previous projection recorded before comparing', async () => {
    // Column 8 = plan 3 + a live add-on 5. Comparing it to the snapshot raw
    // would read "overridden" and then add the 5 a second time.
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: PLAN_DEVICES }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: ADD_ON_DEVICES }],
      subscription: { trafficLimit: null, deviceLimit: 8, planSnapshot: planSnapshot() },
      existing: priorProjection({
        baseDeviceLimit: PLAN_DEVICES,
        activeDeviceContribution: 5,
        desiredDeviceLimit: 8,
      }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseDeviceLimit, PLAN_DEVICES);
    assert.equal(result.desiredDeviceLimit, 8);
    assert.notEqual(result.desiredDeviceLimit, 13, 'deriving 13 counts the live add-on twice');
  });

  it('still corrects a column that drifted by keeping an expired entitlement contribution', async () => {
    // The add-on is gone from the ledger but the mirrored column still carries
    // its 5. That is DRIFT, not an operator value, and remediation must fix it.
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: PLAN_DEVICES }],
      contributions: [],
      subscription: { trafficLimit: null, deviceLimit: 8, planSnapshot: planSnapshot() },
      existing: priorProjection({
        baseDeviceLimit: PLAN_DEVICES,
        activeDeviceContribution: 5,
        desiredDeviceLimit: 8,
      }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseDeviceLimit, PLAN_DEVICES);
    assert.equal(result.desiredDeviceLimit, PLAN_DEVICES);
    assert.notEqual(result.desiredDeviceLimit, 8, 'the stale add-on share was never taken back');
  });

  it('leaves the term baseline in force when the stored snapshot is unreadable', async () => {
    // Imported/legacy rows carry a snapshot with none of the four keys. The
    // term baseline has to stand or a paid plan change never reaches them.
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: 10 }],
      contributions: [],
      subscription: { trafficLimit: null, deviceLimit: PLAN_DEVICES, planSnapshot: { id: 'plan-old' } },
      existing: priorProjection({ baseDeviceLimit: PLAN_DEVICES, desiredDeviceLimit: PLAN_DEVICES }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseDeviceLimit, 10);
    assert.notEqual(result.baseDeviceLimit, PLAN_DEVICES, 'an unreadable snapshot must not freeze the column in');
  });

  it('an operator-raised traffic limit is the baseline in bytes, with the add-on on top', async () => {
    const gib = 1024n * 1024n * 1024n;
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: PLAN_DEVICES }],
      contributions: [{ type: 'EXTRA_TRAFFIC', totalValue: 50n * gib }],
      subscription: { trafficLimit: 250, deviceLimit: PLAN_DEVICES, planSnapshot: planSnapshot() },
      existing: priorProjection({
        baseTrafficLimitBytes: 100n * gib,
        baseDeviceLimit: PLAN_DEVICES,
        desiredTrafficLimitBytes: 100n * gib,
        desiredDeviceLimit: PLAN_DEVICES,
      }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseTrafficLimitBytes, 250n * gib);
    assert.equal(result.desiredTrafficLimitBytes, 300n * gib);
    assert.notEqual(result.desiredTrafficLimitBytes, 150n * gib, 'deriving 150 GiB means the plan baseline won');
  });

  it('an operator-granted unlimited device limit survives as an unlimited baseline', async () => {
    // `deviceLimit <= 0` is the product's canonical unlimited, and unlimited
    // absorbs: no contribution can make it finite again.
    const { service, tx } = build({
      activeTerms: [{ id: 'term-2', baseTrafficLimitBytes: null, baseDeviceLimit: PLAN_DEVICES }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: ADD_ON_DEVICES }],
      subscription: { trafficLimit: null, deviceLimit: 0, planSnapshot: planSnapshot() },
      existing: priorProjection({ baseDeviceLimit: PLAN_DEVICES, desiredDeviceLimit: PLAN_DEVICES }),
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.baseDeviceLimit, null);
    assert.equal(result.desiredDeviceLimit, null);
  });
});
