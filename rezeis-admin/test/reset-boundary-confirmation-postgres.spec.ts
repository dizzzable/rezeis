import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  type TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_PRESENTATION } from '../src/common/services/system-events.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import {
  RESET_CONFIRMATION_HOLD_MS,
  ResetBoundaryConfirmationService,
} from '../src/modules/add-on-entitlements/services/reset-boundary-confirmation.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import type { RemnawaveProfileFacts } from '../src/modules/remnawave/utils/remnawave-profile-facts.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * THE LIMIT DROP FOLLOWS THE COUNTER RESET — W7 test 3, on PostgreSQL
 * ═══════════════════════════════════════════════════════════════════
 * An add-on «до сброса трафика» is taken off only once Remnawave's reset is
 * confirmed, at most six hours late; then it expires anyway with ONE incident
 * per boundary. The selection, the hold and the epoch close are SQL, so they
 * are proved here, through the real sweep (`runDueBoundaries`): the
 * confirmation pass, the selection that leaves held rows out of the window,
 * and the boundary that expires what is due.
 *
 * Remnawave is a fake `RemnawaveProfileFactsService` whose answers each case
 * sets. Every boundary here is an instant of this file's own (`P`), minutes
 * or hours before the real now: the confirmation compares instants, it does
 * not predict them (that is `reset-cycle-policy.ts`, proved elsewhere).
 *
 * The sweep reads the whole table, as the worker does; assertions are about
 * this file's rows only. Runs only with TEST_DATABASE_URL; listed in ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4hold-${process.pid}-${Date.now()}`;
const GIB = 1024n * 1024n * 1024n;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MARGIN = 30 * MINUTE;

let prisma: PrismaService;
const users: string[] = [];

interface ReadAnswer {
  readonly facts: RemnawaveProfileFacts | null;
}

/** What the fake Remnawave answers per subscription, and who was read. */
const remnawave = {
  answers: new Map<string, ReadAnswer>(),
  reads: [] as string[],
};

const incidents: Array<{ message: string; metadata: Record<string, unknown> }> = [];

interface HeldFixture {
  readonly tag: string;
  readonly strategy: TrafficLimitStrategy;
  /** Remnawave's reset instant the add-on ends at. */
  readonly plannedAt: Date;
  /** Default: `plannedAt + margin` — ends AT the reset. Earlier: the subscription's end cut it short. */
  readonly expiresAt?: Date;
  /** What the subscription has stamped. */
  readonly lastReset?: Date | null;
  readonly status?: SubscriptionStatus;
  /** A second, ordinary add-on (ends with the subscription), due at this instant. */
  readonly ordinaryDueAt?: Date;
}

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

/**
 * One subscription in the model with a 5 GB add-on bound to a reset epoch, as
 * a fulfilment leaves it: columns 105 GB = the plan's 100 + the add-on's 5, the
 * projection recording that, the epoch open.
 */
