import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';
import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';

/**
 * The snapshot key that decides whether a re-linked subscriber exists
 * ──────────────────────────────────────────────────────────────────
 *
 * `Subscription` has no `planId` column: which plan a subscription is on lives
 * in the `planSnapshot` JSON. Two different keys are used for it, and they are
 * NOT interchangeable.
 *
 *   `id`     — the CANONICAL key, and the one every reader outside the import
 *              domain uses. `PlanSnapshotSyncService` selects on
 *              `plan_snapshot->>'id'`, `AddOnEligibilityService` and
 *              `EntitlementCutoverService` read `snapshot['id']`, and the
 *              broadcast audience filter and `PlanSquadPropagationService` both
 *              match `path: ['id']`.
 *   `planId` — the IMPORT domain's "this imported row has been linked to a real
 *              plan" marker: `isImportedOrUnassigned` tests it, this cloner
 *              skips a row that already carries one, and the altshop /
 *              remnashop importers rebuild the snapshot from donor facts
 *              carrying `planId` and only `planId`.
 *
 * The cloner's re-link wrote `planId` alone, so a re-linked subscriber matched
 * none of the canonical readers: it refreshed `name` / `tag` / `type` once and
 * then never mirrored a later rename, because the rename mirror could not find
 * the row. The plan's old name kept showing on the cabinet card, in the bot and
 * on invoices — forever.
 *
 * The repair is to write BOTH, exactly as `BulkPlanAssignmentService` was
 * repaired. These cases drive the REAL cloner and then feed what it wrote to the
 * REAL rename mirror, so nothing is asserted about a helper's return value.
 */

interface StoredSubscription {
  readonly id: string;
  planSnapshot: Record<string, unknown>;
}

function buildCatalogRecord(): Record<string, unknown> {
  return {
    id: 'import-1',
    sourceType: 'altshop',
    result: {
      catalog: {
        plans: [
          {
            id: 7,
            name: 'Legacy',
            tag: 'LEGACY',
            type: 'BOTH',
            availability: 'ALL',
            traffic_limit: 100,
            device_limit: 3,
            traffic_limit_strategy: 'NO_RESET',
            is_active: true,
            order_index: 0,
          },
        ],
        planDurations: [{ id: 1, plan_id: 7, days: 30 }],
        planPrices: [{ id: 1, plan_duration_id: 1, currency: 'RUB', price: '100' }],
      },
    },
  };
}

/**
 * The donor row as an import left it: `importedFrom` marks it, and
 * `originalPlanSnapshot.id` is the SOURCE-side plan id the cloner translates.
 * It carries no `planId`, which is what makes it a re-link candidate, and no
 * limit keys, which is what an import typically leaves behind.
 */
function importedSubscription(): StoredSubscription {
  return {
    id: 'sub-1',
    planSnapshot: {
      importedFrom: 'altshop',
      name: 'IMPORTED',
      originalPlanSnapshot: { id: 7, name: 'Legacy' },
    },
  };
}

function buildHarness(subscriptions: StoredSubscription[]) {
  const record = buildCatalogRecord();
  let seq = 0;
  const createdPlans: Array<Record<string, unknown>> = [];

  const prisma = {
    importRecord: { findUnique: async () => record },
    plan: {
      // Two different callers: the name-dedup pre-scan (`select` only) and the
      // cloned-plan pre-load for the re-link (`where` + `include`).
      findMany: async (query?: { where?: { id?: { in?: readonly string[] } } }) => {
        if (query?.where === undefined) return [];
        const wanted = new Set(query.where.id?.in ?? []);
        return createdPlans.filter((plan) => wanted.has(plan.id as string));
      },
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const plan = {
          id: `plan-cuid-${seq}`,
          name: data.name,
          tag: data.tag ?? null,
          type: data.type,
          icon: null,
          trafficLimit: data.trafficLimit ?? null,
          deviceLimit: data.deviceLimit,
          trafficLimitStrategy: data.trafficLimitStrategy,
          internalSquads: data.internalSquads,
          externalSquad: data.externalSquad,
          durations: [{ days: 30 }],
        };
        createdPlans.push(plan);
        return plan;
      },
      update: async () => ({}),
    },
    subscription: {
      findMany: async () => subscriptions.map((sub) => ({ ...sub })),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { planSnapshot: Record<string, unknown> };
      }) => {
        const target = subscriptions.find((sub) => sub.id === where.id)!;
        target.planSnapshot = data.planSnapshot;
        return {};
      },
    },
    adminAuditLog: { create: async () => ({}) },
  };

  return { service: new BackupPlanClonerService(prisma as never), createdPlans };
}

const CLONE_INPUT = {
  importRecordId: 'import-1',
  selectedSourcePlanIds: [] as ReadonlyArray<number>,
  linkSubscriptions: true,
  createdBy: 'admin-1',
};

/**
 * The rename mirror, driven for real against the rows the cloner just wrote.
 *
 * `syncPlanSnapshotMetadata` selects with `WHERE "plan_snapshot"->>'id' = $1`.
 * The double reproduces exactly that predicate — a JSON string member named
 * `id` — and nothing else, so a row the real query would miss is missed here
 * too.
 */
