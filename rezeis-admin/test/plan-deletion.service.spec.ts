import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminPlansController } from '../src/modules/plans/controllers/admin-plans.controller';
import { PlanMoveDirection } from '../src/modules/plans/dto/move-plan.dto';
import { PlanDeletionService } from '../src/modules/plans/services/plan-deletion.service';
import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { assertEffectiveRoutePermission } from './helpers/controller-routes';
import { buildPlanReferenceDb, PlanReferenceDbSeed, Row } from './fixtures/plan-reference-db';

/**
 * DELETING A PLAN — contract v2 (13.09.2026), at the service seam.
 *
 * The delete never refuses. What these cases pin is the only decision it makes:
 * whether the row can go (nothing uses it) or must stay hidden (something does),
 * and the three things that have to be true either way — the other plans'
 * transition lists no longer name it, the order the operator sees has no hole,
 * and the audit log says which of the two happened and why.
 *
 * The database is the where-evaluating double in
 * `test/fixtures/plan-reference-db.ts`, so a reference that stops counting is a
 * red case here, not a green one; `test/plan-delete-postgres.spec.ts` proves the
 * same flow against PostgreSQL, cascades and the row lock included.
 */

const CONTEXT = {
  currentAdmin: { id: 'admin-1' } as never,
  requestMetadata: { requestId: 'req-1', remoteAddress: '203.0.113.7', userAgent: 'spec' },
};
const EARLIER = new Date('2026-09-01T00:00:00.000Z');

function harness(seed: PlanReferenceDbSeed) {
  const db = buildPlanReferenceDb(seed);
  const guard = new PlanReferenceGuardService(db.client as never);
  const deletion = new PlanDeletionService(db.client as never, guard);
  return { db, guard, deletion };
}

const liveSubscription = (planId: string): Row => ({
  id: `sub-${planId}`,
  status: 'ACTIVE',
  planSnapshot: { id: planId },
});

describe('DELETE removes a plan nothing uses, once it is off sale', () => {
  it('deletes the row and answers removed: true', async () => {
    const { db, deletion } = harness({
      plans: [{ id: 'gone', name: 'Старт 2024', isArchived: true }, { id: 'kept', orderIndex: 1 }],
    });

    const result = await deletion.deletePlan('gone', CONTEXT);

    assert.deepEqual(result, { deleted: true, removed: true });
    assert.equal(db.plan('gone'), undefined, 'the row is still there');
    assert.ok(db.calls.includes('plan.delete'), 'no hard delete was issued');
    assert.equal(db.visibleOrder(), 'kept@0');
  });

  it('removes an unused plan that is inactive but not archived — it is off sale too', async () => {
    const { db, deletion } = harness({ plans: [{ id: 'gone', isActive: false, isArchived: false }] });

    const result = await deletion.deletePlan('gone', CONTEXT);

    assert.deepEqual(result, { deleted: true, removed: true });
    assert.equal(db.plan('gone'), undefined);
  });

  it('only HIDES an unused plan that is still on sale: a checkout may be writing its invoice right now', async () => {
    const { db, deletion } = harness({ plans: [{ id: 'selling', isActive: true, isArchived: false }] });

    const result = await deletion.deletePlan('selling', CONTEXT);

    // Nothing references it at this instant, but checkout reads the plan without
    // a lock; a hard delete here can race an invoice being inserted for it.
    assert.deepEqual(result, { deleted: true, removed: false });
    const row = db.plan('selling');
    assert.ok(row !== undefined, 'an on-sale plan was hard-deleted in the same breath as it left sale');
    assert.ok(row.deletedAt instanceof Date);
    assert.equal(row.isActive, false);
    assert.equal(row.isArchived, true);
    assert.equal(db.calls.includes('plan.delete'), false);
    assert.deepEqual((db.tables.adminAuditLog[0]?.metadata as Row).references, []);
  });

  it('writes plans.deleted with removed: true and no references', async () => {
    const { db, deletion } = harness({ plans: [{ id: 'gone', name: 'Старт 2024', isArchived: true }] });

    await deletion.deletePlan('gone', CONTEXT);

    assert.equal(db.tables.adminAuditLog.length, 1);
    const audit = db.tables.adminAuditLog[0]!;
    assert.equal(audit.action, 'plans.deleted');
    assert.equal(audit.ipAddress, '203.0.113.7');
    assert.deepEqual(audit.adminUser, { connect: { id: 'admin-1' } });
    assert.deepEqual(audit.metadata, {
      requestId: 'req-1',
      planId: 'gone',
      name: 'Старт 2024',
      removed: true,
      references: [],
      transitionsStripped: 0,
    });
  });
});

