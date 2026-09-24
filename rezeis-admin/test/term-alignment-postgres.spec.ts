import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
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
import {
  SubscriptionTermService,
  TERM_SHORTENED_ACROSS_SCHEDULED_TERM,
} from '../src/modules/add-on-entitlements/services/subscription-term.service';

/**
 * THE TAIL TERM FOLLOWS THE SUBSCRIPTION'S EXPIRY; A PLAN CHANGE ROTATES THE
 * TERM — against PostgreSQL, because both rules live next to CHECK
 * constraints (`ends_at > starts_at`, `expires_at > scheduled_activation_at`)
 * and a partial unique index (one ACTIVE term) that no fake enforces.
 *
 * Every instant is anchored to now: an absolute date in a fixture changes the
 * side of "now" it is on as time passes, and with it the meaning of the test.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d1align-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;

let prisma: PrismaService;
const users: string[] = [];
const plans: string[] = [];
let seq = 0;

const at = (offsetDays: number): Date => new Date(Date.now() + offsetDays * DAY_MS);

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

/** A subscription in the model: one ACTIVE generation-1 term ending at its expiry. */
async function subscriptionWithTerm(
  userId: string,
  tag: string,
  window: { startsAt: Date; expiresAt: Date | null },
  limits: { traffic: number | null; devices: number } = { traffic: 100, devices: 3 },
): Promise<{ id: string; termId: string; endsAt: Date | null }> {
  const id = `${prefix}-${tag}`;
  await prisma.subscription.create({
    data: {
      id,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { id: `${prefix}-old-plan`, trafficLimit: limits.traffic, deviceLimit: limits.devices, trafficLimitStrategy: 'NO_RESET' },
      trafficLimit: limits.traffic,
      deviceLimit: limits.devices,
      expiresAt: window.expiresAt,
      remnawaveId: `${prefix}-${tag}-rw`,
    },
  });
  const term = await prisma.subscriptionTerm.create({
    data: {
      subscriptionId: id,
      generation: 1,
      status: SubscriptionTermStatus.ACTIVE,
      planSnapshot: {},
      startsAt: window.startsAt,
      endsAt: window.expiresAt,
      baseTrafficLimitBytes: limits.traffic === null ? null : BigInt(limits.traffic) * GIB,
      baseDeviceLimit: limits.devices <= 0 ? null : limits.devices,
      trafficResetStrategy: 'NO_RESET',
      resetAnchorAt: window.startsAt,
    },
  });
  return { id, termId: term.id, endsAt: term.endsAt };
}

