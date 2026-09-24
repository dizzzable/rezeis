import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import { takePanelAnswerStatus } from '../src/modules/profile-sync/panel-answer-status';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import { OPERATOR_TRAFFIC_RESET_CAUSE } from '../src/modules/remnawave/services/term-model-readback';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { at, createPlan, newUser, termModelFixtures, type Limits, type TermModelFixtures } from './helpers/term-model-fixtures';
import { realTermHooks } from './helpers/term-model-hooks';

/**
 * THE STATUS OF A SUBSCRIPTION IN THE TERM MODEL, against Remnawave events
 * that arrive late — through the real webhook handler, the real profile-sync
 * processor and the real «Импорт из Remnawave»; only Remnawave is a double.
 *
 * A status Remnawave reports is its runtime state at the moment it stamped the
 * report. Once a push of the panel's own has landed after that moment, the
 * report describes an older state: a renewal made an EXPIRED subscription
 * ACTIVE, a top-up lifted LIMITED, and an event stamped before the push says
 * otherwise. So (`term-model-readback.ts`):
 *
 *  - the status follows the expiry's rule: not taken from a read the panel's
 *    own push outranks (S1, S2, S12), still taken from one it does not (S3);
 *  - nor does such a read tell anybody anything: no «трафик закончился», no
 *    card, no automation (S1, S2, S4) — except the one-off facts, a first
 *    connection and a reset that happened (S7);
 *  - the fresh status comes from Remnawave's own answer to the push
 *    (`ProfileSyncProcessor`): the PATCH's (S2), the reset's after it (S9),
 *    the POST's (S10). An older
 *    push's answer never overwrites what a newer push is establishing (S5),
 *    and never moves a status the panel's own date decides (S8); a crossing
 *    into LIMITED it reports tells the customer, once (S4);
 *  - DISABLED (the owner, 24.09.2026): a switch-off or switch-on made in
 *    Remnawave while a push was on its way comes from that push's answer; the
 *    panel's own switch-off, and a blocked owner's, are kept (S15);
 *  - while the latest push of ours has FAILED, a LIMITED is still taken, with
 *    its notice, when the traffic used reaches the row's own limit (S16);
 *  - the operator's «Сбросить» is a push of ours for the status (the owner,
 *    24.09.2026): a report stamped before it does not limit again, and the
 *    status after it comes from Remnawave, read right after the reset (S17);
 *  - a subscription OUTSIDE the model keeps today's behaviour (S6).
 *
 * Every flag this touches is pinned in each case.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const GIB = 1024 ** 3;
/** A panel-id range no other spec uses, so an event names only our rows. */
const PANEL_BASE = 1_500_000_000 + (Date.now() % 2_000_000) * 100;
/** Marks the Activity Feed rows this spec's webhooks store, for its cleanup. */
const SOURCE_IP = `w4-status-${process.pid}`;
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let fx: TermModelFixtures;
/** The operator who presses «Сбросить» (S17). */
let adminId = '';
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
let webhook: RemnawaveWebhookService;
/** What the webhook forwarded to the system-event bus (cards, audit, automations). */
const forwarded: Array<{ readonly type: string; readonly metadata?: Record<string, unknown> }> = [];
/** Customer notices created (the «трафик закончился» one is `limited`). */
const notices: Array<{ readonly userId: string; readonly type: string }> = [];
/** Put-backs the webhook handed to the queue. */
const enqueued: string[] = [];

type Owner = { readonly userId: string; readonly subscriptionId: string; readonly panelId: number };

/** A linked subscription on a 3 / 100 GB plan, in the model unless `outside`. */
async function subscription(
  planId: string,
  options: {
    readonly status?: SubscriptionStatus;
    readonly expiresAt?: Date;
    readonly outside?: boolean;
    readonly panelId?: number;
    readonly unlinked?: boolean;
  } = {},
): Promise<Owner> {
  const userId = await newUser(fx);
  const panelId = options.panelId ?? PANEL_BASE + fx.next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
      },
      trafficLimit: PLAN.trafficLimit,
      deviceLimit: PLAN.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: options.unlinked === true ? null : String(panelId),
      remnawavePanelId: options.unlinked === true ? null : panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  const owner = { userId, subscriptionId: row.id, panelId };
  if (options.outside !== true) {
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, owner.subscriptionId));
    assert.equal(entered.outcome, 'CREATED');
  }
  // After the cutover, which mints the term from an ACTIVE row.
  await prisma.subscription.update({
    where: { id: owner.subscriptionId },
    data: {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
  });
  return owner;
}

