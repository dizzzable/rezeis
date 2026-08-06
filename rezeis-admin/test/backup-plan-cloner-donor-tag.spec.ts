import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';

/**
 * `Plan.tag` is not a free-text label — it lands on the Remnawave panel
 * profile, and the panel declares it as `^[A-Z0-9_]+$`, max 16
 * (`@remnawave/backend-contract`, restated in `remnawave-tag.util.ts`).
 *
 * The cloner used to write `tag: plan.tag ?? undefined` straight from the
 * donor catalog. Nothing downstream catches that: the admin DTOs validate only
 * a tag the operator TYPES, and a PATCH that omits `tag` deliberately carries
 * the stored value through untouched. So a donor tag with a space sat in the
 * catalog until a background sync tried to push it — the strict path refusing
 * the whole desired-state PATCH as `invalidContract`, the legacy path
 * collecting a 400 — hours later, on somebody else's subscription.
 *
 * These specs drive the real service, so they assert the value actually handed
 * to `plan.create`, not a helper's return.
 */

interface CreatedPlan {
  readonly name: string;
  readonly tag: string | undefined;
}

function buildCatalogRecord(
  plans: ReadonlyArray<{ readonly id: number; readonly name: string; readonly tag: unknown }>,
): Record<string, unknown> {
  return {
    id: 'import-1',
    sourceType: 'altshop',
    result: {
      catalog: {
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          tag: p.tag,
          type: 'BOTH',
          availability: 'ALL',
          traffic_limit: 0,
          device_limit: 3,
          traffic_limit_strategy: 'NO_RESET',
          is_active: true,
          order_index: 0,
        })),
        planDurations: [{ id: 1, plan_id: plans[0]?.id ?? 1, days: 30 }],
        planPrices: [{ id: 1, plan_duration_id: 1, currency: 'RUB', price: '100' }],
      },
    },
  };
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
      create: async ({ data }: { data: { name: string; tag: string | undefined } }) => {
        created.push({ name: data.name, tag: data.tag });
        seq += 1;
        return { id: `plan-cuid-${seq}`, name: data.name };
      },
      update: async () => ({}),
    },
    subscription: { findMany: async () => [], update: async () => ({}) },
    adminAuditLog: { create: async () => ({}) },
  };

  return {
    service: new BackupPlanClonerService(prisma as never),
    created,
  };
}

const CLONE_INPUT = {
  importRecordId: 'import-1',
  selectedSourcePlanIds: [] as ReadonlyArray<number>,
  linkSubscriptions: false,
  createdBy: 'admin-1',
};

describe('BackupPlanClonerService donor tag', () => {
  it('drops a donor tag the panel would reject instead of storing it', async () => {
    const { service, created } = buildHarness(
      buildCatalogRecord([{ id: 1, name: 'Legacy', tag: 'legacy tag from donor' }]),
    );

    await service.clone(CLONE_INPUT);

    assert.equal(created.length, 1);
    // NOT `'LEGACY_TAG_FROM'`: substituting and truncating would invent a
    // different, panel-valid label that nothing downstream could tell was
    // fabricated. The plan still clones — only the unusable label is dropped.
    assert.equal(created[0]?.tag, undefined);
  });

  it('keeps a donor tag that already satisfies the panel rule', async () => {
    const { service, created } = buildHarness(
      buildCatalogRecord([{ id: 1, name: 'Premium', tag: 'PREMIUM_2026' }]),
    );

    await service.clone(CLONE_INPUT);

    assert.equal(created[0]?.tag, 'PREMIUM_2026');
  });

  it('upper-cases a donor tag that differs from the panel form only by case', async () => {
    // The panel has no lowercase form of this token, so reading `premium` as
    // `PREMIUM` is faithful, not invention — no characters are substituted.
    const { service, created } = buildHarness(
      buildCatalogRecord([{ id: 1, name: 'Premium', tag: '  premium_2026  ' }]),
    );

    await service.clone(CLONE_INPUT);

    assert.equal(created[0]?.tag, 'PREMIUM_2026');
  });

  it('drops a donor tag longer than the panel maximum rather than truncating it', async () => {
    const { service, created } = buildHarness(
      buildCatalogRecord([{ id: 1, name: 'Long', tag: 'SEVENTEEN_CHARSX' + 'X' }]),
    );

    await service.clone(CLONE_INPUT);

    assert.equal(created[0]?.tag, undefined);
  });

  it('leaves an absent donor tag absent', async () => {
    const { service, created } = buildHarness(
      buildCatalogRecord([{ id: 1, name: 'Untagged', tag: null }]),
    );

    await service.clone(CLONE_INPUT);

    assert.equal(created[0]?.tag, undefined);
  });

  it('previews the tag the clone would actually store', async () => {
    // The preview drives the operator's selection. Advertising a tag the write
    // then drops is how they find out too late.
    const { service } = buildHarness(
      buildCatalogRecord([
        { id: 1, name: 'Legacy', tag: 'legacy tag from donor' },
        { id: 2, name: 'Premium', tag: 'premium' },
      ]),
    );

    const preview = await service.preview('import-1');

    assert.equal(preview.plans[0]?.tag, null);
    assert.equal(preview.plans[1]?.tag, 'PREMIUM');
  });
});