describe('DELETE hides a plan something still uses', () => {
  it('keeps the row, stamps it, takes it off sale and answers removed: false', async () => {
    const { db, deletion } = harness({
      plans: [{ id: 'used', isActive: true, isArchived: false }],
      subscriptions: [liveSubscription('used')],
    });

    const result = await deletion.deletePlan('used', CONTEXT);

    assert.deepEqual(result, { deleted: true, removed: false });
    const row = db.plan('used');
    assert.ok(row !== undefined, 'a plan a subscriber is on was hard-deleted');
    assert.ok(row.deletedAt instanceof Date, 'deletedAt was not stamped');
    assert.equal(row.isArchived, true);
    assert.equal(row.isActive, false);
    assert.equal(db.calls.includes('plan.delete'), false);
  });

  it('records what kept it, with exact counts, in contract order', async () => {
    const { db, deletion } = harness({
      plans: [{ id: 'used', name: 'Pro' }],
      quests: [
        { id: 'q1', rewardPlanId: 'used', rewardType: 'DAYS' },
        { id: 'q2', rewardPlanId: 'used', rewardType: 'PROMOCODE' },
      ],
      subscriptions: [liveSubscription('used')],
    });

    await deletion.deletePlan('used', CONTEXT);

    assert.deepEqual(db.tables.adminAuditLog[0]?.metadata, {
      requestId: 'req-1',
      planId: 'used',
      name: 'Pro',
      removed: false,
      references: [
        { kind: 'subscriptions', count: 1 },
        { kind: 'quests', count: 2 },
      ],
      transitionsStripped: 0,
    });
  });

  // One case per money-critical kind: the row a paid invoice is fulfilled from
  // must survive the button, whatever else is true.
  const moneyCritical: ReadonlyArray<[string, PlanReferenceDbSeed]> = [
    ['a PENDING purchase', { transactions: [{ id: 't', status: 'PENDING', planSnapshot: { id: 'used' }, fulfilledAt: null, createdAt: EARLIER }] }],
    ['a paid purchase not yet fulfilled', { transactions: [{ id: 't', status: 'COMPLETED', planSnapshot: { id: 'used' }, fulfilledAt: null, createdAt: EARLIER }] }],
    ['a SCHEDULED paid term', { subscriptionTerms: [{ id: 'term', planId: 'used', status: 'SCHEDULED' }] }],
    ['a RESERVED paid trial', { trialClaims: [{ id: 'c', planId: 'used', status: 'RESERVED' }] }],
  ];
  for (const [what, seed] of moneyCritical) {
    it(`keeps the row for ${what}`, async () => {
      const { db, deletion } = harness({ plans: [{ id: 'used' }], ...seed });

      const result = await deletion.deletePlan('used', CONTEXT);

      assert.equal(result.removed, false);
      assert.ok(db.plan('used') !== undefined);
    });
  }
});

describe('DELETE strips the plan from every other plan’s transitions first', () => {
  it('removes it from upgrade and replacement lists and leaves the other entries', async () => {
    const { db, deletion } = harness({
      plans: [
        { id: 'target', upgradeToPlanIds: ['elsewhere'], isArchived: true },
        { id: 'a', upgradeToPlanIds: ['target', 'b'] },
        { id: 'b', isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: ['target', 'a'] },
        { id: 'elsewhere' },
      ],
    });

    const result = await deletion.deletePlan('target', CONTEXT);

    assert.deepEqual(db.plan('a')?.upgradeToPlanIds, ['b']);
    assert.deepEqual(db.plan('b')?.replacementPlanIds, ['a']);
    // A transition alone never keeps a plan: stripped, then nothing is left.
    assert.equal(result.removed, true);
    assert.equal(db.tables.adminAuditLog[0]?.metadata && (db.tables.adminAuditLog[0].metadata as Row).transitionsStripped, 2);
  });

  it('strips before counting, so a plan used by a subscription AND a transition is hidden with no transition left', async () => {
    const { db, deletion } = harness({
      plans: [{ id: 'target' }, { id: 'a', upgradeToPlanIds: ['target'] }],
      subscriptions: [liveSubscription('target')],
    });

    const result = await deletion.deletePlan('target', CONTEXT);

    assert.equal(result.removed, false);
    assert.deepEqual(db.plan('a')?.upgradeToPlanIds, []);
    assert.deepEqual((db.tables.adminAuditLog[0]?.metadata as Row).references, [{ kind: 'subscriptions', count: 1 }]);
  });

  it('locks the plan row before it strips or counts anything', async () => {
    const { db, deletion } = harness({ plans: [{ id: 'target' }, { id: 'a', upgradeToPlanIds: ['target'] }] });

    await deletion.deletePlan('target', CONTEXT);

    const lock = db.calls.indexOf('$queryRaw:lock-plan');
    const strip = db.calls.indexOf('$executeRaw:strip-transitions');
    const firstCount = db.calls.findIndex((call) => call.endsWith('.count') || call.endsWith('.groupBy'));
    assert.ok(lock >= 0 && strip > lock && firstCount > strip, `order was: ${db.calls.join(' → ')}`);
    assert.equal(db.transactions, 1, 'the delete ran outside a single transaction');
  });
});