/** A paid add-on, as the ledger records it. */
async function addOn(
  userId: string,
  subscriptionId: string,
  termId: string,
  options: {
    expiresAt: Date | null;
    activatedAt?: Date;
    state?: 'ACTIVE' | 'PENDING_ACTIVATION';
    lifetime?: AddOnLifetime;
    type?: AddOnType;
  },
) {
  seq += 1;
  const activatedAt = options.activatedAt ?? at(-3);
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${seq}`,
      userId,
      subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'USD',
      amount: new Prisma.Decimal('1.00'),
      planSnapshot: {},
    },
  });
  const type = options.type ?? AddOnType.EXTRA_DEVICES;
  return prisma.addOnEntitlement.create({
    data: {
      subscriptionId,
      termId,
      sourceTransactionId: payment.id,
      sourceLineKey: 'line',
      catalogRevision: 1,
      receiptName: type === AddOnType.EXTRA_DEVICES ? '+1 device' : '+5 GB',
      type,
      valuePerUnit: type === AddOnType.EXTRA_DEVICES ? 1 : 5,
      totalValue: type === AddOnType.EXTRA_DEVICES ? 1n : 5n * GIB,
      lifetime: options.lifetime ?? AddOnLifetime.UNTIL_SUBSCRIPTION_END,
      unitAmount: new Prisma.Decimal('1.00'),
      totalAmount: new Prisma.Decimal('1.00'),
      currency: 'USD',
      purchasedAt: activatedAt,
      scheduledActivationAt: activatedAt,
      activatedAt: options.state === 'PENDING_ACTIVATION' ? null : activatedAt,
      expiresAt: options.expiresAt,
      state: options.state ?? 'ACTIVE',
    },
  });
}

run('term alignment and plan-change rotation — PostgreSQL', () => {
  const terms = new SubscriptionTermService();
  const entitlements = new AddOnEntitlementService();
  const projections = new EffectiveProjectionService();

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.plan.deleteMany({ where: { id: { in: plans } } });
    await prisma.$disconnect();
  });

  const align = (subscriptionId: string) =>
    prisma.$transaction((tx) => terms.alignTailToExpiryInTransaction(tx, subscriptionId));

  it('EXTENSION: bonus days move the tail and the add-ons that ended with it — and nothing else', async () => {
    const userId = await newUser('extend');
    const { id, termId, endsAt } = await subscriptionWithTerm(userId, 'extend', { startsAt: at(-10), expiresAt: at(5) });
    // Bound the way the ledger binds it — expiresAt = term.endsAt, to the millisecond.
    const endsWithTerm = await addOn(userId, id, termId, { expiresAt: endsAt });
    const ownDate = await addOn(userId, id, termId, { expiresAt: at(2) });
    const resetScoped = await addOn(userId, id, termId, { expiresAt: endsAt, lifetime: AddOnLifetime.UNTIL_NEXT_RESET });
    const oldEnd = (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).endsAt!;

    // Promo days: the expiry moves, the term does not know.
    const newExpiry = new Date(oldEnd.getTime() + 7 * DAY_MS);
    await prisma.subscription.update({ where: { id }, data: { expiresAt: newExpiry } });
    const result = await align(id);

    assert.equal(result.outcome, 'ALIGNED');
    const term = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } });
    assert.equal(term.endsAt?.getTime(), newExpiry.getTime());
    assert.equal(term.baseDeviceLimit, 3, 'the WINDOW moves, the BASE never does');
    const moved = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: endsWithTerm.id } });
    assert.equal(moved.expiresAt?.getTime(), newExpiry.getTime());
    assert.equal(moved.version, endsWithTerm.version + 1);
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: ownDate.id } })).expiresAt?.getTime(),
      ownDate.expiresAt?.getTime(),
      'an add-on with its own, earlier date keeps it',
    );
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: resetScoped.id } })).expiresAt?.getTime(),
      resetScoped.expiresAt?.getTime(),
      'a reset-scoped add-on does not end with the subscription',
    );
    const events = await prisma.addOnEntitlementEvent.findMany({ where: { entitlementId: endsWithTerm.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.reason, 'TERM_WINDOW_ALIGNED');
    assert.equal(events[0]!.fromState, 'ACTIVE');
    assert.equal(events[0]!.toState, 'ACTIVE');
    assert.deepEqual(
      (events[0]!.metadata as Record<string, unknown>)['previousExpiresAt'],
      oldEnd.toISOString(),
    );

    // Aligned already: a second call changes nothing and audits nothing.
    assert.equal((await align(id)).outcome, 'UNCHANGED');
    assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: endsWithTerm.id } }), 1);
  });

  it('SHORTENING: the tail moves back, and no add-on outlives the subscription', async () => {
    const userId = await newUser('shorten');
    const { id, termId, endsAt } = await subscriptionWithTerm(userId, 'shorten', { startsAt: at(-10), expiresAt: at(20) });
    const endsWithTerm = await addOn(userId, id, termId, { expiresAt: endsAt });
    const later = await addOn(userId, id, termId, { expiresAt: at(15) });
    const earlier = await addOn(userId, id, termId, { expiresAt: at(1) });

    const cut = at(4);
    await prisma.subscription.update({ where: { id }, data: { expiresAt: cut } });
    const result = await align(id);

    assert.equal(result.outcome, 'ALIGNED');
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).endsAt?.getTime(), cut.getTime());
    for (const moved of [endsWithTerm, later]) {
      assert.equal(
        (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: moved.id } })).expiresAt?.getTime(),
        cut.getTime(),
      );
    }
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: earlier.id } })).expiresAt?.getTime(),
      earlier.expiresAt?.getTime(),
    );
  });

  it('SHORTENING before the ACTIVE term began: it ends one second after its start, and its add-ons become due', async () => {
    const userId = await newUser('before-start');
    const startsAt = at(-2);
    const { id, termId, endsAt } = await subscriptionWithTerm(userId, 'before-start', { startsAt, expiresAt: at(28) });
    const bought = await addOn(userId, id, termId, {
      expiresAt: endsAt,
      activatedAt: at(-1),
      type: AddOnType.EXTRA_TRAFFIC,
    });

    // The operator expires the subscription at a date before this term began.
    await prisma.subscription.update({ where: { id }, data: { expiresAt: at(-5) } });
    const result = await align(id);

    assert.equal(result.outcome, 'ALIGNED');
    const term = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } });
    assert.equal(term.endsAt?.getTime(), startsAt.getTime() + 1_000);
    const clamped = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: bought.id } });
    // Never at or before its own activation (the CHECK); one second after it.
    assert.equal(clamped.expiresAt?.getTime(), bought.scheduledActivationAt.getTime() + 1_000);

    // And the boundary sweep now expires it.
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    const expiry = await boundary.expireDueForSubscription(id, new Date());
    assert.equal(expiry.expired, 1);
  });

  it('A QUEUED SUCCESSOR: only the last SCHEDULED term moves; shortening across it is an incident, not a write', async () => {
    const userId = await newUser('queued');
    const { id, termId } = await subscriptionWithTerm(userId, 'queued', { startsAt: at(-10), expiresAt: at(5) });
    const renewal = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id,
        generation: 2,
        status: SubscriptionTermStatus.SCHEDULED,
        planSnapshot: {},
        startsAt: at(5),
        endsAt: at(35),
        baseTrafficLimitBytes: 100n * GIB,
        baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET',
        resetAnchorAt: at(5),
      },
    });
    const activeEnd = (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).endsAt!;
    const renewalAddOn = await addOn(userId, id, renewal.id, {
      expiresAt: renewal.endsAt,
      activatedAt: renewal.startsAt,
      state: 'PENDING_ACTIVATION',
    });
    await prisma.subscription.update({ where: { id }, data: { expiresAt: renewal.endsAt } });

    // Bonus days on top of a paid renewal: the renewal term takes them.
    const extended = new Date(renewal.endsAt!.getTime() + 3 * DAY_MS);
    await prisma.subscription.update({ where: { id }, data: { expiresAt: extended } });
    const result = await align(id);
    assert.equal(result.outcome, 'ALIGNED');
    assert.equal(result.outcome === 'ALIGNED' ? result.termId : null, renewal.id);
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: renewal.id } })).endsAt?.getTime(), extended.getTime());
    assert.equal(
      (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).endsAt?.getTime(),
      activeEnd.getTime(),
      'the ACTIVE term under a queued successor is never touched',
    );
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: renewalAddOn.id } })).expiresAt?.getTime(),
      extended.getTime(),
    );

    // Shortened to before the paid renewal even starts: nothing written, one incident.
    await prisma.subscription.update({ where: { id }, data: { expiresAt: at(3) } });
    const blocked = await align(id);
    assert.equal(blocked.outcome, 'SCHEDULED_SUCCESSOR_BLOCKS');
    const again = await align(id);
    assert.equal(again.outcome, 'SCHEDULED_SUCCESSOR_BLOCKS');
    const incidents = await prisma.entitlementIncident.findMany({ where: { subscriptionId: id } });
    assert.equal(incidents.length, 1, 'one incident, not one per call');
    assert.equal(incidents[0]!.summaryCode, TERM_SHORTENED_ACROSS_SCHEDULED_TERM);
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: renewal.id } })).endsAt?.getTime(), extended.getTime());
  });

  it('LIFETIME: the tail becomes open-ended, and so do the add-ons that ended with it', async () => {
    const userId = await newUser('lifetime');
    const { id, termId, endsAt } = await subscriptionWithTerm(userId, 'lifetime', { startsAt: at(-10), expiresAt: at(5) });
    const bought = await addOn(userId, id, termId, { expiresAt: endsAt });
    await prisma.subscription.update({ where: { id }, data: { expiresAt: null } });

    assert.equal((await align(id)).outcome, 'ALIGNED');
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).endsAt, null);
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: bought.id } })).expiresAt, null);
  });

  it('THE SWEEP ALIGNS BEFORE IT EXPIRES: an add-on due at the old end survives bonus days given before the tick', async () => {
    const userId = await newUser('sweep');
    const { id, termId, endsAt } = await subscriptionWithTerm(userId, 'sweep', { startsAt: at(-30), expiresAt: at(-0.01) });
    const bought = await addOn(userId, id, termId, { expiresAt: endsAt, type: AddOnType.EXTRA_TRAFFIC });
    // Seven bonus days landed a moment before the sweep reached the add-on.
    const bonusEnd = at(7);
    await prisma.subscription.update({ where: { id }, data: { expiresAt: bonusEnd } });

    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    const result = await boundary.expireDueForSubscription(id, new Date());

    assert.equal(result.began, 0, 'nothing was due once the term followed the subscription');
    const kept = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: bought.id } });
    assert.equal(kept.state, 'ACTIVE');
    assert.equal(kept.expiresAt?.getTime(), bonusEnd.getTime());
  });

  it('THE DRIFT SWEEP finds drifted tails, aligns them, and reports a blocked one once', async () => {
    const userId = await newUser('drift');
    const drifted = await subscriptionWithTerm(userId, 'drift-a', { startsAt: at(-10), expiresAt: at(5) });
    await prisma.subscription.update({ where: { id: drifted.id }, data: { expiresAt: at(9) } });
    const aligned = await subscriptionWithTerm(userId, 'drift-b', { startsAt: at(-10), expiresAt: at(5) });
    const blocked = await subscriptionWithTerm(userId, 'drift-c', { startsAt: at(-10), expiresAt: at(5) });
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: blocked.id,
        generation: 2,
        status: SubscriptionTermStatus.SCHEDULED,
        planSnapshot: {},
        startsAt: at(5),
        endsAt: at(35),
        trafficResetStrategy: 'NO_RESET',
      },
    });
    await prisma.subscription.update({ where: { id: blocked.id }, data: { expiresAt: at(2) } });

    const scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      terms,
    );
    // The sweep walks the whole table in id order; run it until it wraps so
    // this file's rows are visited whatever else the database holds.
    let examined = 0;
    for (let pass = 0; pass < 50; pass += 1) {
      const result = await scheduler.alignDriftedTerms();
      examined += result.examined;
      if (result.examined < 500) break;
    }
    assert.ok(examined >= 2);
    assert.equal(
      (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: drifted.termId } })).endsAt?.getTime(),
      (await prisma.subscription.findUniqueOrThrow({ where: { id: drifted.id } })).expiresAt?.getTime(),
    );
    assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlement: { subscriptionId: aligned.id } } }), 0);
    assert.equal(await prisma.entitlementIncident.count({ where: { subscriptionId: blocked.id } }), 1);

    // A second sweep: the aligned rows are no longer candidates, and the
    // blocked one is parked behind its open incident — examined by nobody.
    const before = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: drifted.termId } });
    for (let pass = 0; pass < 50; pass += 1) {
      const result = await scheduler.alignDriftedTerms();
      if (result.examined < 500) break;
    }
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: drifted.termId } })).updatedAt.getTime(), before.updatedAt.getTime());
    assert.equal(await prisma.entitlementIncident.count({ where: { subscriptionId: blocked.id } }), 1);
  });

  it('ROTATION: a plan change ends the ACTIVE term, starts one on the plan, and the recompute follows the new base', async () => {
    const userId = await newUser('rotate');
    const planId = `${prefix}-rotate-plan`;
    const plan = await prisma.plan.create({
      data: { id: planId, name: planId, trafficLimit: 300, deviceLimit: 6, trafficLimitStrategy: 'MONTH' },
    });
    plans.push(planId);
    const expiresAt = at(12);
    const { id, termId } = await subscriptionWithTerm(userId, 'rotate', { startsAt: at(-10), expiresAt });
    const bought = await addOn(userId, id, termId, { expiresAt });
    await prisma.$transaction((tx) => projections.recomputeInTransaction(tx, { subscriptionId: id, mode: 'ACTIVE' }));

    // The caller's half of a plan change: the columns and the snapshot…
    await prisma.subscription.update({
      where: { id },
      data: {
        trafficLimit: 300,
        deviceLimit: 7,
        planSnapshot: { id: planId, trafficLimit: 300, deviceLimit: 6, trafficLimitStrategy: 'MONTH' },
      },
    });
    const before = Date.now();
    const result = await prisma.$transaction((tx) =>
      terms.rotateForPlanChangeInTransaction(tx, {
        subscriptionId: id,
        plan,
        snapshotSource: 'TEST_PLAN_CHANGE_TERM',
        scheduledTerms: 'REFUSE',
      }),
    );

    assert.equal(result.outcome, 'ROTATED');
    if (result.outcome !== 'ROTATED') return;
    assert.equal(result.previousTermId, termId);
    const chain = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId: id },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(chain.map((term) => [term.generation, term.status]), [[1, 'ENDED'], [2, 'ACTIVE']]);
    const rotated = chain[1]!;
    assert.equal(rotated.baseTrafficLimitBytes, 300n * GIB);
    assert.equal(rotated.baseDeviceLimit, 6);
    assert.equal(rotated.trafficResetStrategy, 'MONTH');
    assert.equal(rotated.planId, planId);
    assert.equal(rotated.endsAt?.getTime(), expiresAt.getTime());
    assert.ok(rotated.startsAt.getTime() >= before - 1_000 && rotated.startsAt.getTime() <= Date.now());
    assert.equal((rotated.planSnapshot as Record<string, unknown>)['snapshotSource'], 'TEST_PLAN_CHANGE_TERM');
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: bought.id } })).state,
      'ACTIVE',
      'an add-on bound to the ended term keeps counting',
    );

    // …and the recompute now takes the NEW plan's base: 6 + the one add-on.
    const projection = await prisma.$transaction((tx) =>
      projections.recomputeInTransaction(tx, { subscriptionId: id, mode: 'ACTIVE' }),
    );
    assert.equal(projection.baselineTermId, rotated.id);
    assert.equal(projection.desiredDeviceLimit, 7);
    assert.equal(projection.desiredTrafficLimitBytes, 300n * GIB);
  });

  it('ROTATION of an expired subscription gets the one-second window at its expiry', async () => {
    const userId = await newUser('rotate-expired');
    const planId = `${prefix}-rotate-expired-plan`;
    const plan = await prisma.plan.create({ data: { id: planId, name: planId, trafficLimit: 50, deviceLimit: 2 } });
    plans.push(planId);
    const lapsed = at(-4);
    const { id } = await subscriptionWithTerm(userId, 'rotate-expired', { startsAt: at(-34), expiresAt: lapsed });

    const result = await prisma.$transaction((tx) =>
      terms.rotateForPlanChangeInTransaction(tx, {
        subscriptionId: id,
        plan,
        snapshotSource: 'TEST_PLAN_CHANGE_TERM',
        scheduledTerms: 'REFUSE',
      }),
    );
    assert.equal(result.outcome, 'ROTATED');
    if (result.outcome !== 'ROTATED') return;
    assert.equal(result.endsAt?.getTime(), lapsed.getTime());
    assert.equal(result.startsAt.getTime(), lapsed.getTime() - 1_000);
  });

  it('ROTATION refuses or cancels a queued term by the caller\'s rule, and never touches a row outside the model', async () => {
    const userId = await newUser('rotate-queued');
    const planId = `${prefix}-rotate-queued-plan`;
    const plan = await prisma.plan.create({ data: { id: planId, name: planId, trafficLimit: 70, deviceLimit: 2 } });
    plans.push(planId);
    const rotate = (subscriptionId: string, scheduledTerms: 'REFUSE' | 'CANCEL_UNBOUND') =>
      prisma.$transaction((tx) =>
        terms.rotateForPlanChangeInTransaction(tx, {
          subscriptionId,
          plan,
          snapshotSource: 'TEST_PLAN_CHANGE_TERM',
          scheduledTerms,
        }),
      );
    const queue = async (subscriptionId: string) =>
      prisma.subscriptionTerm.create({
        data: {
          subscriptionId,
          generation: 2,
          status: SubscriptionTermStatus.SCHEDULED,
          planSnapshot: {},
          startsAt: at(5),
          endsAt: at(35),
          trafficResetStrategy: 'NO_RESET',
        },
      });

    // Unbound queued term: REFUSE leaves it, CANCEL_UNBOUND cancels it and rotates.
    const unbound = await subscriptionWithTerm(userId, 'rq-unbound', { startsAt: at(-10), expiresAt: at(35) });
    const queued = await queue(unbound.id);
    const refused = await rotate(unbound.id, 'REFUSE');
    assert.deepEqual(refused, { outcome: 'SCHEDULED_TERMS_BLOCK', scheduledTermIds: [queued.id], boundEntitlements: 0 });
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: unbound.id } }), 2);
    const cancelled = await rotate(unbound.id, 'CANCEL_UNBOUND');
    assert.equal(cancelled.outcome, 'ROTATED');
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: queued.id } })).status, 'CANCELED');

    // A queued term carrying a paid add-on: refused either way, nothing written.
    const bound = await subscriptionWithTerm(userId, 'rq-bound', { startsAt: at(-10), expiresAt: at(35) });
    const paidQueue = await queue(bound.id);
    await addOn(userId, bound.id, paidQueue.id, { expiresAt: at(35), activatedAt: at(5), state: 'PENDING_ACTIVATION' });
    const blocked = await rotate(bound.id, 'CANCEL_UNBOUND');
    assert.equal(blocked.outcome, 'SCHEDULED_TERMS_BLOCK');
    assert.equal(blocked.outcome === 'SCHEDULED_TERMS_BLOCK' ? blocked.boundEntitlements : -1, 1);
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: paidQueue.id } })).status, 'SCHEDULED');
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: bound.id } }), 2);

    // Not in the model: nothing to rotate.
    const outside = `${prefix}-rq-outside`;
    await prisma.subscription.create({
      data: { id: outside, userId, status: SubscriptionStatus.ACTIVE, planSnapshot: {}, deviceLimit: 1, expiresAt: at(9) },
    });
    assert.deepEqual(await rotate(outside, 'CANCEL_UNBOUND'), { outcome: 'NO_ACTIVE_TERM' });
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: outside } }), 0);
  });
});
