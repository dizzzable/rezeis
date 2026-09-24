import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';

/**
 * THE BOUNDARY SWEEP CANNOT BE STARVED — against PostgreSQL, because the
 * selection is SQL: its ORDER BY, its split into fresh boundaries and
 * re-entries, and the parking of device expiries that wait for an operator.
 *
 * A tick takes 200 subscriptions. Before this, it took them in no order from
 * one list, so rows that come back every tick by design — device reductions
 * waiting for an approval, a DELETED row whose recompute threw — could fill the
 * window and a healthy add-on behind them never expired.
 *
 * The sweep reads the WHOLE table, as the worker does, so this file's rows are
 * made due far in the past: whatever else the database holds, they sort first.
 * Assertions are about this file's rows only.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d1sweep-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;

let prisma: PrismaService;
const users: string[] = [];

const at = (offsetDays: number): Date => new Date(Date.now() + offsetDays * DAY_MS);

interface DueFixture {
  readonly id: string;
  readonly status?: SubscriptionStatus;
  /** The add-on's end — the instant the sweep orders by. */
  readonly dueAt: Date;
  readonly state: 'ACTIVE' | 'EXPIRING';
  readonly type: AddOnType;
  /** A device-reduction plan at the projection's current revision. */
  readonly plan?: 'PENDING' | 'BLOCKED';
  /** An OPEN planner incident at the projection's current revision. */
  readonly plannerIncident?: boolean;
}

/**
 * Many subscriptions in the model, each with one due add-on, in bulk: a term,
 * a projection at revision 1, the add-on, and optionally a device plan or a
 * planner incident at that revision.
 */
