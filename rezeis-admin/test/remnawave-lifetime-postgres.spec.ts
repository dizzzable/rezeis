import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import {
  ExpiredProfileCleanupService,
  PANEL_NO_END_REASSERT_CAUSE,
} from '../src/modules/profile-sync/expired-profile-cleanup.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { PANEL_NO_END_EXPIRE_AT } from '../src/modules/remnawave/services/panel-expiry';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { at, createPlan, newUser, termModelFixtures, type Limits, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * A SUBSCRIPTION WITH NO END DATE (`expiresAt = null`, a plan bought for ever)
 * against Remnawave — R1-01, the four defects of R1's probe turned around
 * (L1–L4), through the real webhook handler, the real processor, the real
 * importers and the real cleanup; only Remnawave is a double.
 *
 * "No end" goes to the panel as 31.12.2099 and reads back as `null`
 * (`panel-expiry.ts`); a row with no end takes no date from a read, nor an
 * EXPIRED derived from one; and a one-off UPDATE carries "no end" into
 * profiles an older build created with thirty days.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const GIB = 1024 ** 3;
/** A panel-id range no other spec uses, so an event names only our rows. */
const PANEL_BASE = 1_300_000_000 + (Date.now() % 2_000_000) * 100;
const TELEGRAM_BASE = 7_300_000_000 + (Date.now() % 1_000_000) * 50;
const SOURCE_IP = `w4-lifetime-${process.pid}`;

let prisma: PrismaService;
let fx: TermModelFixtures;
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
let webhook: RemnawaveWebhookService;
const forwarded: Array<{ readonly type: string; readonly metadata?: Record<string, unknown> }> = [];
const notices: Array<{ readonly userId: string; readonly type: string }> = [];
/** The processor's own events (the «Подписка создана» card). */
const processorEvents: Array<{ readonly type: string; readonly metadata?: Record<string, unknown> }> = [];

type Owner = {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly panelId: number;
  readonly telegramId: bigint;
};

/** A linked subscription with no end on a 3 / 100 GB plan, in the model unless `outside`. */
async function subscription(
  planId: string,
  options: {
    readonly expiresAt?: Date | null;
    readonly status?: SubscriptionStatus;
    readonly outside?: boolean;
    readonly unlinked?: boolean;
    readonly panelId?: number;
    readonly identity?: (panelId: number) => string;
    readonly createdAt?: Date;
  } = {},
): Promise<Owner> {
  const telegramId = BigInt(TELEGRAM_BASE + fx.next());
  const userId = await newUser(fx, { telegramId });
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
        selectedDurationDays: -1,
      },
      trafficLimit: PLAN.trafficLimit,
      deviceLimit: PLAN.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: options.unlinked === true ? null : (options.identity ?? String)(panelId),
      remnawavePanelId: options.unlinked === true ? null : panelId,
      createdAt: options.createdAt ?? at(-40),
      startedAt: at(-40),
      // The cutover mints the term from a dated row; the date goes after it.
      expiresAt: at(20),
    },
    select: { id: true },
  });
  const owner = { userId, subscriptionId: row.id, panelId, telegramId };
  if (options.outside !== true) {
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, owner.subscriptionId));
    assert.equal(entered.outcome, 'CREATED');
  }
  await prisma.subscription.update({
    where: { id: owner.subscriptionId },
    data: {
      expiresAt: options.expiresAt === undefined ? null : options.expiresAt,
      ...(options.status === undefined ? {} : { status: options.status }),
    },
  });
  return owner;
}

async function pushOfOurs(owner: Owner, status: SyncJobStatus, completedAt: Date | null = null): Promise<void> {
  await prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: SyncAction.UPDATE,
      status,
      completedAt,
      createdAt: completedAt === null ? new Date() : new Date(completedAt.getTime() - 1_000),
      payload: { source: 'ADMIN_MUTATION' },
    },
  });
}

