import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import { resolveInheritedPlanLimitUpdate } from '../src/modules/subscriptions/services/plan-inherited-limits.util';
import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

/**
 * WHO OWNS A SUBSCRIPTION'S LIMIT BASELINE
 *
 * `Subscription.planSnapshot` records what the plan gave THIS subscription.
 * `resolveInheritedPlanLimitUpdate` compares the columns against it to decide,
 * at renewal, whether an operator individually adjusted the customer. That only
 * works if the baseline means what it says, so every writer has to make one
 * deliberate choice:
 *
 *   moves a column AND the snapshot  → still plan-given; the next renewal
 *                                      re-applies the plan and the change dies
 *   moves a column and NOT the snapshot → an operator override that outlives
 *                                      every future renewal
 *
 * These specs pin that choice for each writer, and they run the decision
 * through the real resolver rather than asserting a JSON shape — a snapshot
 * that "looks right" but does not flip the resolver would guard nothing.
 */

const ASSIGNED = {
  trafficLimit: 100,
  deviceLimit: 2,
  internalSquads: ['squad-assigned'],
  externalSquad: 'ext-assigned',
} as const;

const EDITED_PLAN = {
  id: 'plan-1',
  name: 'Renamed plan',
  tag: 'PROMO',
  type: 'UNLIMITED',
  trafficLimit: 500,
  deviceLimit: 9,
  trafficLimitStrategy: 'MONTH',
  internalSquads: ['squad-edited'],
  externalSquad: 'ext-edited',
} as const;

function assignedSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Original plan',
    tag: null,
    type: 'BOTH',
    icon: 'zap',
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: ASSIGNED.trafficLimit,
    deviceLimit: ASSIGNED.deviceLimit,
    internalSquads: [...ASSIGNED.internalSquads],
    externalSquad: ASSIGNED.externalSquad,
    ...extra,
  };
}

function assignedColumns() {
  return {
    trafficLimit: ASSIGNED.trafficLimit,
    deviceLimit: ASSIGNED.deviceLimit,
    internalSquads: [...ASSIGNED.internalSquads],
    externalSquad: ASSIGNED.externalSquad,
  };
}

function planLimits(plan: typeof EDITED_PLAN) {
  return {
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
  };
}

// ═══ 1. A plan edit must not move the baseline ═════════════════════════════

async function runPlanSnapshotSync(storedSnapshot: unknown): Promise<Record<string, unknown>> {
  const written: unknown[] = [];
  const service = new PlanSnapshotSyncService();
  const count = await service.syncPlanSnapshotMetadata(
    {
      $queryRaw: async () => [{ id: 'sub-1', planSnapshot: storedSnapshot }],
      subscription: {
        update: async (args: { readonly data: { readonly planSnapshot: unknown } }) => {
          written.push(args.data.planSnapshot);
          return null;
        },
      },
    } as never,
    EDITED_PLAN as never,
  );
  assert.equal(count, 1, 'the sync must have visited the subscriber');
  return written[0] as Record<string, unknown>;
}

describe('a plan edit and the subscriber limit baseline', () => {
  it('leaves the four limit keys alone, so a never-adjusted subscriber still reads as INHERITED', async () => {
    const after = await runPlanSnapshotSync(assignedSnapshot());

    // The baseline still records what the plan gave this subscription…
    assert.equal(after['trafficLimit'], ASSIGNED.trafficLimit);
    assert.equal(after['deviceLimit'], ASSIGNED.deviceLimit);
    assert.deepStrictEqual(after['internalSquads'], [...ASSIGNED.internalSquads]);
    assert.equal(after['externalSquad'], ASSIGNED.externalSquad);

    // …so the real resolver still sees an untouched subscriber and hands the
    // edit through at renewal. This is the assertion that matters: mirroring
    // the four would pin every subscriber's limits forever.
    const update = resolveInheritedPlanLimitUpdate({
      current: assignedColumns(),
      planSnapshot: after,
      plan: planLimits(EDITED_PLAN),
    });
    assert.deepStrictEqual(update, {
      trafficLimit: EDITED_PLAN.trafficLimit,
      deviceLimit: EDITED_PLAN.deviceLimit,
      internalSquads: [...EDITED_PLAN.internalSquads],
      externalSquad: EDITED_PLAN.externalSquad,
    });
  });

  it('still lets an operator-adjusted subscriber keep their limit', async () => {
    // The other direction, so freezing the baseline cannot be mistaken for
    // "renewal never writes anything".
    const after = await runPlanSnapshotSync(assignedSnapshot());
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...assignedColumns(), deviceLimit: 25 },
      planSnapshot: after,
      plan: planLimits(EDITED_PLAN),
    });
    assert.equal('deviceLimit' in update, false);
  });

  it('a renamed plan still reaches subscribers', async () => {
    // Display facts DO track the live plan: a renamed or re-tagged plan must
    // not keep showing its old label on the card, in the bot or on an invoice.
    const after = await runPlanSnapshotSync(assignedSnapshot());

    assert.equal(after['name'], EDITED_PLAN.name);
    assert.equal(after['tag'], EDITED_PLAN.tag);
    assert.equal(after['type'], EDITED_PLAN.type);
    // Not display-only — the sync processor pushes this one to the panel — but
    // the plan is its only owner, so it keeps tracking.
    assert.equal(after['trafficLimitStrategy'], EDITED_PLAN.trafficLimitStrategy);
    // …and the icon stays frozen at purchase time, as it always has.
    assert.equal(after['icon'], 'zap');
  });
});

