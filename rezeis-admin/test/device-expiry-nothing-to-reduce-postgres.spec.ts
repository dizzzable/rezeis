import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnLifetime, AddOnType, Prisma, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import {
  at,
  createPlan,
  subscriptionInModel,
  termModelFixtures,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * A DEVICE ADD-ON THAT HAS ENDED ON A SUBSCRIPTION WITH NOTHING TO REDUCE — no
 * panel profile to hold a device, or an unlimited device limit — completes its
 * expiry in the sweep that finds it, on PostgreSQL, through
 * the real scheduler, boundary and planner.
 *
 * Before, the planner answered `NOT_APPLICABLE` and the sweep did nothing with
 * it: the add-on stayed EXPIRING and came back every five minutes for another
 * planning call that could only say the same, forever.
 *
 * The sweep runs over the whole table, as the worker does, and the rows here
 * are due years back so that they sort first; the assertions are only about
 * these rows.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

let prisma: PrismaService;
let fx: TermModelFixtures;
let scheduler: EntitlementBoundarySchedulerService;

/** An EXTRA_DEVICES add-on whose expiry began long ago and never completed. */
async function endedDeviceAddOn(owner: { readonly userId: string; readonly subscriptionId: string }): Promise<string> {
  const term = await prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
  });
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${fx.prefix}-pay-${fx.next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: {},
    },
  });
  const entitlement = await prisma.addOnEntitlement.create({
    data: {
      subscriptionId: owner.subscriptionId,
      termId: term.id,
      sourceTransactionId: payment.id,
      sourceLineKey: 'line',
      catalogRevision: 1,
      receiptName: '+2 devices',
      type: AddOnType.EXTRA_DEVICES,
      valuePerUnit: 2,
      totalValue: 2n,
      lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
      unitAmount: new Prisma.Decimal('99'),
      totalAmount: new Prisma.Decimal('99'),
      currency: 'RUB',
      purchasedAt: at(-3000),
      scheduledActivationAt: at(-3000),
      activatedAt: at(-3000),
      expiresAt: at(-2900),
      state: 'EXPIRING',
    },
  });
  return entitlement.id;
}

run('a device add-on with nothing to reduce completes its expiry — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2reduce-${process.pid}-${Date.now()}`);
    const terms = new SubscriptionTermService();
    const entitlements = new AddOnEntitlementService();
    const projections = new EffectiveProjectionService();
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    // No panel stub: neither case may reach the panel.
    const planner = new DeviceReductionPlanService(prisma, {} as never);
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      planner,
      {} as never,
      terms,
    );
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  for (const shape of [
    { name: 'no panel profile is linked', reason: 'NO_PANEL_PROFILE', devices: 3, unlinked: true },
    { name: 'the device limit is unlimited', reason: 'UNLIMITED_DEVICES', devices: 0, unlinked: false },
  ] as const) {
    it(`completes when ${shape.name}, and does not come back`, async () => {
      const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionInModel(fx, {
        planId: plan,
        plan: { trafficLimit: 100, deviceLimit: 3 },
        columns: { trafficLimit: 100, deviceLimit: shape.devices },
        unlinked: shape.unlinked,
      });
      const addOnId = await endedDeviceAddOn(owner);

      await scheduler.runDueBoundaries();

      const completed = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(completed.state, 'EXPIRED', 'the expiry completed');
      const event = await prisma.addOnEntitlementEvent.findFirstOrThrow({
        where: { entitlementId: addOnId, toState: 'EXPIRED' },
      });
      assert.equal(event.reason, 'DEVICE_REDUCTION_NOT_APPLICABLE');
      assert.equal((event.metadata as { plannerReason?: string }).plannerReason, shape.reason);
      assert.equal(event.commandKey, `device-expiry-not-applicable:${addOnId}`);
      assert.equal(await prisma.deviceReductionPlan.count({ where: { subscriptionId: owner.subscriptionId } }), 0);

      // The next tick finds nothing left to do for it.
      const eventsBefore = await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOnId } });
      await scheduler.runDueBoundaries();
      assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOnId } }), eventsBefore);
      assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } })).state, 'EXPIRED');
    });
  }
});