async function seedDue(userId: string, fixtures: readonly DueFixture[]): Promise<void> {
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${userId}`,
      userId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'USD',
      amount: new Prisma.Decimal('1.00'),
      planSnapshot: {},
    },
  });
  const chunks = <T>(rows: readonly T[]): T[][] => {
    const out: T[][] = [];
    for (let offset = 0; offset < rows.length; offset += 500) out.push(rows.slice(offset, offset + 500));
    return out;
  };
  for (const part of chunks(fixtures)) {
    await prisma.subscription.createMany({
      data: part.map((row) => ({
        id: row.id,
        userId,
        status: row.status ?? SubscriptionStatus.ACTIVE,
        planSnapshot: { trafficLimit: 100, deviceLimit: 3 },
        trafficLimit: 100,
        deviceLimit: 3,
        expiresAt: at(30),
      })),
    });
    await prisma.subscriptionTerm.createMany({
      data: part.map((row) => ({
        id: `${row.id}-term`,
        subscriptionId: row.id,
        generation: 1,
        status: SubscriptionTermStatus.ACTIVE,
        planSnapshot: {},
        startsAt: new Date(row.dueAt.getTime() - 60 * DAY_MS),
        endsAt: at(30),
        baseTrafficLimitBytes: 100n * GIB,
        baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET',
      })),
    });
    await prisma.subscriptionEffectiveProjection.createMany({
      data: part.map((row) => ({
        id: `${row.id}-projection`,
        subscriptionId: row.id,
        baselineTermId: `${row.id}-term`,
        desiredRevision: 1n,
        baseTrafficLimitBytes: 100n * GIB,
        baseDeviceLimit: 3,
        activeTrafficContributionBytes: row.state === 'ACTIVE' && row.type === AddOnType.EXTRA_TRAFFIC ? 5n * GIB : 0n,
        activeDeviceContribution: row.state === 'ACTIVE' && row.type === AddOnType.EXTRA_DEVICES ? 1 : 0,
        desiredTrafficLimitBytes: 100n * GIB,
        desiredDeviceLimit: 3,
        state: 'APPLIED',
      })),
    });
    await prisma.addOnEntitlement.createMany({
      data: part.map((row) => ({
        id: `${row.id}-addon`,
        subscriptionId: row.id,
        termId: `${row.id}-term`,
        sourceTransactionId: payment.id,
        sourceLineKey: row.id,
        catalogRevision: 1,
        receiptName: 'fixture',
        type: row.type,
        valuePerUnit: row.type === AddOnType.EXTRA_DEVICES ? 1 : 5,
        totalValue: row.type === AddOnType.EXTRA_DEVICES ? 1n : 5n * GIB,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: new Date(row.dueAt.getTime() - 30 * DAY_MS),
        scheduledActivationAt: new Date(row.dueAt.getTime() - 30 * DAY_MS),
        activatedAt: new Date(row.dueAt.getTime() - 30 * DAY_MS),
        expiresAt: row.dueAt,
        state: row.state,
      })),
    });
    const planned = part.filter((row) => row.plan !== undefined);
    if (planned.length > 0) {
      await prisma.deviceReductionPlan.createMany({
        data: planned.map((row) => ({
          id: `${row.id}-plan`,
          subscriptionId: row.id,
          projectionId: `${row.id}-projection`,
          projectionRevision: 1n,
          desiredLimit: 3,
          state: row.plan!,
        })),
      });
    }
    const refused = part.filter((row) => row.plannerIncident === true);
    if (refused.length > 0) {
      await prisma.entitlementIncident.createMany({
        data: refused.map((row) => ({
          subscriptionId: row.id,
          kind: 'DEVICE_REDUCTION_BLOCKED' as const,
          severity: 'WARNING' as const,
          supportRef: `device-reduction-conflict:${row.id}:1`,
          summaryCode: 'DORMANT_RETENTION_CONFLICT',
          metadata: { projectionRevision: '1' },
        })),
      });
    }
  }
}

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

run('entitlement boundary sweep — ordering, parking, DELETED rows — PostgreSQL', () => {
  const terms = new SubscriptionTermService();
  const entitlements = new AddOnEntitlementService();
  const projections = new EffectiveProjectionService();
  const planned: string[] = [];
  const executed: string[] = [];
  let planOutcome: (subscriptionId: string) => Record<string, unknown> = () => ({
    status: 'DEFERRED',
    reason: 'PANEL_UNAVAILABLE',
  });
  let scheduler: EntitlementBoundarySchedulerService;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      {
        planForSubscription: async (subscriptionId: string) => {
          planned.push(subscriptionId);
          return planOutcome(subscriptionId);
        },
      } as never,
      {
        executePlan: async (planId: string) => {
          executed.push(planId);
          return { status: 'DEFERRED' };
        },
      } as never,
      terms,
    );
  });

  after(async () => {
    delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  it('retires a DELETED subscription it finds due instead of throwing on it every tick', async () => {
    const userId = await newUser('deleted');
    const id = `${prefix}-deleted-sub`;
    await seedDue(userId, [
      { id, status: SubscriptionStatus.DELETED, dueAt: at(-4000), state: 'ACTIVE', type: AddOnType.EXTRA_TRAFFIC },
    ]);

    await scheduler.runDueBoundaries(new Date());

    const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: `${id}-addon` } });
    assert.equal(addOn.state, AddOnEntitlementState.REVERSED);
    assert.equal(addOn.terminalReason, 'SUBSCRIPTION_DELETED');
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: `${id}-term` } })).status, 'ENDED');
    assert.equal(
      (await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } })).state,
      'DELETED',
    );
    // Out of the selection for good: nothing of it is due any more.
    const due = await prisma.addOnEntitlement.count({
      where: { subscriptionId: id, state: { in: ['ACTIVE', 'EXPIRING'] } },
    });
    assert.equal(due, 0);
  });

  it('takes fresh boundaries earliest-due first, whatever their ids', async () => {
    const userId = await newUser('order');
    // 200 decoys fill a tick on their own. Two rows fell due years earlier;
    // their ids sort FIRST and LAST, so an order by id — either way — or no
    // order at all leaves one of them behind the decoys.
    const earlyFirst = `aaa-${prefix}-early`;
    const earlyLast = `zzz-${prefix}-early`;
    const fixtures: DueFixture[] = [
      { id: earlyFirst, dueAt: at(-3650), state: 'ACTIVE', type: AddOnType.EXTRA_TRAFFIC },
      { id: earlyLast, dueAt: at(-3649), state: 'ACTIVE', type: AddOnType.EXTRA_TRAFFIC },
      ...Array.from({ length: 200 }, (_, index) => ({
        id: `${prefix}-decoy-${String(index).padStart(3, '0')}`,
        dueAt: at(-3000),
        state: 'ACTIVE' as const,
        type: AddOnType.EXTRA_TRAFFIC,
      })),
    ];
    await seedDue(userId, fixtures);

    await scheduler.runDueBoundaries(new Date());

    for (const id of [earlyFirst, earlyLast]) {
      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: `${id}-addon` } });
      assert.equal(addOn.state, AddOnEntitlementState.EXPIRED, `${id} fell due first and must expire in the first tick`);
    }
    // Drain the decoys so the later cases start from a clean fresh class.
    for (let tick = 0; tick < 5; tick += 1) await scheduler.runDueBoundaries(new Date());
  });

  it('parks device expiries that wait for an operator, so a fresh add-on still expires in one tick', async () => {
    const userId = await newUser('park');
    const waiting = Array.from({ length: 250 }, (_, index) => ({
      id: `${prefix}-waiting-${String(index).padStart(3, '0')}`,
      dueAt: at(-3500 + index / 1_000),
      state: 'EXPIRING' as const,
      type: AddOnType.EXTRA_DEVICES,
      plan: 'PENDING' as const,
    }));
    const refusedByPlanner = `${prefix}-refused`;
    const retrying = `${prefix}-retrying`;
    const fresh = `${prefix}-fresh`;
    await seedDue(userId, [
      ...waiting,
      { id: refusedByPlanner, dueAt: at(-3600), state: 'EXPIRING', type: AddOnType.EXTRA_DEVICES, plannerIncident: true },
      // No plan and no incident: the panel was unavailable — retried every tick.
      { id: retrying, dueAt: at(-3550), state: 'EXPIRING', type: AddOnType.EXTRA_DEVICES },
      // The healthy add-on that must not starve, due LATER than all of them.
      { id: fresh, dueAt: at(-2000), state: 'ACTIVE', type: AddOnType.EXTRA_TRAFFIC },
    ]);
    planned.length = 0;

    // Stage 6 explicitly OFF: unset is ON since the 24.09.2026 flip.
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'false';
    await scheduler.runDueBoundaries(new Date());

    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: `${fresh}-addon` } })).state,
      AddOnEntitlementState.EXPIRED,
      'the fresh add-on expired in the first tick',
    );
    const mine = new Set([...waiting.map((row) => row.id), refusedByPlanner]);
    assert.deepEqual(planned.filter((id) => mine.has(id)), [], 'nothing waiting for an operator was re-planned');
    assert.ok(planned.includes(retrying), 'a device expiry NOT waiting for anyone is retried');
  });

  it('with automatic cleanup on, a planned reduction is executed rather than parked; a planner refusal stays parked', async () => {
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    planned.length = 0;
    executed.length = 0;
    planOutcome = (subscriptionId) => ({ status: 'PLANNED', planId: `${subscriptionId}-plan`, targetCount: 1 });
    try {
      await scheduler.runDueBoundaries(new Date());
    } finally {
      planOutcome = () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' });
      // Back to OFF, spelled out, for the cases after this one.
      process.env.ADDON_DEVICE_CLEANUP_AUTO = 'false';
    }
    const waitingPlanned = planned.filter((id) => id.startsWith(`${prefix}-waiting-`));
    assert.ok(waitingPlanned.length > 0, 'planned reductions come back to the sweep');
    assert.deepEqual(
      executed.filter((planId) => planId.startsWith(`${prefix}-waiting-`)),
      waitingPlanned.map((id) => `${id}-plan`),
      'and each is handed to the executor',
    );
    assert.equal(planned.includes(`${prefix}-refused`), false, 'a planner refusal waits for a person either way');
  });

  it('re-drives the parked expiries hourly, oldest first and bounded', async () => {
    planned.length = 0;
    const result = await scheduler.redriveParkedDeviceExpiries(new Date());
    assert.ok(result.subscriptions <= 100);
    // The planner refusal is the oldest parked row this file made.
    assert.ok(planned.includes(`${prefix}-refused`));
    const waitingPlanned = planned.filter((id) => id.startsWith(`${prefix}-waiting-`));
    assert.ok(waitingPlanned.length > 0);
    assert.deepEqual(waitingPlanned, [...waitingPlanned].sort(), 'oldest first');
  });
});