// ═══ 2. A backup plan clone must not move the baseline either ══════════════

describe('backup plan cloner re-linking subscriptions', () => {
  it('does not re-point the four limit keys at the cloned plan', async () => {
    const donorSnapshot = {
      importedFrom: 'altshop',
      originalPlanSnapshot: { id: 1 },
      trafficLimit: ASSIGNED.trafficLimit,
      deviceLimit: ASSIGNED.deviceLimit,
      internalSquads: [...ASSIGNED.internalSquads],
      externalSquad: ASSIGNED.externalSquad,
    };
    const written: Record<string, unknown>[] = [];
    const clonedPlan = {
      id: 'plan-cuid-1',
      name: 'Legacy',
      tag: 'LEGACY',
      type: 'BOTH',
      icon: 'rocket',
      trafficLimitStrategy: 'MONTH',
      trafficLimit: EDITED_PLAN.trafficLimit,
      deviceLimit: EDITED_PLAN.deviceLimit,
      internalSquads: [...EDITED_PLAN.internalSquads],
      externalSquad: EDITED_PLAN.externalSquad,
      durations: [{ days: 30 }],
    };
    const prisma = {
      importRecord: {
        findUnique: async () => ({
          id: 'import-1',
          sourceType: 'altshop',
          result: {
            catalog: {
              plans: [{
                id: 1, name: 'Legacy', tag: 'LEGACY', type: 'BOTH', availability: 'ALL',
                traffic_limit: 0, device_limit: 3, traffic_limit_strategy: 'NO_RESET',
                is_active: true, order_index: 0,
              }],
              planDurations: [{ id: 1, plan_id: 1, days: 30 }],
              planPrices: [{ id: 1, plan_duration_id: 1, currency: 'RUB', price: '100' }],
            },
          },
        }),
      },
      plan: {
        findMany: async (args?: { readonly where?: { readonly id?: unknown } }) =>
          args?.where?.id === undefined ? [] : [clonedPlan],
        create: async () => ({ id: 'plan-cuid-1', name: 'Legacy' }),
        update: async () => ({}),
      },
      subscription: {
        findMany: async () => [{ id: 'sub-1', planSnapshot: donorSnapshot }],
        update: async (args: { readonly data: { readonly planSnapshot: Record<string, unknown> } }) => {
          written.push(args.data.planSnapshot);
          return {};
        },
      },
      adminAuditLog: { create: async () => ({}) },
    };
    const service = new BackupPlanClonerService(prisma as never);

    await service.clone({
      importRecordId: 'import-1',
      selectedSourcePlanIds: [] as ReadonlyArray<number>,
      linkSubscriptions: true,
      createdBy: 'admin-1',
    });

    assert.equal(written.length, 1, 'the subscription must have been re-linked');
    const snapshot = written[0]!;
    // Display facts follow the clone…
    assert.equal(snapshot['planId'], 'plan-cuid-1');
    assert.equal(snapshot['icon'], 'rocket');
    // …the baseline does not.
    assert.equal(snapshot['trafficLimit'], ASSIGNED.trafficLimit);
    assert.equal(snapshot['deviceLimit'], ASSIGNED.deviceLimit);
    assert.deepStrictEqual(snapshot['internalSquads'], [...ASSIGNED.internalSquads]);
    assert.equal(snapshot['externalSquad'], ASSIGNED.externalSquad);
    // Which is what keeps a re-linked subscriber readable as untouched.
    const update = resolveInheritedPlanLimitUpdate({
      current: assignedColumns(),
      planSnapshot: snapshot,
      plan: planLimits(EDITED_PLAN),
    });
    assert.equal(update.deviceLimit, EDITED_PLAN.deviceLimit);
  });
});

