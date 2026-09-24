import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { buildPlanReferenceDb } from './fixtures/plan-reference-db';
import { NOT_IN_TERM_MODEL } from './helpers/term-model-hooks';

/**
 * AN OPERATOR CANNOT PUT A SUBSCRIPTION ON A DELETED PLAN FROM A STALE PAGE.
 *
 * Neither picker lists a deleted plan, but a page opened before the delete
 * still sends its id. `giveSubscription` and the plan change in
 * `updateSubscription` refuse it with 404 — and until now no test could have
 * noticed that refusal going away: the controller specs answer
 * `plan.findUnique` with a fixed row whatever it is asked, so dropping
 * `deletedAt: null` from either lookup left every case green. The plan table
 * here evaluates the controller's own `where` (`test/fixtures/plan-reference-db.ts`),
 * and each refusal sits beside the same call on a live plan, which must go
 * through.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQUEST = {
  headers: { 'x-request-id': 'req-1', 'user-agent': 'spec' },
  ip: '10.0.0.7',
  socket: { remoteAddress: null },
} as never;

function harness() {
  const db = buildPlanReferenceDb({
    plans: [
      { id: 'plan-live', name: 'Live', trafficLimit: 100, deviceLimit: 3, internalSquads: ['squad-a'] },
      {
        id: 'plan-deleted',
        name: 'Deleted',
        deletedAt: new Date('2026-09-01T00:00:00.000Z'),
        isActive: false,
        isArchived: true,
        trafficLimit: 500,
        deviceLimit: 10,
        internalSquads: ['squad-b'],
      },
    ],
  });
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const row = {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: 'panel-user-1',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: ['squad-a'],
    externalSquad: null,
  };
  const controller = new AdminUserSubscriptionsController(
    {
      user: { findFirst: async () => ({ id: 'user-1', telegramId: BigInt(42) }) },
      plan: db.client.plan,
      subscription: {
        findUnique: async () => row,
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: 'sub-new', remnawaveId: null, ...args.data };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
      adminAuditLog: { create: async () => undefined },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: async () => 1,
          // A plan assignment re-reads the row under its lock to carry what it
          // holds above its old plan; this one has no snapshot to measure by.
          $queryRaw: async () => [{ id: row.id }],
          subscription: {
            findUnique: async () => row,
            update: async (args: { data: Record<string, unknown> }) => {
              updated.push(args.data);
              return { ...row, ...args.data };
            },
            // «Выдать подписку» creates inside a transaction now, beside the
            // hook that enters the term model (nothing enters here).
            create: async (args: { data: Record<string, unknown> }) => {
              created.push(args.data);
              return { id: 'sub-new', remnawaveId: null, ...args.data };
            },
          },
          subscriptionEffectiveProjection: { findUnique: async () => null },
          profileSyncJob: { create: async () => ({ id: 'sync-2' }) },
        }),
    } as never,
    {} as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined } as never,
    {} as never,
    {} as never,
    NOT_IN_TERM_MODEL as never,
  );
  return { controller, created, updated };
}

describe('giving a subscription on a plan', () => {
  it('refuses a deleted plan with 404 and creates nothing', async () => {
    const h = harness();

    await assert.rejects(
      () => h.controller.giveSubscription('42', { planId: 'plan-deleted', durationDays: 30 }, ADMIN, REQUEST),
      NotFoundException,
    );
    assert.deepEqual(h.created, [], 'a subscription was created on a deleted plan');
  });

  it('gives one on a live plan — the non-vacuous half', async () => {
    const h = harness();

    await h.controller.giveSubscription('42', { planId: 'plan-live', durationDays: 30 }, ADMIN, REQUEST);

    assert.equal(h.created.length, 1);
    assert.equal((h.created[0]?.planSnapshot as Record<string, unknown>).id, 'plan-live');
  });
});

describe('changing a subscription’s plan in the editor', () => {
  it('refuses a deleted plan with 404 and writes nothing', async () => {
    const h = harness();

    await assert.rejects(
      () => h.controller.updateSubscription('sub-1', { planId: 'plan-deleted' }, ADMIN, REQUEST),
      NotFoundException,
    );
    assert.deepEqual(h.updated, [], 'the subscription was moved onto a deleted plan');
  });

  it('moves it onto a live plan — the non-vacuous half', async () => {
    const h = harness();

    await h.controller.updateSubscription('sub-1', { planId: 'plan-live' }, ADMIN, REQUEST);

    assert.equal(h.updated.length, 1);
    assert.equal((h.updated[0]?.planSnapshot as Record<string, unknown>).id, 'plan-live');
  });
});
