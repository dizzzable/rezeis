import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConflictException, type ArgumentsHost } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionTermStatus,
} from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import {
  ADMIN_PLAN_ASSIGNMENT_TERM,
  AdminUserSubscriptionsController,
} from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { PLAN_ASSIGNMENT_REFUSAL_CODES } from '../src/modules/users/controllers/plan-assignment-refusals';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  activeTerm,
  assertFollowsExpiry,
  at,
  buyAddOns,
  createPlan,
  GIB,
  newUser,
  subscriptionInModel,
  termModelFixtures,
  withStage1,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * «НАЗНАЧИТЬ ПЛАН», THE EXPIRY EDITS, «ВЫДАТЬ ПОДПИСКУ» AND THE ↻ PULL, for a
 * subscription in the durable term model — through the real Users-page
 * controller and the real term services, on PostgreSQL (the one-ACTIVE-term
 * index and the window CHECKs are what a fake would not enforce).
 *
 * The defect behind the first cases (known problem 2): the route wrote the new
 * plan's snapshot and the carried columns and NO term. The next projection
 * recompute — an add-on ending, a purchase, a term activation — read those
 * columns as the plan's own (INHERITED against the new snapshot) and took the
 * OLD term's base: the old plan's limits were mirrored back and pushed.
 *
 * Every subscription here enters the model through `ensureTermInTransaction`,
 * the cutover's own path, and every stage flag stays at its OFF default unless
 * a case says otherwise: what happens to a term must follow the term row, never
 * a flag.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const REQUEST = { headers: {}, ip: '10.0.0.8', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let fx: TermModelFixtures;
let editor: AdminUserSubscriptionsController;
let boundary: EntitlementBoundaryService;
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
let adminId = '';
/** What the ↻ route reads from the panel; the case that needs it sets it. */
let panelAnswer: Record<string, unknown> = {};

async function read(subscriptionId: string) {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, planSnapshot: true, expiresAt: true },
  });
  const projection = await prisma.subscriptionEffectiveProjection.findUnique({ where: { subscriptionId } });
  return {
    trafficLimit: row.trafficLimit,
    deviceLimit: row.deviceLimit,
    expiresAt: row.expiresAt,
    snapshotPlanId: (row.planSnapshot as { id?: string }).id,
    projection,
  };
}

const patch = (subscriptionId: string, body: Record<string, unknown>) =>
  editor.updateSubscription(subscriptionId, body, { id: adminId } as never, REQUEST);

/** What `AdminSafeExceptionFilter` answers the panel with for `exception`. */
function throughSafeFilter(exception: unknown): { statusCode: number; body: Record<string, unknown> } {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = (payload ?? {}) as Record<string, unknown>;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/admin/users/subscriptions/sub', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}

/** A paid renewal period queued after the current one; the expiry already carries its days. */
async function queueRenewal(
  owner: { readonly userId: string; readonly subscriptionId: string },
  planId: string,
  options: { readonly withAddOn: boolean },
) {
  const current = await activeTerm(prisma, owner.subscriptionId);
  return prisma.$transaction(async (tx) => {
    const scheduled = await terms.createScheduledInTransaction(tx, {
      subscriptionId: owner.subscriptionId,
      planId,
      planSnapshot: { id: planId },
      startsAt: current.endsAt!,
      endsAt: at(50),
      baseTrafficLimitBytes: 100n * GIB,
      baseDeviceLimit: 3,
      trafficResetStrategy: 'NO_RESET',
      resetAnchorAt: null,
    });
    if (options.withAddOn) {
      const payment = await tx.transaction.create({
        data: {
          paymentId: `${fx.prefix}-pay-${fx.next()}`,
          userId: owner.userId,
          subscriptionId: owner.subscriptionId,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('399'),
          planSnapshot: {},
        },
      });
      await tx.addOnEntitlement.create({
        data: {
          subscriptionId: owner.subscriptionId,
          termId: scheduled.id,
          sourceTransactionId: payment.id,
          sourceLineKey: 'renewal-line',
          catalogRevision: 1,
          receiptName: '+1 device',
          type: AddOnType.EXTRA_DEVICES,
          valuePerUnit: 1,
          totalValue: 1n,
          lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
          unitAmount: new Prisma.Decimal('50'),
          totalAmount: new Prisma.Decimal('50'),
          currency: 'RUB',
          purchasedAt: at(0),
          scheduledActivationAt: current.endsAt!,
          expiresAt: at(50),
          state: 'PENDING_ACTIVATION',
        },
      });
    }
    await tx.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: at(50) } });
    return { current, scheduled };
  });
}