/** A push of the panel's own, recorded in the state given (not run). */
async function pushOfOurs(
  owner: Owner,
  status: SyncJobStatus,
  options: {
    readonly completedAt?: Date | null;
    readonly createdAt?: Date;
    readonly action?: SyncAction;
    readonly supersededAt?: Date;
  } = {},
): Promise<string> {
  const completedAt = options.completedAt ?? null;
  const job = await prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: options.action ?? SyncAction.UPDATE,
      status,
      completedAt,
      createdAt: options.createdAt ?? (completedAt === null ? new Date() : new Date(completedAt.getTime() - 1_000)),
      ...(options.supersededAt === undefined ? {} : { supersededAt: options.supersededAt }),
      payload: { source: 'ADMIN_MUTATION' },
    },
    select: { id: true },
  });
  return job.id;
}

/** The profile as a 3.x panel serves it: every field a user event's `data` requires. */
function profile(owner: Owner, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: owner.panelId,
    username: `rwst-${owner.panelId}`,
    status,
    subscriptionUrl: `https://panel.example/sub/${owner.panelId}`,
    description: null,
    expireAt: at(20).toISOString(),
    createdAt: at(-10).toISOString(),
    trafficLimitBytes: PLAN.trafficLimit! * GIB,
    hwidDeviceLimit: PLAN.deviceLimit,
    ...extra,
  };
}

/** A `user.*` webhook for this profile, stamped by the panel at `stampedAt`, through the real handler. */
async function panelEvent(
  owner: Owner,
  event: string,
  status: string,
  stampedAt: Date,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await webhook.handleEvent(
    event,
    { scope: 'user', event, timestamp: stampedAt.toISOString(), data: profile(owner, status, extra), meta: {} },
    SOURCE_IP,
  );
}

interface PanelAnswers {
  /** The status in the answer to `PATCH /api/users`. */
  readonly patch?: string;
  /** …to the reset of the traffic counter a renewal's UPDATE makes after it. */
  readonly reset?: string;
  /** …to `POST /api/users`. */
  readonly create?: string;
}

/** The real processor over a Remnawave double answering with `answers`. */
function processorFor(owner: Owner, answers: PanelAnswers): ProfileSyncProcessor {
  const answer = (status: string | undefined) => ({
    kind: 'ok' as const,
    data: { response: profile(owner, status ?? 'ACTIVE') },
  });
  const missing = { kind: 'rejected' as const, status: 404, code: 'A063', detail: 'User not found' };
  const panel = {
    updateUser: async () => answer(answers.patch),
    resetTraffic: async () => answer(answers.reset),
    createUser: async () => answer(answers.create),
    getUserByUsername: async () => missing,
    resolveUser: async () => missing,
  };
  return new ProfileSyncProcessor(
    prisma,
    panel as never,
    {
      generateProfileName: async () => ({ username: `rwst-${owner.panelId}`, description: 'status spec' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined, emit: () => undefined } as never,
    undefined,
    undefined,
    // Tells the customer about a crossing into LIMITED the answer reports —
    // through the webhook's own notice, so both say it in the same words.
    webhook,
  );
}

/** Queues one push and runs it through the real processor; returns when it has COMPLETED. */
async function runPush(
  owner: Owner,
  answers: PanelAnswers,
  options: {
    readonly action?: SyncAction;
    readonly payload?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const job = await prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: options.action ?? SyncAction.UPDATE,
      status: SyncJobStatus.PENDING,
      payload: (options.payload ?? { source: 'ADMIN_MUTATION' }) as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  await runJob(owner, job.id, answers);
  return job.id;
}

/** Runs a push already recorded through the real processor; returns when it has COMPLETED. */
async function runJob(owner: Owner, syncJobId: string, answers: PanelAnswers): Promise<void> {
  await processorFor(owner, answers).process({ data: { syncJobId } } as never);
  const done = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: syncJobId } });
  assert.equal(done.status, SyncJobStatus.COMPLETED, `the push completed (${done.lastError ?? ''})`);
}

async function row(owner: Owner) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: owner.subscriptionId },
    select: { status: true, expiresAt: true, trafficLimit: true, remnawaveId: true },
  });
}

/**
 * «Быстрые действия» → «Сброс трафика» → «Сбросить», through the real
 * controller. Remnawave zeroes the counter and answers the read made right
 * after it with `status`; `null` for a read that fails.
 */