/** The profile as a 3.x panel serves it. */
function profile(owner: Owner, status: string, expireAt: Date | string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: owner.panelId,
    username: `rwlt-${owner.panelId}`,
    status,
    subscriptionUrl: `https://panel.example/sub/${owner.panelId}`,
    description: `reiwa_id: ${owner.userId}`,
    expireAt: typeof expireAt === 'string' ? expireAt : expireAt.toISOString(),
    createdAt: at(-40).toISOString(),
    trafficLimitBytes: PLAN.trafficLimit! * GIB,
    hwidDeviceLimit: PLAN.deviceLimit,
    ...extra,
  };
}

/** A `user.*` webhook through the real handler, stamped at `stampedAt`. */
async function panelEvent(
  owner: Owner,
  event: string,
  status: string,
  expireAt: Date | string,
  stampedAt = new Date(),
  extra: Record<string, unknown> = {},
): Promise<void> {
  await webhook.handleEvent(
    event,
    { scope: 'user', event, timestamp: stampedAt.toISOString(), data: profile(owner, status, expireAt, extra), meta: {} },
    SOURCE_IP,
  );
}

/** The real processor over a Remnawave double; records the bodies it sent. */
function processorFor(owner: Owner, sent: Array<Record<string, unknown>>): ProfileSyncProcessor {
  const answer = (body: Record<string, unknown>) => ({
    kind: 'ok' as const,
    data: { response: profile(owner, 'ACTIVE', String(body['expireAt'] ?? PANEL_NO_END_EXPIRE_AT)) },
  });
  const missing = { kind: 'rejected' as const, status: 404, code: 'A063', detail: 'User not found' };
  const panel = {
    createUser: async (body: Record<string, unknown>) => (sent.push({ create: true, ...body }), answer(body)),
    updateUser: async (body: Record<string, unknown>) => (sent.push(body), answer(body)),
    resetTraffic: async () => answer({}),
    getUserById: async () => answer({}),
    getUserByUsername: async () => missing,
    resolveUser: async () => missing,
  };
  return new ProfileSyncProcessor(
    prisma,
    panel as never,
    {
      generateProfileName: async () => ({ username: `rwlt-${owner.panelId}`, description: `reiwa_id: ${owner.userId}` }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    {
      error: () => undefined,
      warn: () => undefined,
      emit: () => undefined,
      info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) =>
        void processorEvents.push({ type, metadata }),
    } as never,
    undefined,
    undefined,
    webhook,
  );
}

async function runJob(owner: Owner, syncJobId: string, sent: Array<Record<string, unknown>> = []): Promise<void> {
  await processorFor(owner, sent).process({ data: { syncJobId } } as never);
  const done = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: syncJobId } });
  assert.equal(done.status, SyncJobStatus.COMPLETED, `the push completed (${done.lastError ?? ''})`);
}

async function row(owner: Owner) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: owner.subscriptionId },
    select: { status: true, expiresAt: true, remnawaveId: true },
  });
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const cards = (type: string) => forwarded.filter((event) => event.type === type);

/** A Remnawave double for the importers, serving `profiles`. */
function panelDouble(profiles: readonly RemnawavePanelUser[]) {
  const byId = new Map(profiles.map((entry) => [entry.uuid, entry]));
  return {
    strictGetAllPanelUsers: async () => ({ kind: 'ok' as const, value: { users: [...profiles], total: profiles.length, complete: true } }),
    getPanelUser: async (id: string) => byId.get(id) ?? null,
    strictGetPanelUserExpiry: async (id: string) =>
      byId.has(id) ? { kind: 'ok' as const, value: null } : { kind: 'notFound' as const },
    updatePanelUser: async () => ({}),
  };
}