describe('DELETE answers 404 for a plan that is not there to delete', () => {
  it('404s an unknown id and changes nothing', async () => {
    const { db, deletion } = harness({ plans: [{ id: 'a', upgradeToPlanIds: ['ghost'] }] });

    await assert.rejects(() => deletion.deletePlan('ghost', CONTEXT), NotFoundException);

    assert.deepEqual(db.plan('a')?.upgradeToPlanIds, ['ghost']);
    assert.deepEqual(db.tables.adminAuditLog, []);
  });

  it('404s a plan that was already soft-deleted, and does not decide a second time', async () => {
    const { db, deletion } = harness({
      plans: [{ id: 'hidden', deletedAt: EARLIER, isActive: false, isArchived: true }],
    });

    await assert.rejects(() => deletion.deletePlan('hidden', CONTEXT), NotFoundException);

    assert.ok(db.plan('hidden') !== undefined, 'a second delete removed the hidden row');
    assert.deepEqual(db.tables.adminAuditLog, []);
    assert.equal(db.calls.includes('$executeRaw:strip-transitions'), false);
  });
});

describe('the order the operator sees has no hole and no duplicate', () => {
  const four = (): Row[] => [
    { id: 'p0', orderIndex: 0 },
    // Archived, so an unused p1 is hard-deleted rather than hidden.
    { id: 'p1', orderIndex: 1, isArchived: true },
    { id: 'p2', orderIndex: 2 },
    { id: 'p3', orderIndex: 3 },
  ];

  it('after a hard delete', async () => {
    const { db, deletion } = harness({ plans: four() });

    await deletion.deletePlan('p1', CONTEXT);

    assert.equal(db.visibleOrder(), 'p0@0 p2@1 p3@2');
  });

  it('after a soft delete — the hidden plan leaves no gap', async () => {
    const { db, deletion } = harness({ plans: four(), subscriptions: [liveSubscription('p1')] });

    await deletion.deletePlan('p1', CONTEXT);

    assert.ok(db.plan('p1') !== undefined);
    assert.equal(db.visibleOrder(), 'p0@0 p2@1 p3@2');
  });

  it('ignores earlier hidden plans when compacting', async () => {
    const { db, deletion } = harness({
      plans: [
        { id: 'hidden', orderIndex: 0, deletedAt: EARLIER, isActive: false, isArchived: true },
        { id: 'p0', orderIndex: 1 },
        { id: 'p1', orderIndex: 2 },
      ],
    });

    await deletion.deletePlan('p0', CONTEXT);

    assert.equal(db.visibleOrder(), 'p1@0');
  });
});

describe('GET /admin/plans/:planId/references', () => {
  it('answers { planId, references } with only kinds above zero, in contract order', async () => {
    const { deletion } = harness({
      plans: [{ id: 'used' }, { id: 'a', replacementPlanIds: ['used'] }],
      addOns: [{ id: 'addon', applicablePlanIds: ['used'] }],
      subscriptions: [liveSubscription('used')],
    });

    const body = await deletion.getReferences('used');

    assert.deepEqual(body, {
      planId: 'used',
      references: [
        { kind: 'subscriptions', count: 1 },
        { kind: 'addOns', count: 1 },
        { kind: 'transitions', count: 1 },
      ],
    });
  });

  it('answers an empty list for a plan nothing uses', async () => {
    const { deletion } = harness({ plans: [{ id: 'free' }] });

    assert.deepEqual(await deletion.getReferences('free'), { planId: 'free', references: [] });
  });

  it('404s an unknown plan', async () => {
    const { deletion } = harness({ plans: [] });

    await assert.rejects(() => deletion.getReferences('ghost'), NotFoundException);
  });

  it('404s a soft-deleted plan', async () => {
    const { deletion } = harness({ plans: [{ id: 'hidden', deletedAt: EARLIER }] });

    await assert.rejects(() => deletion.getReferences('hidden'), NotFoundException);
  });
});