run('the Users page and the durable term model — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    // Stage 1 explicitly OFF unless a case turns it on: unset is ON since the
    // 24.09.2026 flip.
    process.env.ADDON_ENTITLEMENT_SHADOW = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2assign-${process.pid}-${Date.now()}`);
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    boundary = new EntitlementBoundaryService(prisma, new AddOnEntitlementService(), terms, projections);
    editor = new AdminUserSubscriptionsController(
      prisma,
      { getPanelUserOutcome: async () => ({ kind: 'ok', user: panelAnswer }) } as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {} as never,
      {} as never,
      realTermHooks(prisma),
    );
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('after «Назначить план», when the live add-ons end the NEW plan stands — not the old one coming back', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOns(fx, owner, { devices: 2, trafficGb: 50 });

    await patch(owner.subscriptionId, { planId: b });
    // The add-ons reach their end.
    const expiresAt = (await read(owner.subscriptionId)).expiresAt!;
    await boundary.expireDueForSubscription(owner.subscriptionId, new Date(expiresAt.getTime() + 60_000));

    const afterExpiry = await read(owner.subscriptionId);
    assert.equal(afterExpiry.projection?.desiredDeviceLimit, 5, 'the new plan — 3 is the old plan coming back');
    assert.equal(afterExpiry.projection?.desiredTrafficLimitBytes, 500n * GIB, '100 GB is the old plan coming back');
    assert.deepEqual([afterExpiry.trafficLimit, afterExpiry.deviceLimit], [500, 5]);
  });

  it('«Назначить план» rotates the term, and live add-ons count once', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOns(fx, owner, { devices: 2, trafficGb: 50 });
    const bought = await read(owner.subscriptionId);
    // Self-check: the add-ons are live on the old plan.
    assert.deepEqual([bought.trafficLimit, bought.deviceLimit], [150, 5]);
    const oldTerm = await activeTerm(prisma, owner.subscriptionId);

    await patch(owner.subscriptionId, { planId: b });

    const assigned = await read(owner.subscriptionId);
    assert.deepEqual(
      [assigned.trafficLimit, assigned.deviceLimit],
      [550, 7],
      'the new plan plus the live add-ons, counted once — 600 / 9 would be twice',
    );
    assert.equal(assigned.projection?.desiredDeviceLimit, 7);
    assert.equal(assigned.projection?.desiredTrafficLimitBytes, 550n * GIB);
    const rotated = await activeTerm(prisma, owner.subscriptionId);
    assert.notEqual(rotated.id, oldTerm.id, 'a new term is ACTIVE');
    assert.equal(rotated.planId, b);
    assert.equal(rotated.baseDeviceLimit, 5, 'the term records what the PLAN gives');
    assert.equal(rotated.baseTrafficLimitBytes, 500n * GIB);
    assert.equal((rotated.planSnapshot as { snapshotSource?: string }).snapshotSource, ADMIN_PLAN_ASSIGNMENT_TERM);
    assert.equal(rotated.endsAt?.getTime(), assigned.expiresAt?.getTime(), 'the new term runs to the expiry');
    const ended = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: oldTerm.id } });
    assert.equal(ended.status, SubscriptionTermStatus.ENDED);
    const job = await prisma.profileSyncJob.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(job.cause, 'PLAN_CHANGE');
    assert.equal(job.desiredRevision, assigned.projection?.desiredRevision);
  });

  it("what sat above the old plan (a grandfathered add-on) is the new term's baseline, and stays it", async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const c = await createPlan(fx, { trafficLimit: 400, deviceLimit: 10 });
    // Two devices bought before the model existed: a raw increment, folded
    // into the cutover term's base.
    const owner = await subscriptionInModel(fx, {
      planId: a,
      plan: { trafficLimit: 100, deviceLimit: 3 },
      columns: { trafficLimit: 100, deviceLimit: 5 },
    });

    await patch(owner.subscriptionId, { planId: c });

    const assigned = await read(owner.subscriptionId);
    assert.deepEqual([assigned.trafficLimit, assigned.deviceLimit], [400, 12], 'the new plan plus the +2 it held');
    assert.equal(assigned.projection?.baseDeviceLimit, 12, 'the carried value is the baseline');
    assert.equal(assigned.projection?.desiredDeviceLimit, 12);
    assert.equal((await activeTerm(prisma, owner.subscriptionId)).baseDeviceLimit, 10);

    // The next recompute — whatever triggers it — keeps it.
    const again = await prisma.$transaction((tx) =>
      projections.recomputeInTransaction(tx, { subscriptionId: owner.subscriptionId, mode: 'ACTIVE' }),
    );
    assert.equal(again.desiredDeviceLimit, 12);
    assert.equal(again.desiredTrafficLimitBytes, 400n * GIB);
  });

  it('rotates with stage 1 turned OFF: a subscription already in the model is never stranded', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 250, deviceLimit: 4 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });

    await withStage1('false', () => patch(owner.subscriptionId, { planId: b }));

    assert.equal((await activeTerm(prisma, owner.subscriptionId)).planId, b);
    assert.equal((await read(owner.subscriptionId)).projection?.desiredDeviceLimit, 4);
  });

  it('a queued renewal term with no add-on is cancelled; its paid days are in the new term', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 300, deviceLimit: 6 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    const { scheduled } = await queueRenewal(owner, a, { withAddOn: false });

    await patch(owner.subscriptionId, { planId: b });

    const cancelled = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: scheduled.id } });
    assert.equal(cancelled.status, SubscriptionTermStatus.CANCELED);
    const rotated = await activeTerm(prisma, owner.subscriptionId);
    assert.equal(rotated.planId, b);
    const row = await read(owner.subscriptionId);
    assert.equal(rotated.endsAt?.getTime(), row.expiresAt?.getTime(), "the renewal days stay the customer's");
  });

  it('a queued renewal term that carries an add-on refuses with 409, and nothing is written', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 300, deviceLimit: 6 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    const { current, scheduled } = await queueRenewal(owner, a, { withAddOn: true });
    const before = await read(owner.subscriptionId);

    const refusal = await patch(owner.subscriptionId, { planId: b }).then(
      () => assert.fail('the plan was assigned over a paid queued period'),
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof ConflictException);
    // With its code, through the filter the panel answers with: the SPA puts
    // it in the operator's language instead of printing the English sentence.
    const wire = throughSafeFilter(refusal);
    assert.equal(wire.statusCode, 409);
    assert.equal(wire.body['code'], PLAN_ASSIGNMENT_REFUSAL_CODES.queuedRenewalWithAddOns, 'stripped by the filter');
    assert.match(String(wire.body['message']), /^A paid renewal period is queued/);

    const after = await read(owner.subscriptionId);
    assert.equal(after.snapshotPlanId, a, 'the plan did not move');
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [before.trafficLimit, before.deviceLimit]);
    assert.equal((await activeTerm(prisma, owner.subscriptionId)).id, current.id);
    assert.equal(
      (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: scheduled.id } })).status,
      SubscriptionTermStatus.SCHEDULED,
    );
  });

  it('an expiry edit moves the tail term, and the add-on sold "until the end" with it', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    const [addOnId] = await buyAddOns(fx, owner, { devices: 1 });
    const oldEnd = (await activeTerm(prisma, owner.subscriptionId)).endsAt!;

    await patch(owner.subscriptionId, { expireDays: 7 });

    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId!], oldEnd);
    const event = await prisma.addOnEntitlementEvent.findFirstOrThrow({
      where: { entitlementId: addOnId!, reason: 'TERM_WINDOW_ALIGNED' },
    });
    assert.equal(event.actorType, AddOnEntitlementActorType.ADMIN);
    assert.equal(event.actorId, adminId);
    assert.equal(event.correlationId, `admin-subscription-edit:${owner.subscriptionId}`);
  });

  it('a plan and a new expiry in one request: the add-on follows the new expiry, not the frozen old term', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    const [addOnId] = await buyAddOns(fx, owner, { devices: 2 });
    const oldEnd = (await activeTerm(prisma, owner.subscriptionId)).endsAt!;

    await patch(owner.subscriptionId, { planId: b, expireDays: 9 });

    // The old term end frozen by the rotation would cut the add-on short by nine days.
    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId!], oldEnd);
    assert.equal((await activeTerm(prisma, owner.subscriptionId)).planId, b);
  });

  it('«Выдать подписку» with stage 1 on: one ACTIVE term over the new subscription, and a shadow equal to its columns', async () => {
    const plan = await createPlan(fx, { trafficLimit: 120, deviceLimit: 4 });
    const telegramId = BigInt(7_700_000_000 + fx.next());
    const userId = await newUser(fx, { telegramId });

    const given = await withStage1('true', () =>
      editor.giveSubscription(String(telegramId), { planId: plan, durationDays: 30 }, { id: adminId } as never, REQUEST),
    );

    assert.equal(given.userId, userId);
    const created = await prisma.subscriptionTerm.findMany({ where: { subscriptionId: given.id } });
    assert.equal(created.length, 1);
    assert.equal(created[0]!.status, SubscriptionTermStatus.ACTIVE);
    assert.equal(created[0]!.generation, 1);
    assert.equal(created[0]!.endsAt?.getTime(), given.expiresAt?.getTime());
    const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
      where: { subscriptionId: given.id },
    });
    assert.equal(projection.state, 'SHADOW');
    assert.equal(projection.desiredDeviceLimit, 4);
    assert.equal(projection.desiredTrafficLimitBytes, 120n * GIB);
  });

  it('«Выдать подписку» with stage 1 off leaves the new subscription outside the model', async () => {
    const plan = await createPlan(fx, { trafficLimit: 120, deviceLimit: 4 });
    const telegramId = BigInt(7_700_000_000 + fx.next());
    await newUser(fx, { telegramId });

    // OFF spelled out: unset is ON since the 24.09.2026 flip.
    const given = await withStage1('false', () =>
      editor.giveSubscription(String(telegramId), { planId: plan, durationDays: 30 }, { id: adminId } as never, REQUEST),
    );

    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: given.id } }), 0);
    assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: given.id } }), 0);
  });

  it('the ↻ pull that adopts a later expiry from the panel moves the tail term and the add-on with it', async () => {
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const owner = await subscriptionInModel(fx, { planId: a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    const [addOnId] = await buyAddOns(fx, owner, { devices: 1 });
    const oldEnd = (await activeTerm(prisma, owner.subscriptionId)).endsAt!;
    const panelExpiry = at(41);
    panelAnswer = {
      uuid: `${fx.prefix}-rw-${owner.panelId}`,
      username: `${fx.prefix}-profile-${owner.panelId}`,
      status: 'ACTIVE',
      subscriptionUrl: `https://sub.example.test/${owner.panelId}`,
      telegramId: null,
      panelId: owner.panelId,
      email: null,
      expireAt: panelExpiry.toISOString(),
      createdAt: at(-10).toISOString(),
      lastTrafficResetAt: null,
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
      trafficLimitStrategy: null,
      tag: null,
      description: null,
      activeInternalSquads: [],
      externalSquadUuid: null,
    };

    const result = await editor.syncSubscription(owner.subscriptionId, { id: adminId } as never, REQUEST);

    assert.equal(result.synced, true);
    const followed = await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId!], oldEnd);
    assert.equal(followed.getTime(), panelExpiry.getTime(), "the panel's expiry was adopted");
  });
});