// ═══ 3. A points-bought traffic top-up resets at renewal ═══════════════════

const referralSettings = {
  points_exchange: {
    exchange_enabled: true,
    subscription_days: { enabled: true, points_cost: 100, min_points: 100, max_points: -1 },
    traffic: { enabled: true, points_cost: 50, min_points: 50, max_points: 500, max_traffic_gb: 100 },
  },
};

describe('referral points traffic top-up', () => {
  async function runTrafficExchange(storedSnapshot: unknown) {
    const updates: Array<{ readonly data: Record<string, unknown> }> = [];
    const service = new ReferralPointsExchangeService(
      {
        settings: { findFirst: async () => ({ referralSettings }) },
        user: { findUnique: async () => ({ id: 'user-1', points: 500, currentSubscriptionId: 'sub-1' }) },
        subscription: { findUnique: async () => ({ remnawaveId: 'rw-1' }), findFirst: async () => ({ id: 'sub-1' }) },
        profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        $transaction: async (callback: (tx: unknown) => Promise<void>) =>
          callback({
            $queryRaw: async () => [],
            user: {
              findUnique: async () => ({ id: 'user-1', currentSubscriptionId: 'sub-1' }),
              updateMany: async () => ({ count: 1 }),
            },
            subscription: {
              findFirst: async () => ({ id: 'sub-1' }),
              findUnique: async () => ({
                id: 'sub-1',
                userId: 'user-1',
                status: SubscriptionStatus.ACTIVE,
                expiresAt: new Date(Date.now() + 30 * 86_400_000),
                trafficLimit: ASSIGNED.trafficLimit,
                remnawaveId: 'rw-1',
                planSnapshot: storedSnapshot,
              }),
              update: async (args: { readonly data: Record<string, unknown> }) => {
                updates.push(args);
                return {};
              },
            },
            profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
            referralPointsExchange: { create: async () => ({ id: 'exchange-1' }) },
            pointsLedgerEntry: { findUnique: async () => null, create: async () => ({ id: 'ledger-1' }) },
          }),
      } as never,
      { enqueue: async () => undefined } as never,
      new PointsWalletService(),
    );

    await service.executeExchange({ userId: 'user-1', type: 'TRAFFIC', points: 100 });
    assert.equal(updates.length, 1, 'the top-up must have written the subscription');
    return updates[0]!.data;
  }

  it('moves the snapshot with the column, so the top-up resets at the next renewal', async () => {
    // Aligned with the promocode EXTRA_TRAFFIC reward: a points-bought top-up
    // is a bonus for the CURRENT period, not a permanent change to the priced
    // good. Leaving the snapshot behind would declare an operator override and
    // make the top-up outlive every future renewal.
    const data = await runTrafficExchange(assignedSnapshot());

    // 100 points at 50/GB = 2 GB on top of the plan's 100.
    assert.equal(data['trafficLimit'], ASSIGNED.trafficLimit + 2);
    const snapshot = data['planSnapshot'] as Record<string, unknown>;
    assert.equal(snapshot['trafficLimit'], ASSIGNED.trafficLimit + 2);

    // The pair is in step, so the real resolver reads the subscription as
    // still tracking its plan and the renewal puts the plan's limit back.
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...assignedColumns(), trafficLimit: ASSIGNED.trafficLimit + 2 },
      planSnapshot: snapshot,
      plan: planLimits(EDITED_PLAN),
    });
    assert.equal(update.trafficLimit, EDITED_PLAN.trafficLimit);
  });

  it('leaves every other snapshot key untouched while topping up', async () => {
    const data = await runTrafficExchange(assignedSnapshot());
    const snapshot = data['planSnapshot'] as Record<string, unknown>;

    assert.equal(snapshot['id'], 'plan-1');
    assert.equal(snapshot['icon'], 'zap');
    assert.equal(snapshot['deviceLimit'], ASSIGNED.deviceLimit);
    assert.deepStrictEqual(snapshot['internalSquads'], [...ASSIGNED.internalSquads]);
  });
});

// ═══ 4. A panel-side edit must not outlive the next renewal ════════════════