describe('a soft-deleted plan is gone from every operator surface', () => {
  function adminService(seed: PlanReferenceDbSeed): { service: PlansAdminService; db: ReturnType<typeof buildPlanReferenceDb> } {
    const db = buildPlanReferenceDb(seed);
    const remnawave = { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] };
    const service = new PlansAdminService(
      db.client as never,
      remnawave as never,
      { syncPlanSnapshotMetadata: async () => 0 } as never,
      new PlansAdminValidators(db.client as never, remnawave as never),
      new PlanSquadPropagationService(db.client as never, { enqueue: async () => undefined } as never),
    );
    return { service, db };
  }
  const seed: PlanReferenceDbSeed = {
    plans: [
      { id: 'live', name: 'Live', orderIndex: 0 },
      { id: 'hidden', name: 'Hidden', orderIndex: 1, deletedAt: EARLIER, isActive: false, isArchived: true, availability: 'ALLOWED' },
    ],
  };

  it('is not in GET /admin/plans — while a live plan is', async () => {
    const { service } = adminService(seed);

    const ids = (await service.listPlans()).map((plan) => plan.id);

    assert.deepEqual(ids, ['live']);
  });

  it('404s GET /admin/plans/:planId', async () => {
    const { service } = adminService(seed);

    await assert.rejects(() => service.getPlan('hidden'), NotFoundException);
    assert.equal((await service.getPlan('live')).id, 'live');
  });

  it('404s an edit — which could otherwise put it back on sale', async () => {
    const { service, db } = adminService(seed);

    await assert.rejects(() => service.updatePlan('hidden', { isActive: true }, CONTEXT), NotFoundException);

    assert.equal(db.plan('hidden')?.isActive, false);
  });

  it('404s a move, and a move of a live plan never swaps with it', async () => {
    const { service, db } = adminService(seed);

    await assert.rejects(() => service.movePlan('hidden', PlanMoveDirection.UP, CONTEXT), NotFoundException);
    await service.movePlan('live', PlanMoveDirection.DOWN, CONTEXT);

    assert.equal(db.plan('live')?.orderIndex, 0, 'the last visible plan moved down past a hidden one');
  });

  it('takes no slot in a reorder sent by a stale page', async () => {
    const { service, db } = adminService(seed);

    await service.reorderPlans(['hidden', 'live'], CONTEXT);

    assert.equal(db.plan('live')?.orderIndex, 0);
    assert.equal(db.plan('hidden')?.orderIndex, 1, 'a hidden plan was given a visible slot');
  });

  it('404s the allow-list toggle on the user card', async () => {
    const { service } = adminService(seed);

    await assert.rejects(
      () => service.setUserPlanAccess({ planId: 'hidden', userId: 'user-1', granted: true, context: CONTEXT }),
      NotFoundException,
    );
  });
});

describe('the admin plans controller', () => {
  it('serves GET :planId/references and DELETE :planId, both gated on plans:delete', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.getPlanReferences), ':planId/references');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.getPlanReferences), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.deletePlan), ':planId');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.deletePlan), RequestMethod.DELETE);
    assertEffectiveRoutePermission(
      AdminPlansController,
      AdminPlansController.prototype.getPlanReferences,
      { resource: 'plans', action: 'delete' },
      'GET admin/plans/:planId/references',
    );
    assertEffectiveRoutePermission(
      AdminPlansController,
      AdminPlansController.prototype.deletePlan,
      { resource: 'plans', action: 'delete' },
      'DELETE admin/plans/:planId',
    );
  });

  it('answers the delete with the service’s body unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new AdminPlansController(
      {} as never,
      {} as never,
      {
        deletePlan: async (planId: string, context: unknown) => {
          calls.push({ planId, context });
          return { deleted: true, removed: false };
        },
        getReferences: async (planId: string) => ({ planId, references: [{ kind: 'quests', count: 3 }] }),
      } as never,
    );
    const request = { headers: { 'user-agent': 'spec' }, ip: '203.0.113.7', socket: {} } as never;

    assert.deepEqual(await controller.deletePlan('p1', { id: 'admin-1' } as never, request), {
      deleted: true,
      removed: false,
    });
    assert.deepEqual(await controller.getPlanReferences('p1'), {
      planId: 'p1',
      references: [{ kind: 'quests', count: 3 }],
    });
    assert.equal(calls.length, 1);
  });
});