async function seedHeld(fixture: HeldFixture): Promise<{ readonly subscriptionId: string; readonly epochId: string }> {
  const userId = await newUser(fixture.tag);
  const id = `${prefix}-${fixture.tag}`;
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${id}-pay`,
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
  await prisma.subscription.create({
    data: {
      id,
      userId,
      status: fixture.status ?? SubscriptionStatus.LIMITED,
      remnawaveId: String(700_000 + users.length),
      remnawavePanelId: 700_000 + users.length,
      planSnapshot: { trafficLimit: 100, deviceLimit: 3 },
      // The plan's 100 GB plus what the add-ons below add, as a fulfilment mirrors it.
      trafficLimit: fixture.ordinaryDueAt === undefined ? 105 : 106,
      deviceLimit: 3,
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
      remnawaveLastTrafficResetAt: fixture.lastReset ?? null,
    },
  });
  const termId = `${id}-term`;
  await prisma.subscriptionTerm.create({
    data: {
      id: termId,
      subscriptionId: id,
      generation: 1,
      status: SubscriptionTermStatus.ACTIVE,
      planSnapshot: {},
      startsAt: new Date(fixture.plannedAt.getTime() - 40 * 24 * HOUR),
      endsAt: new Date(Date.now() + 30 * 24 * HOUR),
      baseTrafficLimitBytes: 100n * GIB,
      baseDeviceLimit: 3,
      trafficResetStrategy: fixture.strategy,
      resetAnchorAt: new Date(fixture.plannedAt.getTime() - 60 * 24 * HOUR),
    },
  });
  const epoch = await prisma.subscriptionResetEpoch.create({
    data: {
      termId,
      ordinal: 1,
      startsAt: new Date(fixture.plannedAt.getTime() - 24 * HOUR),
      plannedEndsAt: fixture.plannedAt,
    },
  });
  const ordinary = fixture.ordinaryDueAt === undefined ? 0n : 1n * GIB;
  await prisma.subscriptionEffectiveProjection.create({
    data: {
      subscriptionId: id,
      baselineTermId: termId,
      desiredRevision: 1n,
      baseTrafficLimitBytes: 100n * GIB,
      baseDeviceLimit: 3,
      activeTrafficContributionBytes: 5n * GIB + ordinary,
      activeDeviceContribution: 0,
      desiredTrafficLimitBytes: 105n * GIB + ordinary,
      desiredDeviceLimit: 3,
      state: 'APPLIED',
    },
  });
  const resetEndsAt = fixture.expiresAt ?? new Date(fixture.plannedAt.getTime() + MARGIN);
  const purchasedAt = new Date(Math.min(fixture.plannedAt.getTime() - 2 * HOUR, resetEndsAt.getTime() - HOUR));
  await prisma.addOnEntitlement.create({
    data: {
      id: `${id}-reset`,
      subscriptionId: id,
      termId,
      sourceTransactionId: payment.id,
      sourceLineKey: 'reset',
      catalogRevision: 1,
      receiptName: '+5 GB до сброса',
      type: AddOnType.EXTRA_TRAFFIC,
      valuePerUnit: 5,
      totalValue: 5n * GIB,
      lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
      unitAmount: new Prisma.Decimal('1.00'),
      totalAmount: new Prisma.Decimal('1.00'),
      currency: 'USD',
      purchasedAt,
      scheduledActivationAt: purchasedAt,
      activatedAt: purchasedAt,
      expiresAt: resetEndsAt,
      expiryEpochId: epoch.id,
      state: AddOnEntitlementState.ACTIVE,
    },
  });
  if (fixture.ordinaryDueAt !== undefined) {
    await prisma.addOnEntitlement.create({
      data: {
        id: `${id}-ordinary`,
        subscriptionId: id,
        termId,
        sourceTransactionId: payment.id,
        sourceLineKey: 'ordinary',
        catalogRevision: 1,
        receiptName: '+1 GB',
        type: AddOnType.EXTRA_TRAFFIC,
        valuePerUnit: 1,
        totalValue: 1n * GIB,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt,
        scheduledActivationAt: purchasedAt,
        activatedAt: purchasedAt,
        expiresAt: fixture.ordinaryDueAt,
        state: AddOnEntitlementState.ACTIVE,
      },
    });
  }
  return { subscriptionId: id, epochId: epoch.id };
}

async function stateOf(subscriptionId: string, line = 'reset'): Promise<AddOnEntitlementState> {
  return (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: `${subscriptionId}-${line}` } })).state;
}

async function epochOf(epochId: string) {
  return prisma.subscriptionResetEpoch.findUniqueOrThrow({ where: { id: epochId } });
}

run('an add-on «до сброса» waits for Remnawave\'s reset — PostgreSQL', () => {
  let scheduler: EntitlementBoundarySchedulerService;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    const boundary = new EntitlementBoundaryService(
      prisma,
      new AddOnEntitlementService(),
      terms,
      new EffectiveProjectionService(),
    );
    const confirmation = new ResetBoundaryConfirmationService(
      prisma,
      {
        refreshProfileFacts: async (subscriptionId: string) => {
          remnawave.reads.push(subscriptionId);
          return remnawave.answers.get(subscriptionId)?.facts ?? null;
        },
      } as never,
      {
        error: (_type: string, _category: string, message: string, metadata: Record<string, unknown>) => {
          incidents.push({ message, metadata });
        },
      } as never,
    );
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      { planForSubscription: async () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' }) } as never,
      { executePlan: async () => ({ status: 'DEFERRED' }) } as never,
      terms,
      undefined,
      confirmation,
    );
  });

  beforeEach(() => {
    remnawave.answers.clear();
    remnawave.reads.length = 0;
    incidents.length = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  it('holds a DAY add-on past its end while nothing confirms the reset, and keeps its traffic', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 2 * HOUR);
    const { subscriptionId, epochId } = await seedHeld({ tag: 'unconfirmed', strategy: 'DAY', plannedAt });
    // The sample read: Remnawave still reports yesterday's reset.
    remnawave.answers.set(subscriptionId, {
      facts: { createdAt: null, lastTrafficResetAt: new Date(plannedAt.getTime() - 24 * HOUR) },
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(subscriptionId), AddOnEntitlementState.ACTIVE, 'held: its end passed, the reset is unconfirmed');
    assert.equal((await epochOf(epochId)).closedAt, null);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).trafficLimit, 105);
    assert.ok(remnawave.reads.includes(subscriptionId), 'a sample profile was read');
    assert.deepEqual(incidents, []);
  });

  it('takes it off once a sample profile shows the batch ran: columns back at base, a BOUNDARY_EXPIRY push', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 90 * MINUTE);
    const { subscriptionId, epochId } = await seedHeld({ tag: 'sampled', strategy: 'DAY', plannedAt });
    remnawave.answers.set(subscriptionId, {
      facts: { createdAt: null, lastTrafficResetAt: new Date(plannedAt.getTime() + 27) },
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(subscriptionId), AddOnEntitlementState.EXPIRED);
    const epoch = await epochOf(epochId);
    assert.ok(epoch.closedAt !== null);
    assert.equal(epoch.closeSource, 'WEBHOOK_RECONCILIATION');
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).trafficLimit, 100);
    const job = await prisma.profileSyncJob.findFirst({ where: { subscriptionId, cause: 'BOUNDARY_EXPIRY' } });
    assert.ok(job !== null, 'the base limit is pushed');
  });

  it('confirms from a reset already stamped on a subscription of the boundary, without reading anybody', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 80 * MINUTE);
    const stamped = await seedHeld({
      tag: 'stamped-a',
      strategy: 'WEEK',
      plannedAt,
      lastReset: new Date(plannedAt.getTime() + 40),
    });
    const other = await seedHeld({ tag: 'stamped-b', strategy: 'WEEK', plannedAt });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(stamped.subscriptionId), AddOnEntitlementState.EXPIRED);
    assert.equal(await stateOf(other.subscriptionId), AddOnEntitlementState.EXPIRED, 'one batch resets the whole strategy');
    assert.deepEqual(remnawave.reads, []);
  });

  it('does not take a manual reset hours later for the batch', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 5 * HOUR);
    const { subscriptionId } = await seedHeld({ tag: 'manual-later', strategy: 'MONTH', plannedAt });
    remnawave.answers.set(subscriptionId, {
      facts: { createdAt: null, lastTrafficResetAt: new Date(plannedAt.getTime() + 3 * HOUR) },
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(subscriptionId), AddOnEntitlementState.ACTIVE);
  });

  it('confirms a rolling boundary subscription by subscription, from each one\'s own reset', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 70 * MINUTE);
    const stamped = await seedHeld({
      tag: 'rolling-stamped',
      strategy: 'MONTH_ROLLING',
      plannedAt,
      lastReset: new Date(plannedAt.getTime() + 12),
    });
    const readOk = await seedHeld({ tag: 'rolling-read', strategy: 'MONTH_ROLLING', plannedAt });
    const notYet = await seedHeld({ tag: 'rolling-not-yet', strategy: 'MONTH_ROLLING', plannedAt });
    remnawave.answers.set(readOk.subscriptionId, {
      facts: { createdAt: null, lastTrafficResetAt: new Date(plannedAt.getTime() + 15) },
    });
    remnawave.answers.set(notYet.subscriptionId, {
      facts: { createdAt: null, lastTrafficResetAt: new Date(plannedAt.getTime() - 30 * 24 * HOUR) },
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(stamped.subscriptionId), AddOnEntitlementState.EXPIRED);
    assert.equal(await stateOf(readOk.subscriptionId), AddOnEntitlementState.EXPIRED);
    assert.equal(await stateOf(notYet.subscriptionId), AddOnEntitlementState.ACTIVE, 'its own counter was not reset');
    assert.equal((await epochOf(notYet.epochId)).closedAt, null);
    assert.ok(!remnawave.reads.includes(stamped.subscriptionId), 'what is stamped is not read again');
  });

  it('expires it anyway at the end of the hold, with ONE incident for the boundary', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - MARGIN - RESET_CONFIRMATION_HOLD_MS - MINUTE);
    const first = await seedHeld({ tag: 'capped-a', strategy: 'DAY', plannedAt });
    const second = await seedHeld({ tag: 'capped-b', strategy: 'DAY', plannedAt });

    await scheduler.runDueBoundaries(now);
    await scheduler.runDueBoundaries(new Date(now.getTime() + 5 * MINUTE));

    for (const fixture of [first, second]) {
      assert.equal(await stateOf(fixture.subscriptionId), AddOnEntitlementState.EXPIRED);
      const epoch = await epochOf(fixture.epochId);
      assert.equal(epoch.closeSource, 'SCHEDULER');
    }
    const mine = incidents.filter((incident) => incident.metadata['plannedResetAt'] === plannedAt.toISOString());
    assert.equal(mine.length, 1, 'one incident per boundary, however many subscriptions and ticks');
    assert.equal(mine[0]!.metadata['reason'], 'remnawave_reset_unconfirmed');
    assert.equal(mine[0]!.metadata['strategy'], 'DAY');
    assert.equal(mine[0]!.metadata['subscriptions'], 2);
    assert.match(String(mine[0]!.metadata['why']), /Remnawave не сбросил трафик по расписанию/);
    assert.match(String(mine[0]!.metadata['nextSteps']), /Часовой пояс Remnawave/);
    // Titled for what it is on the operator's card.
    const variant = EVENT_PRESENTATION['system.error']!.variants!.find((candidate) => candidate.when(mine[0]!.metadata));
    assert.equal(variant?.title, 'Remnawave не сбросил трафик по расписанию');
  });

  it('raises one incident when two passes race over the same boundary', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - MARGIN - RESET_CONFIRMATION_HOLD_MS - 2 * MINUTE);
    await seedHeld({ tag: 'race-a', strategy: 'WEEK', plannedAt });
    await seedHeld({ tag: 'race-b', strategy: 'WEEK', plannedAt });
    const raced: Array<Record<string, unknown>> = [];
    const events = {
      error: (_type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
        raced.push(metadata);
      },
    };
    // Pass A may close only once pass B has seen the boundary open: both are
    // then past the selection, and exactly one of them can close it.
    let seenByB!: () => void;
    const bHasSeen = new Promise<void>((resolve) => {
      seenByB = resolve;
    });
    const prismaA = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$executeRaw') {
          return async (...args: Parameters<PrismaService['$executeRaw']>) => {
            await bHasSeen;
            return target.$executeRaw(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const prismaB = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$queryRaw') {
          return async (...args: Parameters<PrismaService['$queryRaw']>) => {
            const rows = await target.$queryRaw(...args);
            seenByB();
            return rows;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const passA = new ResetBoundaryConfirmationService(prismaA as PrismaService, undefined, events as never);
    const passB = new ResetBoundaryConfirmationService(prismaB as PrismaService, undefined, events as never);

    await Promise.all([passA.confirmDueBoundaries(now), passB.confirmDueBoundaries(now)]);

    const mine = raced.filter((metadata) => metadata['plannedResetAt'] === plannedAt.toISOString());
    assert.equal(mine.length, 1, 'the pass that closed the boundary raises it; the other finds it closed');
  });

  it('lets the hold run out on the sweep\'s own clock even when the confirmation pass never ran', async () => {
    const now = new Date();
    const terms = new SubscriptionTermService();
    const bare = new EntitlementBoundarySchedulerService(
      prisma,
      new EntitlementBoundaryService(prisma, new AddOnEntitlementService(), terms, new EffectiveProjectionService()),
      { enqueue: async () => undefined } as never,
      { planForSubscription: async () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' }) } as never,
      { executePlan: async () => ({ status: 'DEFERRED' }) } as never,
      terms,
    );
    const within = await seedHeld({ tag: 'bare-within', strategy: 'MONTH', plannedAt: new Date(now.getTime() - 3 * HOUR) });
    const past = await seedHeld({
      tag: 'bare-past',
      strategy: 'MONTH',
      plannedAt: new Date(now.getTime() - MARGIN - RESET_CONFIRMATION_HOLD_MS - MINUTE),
    });

    await bare.runDueBoundaries(now);

    assert.equal(await stateOf(within.subscriptionId), AddOnEntitlementState.ACTIVE, 'inside the hold: still waiting');
    assert.equal(await stateOf(past.subscriptionId), AddOnEntitlementState.EXPIRED, 'the hold ran out: expired');
  });

  it('does not hold an add-on the subscription\'s end cut short: it ends with the subscription', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() + 3 * HOUR);
    const { subscriptionId, epochId } = await seedHeld({
      tag: 'capped-by-end',
      strategy: 'DAY',
      plannedAt,
      expiresAt: new Date(now.getTime() - 10 * MINUTE),
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(subscriptionId), AddOnEntitlementState.EXPIRED);
    assert.equal((await epochOf(epochId)).closedAt, null, 'its boundary was never waited on');
  });

  it('does not expire a held add-on when its subscription comes up for another boundary', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 2 * HOUR);
    const { subscriptionId } = await seedHeld({
      tag: 'held-beside-ordinary',
      strategy: 'DAY',
      plannedAt,
      ordinaryDueAt: new Date(now.getTime() - 20 * MINUTE),
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(subscriptionId, 'ordinary'), AddOnEntitlementState.EXPIRED, 'the ordinary add-on is due');
    assert.equal(await stateOf(subscriptionId, 'reset'), AddOnEntitlementState.ACTIVE, 'the held one still waits');
    // The push that followed carries the held add-on: 100 + 5.
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).trafficLimit, 105);
  });

  it('keeps held add-ons out of the window: a full window of them does not starve a fresh boundary', async () => {
    const now = new Date();
    const plannedAt = new Date(now.getTime() - 4 * HOUR);
    const userId = await newUser('window');
    const payment = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-window-pay`,
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
    const held = Array.from({ length: 200 }, (_, index) => `${prefix}-held-${String(index).padStart(3, '0')}`);
    await prisma.subscription.createMany({
      data: held.map((id) => ({ id, userId, status: SubscriptionStatus.ACTIVE, planSnapshot: {}, trafficLimit: 105 })),
    });
    await prisma.subscriptionTerm.createMany({
      data: held.map((id) => ({
        id: `${id}-term`,
        subscriptionId: id,
        generation: 1,
        status: SubscriptionTermStatus.ACTIVE,
        planSnapshot: {},
        startsAt: new Date(plannedAt.getTime() - 40 * 24 * HOUR),
        baseTrafficLimitBytes: 100n * GIB,
        trafficResetStrategy: 'MONTH' as const,
      })),
    });
    await prisma.subscriptionResetEpoch.createMany({
      data: held.map((id) => ({
        id: `${id}-epoch`,
        termId: `${id}-term`,
        ordinal: 1,
        startsAt: new Date(plannedAt.getTime() - 24 * HOUR),
        plannedEndsAt: plannedAt,
      })),
    });
    await prisma.addOnEntitlement.createMany({
      data: held.map((id) => ({
        id: `${id}-reset`,
        subscriptionId: id,
        termId: `${id}-term`,
        sourceTransactionId: payment.id,
        sourceLineKey: id,
        catalogRevision: 1,
        receiptName: 'held',
        type: AddOnType.EXTRA_TRAFFIC,
        valuePerUnit: 5,
        totalValue: 5n * GIB,
        lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: new Date(plannedAt.getTime() - HOUR),
        scheduledActivationAt: new Date(plannedAt.getTime() - HOUR),
        activatedAt: new Date(plannedAt.getTime() - HOUR),
        expiresAt: new Date(plannedAt.getTime() + MARGIN),
        expiryEpochId: `${id}-epoch`,
        state: AddOnEntitlementState.ACTIVE,
      })),
    });
    // Due LATER than every held row: behind all 200 of them in the order.
    const fresh = await seedHeld({
      tag: 'fresh-behind',
      strategy: 'NO_RESET',
      plannedAt: new Date(now.getTime() + 24 * HOUR),
      expiresAt: new Date(now.getTime() - MINUTE),
    });

    await scheduler.runDueBoundaries(now);

    assert.equal(await stateOf(fresh.subscriptionId), AddOnEntitlementState.EXPIRED, 'the fresh boundary expired in one tick');
    const stillActive = await prisma.addOnEntitlement.count({
      where: { id: { in: held.map((id) => `${id}-reset`) }, state: AddOnEntitlementState.ACTIVE },
    });
    assert.equal(stillActive, 200, 'every held add-on still waits');
  });
});