async function mirrorRename(
  subscriptions: StoredSubscription[],
  plan: { readonly id: string; readonly name: string },
): Promise<number> {
  const client = {
    $queryRaw: async (query: { readonly values?: readonly unknown[] }) => {
      const planId = query.values?.[0];
      return subscriptions
        .filter((sub) => sub.planSnapshot['id'] === planId)
        .map((sub) => ({ id: sub.id, planSnapshot: sub.planSnapshot }));
    },
    subscription: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { planSnapshot: Record<string, unknown> };
      }) => {
        const target = subscriptions.find((sub) => sub.id === where.id)!;
        target.planSnapshot = data.planSnapshot;
        return {};
      },
    },
  };
  return new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, {
    id: plan.id,
    name: plan.name,
    tag: 'LEGACY',
    type: 'BOTH',
    trafficLimit: 100,
    deviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
  } as never);
}

describe('BackupPlanClonerService subscription re-link', () => {
  it('makes a re-linked subscriber findable by the rename mirror', async () => {
    const subscriptions = [importedSubscription()];
    const { service, createdPlans } = buildHarness(subscriptions);

    const result = await service.clone(CLONE_INPUT);
    assert.equal(result.subscriptionsLinked, 1, 'the re-link must actually have run');
    const clonedPlanId = createdPlans[0]!.id as string;

    const mirrored = await mirrorRename(subscriptions, { id: clonedPlanId, name: 'Legacy Renamed' });

    assert.equal(
      mirrored,
      1,
      'the re-linked subscriber was invisible to `PlanSnapshotSyncService`, which selects on ' +
        "`plan_snapshot->>'id'`. Their card, the bot and their invoices keep showing the plan's " +
        'old name for the rest of the subscription.',
    );
    assert.equal(subscriptions[0]!.planSnapshot['name'], 'Legacy Renamed');
  });

  it('writes the canonical id the plan-scoped readers use', async () => {
    const subscriptions = [importedSubscription()];
    const { service, createdPlans } = buildHarness(subscriptions);

    await service.clone(CLONE_INPUT);

    const clonedPlanId = createdPlans[0]!.id as string;
    assert.equal(
      subscriptions[0]!.planSnapshot['id'],
      clonedPlanId,
      "`AddOnEligibilityService` reads `snapshot['id']` for its `applicablePlanIds` gate and the " +
        "broadcast audience filter matches `path: ['id']`; without this key a re-linked subscriber " +
        'is offered no plan-scoped add-on and matches no plan-filtered broadcast',
    );
  });

  it('keeps planId, which is the import domain marker and not a duplicate', async () => {
    const subscriptions = [importedSubscription()];
    const { service, createdPlans } = buildHarness(subscriptions);

    await service.clone(CLONE_INPUT);

    const clonedPlanId = createdPlans[0]!.id as string;
    assert.equal(
      subscriptions[0]!.planSnapshot['planId'],
      clonedPlanId,
      '`isImportedOrUnassigned` tests `planId`, this cloner skips a row that already carries one, ' +
        'and the altshop / remnashop importers carry ONLY `planId` across a re-import. Dropping it ' +
        'would make a re-import silently unlink the plan.',
    );
  });

  it('does not re-point the four inherited-limit keys at the clone', async () => {
    // Unchanged by this repair and asserted because the object is being edited:
    // those four keys are the baseline the override rule compares a
    // subscription's COLUMNS against. Re-pointing them while leaving the columns
    // alone would declare every re-linked subscriber "individually overridden"
    // and pin their limits for good.
    const subscriptions = [importedSubscription()];
    const { service } = buildHarness(subscriptions);

    await service.clone(CLONE_INPUT);

    const snapshot = subscriptions[0]!.planSnapshot;
    for (const key of ['trafficLimit', 'deviceLimit', 'internalSquads', 'externalSquad']) {
      assert.equal(
        key in snapshot,
        false,
        `the re-link invented a "${key}" the donor snapshot never had; that pins the column`,
      );
    }
  });

  it('leaves a subscription that already names a plan alone', async () => {
    // The dedup that stops a second clone run from re-planning a subscription
    // an operator already assigned — it reads `planId`, which is why that key
    // has to survive the repair above.
    const subscriptions: StoredSubscription[] = [
      {
        id: 'sub-1',
        planSnapshot: {
          importedFrom: 'altshop',
          planId: 'plan-chosen-by-hand',
          originalPlanSnapshot: { id: 7, name: 'Legacy' },
        },
      },
    ];
    const { service } = buildHarness(subscriptions);

    const result = await service.clone(CLONE_INPUT);

    assert.equal(result.subscriptionsLinked, 0);
    assert.equal(subscriptions[0]!.planSnapshot['planId'], 'plan-chosen-by-hand');
    assert.equal('id' in subscriptions[0]!.planSnapshot, false);
  });
});