/** A decoded panel row, as `RemnawaveApiService` hands one to the importers. */
function panelUserOf(owner: Owner, status: string, expireAt: string, identity = String(owner.panelId)): RemnawavePanelUser {
  return {
    uuid: identity,
    username: `rwlt-${owner.panelId}`,
    status,
    subscriptionUrl: `https://panel.example/sub/${owner.panelId}`,
    telegramId: Number(owner.telegramId),
    panelId: owner.panelId,
    email: null,
    expireAt,
    createdAt: at(-40).toISOString(),
    lastTrafficResetAt: null,
    trafficLimitBytes: PLAN.trafficLimit! * GIB,
    hwidDeviceLimit: PLAN.deviceLimit,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: `reiwa_id: ${owner.userId}`,
    activeInternalSquads: [],
    externalSquadUuid: null,
  } as RemnawavePanelUser;
}

run('a subscription with no end date against Remnawave (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    process.env['ADDON_PROJECTION_SYNC'] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rwlt-${process.pid}-${Date.now()}`);
    const bus = {
      emit: (event: { type: string; metadata?: Record<string, unknown> }) => void forwarded.push(event),
      info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) =>
        void forwarded.push({ type, metadata }),
      warn: () => undefined,
      error: () => undefined,
    };
    webhook = new RemnawaveWebhookService(
      prisma,
      { webhookSecret: null } as never,
      bus as never,
      { getPanelUserUsage: async () => null } as never,
      { build: async (subscription: { id: string }) => ({ subscriptionId: subscription.id }) } as never,
      { create: async (input: { userId: string; type: string }) => void notices.push(input) } as never,
      { get: () => ({ enqueue: async () => undefined }) } as never,
    );
  });

  beforeEach(() => {
    forwarded.length = 0;
    notices.length = 0;
    processorEvents.length = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.remnawaveWebhookEvent.deleteMany({ where: { sourceIp: SOURCE_IP } }).catch(() => undefined);
    await prisma.profileSyncJob
      .deleteMany({ where: { subscription: { userId: { in: fx.users } } } })
      .catch(() => undefined);
    await prisma.trialClaim.deleteMany({ where: { userId: { in: fx.users } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { filename: { startsWith: fx.prefix } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── R1's four defects, turned around ──────────────────────────────────────

  it('L1 outside the model, the echo of our own push dates nothing, and "no end" reads as none', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { outside: true });
    await panelEvent(owner, 'user.modified', 'ACTIVE', at(30));
    assert.equal((await row(owner)).expiresAt, null, 'the thirty days an older CREATE gave the profile');
    await panelEvent(owner, 'user.modified', 'ACTIVE', PANEL_NO_END_EXPIRE_AT);
    assert.equal((await row(owner)).expiresAt, null);

    // A dated row whose profile was set «до 2099 года» in Remnawave: no end.
    const dated = await subscription(plan, { outside: true, expiresAt: at(20) });
    await panelEvent(dated, 'user.modified', 'ACTIVE', '2099-09-24T17:05:00.000+03:00');
    assert.equal((await row(dated)).expiresAt, null);
  });

  it('L2 in the model, the first genuine event after our push dates nothing; its fact is still forwarded', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan);
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(600_000));
    await panelEvent(owner, 'user.first_connected', 'ACTIVE', at(20));
    assert.equal((await row(owner)).expiresAt, null);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_FIRST_CONNECTED).length, 1);

    // The same "no end" makes a dated row in the model open-ended — unless a
    // push of ours outranks the read.
    const dated = await subscription(plan, { expiresAt: at(20) });
    await panelEvent(dated, 'user.modified', 'ACTIVE', PANEL_NO_END_EXPIRE_AT);
    assert.equal((await row(dated)).expiresAt, null);
    const outranked = await subscription(plan, { expiresAt: at(20) });
    await pushOfOurs(outranked, SyncJobStatus.PENDING);
    await panelEvent(outranked, 'user.modified', 'ACTIVE', PANEL_NO_END_EXPIRE_AT);
    assert.notEqual((await row(outranked)).expiresAt, null, 'our push is on its way: nothing taken');
  });

  it('L3 Remnawave expiring the old thirty-day profile neither dates nor expires the row, and tells nobody', async () => {
    const plan = await createPlan(fx, PLAN);
    for (const outside of [false, true]) {
      forwarded.length = 0;
      const owner = await subscription(plan, { outside });
      await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(31 * 86_400_000));
      await panelEvent(owner, 'user.expired', 'EXPIRED', at(-1));
      assert.deepEqual(await row(owner).then((r) => ({ status: r.status, expiresAt: r.expiresAt })), {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
      }, outside ? 'outside the model' : 'in the model');
      assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRED), [], 'no «Подписка закончилась — Продлить» for a plan bought for ever');
      await panelEvent(owner, 'user.expires_in_24_hours', 'ACTIVE', at(1));
      assert.deepEqual(cards(EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON), [], 'nor «скоро истекает»');
    }

    // LIMITED says nothing about the date: taken, told and forwarded as always.
    const limited = await subscription(plan);
    await panelEvent(limited, 'user.limited', 'LIMITED', at(-1));
    assert.deepEqual(await row(limited).then((r) => ({ status: r.status, expiresAt: r.expiresAt })), {
      status: SubscriptionStatus.LIMITED,
      expiresAt: null,
    });
    assert.equal(notices.filter((n) => n.userId === limited.userId && n.type === 'limited').length, 1);
    assert.equal(cards(EVENT_TYPES.REMNAWAVE_USER_LIMITED).length, 1);
  });

  it('L4 CREATE and UPDATE send "no end" as 31.12.2099; the card shows no date', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { unlinked: true });
    const sent: Array<Record<string, unknown>> = [];
    const create = await prisma.profileSyncJob.create({
      data: { subscriptionId: owner.subscriptionId, action: SyncAction.CREATE, status: SyncJobStatus.PENDING, payload: { source: 'PAYMENT_COMPLETION' } },
      select: { id: true },
    });
    await runJob(owner, create.id, sent);
    assert.equal(sent[0]?.['expireAt'], PANEL_NO_END_EXPIRE_AT, 'CREATE');
    const created = processorEvents.find((event) => event.type === EVENT_TYPES.SUBSCRIPTION_CREATED);
    assert.ok(created !== undefined, 'the «Подписка создана» card went out');
    assert.equal('expireAt' in (created.metadata ?? {}), false, 'with no «Действует до»');

    const update = await prisma.profileSyncJob.create({
      data: { subscriptionId: owner.subscriptionId, action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, payload: { source: 'ADMIN_MUTATION' } },
      select: { id: true },
    });
    await runJob(owner, update.id, sent);
    assert.equal(sent[1]?.['expireAt'], PANEL_NO_END_EXPIRE_AT, 'UPDATE');
    assert.equal((await row(owner)).expiresAt, null);
  });

  it('outside the model, a row with no end beside a dated duplicate takes nothing from a dated event, its snapshot included', async () => {
    // The webhook writes a row with no end apart only when the dated statement
    // reached no row (one write on the hot path); the pair is the price.
    const plan = await createPlan(fx, PLAN);
    const lifetime = await subscription(plan, { outside: true });
    const dated = await subscription(plan, { outside: true, expiresAt: at(20), panelId: lifetime.panelId });
    const moved = at(30);
    await panelEvent(lifetime, 'user.modified', 'ACTIVE', moved, new Date(), { trafficLimitBytes: 200 * GIB });
    const read = async (owner: Owner) => {
      const found = await prisma.subscription.findUniqueOrThrow({
        where: { id: owner.subscriptionId },
        select: { expiresAt: true, trafficLimit: true, planSnapshot: true },
      });
      return {
        expiresAt: found.expiresAt?.getTime() ?? null,
        trafficLimit: found.trafficLimit,
        snapshotTraffic: (found.planSnapshot as Record<string, unknown>)['trafficLimit'],
      };
    };
    assert.deepEqual(await read(dated), { expiresAt: moved.getTime(), trafficLimit: 200, snapshotTraffic: 200 }, 'mirrored as always');
    assert.deepEqual(await read(lifetime), { expiresAt: null, trafficLimit: PLAN.trafficLimit, snapshotTraffic: PLAN.trafficLimit });
  });

  // ── The other read-backs ──────────────────────────────────────────────────

  it('«Импорт из Remnawave» keeps a row with no end open, in the model and outside it, and creates one from 2099', async () => {
    const plan = await createPlan(fx, PLAN);
    const inside = await subscription(plan);
    const outside = await subscription(plan, { outside: true });
    const thirtyDaysGone = at(-1).toISOString();
    const importer = new RemnawaveImporterService(
      prisma,
      panelDouble([panelUserOf(inside, 'EXPIRED', thirtyDaysGone), panelUserOf(outside, 'EXPIRED', thirtyDaysGone)]) as never,
    );
    const record = await prisma.importRecord.create({ data: { filename: `${fx.prefix}-rw.json`, sourceType: 'remnawave' }, select: { id: true } });
    assert.deepEqual((await importer.run({ mode: 'sync', createdBy: null, importRecordId: record.id })).errors, []);
    for (const [name, owner] of [['in the model', inside], ['outside it', outside]] as const) {
      assert.deepEqual(await row(owner).then((r) => ({ status: r.status, expiresAt: r.expiresAt })), {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
      }, name);
    }

    // A profile the panel has not seen before, dated 2099: imported with no end.
    const userId = await newUser(fx, { telegramId: BigInt(TELEGRAM_BASE + fx.next()) });
    const fresh = { userId, subscriptionId: '', panelId: PANEL_BASE + fx.next(), telegramId: BigInt(TELEGRAM_BASE + fx.next()) };
    const newcomer = new RemnawaveImporterService(prisma, panelDouble([panelUserOf(fresh, 'ACTIVE', PANEL_NO_END_EXPIRE_AT)]) as never);
    const record2 = await prisma.importRecord.create({ data: { filename: `${fx.prefix}-rw2.json`, sourceType: 'remnawave' }, select: { id: true } });
    assert.deepEqual((await newcomer.run({ mode: 'sync', createdBy: null, importRecordId: record2.id })).errors, []);
    const created = await prisma.subscription.findFirstOrThrow({ where: { remnawavePanelId: fresh.panelId }, select: { expiresAt: true, userId: true } });
    if (!fx.users.includes(created.userId)) fx.users.push(created.userId);
    assert.equal(created.expiresAt, null);
  });

  it('a backup re-import keeps a row with no end open in the model: the rule reads the row’s own expiry', async () => {
    const plan = await createPlan(fx, PLAN);
    const uuidOf = (panelId: number) => `${String(panelId).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const owner = await subscription(plan, { identity: uuidOf });
    const importer = new RemnashopImporterService(
      prisma,
      panelDouble([panelUserOf(owner, 'EXPIRED', at(-1).toISOString(), uuidOf(owner.panelId))]) as never,
    );
    const record = await prisma.importRecord.create({ data: { filename: `${fx.prefix}-rs.json`, sourceType: 'remnashop' }, select: { id: true } });
    const donorId = fx.next();
    const result = await importer.run({
      mode: 'sync',
      createdBy: null,
      importRecordId: record.id,
      users: [
        {
          id: donorId, telegram_id: Number(owner.telegramId), username: null, referral_code: null, name: null, role: 1,
          language: 'ru', personal_discount: 0, purchase_discount: 0, points: 0, is_blocked: false, is_bot_blocked: false,
          is_rules_accepted: true, is_trial_available: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      subscriptions: [
        {
          id: donorId, user_remna_id: uuidOf(owner.panelId), user_telegram_id: Number(owner.telegramId), status: 'ACTIVE',
          is_trial: false, traffic_limit: 100, device_limit: 3, traffic_limit_strategy: null, tag: null, internal_squads: [],
          external_squad: null, expire_at: '2027-01-01T00:00:00Z', url: 'https://old-panel.example/sub', plan_snapshot: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    } as never);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(await row(owner).then((r) => ({ status: r.status, expiresAt: r.expiresAt })), {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
    });
  });

  it('the expired-profile cleanup heals a row whose profile has no end to no end, and revives it', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await subscription(plan, { expiresAt: at(-10), status: SubscriptionStatus.EXPIRED, outside: true });
    const unreachable = { kind: 'network' as const, detail: 'not this case’s profile' };
    const cleanup = new ExpiredProfileCleanupService(
      prisma,
      { info: () => undefined, warn: () => undefined } as never,
      {} as never,
      {
        resolveUser: async () => unreachable,
        getUserById: async (userId: number) =>
          userId === owner.panelId
            ? { kind: 'ok' as const, data: { response: profile(owner, 'ACTIVE', PANEL_NO_END_EXPIRE_AT) } }
            : unreachable,
      } as never,
      { deleteExpiredIfUnchanged: async () => ({ deleted: false }) } as never,
    );
    await (cleanup as unknown as { enqueueProfileDeletions(cutoff: Date): Promise<number> }).enqueueProfileDeletions(at(-3));
    assert.deepEqual(await row(owner).then((r) => ({ status: r.status, expiresAt: r.expiresAt })), {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
    });
  });

  // ── The one-off re-push ───────────────────────────────────────────────────

  it('queues one "no end" UPDATE per live linked row with no end, never twice, and the push carries 31.12.2099', async () => {
    const plan = await createPlan(fx, PLAN);
    const inside = await subscription(plan);
    const outside = await subscription(plan, { outside: true });
    // Its profile passed its thirty days long ago: its customer is cut off now.
    const oldest = await subscription(plan, { createdAt: new Date('2000-01-01T00:00:00.000Z') });
    const unlinked = await subscription(plan, { unlinked: true });
    const deleted = await subscription(plan, { status: SubscriptionStatus.DELETED });
    const dated = await subscription(plan, { expiresAt: at(20) });
    const enqueued: string[] = [];
    const cleanup = new ExpiredProfileCleanupService(
      prisma,
      { info: () => undefined, warn: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: async (syncJobId: string) => void enqueued.push(syncJobId) } as never,
    );
    const markers = async (owner: Owner) =>
      prisma.profileSyncJob.findMany({ where: { subscriptionId: owner.subscriptionId, cause: PANEL_NO_END_REASSERT_CAUSE } });
    // One at a time, oldest first, then the rest: a pass takes no more than its batch.
    assert.equal(await cleanup.reassertPanelNoEnd(1), 1);
    assert.equal((await markers(oldest)).length, 1, 'the oldest first');
    assert.deepEqual(await markers(inside), [], 'and only it');
    while ((await cleanup.reassertPanelNoEnd(50)) > 0) {
      // Other specs' rows may be in the book too; drain it.
    }
    for (const owner of [inside, outside]) {
      const jobs = await markers(owner);
      assert.equal(jobs.length, 1, 'one UPDATE for a linked row with no end');
      assert.equal(jobs[0]!.action, SyncAction.UPDATE);
      assert.deepEqual(jobs[0]!.payload, { source: PANEL_NO_END_REASSERT_CAUSE }, 'no status is pushed with it');
      assert.ok(enqueued.includes(jobs[0]!.id), 'and it is queued at once');
    }
    for (const owner of [unlinked, deleted, dated]) {
      assert.deepEqual(await markers(owner), [], 'nothing for an unlinked, a deleted or a dated row');
    }
    assert.equal(await cleanup.reassertPanelNoEnd(), 0, 'never twice');

    const sent: Array<Record<string, unknown>> = [];
    await runJob(inside, (await markers(inside))[0]!.id, sent);
    assert.equal(sent[0]?.['expireAt'], PANEL_NO_END_EXPIRE_AT);
    assert.equal('status' in (sent[0] ?? {}), false);
  });
});