describe('panel webhook limit mirror', () => {
  interface WebhookRun {
    /** What the single column-writing statement carried. */
    readonly columnWrites: Array<Record<string, unknown>>;
    /** What the additive baseline pass carried, if it ran at all. */
    readonly baselineWrites: Array<Record<string, unknown>>;
    readonly snapshotReads: number;
  }

  async function runPanelEvent(
    payloadData: Record<string, unknown>,
    storedSnapshot: unknown = assignedSnapshot(),
  ): Promise<WebhookRun> {
    const columnWrites: Array<Record<string, unknown>> = [];
    const baselineWrites: Array<Record<string, unknown>> = [];
    let snapshotReads = 0;
    const prisma = {
      remnawaveWebhookEvent: { create: async () => undefined },
      subscription: {
        updateMany: async (args: { readonly data: Record<string, unknown> }) => {
          columnWrites.push(args.data);
          return { count: 1 };
        },
        findMany: async () => {
          snapshotReads += 1;
          return [{ id: 'sub-1', planSnapshot: storedSnapshot }];
        },
        update: async (args: { readonly data: Record<string, unknown> }) => {
          baselineWrites.push(args.data);
          return {};
        },
      },
    };
    const service = new RemnawaveWebhookService(
      prisma as never,
      { webhookSecret: 'secret' } as never,
      { emit: () => undefined } as never,
      { getPanelUserUsage: async () => null } as never,
      // Notice builder + notification sink. Inert here: the traffic-limit
      // notice has its own spec, and this case is about limit ownership.
      { build: async () => ({}) } as never,
      { create: async () => undefined } as never,
    );
    const reconcile = (
      service as unknown as {
        reconcileSubscriptionFromEvent(event: string, payload: Record<string, unknown>): Promise<void>;
      }
    ).reconcileSubscriptionFromEvent.bind(service);

    await reconcile('user.modified', { event: 'user.modified', data: { uuid: 'rw-1', ...payloadData } });
    return { columnWrites, baselineWrites, snapshotReads };
  }

  it('a panel-side limit change does not outlive the next renewal', async () => {
    const run = await runPanelEvent({
      trafficLimitBytes: 300 * 1024 ** 3,
      hwidDeviceLimit: 11,
    });

    // The fact IS recorded — the customer really does have these right now —
    // and it still goes out on the single column-writing statement the mirror
    // has always used.
    assert.equal(run.columnWrites.length, 1);
    const columns = run.columnWrites[0]!;
    assert.equal(columns['trafficLimit'], 300);
    assert.equal(columns['deviceLimit'], 11);

    // …and the baseline moves with it, so the resolver reads the subscription
    // as still plan-tracking and the renewal restores the plan's own limits.
    assert.equal(run.baselineWrites.length, 1);
    const baseline = run.baselineWrites[0]!;
    assert.deepStrictEqual(
      Object.keys(baseline),
      ['planSnapshot'],
      'the baseline pass must write nothing but the snapshot',
    );
    const snapshot = baseline['planSnapshot'] as Record<string, unknown>;
    assert.equal(snapshot['trafficLimit'], 300);
    assert.equal(snapshot['deviceLimit'], 11);

    const update = resolveInheritedPlanLimitUpdate({
      current: { ...assignedColumns(), trafficLimit: 300, deviceLimit: 11 },
      planSnapshot: snapshot,
      plan: planLimits(EDITED_PLAN),
    });
    assert.equal(update.trafficLimit, EDITED_PLAN.trafficLimit);
    assert.equal(update.deviceLimit, EDITED_PLAN.deviceLimit);
  });

  it('mirrors an unlimited traffic cap as null on both the column and the baseline', async () => {
    const run = await runPanelEvent({ trafficLimitBytes: 0 });

    assert.equal(run.columnWrites[0]!['trafficLimit'], null);
    const snapshot = run.baselineWrites[0]!['planSnapshot'] as Record<string, unknown>;
    assert.equal(snapshot['trafficLimit'], null);
  });

  it('never adopts a limit the event did not state', async () => {
    const run = await runPanelEvent({ trafficLimitBytes: 300 * 1024 ** 3 });
    const columns = run.columnWrites[0]!;

    assert.equal('deviceLimit' in columns, false, 'a missing hwidDeviceLimit must not become a value');
    const snapshot = run.baselineWrites[0]!['planSnapshot'] as Record<string, unknown>;
    assert.equal(snapshot['trafficLimit'], 300);
    assert.equal(
      snapshot['deviceLimit'],
      ASSIGNED.deviceLimit,
      'the untouched key keeps the baseline it already had',
    );
  });

  it('reads no snapshot at all for an event that carries no limit', async () => {
    // Status and expiry are the overwhelming majority of panel events. They
    // must stay on the single cheap `updateMany`.
    const run = await runPanelEvent({ status: 'ACTIVE', expireAt: '2030-01-01T00:00:00.000Z' });

    assert.equal(run.columnWrites.length, 1, 'the columns still go out on one statement');
    assert.equal(run.snapshotReads, 0);
    assert.equal(run.baselineWrites.length, 0);
  });
});
