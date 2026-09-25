import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus, SubscriptionTermStatus, TrafficLimitStrategy } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { PLAN_STRATEGY_UPDATE_CAUSE } from '../src/modules/add-on-entitlements/services/reset-rule-follow';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import {
  PLAN_SQUAD_PROPAGATION_CAUSE,
  PlanSquadPropagationService,
} from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { resolveInheritedPlanLimitUpdate } from '../src/modules/subscriptions/services/plan-inherited-limits.util';
import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A PLAN'S SQUAD EDIT ON POSTGRESQL (FX5 item 1; review R4-02).
 *
 * The propagation moves every tracking subscriber's squad columns and its
 * snapshot's two squad keys in ONE statement, and writes their pushes in one
 * more — whatever the plan's size. It used to be one statement per subscriber
 * inside the plan edit's 5-second transaction: about 7,000 subscribers rolled
 * «Сохранить» back (P2028). What the per-row code enforced is proved here on
 * real rows: only subscribers still on the plan's previous squads move (order
 * does not matter), a DELETED row is never touched, a non-live or unlinked one
 * moves without a push, the snapshot's squads are re-declared (so a renewal
 * still reads the row as the plan's) and its limit keys are not.
 *
 * With the reset rule changed in the same save, a subscriber's push is the
 * reset rule's — after its follow — never a squad push before it (R4-02).
 *
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `fx5squad-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;

const SQUAD_A = '11111111-1111-4111-8111-111111111111';
const SQUAD_B = '22222222-2222-4222-8222-222222222222';
const SQUAD_C = '33333333-3333-4333-8333-333333333333';
const EXTERNAL_OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXTERNAL_NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let prisma: PrismaService;
let cutover: EntitlementCutoverService;
const created = { users: [] as string[], plans: [] as string[], admins: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

/** Remnawave serves every squad these cases name. */
const remnawave = {
  getInternalSquadOptions: async () => [SQUAD_A, SQUAD_B, SQUAD_C].map((uuid) => ({ uuid, name: uuid.slice(0, 4) })),
  getExternalSquadOptions: async () => [EXTERNAL_OLD, EXTERNAL_NEW].map((uuid) => ({ uuid, name: uuid.slice(0, 4) })),
};

async function plan(input: {
  readonly internalSquads: readonly string[];
  readonly externalSquad?: string | null;
  readonly strategy?: TrafficLimitStrategy;
}): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 940_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [...input.internalSquads],
      externalSquad: input.externalSquad ?? null,
      trafficLimitStrategy: input.strategy ?? TrafficLimitStrategy.MONTH,
      availability: 'ALL',
      upgradeToPlanIds: [],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

/** The snapshot a never-adjusted subscriber of `planId` carries. */
function snapshotOf(
  planId: string,
  internalSquads: readonly string[],
  externalSquad: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: planId,
    name: planId,
    icon: 'rocket',
    trafficLimit: 100,
    deviceLimit: 3,
    trafficLimitStrategy: 'MONTH',
    internalSquads: [...internalSquads],
    externalSquad,
    ...extra,
  };
}

async function subscriber(
  planId: string,
  input: {
    readonly internalSquads: readonly string[];
    readonly externalSquad?: string | null;
    readonly status?: SubscriptionStatus;
    readonly linked?: boolean;
    readonly snapshot?: Prisma.InputJsonValue;
    readonly inModel?: boolean;
  },
): Promise<string> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 950_000 + next();
  const externalSquad = input.externalSquad ?? null;
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: input.status ?? SubscriptionStatus.ACTIVE,
      planSnapshot: input.snapshot ?? (snapshotOf(planId, input.internalSquads, externalSquad) as Prisma.InputJsonValue),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [...input.internalSquads],
      externalSquad,
      ...(input.linked === false ? {} : { remnawaveId: String(panelId), remnawavePanelId: panelId }),
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: inDays(30),
    },
    select: { id: true },
  });
  if (input.inModel === true) {
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
    assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
    await prisma.subscriptionTerm.updateMany({
      where: { subscriptionId: row.id, status: SubscriptionTermStatus.ACTIVE },
      data: { planId },
    });
  }
  return row.id;
}

async function row(id: string) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id },
    select: { internalSquads: true, externalSquad: true, planSnapshot: true, status: true },
  });
}

async function pushesOf(subscriptionId: string, cause: string) {
  return prisma.profileSyncJob.findMany({ where: { subscriptionId, cause }, orderBy: { createdAt: 'asc' } });
}

/** Whether a backend is waiting on a lock `pid` holds, within `ms`. */
async function waitUntilBlockedBy(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [found] = await prisma.$queryRaw<Array<{ readonly n: number }>>(
      Prisma.sql`SELECT count(*)::int AS "n" FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
    );
    if ((found?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** The propagation alone, in one interactive transaction with Prisma's default timeout. */
function propagate(
  planId: string,
  input: {
    readonly previousInternalSquads: readonly string[];
    readonly nextInternalSquads: readonly string[];
    readonly previousExternalSquad?: string | null;
    readonly nextExternalSquad?: string | null;
    readonly pushedWithResetRule?: readonly string[];
  },
) {
  const service = new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never);
  return prisma.$transaction((tx) =>
    service.propagateInTransaction(tx, {
      planId,
      previousInternalSquads: input.previousInternalSquads,
      previousExternalSquad: input.previousExternalSquad ?? null,
      nextInternalSquads: input.nextInternalSquads,
      nextExternalSquad: input.nextExternalSquad ?? input.previousExternalSquad ?? null,
      pushedWithResetRule: input.pushedWithResetRule,
    }),
  );
}

/** «Тарифы» → «Редактировать тариф» → «Сохранить», through the real service, its queue recorded. */
async function savePlan(planId: string, patch: Record<string, unknown>) {
  const admin = await prisma.adminUser.create({
    data: { login: `${prefix}-admin-${next()}`, loginNormalized: `${prefix}-admin-${counter}`, passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  created.admins.push(admin.id);
  const enqueued: string[] = [];
  const queue = { enqueue: async (syncJobId: string): Promise<void> => void enqueued.push(syncJobId) };
  const plansAdmin = new PlansAdminService(
    prisma,
    remnawave as never,
    new PlanSnapshotSyncService(),
    new PlansAdminValidators(prisma, remnawave as never),
    new PlanSquadPropagationService(prisma, queue as never),
    queue as never,
  );
  const result = await plansAdmin.updatePlan(planId, patch as never, {
    currentAdmin: { id: admin.id } as never,
    requestMetadata: { requestId: `${prefix}-req-${counter}`, remoteAddress: '203.0.113.9', userAgent: 'fx5a' },
  });
  await plansAdmin.settleResetRuleFollows();
  return { result, enqueued };
}

run('a plan\'s squad edit on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    cutover = new EntitlementCutoverService(prisma, terms, new EffectiveProjectionService());
    await prisma.settings.upsert({ where: { id: 1 }, update: { addOnSettings: {} }, create: {} });
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('squad propagation cleanup failed', error);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM subscriptions WHERE user_id LIKE '${prefix}-scale-u-%'`).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id LIKE '${prefix}-scale-u-%'`).catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('«Сохранить» with new squads on a plan of 7,000 subscribers commits: every one moved and pushed (FX5 item 1)', async () => {
    const N = 7_000;
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const tag = `${prefix}-scale`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, referral_code, name, updated_at)
       SELECT '${tag}-u-' || g, '${tag}-r-' || g, 'u' || g, now() FROM generate_series(1, ${N}) g`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO subscriptions (id, user_id, status, plan_snapshot, traffic_limit, device_limit, internal_squads,
                                  remnawave_id, remnawave_panel_id, created_at, started_at, expires_at, updated_at)
       SELECT '${tag}-s-' || g, '${tag}-u-' || g, 'ACTIVE',
              jsonb_build_object('id', '${planId}', 'name', '${planId}', 'trafficLimit', 100, 'deviceLimit', 3,
                                 'trafficLimitStrategy', 'MONTH', 'internalSquads', '["${SQUAD_A}"]'::jsonb,
                                 'externalSquad', null),
              100, 3, '{${SQUAD_A}}', (660000 + g)::text, 660000 + g, now() - interval '10 days',
              now() - interval '10 days', now() + interval '20 days', now()
       FROM generate_series(1, ${N}) g`,
    );

    const startedAt = Date.now();
    const { result, enqueued } = await savePlan(planId, { internalSquads: [SQUAD_B] });
    console.log(`[fx5a] ${N} subscribers: squad save ${Date.now() - startedAt} ms`);

    assert.equal(result.squadPropagation.subscriptionsUpdated, N);
    assert.equal(result.squadPropagation.syncJobsCreated, N);
    const moved = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM subscriptions
        WHERE id LIKE '${tag}-s-%' AND internal_squads = '{${SQUAD_B}}'
          AND plan_snapshot->'internalSquads' = '["${SQUAD_B}"]'::jsonb`,
    );
    assert.equal(moved[0]!.n, N, 'columns and snapshot, every one');
    const pushes = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(DISTINCT subscription_id)::int AS n FROM profile_sync_jobs
        WHERE subscription_id LIKE '${tag}-s-%' AND cause = '${PLAN_SQUAD_PROPAGATION_CAUSE}' AND status = 'PENDING'`,
    );
    assert.equal(pushes[0]!.n, N, 'one PENDING push each, written with the save');
    assert.ok(enqueued.length > 0 && enqueued.length <= 100, 'the request nudges the queue for the first ones only');
  });

  it('moves only the subscribers still on the previous squads — order does not matter — and never a DELETED one', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A, SQUAD_B] });
    const tracking = await subscriber(planId, { internalSquads: [SQUAD_A, SQUAD_B] });
    const reordered = await subscriber(planId, { internalSquads: [SQUAD_B, SQUAD_A] });
    const diverged = await subscriber(planId, { internalSquads: [SQUAD_C] });
    const partial = await subscriber(planId, { internalSquads: [SQUAD_A] });
    // The plan's internal squads, and an external squad the plan never had: set by hand.
    const ownExternal = await subscriber(planId, { internalSquads: [SQUAD_A, SQUAD_B], externalSquad: EXTERNAL_NEW });
    const deleted = await subscriber(planId, { internalSquads: [SQUAD_A, SQUAD_B], status: SubscriptionStatus.DELETED });

    const { summary } = await propagate(planId, {
      previousInternalSquads: [SQUAD_A, SQUAD_B],
      nextInternalSquads: [SQUAD_C],
    });

    assert.deepEqual((await row(tracking)).internalSquads, [SQUAD_C]);
    assert.deepEqual((await row(reordered)).internalSquads, [SQUAD_C]);
    assert.deepEqual((await row(diverged)).internalSquads, [SQUAD_C], 'already there on its own: untouched either way');
    assert.deepEqual((await row(partial)).internalSquads, [SQUAD_A], 'diverged: left alone');
    assert.deepEqual(
      await row(ownExternal).then((after) => [after.internalSquads, after.externalSquad]),
      [[SQUAD_A, SQUAD_B], EXTERNAL_NEW],
      'diverged in its external squad: left alone',
    );
    assert.deepEqual((await row(deleted)).internalSquads, [SQUAD_A, SQUAD_B], 'a DELETED row is never touched');
    assert.equal(summary.subscriptionsUpdated, 2);
    assert.equal(summary.subscriptionsSkippedDiverged, 3);
    assert.equal((await pushesOf(deleted, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0);
  });

  it('re-declares the snapshot\'s squads so a renewal still reads the row as the plan\'s, and leaves the limit keys alone', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A], externalSquad: EXTERNAL_OLD });
    const adjusted = snapshotOf(planId, [SQUAD_A], EXTERNAL_OLD, { deviceLimit: 5, trafficLimit: 250 });
    const id = await subscriber(planId, {
      internalSquads: [SQUAD_A],
      externalSquad: EXTERNAL_OLD,
      snapshot: adjusted as Prisma.InputJsonValue,
    });

    await propagate(planId, {
      previousInternalSquads: [SQUAD_A],
      previousExternalSquad: EXTERNAL_OLD,
      nextInternalSquads: [SQUAD_B, SQUAD_C],
      nextExternalSquad: EXTERNAL_NEW,
    });

    const after = await row(id);
    assert.deepEqual(after.internalSquads, [SQUAD_B, SQUAD_C]);
    assert.equal(after.externalSquad, EXTERNAL_NEW);
    assert.deepEqual(after.planSnapshot, {
      ...adjusted,
      internalSquads: [SQUAD_B, SQUAD_C],
      externalSquad: EXTERNAL_NEW,
    });
    const decision = resolveInheritedPlanLimitUpdate({
      current: { trafficLimit: 100, deviceLimit: 3, internalSquads: after.internalSquads, externalSquad: after.externalSquad },
      planSnapshot: after.planSnapshot,
      plan: { trafficLimit: 100, deviceLimit: 3, internalSquads: [SQUAD_B, SQUAD_C], externalSquad: EXTERNAL_NEW },
    });
    assert.deepEqual(decision.internalSquads, [SQUAD_B, SQUAD_C], 'INHERITED: a renewal re-applies the plan\'s squads');
    assert.equal(decision.externalSquad, EXTERNAL_NEW);
  });

  it('adds the keys an imported snapshot never had, leaves a snapshot that already records them, and rebuilds one that is not an object', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const imported = { id: planId, importedFrom: 'remnawave-importer', tag: null, trafficLimitStrategy: 'MONTH' };
    const importedRow = await subscriber(planId, { internalSquads: [SQUAD_A], snapshot: imported });
    // Records the new selection already, in another order: not rewritten.
    const recorded = snapshotOf(planId, [SQUAD_C, SQUAD_B], null);
    const recordedRow = await subscriber(planId, { internalSquads: [SQUAD_A], snapshot: recorded as Prisma.InputJsonValue });
    // Names the id only through a string snapshot: nothing to merge into.
    const oddRow = await subscriber(planId, { internalSquads: [SQUAD_A] });
    await prisma.$executeRaw`UPDATE subscriptions SET plan_snapshot = jsonb_build_object('id', ${planId}::text, 'externalSquad', 7) WHERE id = ${oddRow}`;

    await propagate(planId, { previousInternalSquads: [SQUAD_A], nextInternalSquads: [SQUAD_B, SQUAD_C] });

    assert.deepEqual((await row(importedRow)).planSnapshot, { ...imported, internalSquads: [SQUAD_B, SQUAD_C], externalSquad: null });
    const kept = await prisma.$queryRaw<Array<{ text: string }>>`SELECT plan_snapshot::text AS text FROM subscriptions WHERE id = ${recordedRow}`;
    assert.deepEqual(JSON.parse(kept[0]!.text).internalSquads, [SQUAD_C, SQUAD_B], 'already recorded: kept as it was');
    assert.deepEqual((await row(recordedRow)).internalSquads, [SQUAD_B, SQUAD_C], 'the columns move all the same');
    assert.deepEqual((await row(oddRow)).planSnapshot, {
      id: planId,
      externalSquad: null,
      internalSquads: [SQUAD_B, SQUAD_C],
    }, 'a mistyped key is not «recorded»: re-declared');
  });

  it('moves a non-live or unlinked subscriber without a push, and counts the unlinked live one apart', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const live = await subscriber(planId, { internalSquads: [SQUAD_A] });
    const limited = await subscriber(planId, { internalSquads: [SQUAD_A], status: SubscriptionStatus.LIMITED });
    const expired = await subscriber(planId, { internalSquads: [SQUAD_A], status: SubscriptionStatus.EXPIRED });
    const unlinked = await subscriber(planId, { internalSquads: [SQUAD_A], linked: false });

    const { summary, syncJobIds } = await propagate(planId, { previousInternalSquads: [SQUAD_A], nextInternalSquads: [SQUAD_B] });

    for (const id of [live, limited, expired, unlinked]) assert.deepEqual((await row(id)).internalSquads, [SQUAD_B], id);
    assert.equal((await pushesOf(live, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 1);
    assert.equal((await pushesOf(limited, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 1);
    assert.equal((await pushesOf(expired, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0);
    assert.equal((await pushesOf(unlinked, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0);
    assert.deepEqual(summary, {
      propagationId: summary.propagationId,
      subscriptionsUpdated: 4,
      subscriptionsSkippedDiverged: 0,
      syncJobsCreated: 2,
      syncJobsSkippedUnlinked: 1,
      pushedWithResetRule: 0,
    });
    assert.equal(syncJobIds.length, 2);
    const payload = (await pushesOf(live, PLAN_SQUAD_PROPAGATION_CAUSE))[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload, { source: PLAN_SQUAD_PROPAGATION_CAUSE, planId, propagationId: summary.propagationId });
  });

  it('keeps a squad push already waiting instead of a second one, carries it to this edit, and holds it until the commit', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const id = await subscriber(planId, { internalSquads: [SQUAD_A] });
    const waiting = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: id,
        action: 'UPDATE',
        status: 'PENDING',
        cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        payload: { source: PLAN_SQUAD_PROPAGATION_CAUSE, planId, propagationId: 'an-earlier-edit' },
      },
    });

    let claim: unknown = null;
    const service = new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never);
    const { summary, syncJobIds } = await prisma.$transaction(
      async (tx) => {
        const answer = await service.propagateInTransaction(tx, {
          planId,
          previousInternalSquads: [SQUAD_A],
          previousExternalSquad: null,
          nextInternalSquads: [SQUAD_B],
          nextExternalSquad: null,
        });
        // A profile-sync worker claims it meanwhile, as `claimSyncJob` does.
        claim = await prisma
          .$transaction(async (other) => {
            await other.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
            return other.profileSyncJob.updateMany({
              where: { id: waiting.id, status: 'PENDING', supersededAt: null },
              data: { status: 'RUNNING', startedAt: new Date() },
            });
          })
          .catch((error: unknown) => error);
        return answer;
      },
      { timeout: 15_000 },
    );

    assert.match(`${String(claim)} ${JSON.stringify(claim)}`, /55P03|lock timeout/i, 'the claim waited for the commit');
    const pushes = await pushesOf(id, PLAN_SQUAD_PROPAGATION_CAUSE);
    assert.deepEqual(pushes.map((push) => push.id), [waiting.id], 'no second push');
    assert.deepEqual(syncJobIds, [waiting.id]);
    assert.equal(pushes[0]!.status, 'PENDING');
    assert.equal((pushes[0]!.payload as Record<string, unknown>)['propagationId'], summary.propagationId, 'counted in this edit');
  });

  it('a waiting push a worker is claiming while the edit runs is not kept: the edit waits for the claim and writes its own', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const id = await subscriber(planId, { internalSquads: [SQUAD_A] });
    const waiting = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: id,
        action: 'UPDATE',
        status: 'PENDING',
        cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        payload: { source: PLAN_SQUAD_PROPAGATION_CAUSE, planId, propagationId: 'an-earlier-edit' },
      },
    });
    const service = new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never);

    // A profile-sync worker has claimed it (`claimSyncJob`) and not committed
    // when the edit's statement reaches it: it reads the subscription as it
    // was, so it cannot carry this edit.
    const running: { edit?: Promise<{ readonly syncJobIds: readonly string[] }> } = {};
    await prisma.$transaction(
      async (worker) => {
        await worker.profileSyncJob.updateMany({
          where: { id: waiting.id, status: 'PENDING', supersededAt: null },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        const [claimant] = await worker.$queryRaw<Array<{ readonly pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS "pid"`,
        );
        running.edit = prisma.$transaction(
          (tx) =>
            service.propagateInTransaction(tx, {
              planId,
              previousInternalSquads: [SQUAD_A],
              previousExternalSquad: null,
              nextInternalSquads: [SQUAD_B],
              nextExternalSquad: null,
            }),
          { timeout: 15_000 },
        );
        assert.ok(await waitUntilBlockedBy(claimant!.pid), 'fixture: the edit reached the claimed push');
      },
      { timeout: 15_000 },
    );
    const { syncJobIds } = await running.edit!;

    const pushes = await pushesOf(id, PLAN_SQUAD_PROPAGATION_CAUSE);
    assert.equal(pushes.length, 2, 'the claimed push read the old squads: the edit has no push of its own');
    const fresh = pushes.find((push) => push.id !== waiting.id)!;
    assert.deepEqual(syncJobIds, [fresh.id]);
    assert.equal(fresh.status, 'PENDING');
    const claimed = pushes.find((push) => push.id === waiting.id)!;
    assert.equal(claimed.status, 'RUNNING');
    assert.equal((claimed.payload as Record<string, unknown>)['propagationId'], 'an-earlier-edit', 'not counted in this edit');
  });

  it('a save that changes the squads AND the reset rule: the rule\'s push carries the squads, after the follow — no squad push first (R4-02)', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A], strategy: TrafficLimitStrategy.MONTH });
    const inModel = await subscriber(planId, { internalSquads: [SQUAD_A], inModel: true });
    const outside = await subscriber(planId, { internalSquads: [SQUAD_A] });
    // An old import's snapshot names no rule: the rule did not change for it, the squads did.
    const noRule = await subscriber(planId, {
      internalSquads: [SQUAD_A],
      snapshot: { id: planId, internalSquads: [SQUAD_A], externalSquad: null },
    });

    const { result, enqueued } = await savePlan(planId, { internalSquads: [SQUAD_B], trafficLimitStrategy: 'DAY' });

    for (const id of [inModel, outside, noRule]) assert.deepEqual((await row(id)).internalSquads, [SQUAD_B], id);
    assert.equal((await pushesOf(inModel, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0, 'no squad push ahead of its follow');
    assert.equal((await pushesOf(outside, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0);
    const followPush = await pushesOf(inModel, PLAN_STRATEGY_UPDATE_CAUSE);
    assert.equal(followPush.length, 1, 'the follow\'s push, after its terms moved');
    const activeTerm = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: inModel, status: SubscriptionTermStatus.ACTIVE },
    });
    assert.equal(activeTerm.trafficResetStrategy, 'DAY');
    assert.equal((await pushesOf(outside, PLAN_STRATEGY_UPDATE_CAUSE)).length, 1, 'the push written with the edit');
    assert.equal((await pushesOf(noRule, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 1, 'its rule did not change: the squad push');
    assert.equal(result.squadPropagation.pushedWithResetRule, 2);
    assert.equal(result.squadPropagation.syncJobsCreated, 1);
    assert.ok(enqueued.includes(followPush[0]!.id));
  });

  it('a squad edit leaves subscribers of another plan alone', async () => {
    const planId = await plan({ internalSquads: [SQUAD_A] });
    const otherPlan = await plan({ internalSquads: [SQUAD_A] });
    const other = await subscriber(otherPlan, { internalSquads: [SQUAD_A] });

    await propagate(planId, { previousInternalSquads: [SQUAD_A], nextInternalSquads: [SQUAD_B] });

    assert.deepEqual((await row(other)).internalSquads, [SQUAD_A]);
    assert.equal((await pushesOf(other, PLAN_SQUAD_PROPAGATION_CAUSE)).length, 0);
  });
});
