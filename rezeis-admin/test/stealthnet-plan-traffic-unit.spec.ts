import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';
import { mapTariffToPlanRow } from '../src/modules/imports/services/stealthnet-importer.service';
import type {
  StealthnetTariff,
  StealthnetTariffCategory,
} from '../src/modules/imports/utils/stealthnet-backup-parser';

/**
 * A DONOR FIELD CARRYING BYTES INTO A GIGABYTE COLUMN.
 *
 * `mapTariffToPlanRow` emits the donor-catalog plan row that
 * `BackupPlanClonerService` later clones. The cloner reads that row's
 * `traffic_limit` key as `NormalizedSourcePlan.trafficLimit` and writes it
 * straight to `Plan.trafficLimit`, which counts WHOLE GIGABYTES — altshop and
 * remnashop both fill that key from a donor column already denominated that
 * way.
 *
 * STEALTHNET is the only donor whose tariff states the cap in BYTES, and it
 * used to hand them over unconverted. A 50 GB tariff cloned into a plan capped
 * at 53,687,091,200 GB: not an error anywhere, just a number so large it is
 * "unlimited" with extra steps, and a plan the admin form will not accept back.
 *
 * WHY BOTH HALVES ARE DRIVEN HERE. Neither side can see this defect alone. The
 * producer looks right if you believe the key means bytes; the consumer looks
 * right if you believe it means gigabytes. Only the two together state the
 * unit, so these specs run the REAL `mapTariffToPlanRow` output through the
 * REAL cloner and assert what reaches `plan.create`.
 *
 * NOTE THE CONVENTION DIFFERENCE, which is why this is not a copy of the
 * subscription rule: the cloner spells unlimited `plan.trafficLimit > 0 ? … :
 * null`, so `0` in a donor-catalog row means UNLIMITED. On `Subscription`, `0`
 * means genuinely zero gigabytes. Different column, different rule.
 */

const GIB = 1024 * 1024 * 1024;

const CATEGORY: StealthnetTariffCategory = {
  id: 'cat-1',
  name: 'Main',
  emoji_key: null,
  sort_order: 0,
};

function tariff(trafficLimitBytes: number | null): StealthnetTariff {
  return {
    id: 'tariff-1',
    category_id: 'cat-1',
    name: 'Imported tariff',
    description: null,
    duration_days: 30,
    internal_squad_uuids: [],
    traffic_limit_bytes: trafficLimitBytes,
    traffic_reset_mode: 'monthly',
    device_limit: 3,
    price: 100,
    currency: 'rub',
    sort_order: 0,
    included_devices: 3,
    max_extra_devices: 0,
    price_per_extra_device: 0,
  };
}

/** The import record the cloner reads, carrying the REAL producer's rows. */
function buildStealthnetRecord(trafficLimitBytes: number | null): Record<string, unknown> {
  const planRow = mapTariffToPlanRow(tariff(trafficLimitBytes), [CATEGORY]);
  return {
    id: 'import-1',
    sourceType: 'stealthnet',
    result: {
      catalog: {
        // Through JSON exactly as the importer stores it, so nothing survives
        // here that would not survive the database round trip.
        plans: JSON.parse(JSON.stringify([planRow])) as ReadonlyArray<unknown>,
        planDurations: [{ id: 1, plan_id: planRow.id, days: 30 }],
        planPrices: [{ id: 1, plan_duration_id: 1, currency: 'RUB', price: '100' }],
      },
    },
  };
}

interface CreatedPlan {
  readonly name: string;
  readonly trafficLimit: number | null;
}

function buildHarness(record: Record<string, unknown>): {
  readonly service: BackupPlanClonerService;
  readonly created: CreatedPlan[];
} {
  const created: CreatedPlan[] = [];
  let seq = 0;

  const prisma = {
    importRecord: { findUnique: async () => record },
    plan: {
      findMany: async () => [],
      create: async ({ data }: { data: { name: string; trafficLimit: number | null } }) => {
        created.push({ name: data.name, trafficLimit: data.trafficLimit });
        seq += 1;
        return { id: `plan-cuid-${seq}`, name: data.name };
      },
      update: async () => ({}),
    },
    subscription: { findMany: async () => [], update: async () => ({}) },
    adminAuditLog: { create: async () => ({}) },
  };

  return { service: new BackupPlanClonerService(prisma as never), created };
}

const CLONE_INPUT = {
  importRecordId: 'import-1',
  selectedSourcePlanIds: [] as ReadonlyArray<number>,
  linkSubscriptions: false,
  createdBy: 'admin-1',
};

describe('a STEALTHNET tariff cloned into a plan', () => {
  it('states its traffic cap in the gigabytes the cloner reads, not bytes', () => {
    // The producer, alone. 50 GB must leave here as `50` — the number the
    // cloner's column counts — and emphatically not as 53,687,091,200.
    const row = mapTariffToPlanRow(tariff(50 * GIB), [CATEGORY]);

    assert.equal(row.traffic_limit, 50);
    // Named explicitly so a regression reads as the unit error it is rather
    // than as an off-by-something.
    assert.notEqual(row.traffic_limit, 50 * GIB);
  });

  it('reaches Plan.trafficLimit as sane gigabytes', async () => {
    // Producer into consumer. This is the assertion the two halves could not
    // make separately.
    const { service, created } = buildHarness(buildStealthnetRecord(50 * GIB));

    await service.clone(CLONE_INPUT);

    assert.equal(created.length, 1);
    assert.equal(created[0]?.trafficLimit, 50);
  });

  it('does not let a sub-gigabyte tariff collapse into unlimited', async () => {
    // 0.4 GB rounds to `0` without the shared converter's floor, and `0` in a
    // donor-catalog row is how the cloner spells UNLIMITED. So the unfloored
    // spelling does not merely lose precision here: it hands the customer an
    // uncapped plan.
    const { service, created } = buildHarness(buildStealthnetRecord(Math.round(0.4 * GIB)));

    await service.clone(CLONE_INPUT);

    assert.equal(created[0]?.trafficLimit, 1);
    assert.notEqual(created[0]?.trafficLimit, null);
  });

  it('still clones a genuinely uncapped tariff as unlimited', async () => {
    // The control. A conversion that answered `1` for everything would satisfy
    // the specs above; a tariff with no byte cap has to stay unlimited.
    const { service, created } = buildHarness(buildStealthnetRecord(null));

    await service.clone(CLONE_INPUT);

    assert.equal(created.length, 1);
    assert.equal(created[0]?.trafficLimit, null);
  });
});
