import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PlanAvailability, PlanType } from '@prisma/client';

import { CreatePlanDto } from '../src/modules/plans/dto/create-plan.dto';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import {
  buildDeletedPlanName,
  displayPlanName,
  PLAN_NAME_MAX_LENGTH,
  releasePlanNameFromDeletedPlan,
} from '../src/modules/plans/utils/plan-deletion.util';
import { buildPlanReferenceDb, PlanReferenceDbSeed } from './fixtures/plan-reference-db';

/**
 * A DELETED PLAN GIVES ITS NAME UP (plan-deletion contract v2, rule 6).
 *
 * `plans.name` is unique, and a soft-deleted plan keeps its row — so without
 * this, deleting "Pro" while one customer was still on it would make "Pro"
 * impossible to create again, refused over a plan the operator can no longer
 * see or edit. The hidden row is renamed instead, in the same transaction as
 * the write that wants the name. A LIVE plan holding the name still refuses,
 * exactly as before.
 */

const CONTEXT = {
  currentAdmin: { id: 'admin-1' } as never,
  requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
};
const DELETED_AT = new Date('2026-09-01T00:00:00.000Z');
/** A realistic cuid, so the suffix is built from a real id's tail. */
const HIDDEN_ID = 'cmsxo98e8006r01jgn33gtpbe';

const INPUT: CreatePlanDto = {
  name: 'Pro',
  type: PlanType.BOTH,
  availability: PlanAvailability.ALL,
  deviceLimit: 1,
  durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
};

function build(seed: PlanReferenceDbSeed) {
  const db = buildPlanReferenceDb(seed);
  const remnawave = { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] };
  const service = new PlansAdminService(
    db.client as never,
    remnawave as never,
    { syncPlanSnapshotMetadata: async () => 0 } as never,
    new PlansAdminValidators(db.client as never, remnawave as never),
    new PlanSquadPropagationService(db.client as never, { enqueue: async () => undefined } as never),
  );
  return { db, service };
}

const hiddenPro = { id: HIDDEN_ID, name: 'Pro', orderIndex: 5, deletedAt: DELETED_AT, isActive: false, isArchived: true };

describe('creating a plan under a deleted plan’s name', () => {
  it('creates it, and renames the hidden plan in the same transaction', async () => {
    const { db, service } = build({ plans: [hiddenPro] });

    const created = await service.createPlan(INPUT, CONTEXT);

    assert.equal(created.name, 'Pro');
    assert.equal(db.plan(HIDDEN_ID)?.name, 'Pro (deleted n33gtpbe)');
    assert.equal(db.transactions, 1);
    const renameAt = db.calls.indexOf('plan.updateMany');
    const createAt = db.calls.indexOf('plan.create');
    assert.ok(renameAt >= 0 && renameAt < createAt, `order was: ${db.calls.join(' → ')}`);
  });

  it('says so in the audit row', async () => {
    const { db, service } = build({ plans: [hiddenPro] });

    await service.createPlan(INPUT, CONTEXT);

    const metadata = db.tables.adminAuditLog[0]?.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.releasedNameFromDeletedPlan, {
      planId: HIDDEN_ID,
      renamedTo: 'Pro (deleted n33gtpbe)',
    });
  });

  it('still refuses a name a LIVE plan holds, and renames nothing', async () => {
    const { db, service } = build({ plans: [{ id: 'live-pro', name: 'Pro' }] });

    await assert.rejects(
      () => service.createPlan(INPUT, CONTEXT),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error.getResponse() as Record<string, unknown>).code === 'PLAN_NAME_TAKEN',
    );
    assert.equal(db.plan('live-pro')?.name, 'Pro');
    assert.equal(db.calls.includes('plan.create'), false);
    assert.equal(db.calls.includes('plan.updateMany'), false);
  });

  it('leaves a hidden plan with a DIFFERENT name alone', async () => {
    const { db, service } = build({ plans: [{ ...hiddenPro, name: 'Basic' }] });

    await service.createPlan(INPUT, CONTEXT);

    assert.equal(db.plan(HIDDEN_ID)?.name, 'Basic');
    assert.equal(
      (db.tables.adminAuditLog[0]?.metadata as Record<string, unknown>).releasedNameFromDeletedPlan,
      undefined,
    );
  });

  it('appends after the last VISIBLE plan, not after a hidden one', async () => {
    const { service } = build({ plans: [{ id: 'live', orderIndex: 0 }, hiddenPro] });

    const created = await service.createPlan(INPUT, CONTEXT);

    assert.equal(created.orderIndex, 1, 'a new plan landed after the hidden plan’s index');
  });
});