async function operatorReset(owner: Owner, status: string | null): Promise<unknown> {
  const controller = new AdminUserSubscriptionsController(
    prisma,
    {
      resetPanelUserTraffic: async () => undefined,
      getPanelUserOutcome: async () =>
        status === null
          ? { kind: 'unavailable' }
          : { kind: 'ok', user: { ...profile(owner, status), uuid: String(owner.panelId), panelId: owner.panelId } },
    } as never,
    { enqueue: async () => undefined } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    {} as never,
    {} as never,
    realTermHooks(prisma),
  );
  return controller.resetTraffic(owner.subscriptionId, { id: adminId } as never, REQUEST);
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const limitNotices = (owner: Owner) => notices.filter((n) => n.userId === owner.userId && n.type === 'limited');
const cards = (type: string) => forwarded.filter((event) => event.type === type);

run('the status of a subscription in the term model against late Remnawave reports (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rwst-${process.pid}-${Date.now()}`);
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
    const bus = {
      emit: (event: { type: string; metadata?: Record<string, unknown> }) => void forwarded.push(event),
      info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) =>
        void forwarded.push({ type, metadata }),
      warn: () => undefined,
      error: () => undefined,
    };
    const queue = { enqueue: async (syncJobId: string) => void enqueued.push(syncJobId) };
    webhook = new RemnawaveWebhookService(
      prisma,
      { webhookSecret: null } as never,
      bus as never,
      { getPanelUserUsage: async () => null } as never,
      { build: async (subscription: { id: string }) => ({ subscriptionId: subscription.id }) } as never,
      { create: async (input: { userId: string; type: string }) => void notices.push(input) } as never,
      { get: () => queue } as never,
    );
  });

  beforeEach(() => {
    forwarded.length = 0;
    notices.length = 0;
    enqueued.length = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.remnawaveWebhookEvent.deleteMany({ where: { sourceIp: SOURCE_IP } }).catch(() => undefined);
    await prisma.profileSyncJob
      .deleteMany({ where: { subscription: { userId: { in: fx.users } } } })
      .catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { filename: { startsWith: fx.prefix } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── The webhook ───────────────────────────────────────────────────────────

  it('S1 expired, then renewed: a user.expired stamped before the renewal’s push landed is not taken and says nothing', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { status: SubscriptionStatus.EXPIRED, expiresAt: at(-1) });
    // The renewal: ACTIVE and a new expiry, and the UPDATE that carries them,
    // resetting the counter as a paid renewal does. Remnawave lifts EXPIRED.
    const renewed = at(29);
    await prisma.subscription.update({
      where: { id: owner.subscriptionId },
      data: { status: SubscriptionStatus.ACTIVE, expiresAt: renewed },
    });
    await runPush(owner, { patch: 'ACTIVE', reset: 'ACTIVE' }, { payload: { source: 'PAYMENT_COMPLETION', resetTraffic: true } });
    // Remnawave expired the profile a minute ago; the event arrives only now.
    await panelEvent(owner, 'user.expired', 'EXPIRED', ago(60_000), { expireAt: at(-1).toISOString() });
    const after = await row(owner);
    assert.equal(after.status, SubscriptionStatus.ACTIVE, 'the customer paid: not «Истекла»');
    assert.equal(after.expiresAt?.getTime(), renewed.getTime(), 'and the paid days stay');
    assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED), [], 'no card, no automation, no outbound webhook');
    assert.deepEqual(notices, []);
    assert.equal(
      await prisma.remnawaveWebhookEvent.count({ where: { sourceIp: SOURCE_IP, eventType: 'user.expired' } }) > 0,
      true,
      'the Activity Feed still keeps the event',
    );
  });

  it('S2 limited, then topped up: Remnawave’s answer lifts LIMITED, and a user.limited stamped before it changes nothing', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { status: SubscriptionStatus.LIMITED });
    // The top-up: the limit goes up, the status is left for Remnawave to say.
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { trafficLimit: 150 } });
    await runPush(owner, { patch: 'ACTIVE' });
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE, 'the push’s answer says ACTIVE');
    await panelEvent(owner, 'user.limited', 'LIMITED', ago(60_000));
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE, 'the late event is older than the top-up');
    assert.deepEqual(limitNotices(owner), [], 'no «трафик закончился» after paying for traffic');
    assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED), []);
  });

  it('S2b a user.limited stamped before our last push landed does not limit, notify or forward', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, { completedAt: ago(10_000) });
    await panelEvent(owner, 'user.limited', 'LIMITED', ago(60_000));
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE);
    assert.deepEqual(limitNotices(owner), []);
    assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED), []);
  });

  it('S3 a genuine status change is taken as before, with its notice and its card', async () => {
    const plan = await createPlan(fx, PLAN);
    const limited = await subscription(plan);
    await pushOfOurs(limited, SyncJobStatus.COMPLETED, { completedAt: ago(600_000) });
    await panelEvent(limited, 'user.limited', 'LIMITED', ago(5_000));
    assert.equal((await row(limited)).status, SubscriptionStatus.LIMITED);
    assert.equal(limitNotices(limited).length, 1, 'the customer is told once');
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED).length, 1);

    const expired = await subscription(plan, { expiresAt: at(-1) });
    await panelEvent(expired, 'user.expired', 'EXPIRED', ago(5_000), { expireAt: at(-1).toISOString() });
    assert.equal((await row(expired)).status, SubscriptionStatus.EXPIRED, 'never pushed: the report is all there is');
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED).length, 1);

    // Lifted in Remnawave's own UI, after our last push.
    await panelEvent(limited, 'user.enabled', 'ACTIVE', new Date());
    assert.equal((await row(limited)).status, SubscriptionStatus.ACTIVE);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_ENABLED).length, 1);
  });

  it('S4 limited while our push was on its way: withheld then, taken from the push’s answer, and told once', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    const queued = await pushOfOurs(owner, SyncJobStatus.PENDING);
    await panelEvent(owner, 'user.limited', 'LIMITED', new Date());
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE, 'a push of ours is on its way: not yet');
    assert.deepEqual(limitNotices(owner), []);
    // The queued push lands; Remnawave answers with the profile, still LIMITED.
    await runJob(owner, queued, { patch: 'LIMITED' });
    assert.equal((await row(owner)).status, SubscriptionStatus.LIMITED, 'the answer is Remnawave’s own, after our change');
    assert.equal(limitNotices(owner).length, 1, 'the customer hears it from the answer');
    // Remnawave repeats itself: nothing crosses twice.
    await panelEvent(owner, 'user.limited', 'LIMITED', new Date());
    assert.equal(limitNotices(owner).length, 1);
  });

  // ── The answer to a push, and what outranks it ────────────────────────────

  it('S5 an older push’s answer never overwrites what a newer push of ours is about to establish', async () => {
    const plan = await createPlan(fx, PLAN);
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly newer: (owner: Owner) => Promise<unknown>;
      readonly taken: boolean;
    }> = [
      { name: 'queued', newer: (o) => pushOfOurs(o, SyncJobStatus.PENDING, { createdAt: ago(1_000) }), taken: false },
      { name: 'running', newer: (o) => pushOfOurs(o, SyncJobStatus.RUNNING, { createdAt: ago(1_000) }), taken: false },
      { name: 'failed', newer: (o) => pushOfOurs(o, SyncJobStatus.FAILED, { createdAt: ago(1_000) }), taken: false },
      {
        name: 'completed',
        newer: (o) => pushOfOurs(o, SyncJobStatus.COMPLETED, { createdAt: ago(1_000), completedAt: ago(500) }),
        taken: true,
      },
      {
        name: 'superseded',
        newer: (o) => pushOfOurs(o, SyncJobStatus.PENDING, { createdAt: ago(1_000), supersededAt: new Date() }),
        taken: true,
      },
      {
        name: 'a traffic reset',
        newer: (o) => pushOfOurs(o, SyncJobStatus.PENDING, { createdAt: ago(1_000), action: SyncAction.TRAFFIC_RESET }),
        taken: true,
      },
      {
        name: 'older, queued',
        newer: (o) => pushOfOurs(o, SyncJobStatus.PENDING, { createdAt: ago(3_600_000) }),
        taken: true,
      },
    ];
    // Two pushes created in the same millisecond are ordered by id, as
    // `panelPushOutranksRead` orders them.
    const queuedAt = ago(60_000);
    const sameInstant = (idSuffix: string) => async (o: Owner) =>
      prisma.profileSyncJob.create({
        data: {
          id: `${o.subscriptionId}-${idSuffix}`,
          subscriptionId: o.subscriptionId,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          createdAt: queuedAt,
          payload: { source: 'ADMIN_MUTATION' },
        },
      });
    const withTies = [
      ...cases,
      { name: 'same-instant, later-id', newer: sameInstant('job-c'), taken: false },
      { name: 'same-instant, earlier-id', newer: sameInstant('job-a'), taken: true },
    ];
    for (const entry of withTies) {
      const owner = await subscription(plan);
      // THIS push was queued a minute ago; `entry` is recorded beside it.
      const job = await prisma.profileSyncJob.create({
        data: {
          id: `${owner.subscriptionId}-job-b`,
          subscriptionId: owner.subscriptionId,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          createdAt: queuedAt,
          payload: { source: 'ADMIN_MUTATION' },
        },
        select: { id: true },
      });
      await entry.newer(owner);
      await processorFor(owner, { patch: 'LIMITED' }).process({ data: { syncJobId: job.id } } as never);
      assert.equal(
        (await row(owner)).status,
        entry.taken ? SubscriptionStatus.LIMITED : SubscriptionStatus.ACTIVE,
        `a ${entry.name} push beside it: the answer ${entry.taken ? 'is' : 'is not'} taken`,
      );
      assert.equal(limitNotices(owner).length, entry.taken ? 1 : 0, `${entry.name}: the notice follows the status`);
    }
  });

  it('S8 the answer never moves a status the panel’s own date decides', async () => {
    const plan = await createPlan(fx, PLAN);
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly status: SubscriptionStatus;
      readonly expiresAt: Date;
      readonly answer: string;
      readonly after: SubscriptionStatus;
    }> = [
      { name: 'ended by our date, Remnawave behind', status: SubscriptionStatus.EXPIRED, expiresAt: at(-1), answer: 'ACTIVE', after: SubscriptionStatus.EXPIRED },
      { name: 'past its date, autopay retrying', status: SubscriptionStatus.ACTIVE, expiresAt: at(-1), answer: 'EXPIRED', after: SubscriptionStatus.ACTIVE },
      { name: 'past its date, autopay retrying, limited', status: SubscriptionStatus.ACTIVE, expiresAt: at(-1), answer: 'LIMITED', after: SubscriptionStatus.ACTIVE },
      { name: 'limited past its date', status: SubscriptionStatus.LIMITED, expiresAt: at(-1), answer: 'EXPIRED', after: SubscriptionStatus.EXPIRED },
      { name: 'a stale EXPIRED with days left', status: SubscriptionStatus.EXPIRED, expiresAt: at(20), answer: 'ACTIVE', after: SubscriptionStatus.ACTIVE },
      { name: 'an answer that says nothing readable', status: SubscriptionStatus.LIMITED, expiresAt: at(20), answer: 'SOMETHING', after: SubscriptionStatus.LIMITED },
    ];
    for (const entry of cases) {
      const owner = await subscription(plan, { status: entry.status, expiresAt: entry.expiresAt });
      await runPush(owner, { patch: entry.answer });
      assert.equal((await row(owner)).status, entry.after, entry.name);
    }
  });

  it('S15 DISABLED: a switch-off or switch-on made in Remnawave during a push is taken from its answer; the panel’s own is kept', async () => {
    const plan = await createPlan(fx, PLAN);
    const statusSentOf = async (syncJobId: string) =>
      ((await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: syncJobId } })).payload as Record<string, unknown>)[
        'statusSent'
      ];

    // Switched off in Remnawave's UI while a push of ours was queued: the
    // event is withheld, and the push's answer brings it.
    const racing = await subscription(plan);
    const queued = await pushOfOurs(racing, SyncJobStatus.PENDING);
    await panelEvent(racing, 'user.disabled', 'DISABLED', new Date());
    assert.equal((await row(racing)).status, SubscriptionStatus.ACTIVE, 'withheld while our push is on its way');
    await runJob(racing, queued, { patch: 'DISABLED' });
    assert.equal((await row(racing)).status, SubscriptionStatus.DISABLED, 'taken from the answer');

    // A blocked owner: the push itself sends DISABLED, and the row keeps its status.
    const blocked = await subscription(plan);
    await prisma.user.update({ where: { id: blocked.userId }, data: { isBlocked: true } });
    const blockPush = await runPush(blocked, { patch: 'DISABLED' });
    assert.equal((await row(blocked)).status, SubscriptionStatus.ACTIVE, 'never DISABLED from a blocked owner’s answer');
    assert.equal(await statusSentOf(blockPush), 'DISABLED', 'the status the PATCH carried is recorded');

    // The operator switched it off in the panel; an answer of ACTIVE later
    // (switched on in Remnawave during a push) does not undo that.
    const operatorOff = await subscription(plan, { status: SubscriptionStatus.DISABLED });
    const toggle = await runPush(operatorOff, { patch: 'DISABLED' }, { payload: { source: 'ADMIN_MUTATION', propagateStatus: true } });
    assert.equal(await statusSentOf(toggle), 'DISABLED');
    await runPush(operatorOff, { patch: 'ACTIVE' });
    assert.equal((await row(operatorOff)).status, SubscriptionStatus.DISABLED, 'the panel’s own switch-off is kept');

    // A decision made before this release, its value never recorded: kept too.
    const legacyOff = await subscription(plan, { status: SubscriptionStatus.DISABLED });
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: legacyOff.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.COMPLETED,
        completedAt: ago(3_600_000),
        createdAt: ago(3_601_000),
        payload: { source: 'ADMIN_MUTATION', propagateStatus: true },
      },
    });
    await runPush(legacyOff, { patch: 'ACTIVE' });
    assert.equal((await row(legacyOff)).status, SubscriptionStatus.DISABLED, 'an unknown decision counts as the operator’s');

    // Switched off in Remnawave (taken from the event), then back on in
    // Remnawave while a push of ours was on its way: lifted from its answer.
    const remnawaveOff = await subscription(plan);
    await panelEvent(remnawaveOff, 'user.disabled', 'DISABLED', new Date());
    assert.equal((await row(remnawaveOff)).status, SubscriptionStatus.DISABLED, 'nothing of ours is newer: taken');
    await runPush(remnawaveOff, { patch: 'ACTIVE' });
    assert.equal((await row(remnawaveOff)).status, SubscriptionStatus.ACTIVE, 'Remnawave’s DISABLED, Remnawave’s ACTIVE');

    // The operator's last decision was ACTIVE: a later Remnawave-side
    // DISABLED is Remnawave's, and so is the switch-on that lifts it.
    const operatorOn = await subscription(plan);
    const switchOn = await runPush(operatorOn, { patch: 'ACTIVE' }, { payload: { source: 'ADMIN_MUTATION', propagateStatus: true } });
    assert.equal(await statusSentOf(switchOn), 'ACTIVE');
    // Stamped after that push completed: a genuine report, taken.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await panelEvent(operatorOn, 'user.disabled', 'DISABLED', new Date());
    assert.equal((await row(operatorOn)).status, SubscriptionStatus.DISABLED);
    await runPush(operatorOn, { patch: 'ACTIVE' });
    assert.equal((await row(operatorOn)).status, SubscriptionStatus.ACTIVE, 'the panel’s last word was ACTIVE');
  });

  it('S16 while our latest push has FAILED, LIMITED is taken when the traffic used reaches the row’s own limit', async () => {
    const plan = await createPlan(fx, PLAN);
    const used = (gib: number) => ({ userTraffic: { usedTrafficBytes: gib * GIB }, expireAt: at(5).toISOString() });

    const failing = await subscription(plan);
    const expiryBefore = (await row(failing)).expiresAt;
    await pushOfOurs(failing, SyncJobStatus.FAILED);
    await panelEvent(failing, 'user.limited', 'LIMITED', new Date(), used(100));
    const limited = await row(failing);
    assert.equal(limited.status, SubscriptionStatus.LIMITED, '100 GB used of the row’s own 100 GB');
    assert.equal(limited.expiresAt?.getTime(), expiryBefore?.getTime(), 'the expiry stays withheld');
    assert.equal(limitNotices(failing).length, 1, 'and the customer is told once');
    assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED), [], 'everything else stays withheld: no card, no automation');

    // Our unpushed top-up raised the limit to 150: out of traffic only by the
    // limit Remnawave still holds.
    const toppedUp = await subscription(plan);
    await prisma.subscription.update({ where: { id: toppedUp.subscriptionId }, data: { trafficLimit: 150 } });
    await pushOfOurs(toppedUp, SyncJobStatus.FAILED);
    await panelEvent(toppedUp, 'user.limited', 'LIMITED', new Date(), used(100));
    assert.equal((await row(toppedUp)).status, SubscriptionStatus.ACTIVE, 'withheld: our top-up is what failed to land');
    assert.deepEqual(limitNotices(toppedUp), []);

    // A push still on its way: its answer will say it.
    const queued = await subscription(plan);
    await pushOfOurs(queued, SyncJobStatus.PENDING);
    await panelEvent(queued, 'user.limited', 'LIMITED', new Date(), used(100));
    assert.equal((await row(queued)).status, SubscriptionStatus.ACTIVE, 'only a FAILED push');

    // Unlimited traffic proves nothing, and only LIMITED is taken this way.
    const unlimited = await subscription(plan);
    await prisma.subscription.update({ where: { id: unlimited.subscriptionId }, data: { trafficLimit: null } });
    await pushOfOurs(unlimited, SyncJobStatus.FAILED);
    await panelEvent(unlimited, 'user.limited', 'LIMITED', new Date(), used(500));
    assert.equal((await row(unlimited)).status, SubscriptionStatus.ACTIVE);
    const expiring = await subscription(plan);
    await pushOfOurs(expiring, SyncJobStatus.FAILED);
    await panelEvent(expiring, 'user.expired', 'EXPIRED', new Date(), used(100));
    assert.equal((await row(expiring)).status, SubscriptionStatus.ACTIVE, 'EXPIRED stays withheld');
  });

  it('S17 the operator’s «Сбросить» is a push of ours: a user.limited stamped before it does not limit again', async () => {
    const plan = await createPlan(fx, PLAN);
    const resetsOf = (owner: Owner) =>
      prisma.profileSyncJob.findMany({
        where: { subscriptionId: owner.subscriptionId, action: SyncAction.TRAFFIC_RESET },
        select: { status: true, cause: true },
      });

    // Never pushed: without the reset, the late report would be all there is (S3).
    const owner = await subscription(plan);
    assert.deepEqual(await operatorReset(owner, 'ACTIVE'), { reset: true });
    assert.deepEqual(await resetsOf(owner), [{ status: SyncJobStatus.COMPLETED, cause: OPERATOR_TRAFFIC_RESET_CAUSE }]);
    // Remnawave limited the profile a minute ago; the event arrives only now.
    await panelEvent(owner, 'user.limited', 'LIMITED', ago(60_000));
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE, 'the counter it counted is gone');
    assert.deepEqual(limitNotices(owner), [], 'no «трафик закончился» right after the reset');
    assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED), [], 'no card, no automation');
    // The reset carries no expiry of ours: a date Remnawave stated before it is still news.
    const extended = at(40);
    await panelEvent(owner, 'user.modified', 'LIMITED', ago(30_000), { expireAt: extended.toISOString() });
    const modified = await row(owner);
    assert.deepEqual(
      { status: modified.status, expiresAt: modified.expiresAt?.getTime() },
      { status: SubscriptionStatus.ACTIVE, expiresAt: extended.getTime() },
    );
    // Out of traffic again after the reset: a genuine report, taken and told.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await panelEvent(owner, 'user.limited', 'LIMITED', new Date());
    assert.equal((await row(owner)).status, SubscriptionStatus.LIMITED);
    assert.equal(limitNotices(owner).length, 1);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED).length, 1);

    // LIMITED here: Remnawave's answer right after the reset lifts it, and the
    // reset's own report, stamped before we recorded it, is the fact it is.
    const limited = await subscription(plan, { status: SubscriptionStatus.LIMITED });
    await operatorReset(limited, 'ACTIVE');
    assert.equal((await row(limited)).status, SubscriptionStatus.ACTIVE, 'lifted from the answer');
    forwarded.length = 0;
    await panelEvent(limited, 'user.traffic_reset', 'ACTIVE', ago(1_000));
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_TRAFFIC_RESET).length, 1);

    // The read after the reset failed: the counter is zeroed all the same, and
    // the row waits for Remnawave's next word.
    const unread = await subscription(plan, { status: SubscriptionStatus.LIMITED });
    assert.deepEqual(await operatorReset(unread, null), { reset: true });
    assert.equal((await row(unread)).status, SubscriptionStatus.LIMITED);
    assert.equal((await resetsOf(unread)).length, 1, 'recorded all the same');

    // While our latest push has FAILED, a reset since the report outranks the
    // exception of S16 too: the traffic it counted is gone.
    const failing = await subscription(plan);
    await pushOfOurs(failing, SyncJobStatus.FAILED, { createdAt: ago(120_000) });
    await operatorReset(failing, 'ACTIVE');
    await panelEvent(failing, 'user.limited', 'LIMITED', ago(60_000), { userTraffic: { usedTrafficBytes: 100 * GIB } });
    assert.equal((await row(failing)).status, SubscriptionStatus.ACTIVE);
    assert.deepEqual(limitNotices(failing), []);
    // And the record stays out of the subscription's sync state: the card's
    // «Не применилось в панели: …» reads the latest job not superseded
    // (`AdminUserManagementController`), and that is still the push that failed.
    const shownOnCard = await prisma.profileSyncJob.findFirst({
      where: { subscriptionId: failing.subscriptionId, supersededAt: null },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      select: { action: true, status: true },
    });
    assert.deepEqual(shownOnCard, { action: SyncAction.UPDATE, status: SyncJobStatus.FAILED }, 'the failure stays on the card');

    // The answer follows the rule of every push's answer (S15): a switch-off
    // made in Remnawave is taken, a blocked client's DISABLED is the block's.
    const switchedOff = await subscription(plan);
    await operatorReset(switchedOff, 'DISABLED');
    assert.equal((await row(switchedOff)).status, SubscriptionStatus.DISABLED);
    const blocked = await subscription(plan);
    await prisma.user.update({ where: { id: blocked.userId }, data: { isBlocked: true } });
    await operatorReset(blocked, 'DISABLED');
    assert.equal((await row(blocked)).status, SubscriptionStatus.ACTIVE, 'never DISABLED from a blocked owner’s answer');

    // Outside the model: today's behaviour, the answer is not read.
    const outside = await subscription(plan, { outside: true, status: SubscriptionStatus.LIMITED });
    await operatorReset(outside, 'ACTIVE');
    assert.equal((await row(outside)).status, SubscriptionStatus.LIMITED, 'the answer is not read outside the model');
  });

  it('S9 a renewal’s UPDATE resets the counter after its PATCH: the reset’s answer is the fresher one', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { status: SubscriptionStatus.LIMITED });
    await runPush(owner, { patch: 'LIMITED', reset: 'ACTIVE' }, { payload: { source: 'PAYMENT_COMPLETION', resetTraffic: true } });
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE);
  });

  it('S10 a CREATE takes the status of the profile it minted', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { status: SubscriptionStatus.LIMITED, unlinked: true });
    await runPush(owner, { create: 'ACTIVE' }, { action: SyncAction.CREATE });
    const after = await row(owner);
    assert.equal(after.remnawaveId, String(owner.panelId), 'linked');
    assert.equal(after.status, SubscriptionStatus.ACTIVE, 'a fresh profile has passed no traffic');
  });

  // ── Outside the model, and the facts ──────────────────────────────────────

  it('S6 a subscription outside the model keeps today’s behaviour: the late event mirrors, the answer is not read', async () => {
    const plan = await createPlan(fx, PLAN);
    const renewed = await subscription(plan, { outside: true });
    await runPush(renewed, { patch: 'ACTIVE' });
    const old = at(-1);
    await panelEvent(renewed, 'user.expired', 'EXPIRED', ago(60_000), { expireAt: old.toISOString() });
    const mirrored = await row(renewed);
    assert.deepEqual(
      { status: mirrored.status, expiresAt: mirrored.expiresAt?.getTime() },
      { status: SubscriptionStatus.EXPIRED, expiresAt: old.getTime() },
    );
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED).length, 1);

    const limited = await subscription(plan, { outside: true, status: SubscriptionStatus.LIMITED });
    await runPush(limited, { patch: 'ACTIVE' });
    assert.equal((await row(limited)).status, SubscriptionStatus.LIMITED, 'the answer is not read outside the model');
  });

  it('S7 facts are forwarded whatever their age; a pair with a row outside the model forwards as before', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, { completedAt: new Date() });
    // The reset our renewal made, and a first connection, both reported late.
    await panelEvent(owner, 'user.traffic_reset', 'ACTIVE', ago(60_000));
    await panelEvent(owner, 'user.first_connected', 'ACTIVE', ago(60_000));
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_TRAFFIC_RESET).length, 1);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_FIRST_CONNECTED).length, 1);

    const inside = await subscription(plan);
    const outside = await subscription(plan, { outside: true, panelId: inside.panelId });
    await pushOfOurs(inside, SyncJobStatus.COMPLETED, { completedAt: new Date() });
    await panelEvent(inside, 'user.expired', 'EXPIRED', ago(60_000), { expireAt: at(-1).toISOString() });
    assert.equal((await row(inside)).status, SubscriptionStatus.ACTIVE, 'the row in the model is outranked');
    assert.equal((await row(outside)).status, SubscriptionStatus.EXPIRED, 'the one outside mirrors');
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED).length, 1, 'the event reached a row: forwarded');

    // Both rows in the model, only one of them outranked: the event reaches the other.
    const pushed = await subscription(plan);
    const neverPushed = await subscription(plan, { panelId: pushed.panelId });
    await pushOfOurs(pushed, SyncJobStatus.COMPLETED, { completedAt: new Date() });
    forwarded.length = 0;
    await panelEvent(pushed, 'user.expired', 'EXPIRED', ago(60_000), { expireAt: at(-1).toISOString() });
    assert.equal((await row(pushed)).status, SubscriptionStatus.ACTIVE);
    assert.equal((await row(neverPushed)).status, SubscriptionStatus.EXPIRED);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED).length, 1, 'reached a row: forwarded');

    // A profile no subscription names: forwarded as before, nothing withheld.
    forwarded.length = 0;
    await panelEvent({ userId: 'nobody', subscriptionId: 'none', panelId: PANEL_BASE - 1 }, 'user.expired', 'EXPIRED', ago(60_000));
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED).length, 1);
  });

  it('S13 an answer racing a transaction that queues a newer push waits for it, and then yields to it', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    const older = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.RUNNING,
        createdAt: ago(60_000),
        payload: { source: 'ADMIN_MUTATION' },
      },
      select: { id: true, subscriptionId: true, createdAt: true },
    });
    // A top-up in flight: its row write is made (the row is locked) and its
    // push recorded, not yet committed.
    let commit: () => void = () => undefined;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    let written: () => void = () => undefined;
    const writtenOnce = new Promise<void>((resolve) => (written = resolve));
    const topUp = prisma.$transaction(
      async (tx) => {
        await tx.subscription.update({ where: { id: owner.subscriptionId }, data: { trafficLimit: 150 } });
        await tx.profileSyncJob.create({
          data: { subscriptionId: owner.subscriptionId, action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, payload: {} },
        });
        written();
        await committed;
      },
      { timeout: 20_000 },
    );
    await writtenOnce;
    // The older push's answer — LIMITED, from before the top-up — arrives now.
    const answer = takePanelAnswerStatus(prisma, {
      job: older,
      answer: SubscriptionStatus.LIMITED,
      now: new Date(),
      push: { sent: null, ownerBlocked: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    commit();
    await topUp;
    assert.equal(await answer, null, 'the top-up’s push is newer: this answer is not taken');
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE);
  });

  // ── The other read-backs ──────────────────────────────────────────────────

  it('S12 «Импорт из Remnawave» leaves the status alone while a push of ours is on its way', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    await pushOfOurs(owner, SyncJobStatus.PENDING);
    const panelUser = {
      ...profile(owner, 'EXPIRED'),
      uuid: String(owner.panelId),
      panelId: owner.panelId,
      telegramId: null,
      email: null,
      lastTrafficResetAt: null,
      trafficLimitStrategy: 'NO_RESET',
      tag: null,
      description: `reiwa_id: ${owner.userId}`,
      activeInternalSquads: [],
      externalSquadUuid: null,
    } as unknown as RemnawavePanelUser;
    const importer = new RemnawaveImporterService(prisma, {
      strictGetAllPanelUsers: async () => ({ kind: 'ok' as const, value: { users: [panelUser], total: 1, complete: true } }),
      getPanelUser: async () => panelUser,
      strictGetPanelUserExpiry: async () => ({ kind: 'ok' as const, value: null }),
      updatePanelUser: async () => ({}),
    } as never);
    const record = await prisma.importRecord.create({
      data: { filename: `${fx.prefix}-remnawave.json`, sourceType: 'remnawave' },
      select: { id: true },
    });
    const summary = await importer.run({ mode: 'sync', createdBy: null, importRecordId: record.id });
    assert.deepEqual(summary.errors, []);
    assert.equal((await row(owner)).status, SubscriptionStatus.ACTIVE, 'the status is withheld with the expiry');
  });
});