describe('renaming a plan to a deleted plan’s name', () => {
  it('renames the hidden plan and applies the rename', async () => {
    const { db, service } = build({ plans: [{ id: 'basic', name: 'Basic' }, hiddenPro] });

    const updated = await service.updatePlan('basic', { name: 'Pro' }, CONTEXT);

    assert.equal(updated.name, 'Pro');
    assert.equal(db.plan(HIDDEN_ID)?.name, 'Pro (deleted n33gtpbe)');
  });

  it('still refuses a name a LIVE plan holds', async () => {
    const { db, service } = build({ plans: [{ id: 'basic', name: 'Basic' }, { id: 'live-pro', name: 'Pro' }] });

    await assert.rejects(() => service.updatePlan('basic', { name: 'Pro' }, CONTEXT), BadRequestException);
    assert.equal(db.plan('basic')?.name, 'Basic');
  });
});

describe('the name a deleted plan is moved to', () => {
  it('fits the 128 the editor accepts, however long the original was', () => {
    const name = 'П'.repeat(PLAN_NAME_MAX_LENGTH);

    const renamed = buildDeletedPlanName(name, HIDDEN_ID, 0);

    assert.equal(PLAN_NAME_MAX_LENGTH, 128);
    assert.ok(renamed.length <= 128, `${renamed.length} characters`);
    assert.ok(renamed.endsWith(' (deleted n33gtpbe)'));
  });

  it('never cuts an emoji in half at the boundary', () => {
    const name = `${'a'.repeat(108)}😀😀😀`;

    const renamed = buildDeletedPlanName(name, HIDDEN_ID, 0);

    assert.ok(renamed.length <= 128);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(renamed), false, 'a lone high surrogate was left');
    assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(renamed), false, 'a lone low surrogate was left');
  });

  it('widens the suffix when the first candidate is taken', async () => {
    const { db } = build({
      plans: [hiddenPro, { id: 'squatter', name: 'Pro (deleted n33gtpbe)' }],
    });

    const released = await releasePlanNameFromDeletedPlan(db.client as never, { id: HIDDEN_ID, name: 'Pro' });

    assert.deepEqual(released, { planId: HIDDEN_ID, previousName: 'Pro', newName: 'Pro (deleted n33gtpbe-2)' });
    assert.equal(db.plan(HIDDEN_ID)?.name, 'Pro (deleted n33gtpbe-2)');
  });

  it('renames nothing when the hidden plan is already gone — the name is free', async () => {
    const { db } = build({ plans: [{ id: 'live', name: 'Live' }] });

    const released = await releasePlanNameFromDeletedPlan(db.client as never, { id: HIDDEN_ID, name: 'Pro' });

    assert.equal(released, null);
    assert.equal(db.plan('live')?.name, 'Live');
  });

  it('never renames a plan that is not soft-deleted, even if asked to', async () => {
    const { db } = build({ plans: [{ id: 'live-pro', name: 'Pro' }] });

    const released = await releasePlanNameFromDeletedPlan(db.client as never, { id: 'live-pro', name: 'Pro' });

    assert.equal(released, null);
    assert.equal(db.plan('live-pro')?.name, 'Pro');
  });
});

/**
 * The rename is for the unique index only; what a subscriber is shown is the
 * name without it (`displayPlanName`). The callers that write snapshots are
 * pinned in `test/plan-deleted-name-snapshots.spec.ts`; these cases pin what
 * the function strips and, as much, what it must leave alone.
 */
describe('the name a deleted plan is shown under', () => {
  const hiddenAs = (name: string, id = HIDDEN_ID) => ({ id, name, deletedAt: DELETED_AT });

  it('drops exactly the suffix the rename wrote, the widened attempts included', () => {
    for (const attempt of [0, 1, 7]) {
      const renamed = buildDeletedPlanName('Премиум 😀', HIDDEN_ID, attempt);
      assert.notEqual(renamed, 'Премиум 😀', 'fixture: the rename changed nothing');
      assert.equal(displayPlanName(hiddenAs(renamed)), 'Премиум 😀', `attempt ${attempt}: ${renamed}`);
    }
  });

  it('shows a LIVE plan exactly as the operator named it, suffix-shaped or not', () => {
    const named = 'Pro (deleted n33gtpbe)';

    assert.equal(displayPlanName({ id: HIDDEN_ID, name: named, deletedAt: null }), named);
  });

  it('leaves a suffix that names ANOTHER plan’s id alone', () => {
    const named = 'Pro (deleted zzzzzzzz)';

    assert.equal(displayPlanName(hiddenAs(named)), named);
  });

  it('leaves a hidden plan that was never renamed alone', () => {
    assert.equal(displayPlanName(hiddenAs('Pro')), 'Pro');
  });

  it('keeps the whole name when nothing but the suffix would be left', () => {
    const onlySuffix = ' (deleted n33gtpbe)';

    assert.equal(displayPlanName(hiddenAs(onlySuffix)), onlySuffix);
  });

  it('shows a name cut to fit 128 as cut — the characters that made room are not stored', () => {
    const long = 'П'.repeat(PLAN_NAME_MAX_LENGTH);
    const renamed = buildDeletedPlanName(long, HIDDEN_ID, 0);

    const shown = displayPlanName(hiddenAs(renamed));

    assert.equal(shown, 'П'.repeat(PLAN_NAME_MAX_LENGTH - ' (deleted n33gtpbe)'.length));
  });
});
