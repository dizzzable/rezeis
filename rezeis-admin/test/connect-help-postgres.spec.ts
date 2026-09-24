import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import {
  CONNECT_HELP_LAST_RESULT_KEY,
  CONNECT_HELP_MAX_FAILURES,
} from '../src/modules/connect-help/connect-help.constants';
import { connectHelpCandidatesSql, type ConnectHelpCandidateRow } from '../src/modules/connect-help/connect-help.sql';
import {
  ConnectHelpSweepService,
  type ConnectHelpCycleResult,
} from '../src/modules/connect-help/services/connect-help-sweep.service';
import { ConnectHelpSettingsService } from '../src/modules/connect-help/services/connect-help-settings.service';
import { ConnectHelpStatusService } from '../src/modules/connect-help/services/connect-help-status.service';
import type { ConnectSignalState } from '../src/modules/connect-signal/services/connect-signal-health.service';
import { ConnectSignalProbeService } from '../src/modules/connect-signal/services/connect-signal-probe.service';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { NotificationTemplatesService } from '../src/modules/notifications/services/notification-templates.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { ensureSettingsRow } from '../src/modules/settings/utils/settings-row-write.util';

/**
 * «Помощь с подключением» — THE SENDER, END TO END, ON REAL ROWS.
 *
 * Everything below the panel adapter is real: the candidate query and the
 * bucket definitions it composes, the probe's own `recheck` and the writes it
 * makes, the claim, the per-person lock, the ladder in `UserNotificationsService`
 * with the real template table and the real feed rows, and the real
 * `BotNotifierClient` behind a stubbed `fetch`. What is scripted: the panel's
 * answer per profile, the push service's answer per customer, the signal's
 * state, and SMTP (off, as on the owner's production — the ladder spec proves
 * the e-mail rung).
 *
 * Assertions are on ROWS and EMITTED EVENTS — the state row, the feed rows, the
 * bot calls, the events — never on the cycle's return value alone.
 *
 * ISOLATION. CI runs every PostgreSQL spec on one shared database, and the
 * sender reads every eligible row of it. So each case runs at its own "now"
 * years ahead, a month apart from the next: only this file's rows, dated
 * relative to that "now", fall inside a window. The settings row and the two
 * templates this file changes are put back as they were.
 *
 * Run it on a database whose `TimeZone` is not UTC as well as on a UTC one: a
 * statement comparing stored times with SQL `now()` would be off by the zone's
 * offset there, and the window cases below sit within an hour of its edges.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `chelp-${process.pid}-${Date.now()}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A "now" no other spec's rows can reach; case `k` runs a month after case `k - 1`. */
const BASE_NOW = new Date(Date.now() + 1234 * DAY);
const nowFor = (k: number): Date => new Date(BASE_NOW.getTime() + k * 30 * DAY);

let prisma: PrismaService;
let seq = 0;
let nextPanelId = 1_700_000_000 + (process.pid % 10_000) * 1_000 + (Date.now() % 997);
let nextTelegramId = 7_100_000_000_000n + BigInt(process.pid % 100_000) * 100_000n + BigInt(Date.now() % 9_973);

function key(label: string): string {
  seq += 1;
  return `${prefix}-${label}-${seq}`;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Customer {
  readonly id: string;
  readonly telegramId: bigint | null;
}

async function insertUser(options: {
  readonly blocked?: boolean;
  readonly telegram?: boolean;
  readonly prefs?: Record<string, unknown>;
} = {}): Promise<Customer> {
  const id = key('user');
  nextTelegramId += 1n;
  const telegramId = options.telegram === false ? null : nextTelegramId;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "telegram_id", "name", "language", "is_blocked",
                         "notification_prefs", "updated_at")
    VALUES (${id}, ${`${id}-ref`}, ${telegramId}, 'Анна', 'RU'::"Locale", ${options.blocked ?? false},
            ${options.prefs === undefined ? null : JSON.stringify(options.prefs)}::jsonb, ${new Date()})
  `);
  return { id, telegramId };
}

async function insertSubscription(
  owner: Customer,
  input: {
    readonly createdAt: Date;
    readonly status?: 'ACTIVE' | 'LIMITED' | 'EXPIRED';
    readonly isTrial?: boolean;
    readonly snapshot?: Record<string, unknown>;
  },
): Promise<string> {
  const id = key('sub');
  nextPanelId += 1;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscriptions" ("id", "user_id", "status", "is_trial", "plan_snapshot", "remnawave_id",
                                 "created_at", "updated_at")
    VALUES (${id}, ${owner.id}, ${input.status ?? 'ACTIVE'}::"SubscriptionStatus", ${input.isTrial ?? false},
            ${JSON.stringify(input.snapshot ?? { name: 'Премиум' })}::jsonb, ${String(nextPanelId)},
            ${input.createdAt}, ${input.createdAt})
  `);
  return id;
}

async function insertPayment(
  owner: Customer,
  input: {
    readonly subscriptionId: string;
    readonly createdAt: Date;
    readonly purchaseType?: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
    readonly amount?: number;
    readonly gateway?: 'PLATEGA' | 'PARTNER_BALANCE';
    readonly status?: 'COMPLETED' | 'CANCELED';
  },
): Promise<string> {
  const id = key('tx');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type", "gateway_type", "currency",
       "amount", "plan_snapshot", "fulfilled_at", "created_at", "updated_at")
    VALUES (${id}, ${`${id}-pay`}, ${owner.id}, ${input.subscriptionId},
            ${input.status ?? 'COMPLETED'}::"TransactionStatus", ${input.purchaseType ?? 'NEW'}::"PurchaseType",
            ${input.gateway ?? 'PLATEGA'}::"PaymentGatewayType", 'RUB'::"Currency", ${input.amount ?? 499},
            '{}'::jsonb, ${input.createdAt}, ${input.createdAt}, ${input.createdAt})
  `);
  return id;
}

/** A customer with one subscription bought (fulfilled) `hoursAgo` before `now`. */
async function paidCustomer(
  now: Date,
  hoursAgo: number,
  options: { readonly user?: Parameters<typeof insertUser>[0]; readonly owner?: Customer } = {},
): Promise<{ readonly owner: Customer; readonly subscriptionId: string; readonly paymentId: string }> {
  const owner = options.owner ?? (await insertUser(options.user));
  const at = new Date(now.getTime() - hoursAgo * HOUR);
  const subscriptionId = await insertSubscription(owner, { createdAt: at });
  const paymentId = await insertPayment(owner, { subscriptionId, createdAt: at });
  return { owner, subscriptionId, paymentId };
}

interface StateRow {
  readonly help_decided_at: Date | null;
  readonly help_kind: string | null;
  readonly help_anchor_at: Date | null;
  readonly help_source: string | null;
  readonly help_outcome: string | null;
  readonly help_attempts: unknown;
  readonly help_deferrals: number;
  readonly help_event_id: string | null;
  readonly first_connected_at: Date | null;
}

async function stateOf(subscriptionId: string): Promise<StateRow | null> {
  const rows = await prisma.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT "help_decided_at", "help_kind", "help_anchor_at", "help_source", "help_outcome", "help_attempts",
           "help_deferrals", "help_event_id", "first_connected_at"
      FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}
  `);
  return rows[0] ?? null;
}

/** The steps on the row as `channel:result` — without the sender's failure entries, which carry no channel. */
function stepsOf(state: StateRow | null): string[] {
  const entries = Array.isArray(state?.help_attempts) ? (state.help_attempts as Array<Record<string, unknown>>) : [];
  return entries
    .filter((entry) => typeof entry['channel'] === 'string')
    .map((entry) => `${String(entry['channel'])}:${String(entry['result'])}`);
}

function failuresOf(state: StateRow | null): number {
  const entries = Array.isArray(state?.help_attempts) ? (state.help_attempts as Array<Record<string, unknown>>) : [];
  return entries.filter((entry) => typeof entry['error'] === 'string').length;
}

interface FeedRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

async function feedRowsOf(userId: string): Promise<FeedRow[]> {
  return prisma.$queryRaw<FeedRow[]>(Prisma.sql`
    SELECT "id", "type", "payload" FROM "user_notification_events" WHERE "user_id" = ${userId} ORDER BY "created_at"
  `);
}

async function setSettings(value: Record<string, unknown>): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`UPDATE "settings" SET "connect_help_settings" = ${JSON.stringify(value)}::jsonb`);
}

async function setTemplateActive(type: string, isActive: boolean): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`UPDATE "notification_templates" SET "is_active" = ${isActive} WHERE "type" = ${type}`);
}

// ── the world around the sender ─────────────────────────────────────────────

type PanelAnswer = 'not_connected' | 'connected' | 'missing' | 'unavailable';

interface World {
  /** The panel's answer per subscription; absent = not connected. */
  readonly panel: Map<string, PanelAnswer>;
  /** Called on every panel read, before it answers — the race barrier and the "fresh look" hook. */
  onRead: ((subscriptionId: string) => Promise<void>) | null;
  readonly panelReads: string[];
  /** The bot's HTTP answer per Telegram id; absent = Telegram's message id (delivered). */
  readonly bot: Map<string, 'confirmed' | 'unconfirmed' | 'dropped'>;
  readonly botCalls: Array<{ readonly telegramId: string; readonly eventId: string }>;
  /** The push service's answer per customer; absent = no browser bound. */
  readonly push: Map<string, { attempted: number; delivered: number }>;
  readonly pushCalls: Array<{ readonly userId: string; readonly url: string }>;
  readonly events: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }>;
  readonly cache: Map<string, unknown>;
  signal: ConnectSignalState;
  /**
   * The worker dies at the sender's next statement whose SQL matches: it
   * throws instead of running, once. What ran before it stays done.
   */
  dieAt: RegExp | null;
}

function newWorld(): World {
  return {
    panel: new Map(),
    onRead: null,
    panelReads: [],
    bot: new Map(),
    botCalls: [],
    push: new Map(),
    pushCalls: [],
    events: [],
    cache: new Map(),
    signal: 'live',
    dieAt: null,
  };
}

/** The sender's own database handle, through which {@link World.dieAt} kills it. */
function mortalPrisma(): PrismaService {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$executeRaw') {
        return async (query: Prisma.Sql) => {
          if (world.dieAt !== null && world.dieAt.test(query.sql)) {
            world.dieAt = null;
            throw new Error('the worker died here');
          }
          return target.$executeRaw(query);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let world: World = newWorld();
let subscriptionOfProfile = new Map<string, string>();

const NEVER = { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null };

function sender(options: { readonly ladder?: 'throws' } = {}): ConnectHelpSweepService {
  const events = {
    info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) => {
      world.events.push({ type, metadata: metadata ?? {} });
    },
  };
  const cache = {
    get: async <T>(k: string) => (world.cache.get(k) ?? null) as T | null,
    set: async (k: string, value: unknown) => {
      world.cache.set(k, value);
    },
  };
  const panel = {
    getPanelUserOutcome: async (identity: { remnawaveId: string }) => {
      const subscriptionId = subscriptionOfProfile.get(identity.remnawaveId) ?? identity.remnawaveId;
      world.panelReads.push(subscriptionId);
      if (world.onRead !== null) await world.onRead(subscriptionId);
      const answer = world.panel.get(subscriptionId) ?? 'not_connected';
      if (answer === 'missing') return { kind: 'missing' as const };
      if (answer === 'unavailable') return { kind: 'unavailable' as const };
      return {
        kind: 'ok' as const,
        user: {
          userTraffic:
            answer === 'connected' ? { ...NEVER, firstConnectedAt: new Date(Date.now() - HOUR).toISOString() } : NEVER,
        },
      };
    },
  };
  const probe = new ConnectSignalProbeService(prisma, panel as never, cache as never, events as never);
  const health = { current: async () => ({ state: world.signal }) };
  const webPush = {
    sendToUser: async (call: { userId: string; url: string }) => {
      world.pushCalls.push({ userId: call.userId, url: call.url });
      const answer = world.push.get(call.userId) ?? { attempted: 0, delivered: 0 };
      return { ...answer, failed: answer.attempted - answer.delivered, disabled: false };
    },
  };
  const notifications = new UserNotificationsService(
    prisma,
    new NotificationTemplatesService(prisma, events as never),
    new BotNotifierClient(),
    webPush as never,
    { substituteTelegramHtml: async (t: string) => t, substituteFallbacks: async (t: string) => t } as never,
    {
      enqueue: async () => {
        throw new Error('the ladder must not go through the relay queue');
      },
    } as never,
    undefined,
    undefined,
    // SMTP off, as on the owner's production.
    { getSmtpSettings: async () => ({ enabled: false, notifyUsers: false }), send: async () => undefined } as never,
  );
  if (options.ladder === 'throws') {
    notifications.deliverFirstReachable = async () => {
      throw new Error('the template renderer blew up');
    };
  }
  return new ConnectHelpSweepService(
    mortalPrisma(),
    new ConnectHelpSettingsService(prisma),
    probe,
    health as never,
    notifications,
    cache as never,
    events as never,
  );
}

async function registerProfiles(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ id: string; remnawave_id: string }>>(Prisma.sql`
    SELECT "id", "remnawave_id" FROM "subscriptions" WHERE "id" LIKE ${`${prefix}-%`}
  `);
  subscriptionOfProfile = new Map(rows.map((row) => [row.remnawave_id, row.id]));
}

async function cycle(now: Date, service: ConnectHelpSweepService = sender()): Promise<ConnectHelpCycleResult> {
  await registerProfiles();
  return service.runCycle(now);
}

function notConnectedEvents(subscriptionId: string): Array<Record<string, unknown>> {
  return world.events
    .filter((event) => event.type === EVENT_TYPES.SUBSCRIPTION_NOT_CONNECTED)
    .map((event) => event.metadata)
    .filter((metadata) => metadata['subscriptionId'] === subscriptionId);
}

const ON = { enabled: true, delayHours: 24, includeTrials: false };

let realFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
let savedSettings: unknown;
/** The two templates as they stood before this file: `null` = absent, so removed again after. */
const savedTemplates = new Map<string, boolean | null>();

run('«Помощь с подключением» on real rows', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const zone = await prisma.$queryRaw<Array<{ readonly tz: string }>>(
      Prisma.sql`SELECT current_setting('TimeZone') AS "tz"`,
    );
    console.log(`[connect-help-postgres] database TimeZone = ${zone[0]?.tz}`);

    await ensureSettingsRow(prisma);
    const settings = await prisma.$queryRaw<Array<{ value: unknown }>>(
      Prisma.sql`SELECT "connect_help_settings" AS "value" FROM "settings" ORDER BY "id" LIMIT 1`,
    );
    savedSettings = settings[0]?.value ?? {};
    // The two templates, from the shipped catalogue, as a first boot seeds them
    // — and ONLY these two: the table is shared with every other spec.
    for (const type of ['connect_help', 'connect_help_trial']) {
      const existing = await prisma.notificationTemplate.findUnique({ where: { type }, select: { isActive: true } });
      savedTemplates.set(type, existing?.isActive ?? null);
      const shipped = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === type);
      assert.ok(shipped, `${type} is not in the catalogue`);
      await prisma.notificationTemplate.upsert({
        where: { type },
        create: {
          type,
          title: shipped.title,
          body: shipped.body,
          titleEn: shipped.titleEn ?? null,
          bodyEn: shipped.bodyEn ?? null,
          buttons: [...(shipped.buttons ?? [])] as unknown as Prisma.InputJsonValue,
          isActive: true,
        },
        update: { isActive: true },
      });
    }

    realFetch = globalThis.fetch;
    savedEnv = { REIWA_URL: process.env.REIWA_URL, WEBHOOK_SECRET_HEADER: process.env.WEBHOOK_SECRET_HEADER };
    process.env.REIWA_URL = 'https://reiwa.example.test';
    process.env.WEBHOOK_SECRET_HEADER = 'connect-help-postgres-secret';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { metadata?: Record<string, unknown> };
      const telegramId = String(body.metadata?.['telegramId'] ?? '');
      world.botCalls.push({ telegramId, eventId: String(body.metadata?.['eventId'] ?? '') });
      const answer = world.bot.get(telegramId) ?? 'confirmed';
      if (answer === 'dropped') throw new TypeError('fetch failed');
      if (answer === 'unconfirmed') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ messageId: 99 }), { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    world = newWorld();
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "settings" SET "connect_help_settings" = ${JSON.stringify(savedSettings)}::jsonb
    `);
    for (const [type, wasActive] of savedTemplates) {
      if (wasActive === null) await prisma.notificationTemplate.deleteMany({ where: { type } });
      else await setTemplateActive(type, wasActive);
    }
    const like = `${prefix}-%`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transaction_items" WHERE "transaction_id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${like}`);
    await prisma.$disconnect();
  });

  describe('who is a candidate', () => {
    it('helps a purchase N hours old, within the 72-hour catch-up — and nobody else', async () => {
      await setSettings(ON);
      const now = nowFor(1);
      const due = await paidCustomer(now, 25);
      const notYet = await paidCustomer(now, 23);
      const tooOld = await paidCustomer(now, 24 + 73);
      // A renewal is never "became paid": the first money is a month old.
      const renewed = await insertUser();
      const renewedSub = await insertSubscription(renewed, { createdAt: new Date(now.getTime() - 30 * DAY) });
      await insertPayment(renewed, { subscriptionId: renewedSub, createdAt: new Date(now.getTime() - 30 * DAY) });
      await insertPayment(renewed, {
        subscriptionId: renewedSub,
        purchaseType: 'RENEW',
        createdAt: new Date(now.getTime() - 25 * HOUR),
      });
      const blocked = await paidCustomer(now, 25, { user: { blocked: true } });
      const expired = await insertUser();
      const expiredSub = await insertSubscription(expired, {
        createdAt: new Date(now.getTime() - 25 * HOUR),
        status: 'EXPIRED',
      });
      await insertPayment(expired, { subscriptionId: expiredSub, createdAt: new Date(now.getTime() - 25 * HOUR) });
      const imported = await insertUser();
      const importedSub = await insertSubscription(imported, {
        createdAt: new Date(now.getTime() - 25 * HOUR),
        snapshot: { name: 'Импорт', importedFrom: 'bedolaga' },
      });
      await insertPayment(imported, { subscriptionId: importedSub, createdAt: new Date(now.getTime() - 25 * HOUR) });
      const trial = await insertUser();
      const trialSub = await insertSubscription(trial, {
        createdAt: new Date(now.getTime() - 25 * HOUR),
        isTrial: true,
      });
      const connected = await paidCustomer(now, 25);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_connect_states" ("subscription_id", "first_connected_at", "created_at", "updated_at")
        VALUES (${connected.subscriptionId}, ${new Date(now.getTime() - 20 * HOUR)}, ${now}, ${now})
      `);

      await cycle(now);

      const state = await stateOf(due.subscriptionId);
      assert.equal(state?.help_outcome, 'bot');
      assert.equal(state?.help_kind, 'paid');
      assert.equal(state?.help_source, 'auto');
      assert.equal(state?.help_anchor_at?.toISOString(), new Date(now.getTime() - 25 * HOUR).toISOString());
      for (const [label, subscriptionId] of [
        ['a purchase not yet N hours old', notYet.subscriptionId],
        ['a purchase older than the catch-up', tooOld.subscriptionId],
        ['a renewal of an old subscription', renewedSub],
        ['a blocked customer', blocked.subscriptionId],
        ['an expired subscription', expiredSub],
        ['an imported subscription', importedSub],
        ['a free trial, with trials off', trialSub],
        ['a subscription that connected', connected.subscriptionId],
      ] as const) {
        assert.equal((await stateOf(subscriptionId))?.help_decided_at ?? null, null, `${label} was decided`);
        assert.deepEqual(notConnectedEvents(subscriptionId), [], `${label} raised the event`);
      }
      assert.equal(world.botCalls.length, 1, 'exactly one customer was written to');
      assert.equal(
        new Set(world.panelReads).has(notYet.subscriptionId),
        false,
        'a purchase not yet due was read at the panel',
      );
      // Not even LISTED — what the status page reads back. A row listed only to
      // be skipped takes one of the hundred places a cycle has, every cycle:
      // enough of them and the paying customers behind them are never reached.
      const mirrored = world.cache.get(CONNECT_HELP_LAST_RESULT_KEY) as ConnectHelpCycleResult;
      assert.equal(mirrored.candidates, 1, 'the cycle listed more than the one due purchase');
    });

    it('stops at trials the moment the operator switches them off, mid-cycle', async () => {
      await setSettings({ ...ON, includeTrials: true });
      const now = nowFor(11);
      const paid = await paidCustomer(now, 30);
      const trial = await insertUser();
      const trialSub = await insertSubscription(trial, { createdAt: new Date(now.getTime() - 26 * HOUR), isTrial: true });
      world.onRead = async (subscriptionId) => {
        if (subscriptionId === paid.subscriptionId) await setSettings({ ...ON, includeTrials: false });
      };

      await cycle(now);

      assert.equal((await stateOf(paid.subscriptionId))?.help_outcome, 'bot');
      assert.equal((await stateOf(trialSub))?.help_decided_at ?? null, null, 'a trial was helped after trials went off');
      assert.deepEqual(await feedRowsOf(trial.id), []);
    });

    it('with trials on: a free trial, a gift and a 0 ₽ promo get the trial notice; a paid trial and a partner-balance purchase are paid', async () => {
      await setSettings({ ...ON, includeTrials: true });
      const now = nowFor(2);
      const at = new Date(now.getTime() - 25 * HOUR);
      const freeTrial = await insertUser();
      const freeTrialSub = await insertSubscription(freeTrial, { createdAt: at, isTrial: true });
      const gift = await insertUser();
      const giftSub = await insertSubscription(gift, { createdAt: at });
      const promo = await insertUser();
      const promoSub = await insertSubscription(promo, { createdAt: at });
      await insertPayment(promo, { subscriptionId: promoSub, createdAt: at, amount: 0 });
      const paidTrial = await insertUser();
      const paidTrialSub = await insertSubscription(paidTrial, { createdAt: at, isTrial: true });
      await insertPayment(paidTrial, { subscriptionId: paidTrialSub, createdAt: at, amount: 10 });
      const partner = await insertUser();
      const partnerSub = await insertSubscription(partner, { createdAt: at });
      await insertPayment(partner, { subscriptionId: partnerSub, createdAt: at, gateway: 'PARTNER_BALANCE' });

      await cycle(now);

      for (const [label, owner, subscriptionId, kind, type] of [
        ['free trial', freeTrial, freeTrialSub, 'trial', 'connect_help_trial'],
        ['gift', gift, giftSub, 'trial', 'connect_help_trial'],
        ['0 ₽ promo', promo, promoSub, 'trial', 'connect_help_trial'],
        ['paid trial', paidTrial, paidTrialSub, 'paid', 'connect_help'],
        ['partner balance', partner, partnerSub, 'paid', 'connect_help'],
      ] as const) {
        const state = await stateOf(subscriptionId);
        assert.equal(state?.help_kind, kind, label);
        assert.equal(state?.help_outcome, 'bot', label);
        const rows = await feedRowsOf(owner.id);
        assert.deepEqual(
          rows.map((row) => row.type),
          [type],
          `${label} got the wrong notice`,
        );
        assert.equal(rows[0].payload['subscriptionId'], subscriptionId, label);
        if (kind === 'trial') {
          assert.doesNotMatch(String(rows[0].payload['text']), /оплачена/, `${label} was told it paid`);
        } else {
          assert.match(String(rows[0].payload['text']), /оплачена/, label);
        }
      }
    });
  });

  describe('the look before sending', () => {
    it('sends nothing and marks nothing when the panel says the profile connected', async () => {
      await setSettings(ON);
      const now = nowFor(3);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      world.panel.set(subscriptionId, 'connected');

      const result = await cycle(now);

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_decided_at, null, 'a connected subscription was marked');
      assert.notEqual(state?.first_connected_at, null, 'the probe recorded the connection');
      assert.deepEqual(await feedRowsOf(owner.id), []);
      assert.deepEqual(notConnectedEvents(subscriptionId), []);
      assert.equal(result.connected, 1);
    });

    for (const answer of ['unavailable', 'missing'] as const) {
      it(`leaves an unverifiable (${answer}) candidate for the next cycle while its window is open`, async () => {
        await setSettings(ON);
        const now = nowFor(answer === 'unavailable' ? 4 : 5);
        const { owner, subscriptionId } = await paidCustomer(now, 30);
        world.panel.set(subscriptionId, answer);

        const result = await cycle(now);

        assert.equal((await stateOf(subscriptionId))?.help_decided_at ?? null, null);
        assert.deepEqual(await feedRowsOf(owner.id), []);
        assert.equal(result.waiting, 1);
      });
    }

    it('closes the window on an unverifiable candidate: skipped_unverifiable, nothing sent, no event', async () => {
      await setSettings(ON);
      const now = nowFor(6);
      // Five minutes from falling out of the 72-hour catch-up.
      const { owner, subscriptionId } = await paidCustomer(now, 24 + 72 - 5 / 60);
      world.panel.set(subscriptionId, 'unavailable');

      await cycle(now);

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'skipped_unverifiable');
      assert.notEqual(state?.help_decided_at, null);
      assert.deepEqual(await feedRowsOf(owner.id), []);
      assert.deepEqual(notConnectedEvents(subscriptionId), [], 'never verified, so never "not connected"');
    });

    for (const signal of ['webhooks_only', 'blind'] as const) {
      it(`does not ask the panel, and sends nothing, while the signal is ${signal}`, async () => {
        await setSettings(ON);
        const now = nowFor(signal === 'blind' ? 7 : 8);
        const { owner, subscriptionId } = await paidCustomer(now, 30);
        world.signal = signal;

        const result = await cycle(now);

        assert.deepEqual(world.panelReads, []);
        assert.equal((await stateOf(subscriptionId))?.help_decided_at ?? null, null);
        assert.deepEqual(await feedRowsOf(owner.id), []);
        assert.equal(result.waiting, 1);
      });
    }

    it('looks again, fresh, at its turn: a payment refunded after the list was read sends nothing', async () => {
      await setSettings(ON);
      const now = nowFor(9);
      const first = await paidCustomer(now, 30);
      const second = await paidCustomer(now, 26);
      world.onRead = async (subscriptionId) => {
        // While the first (older) candidate is being read at the panel, the
        // second one's payment is refunded.
        if (subscriptionId === first.subscriptionId) {
          await prisma.$executeRaw(Prisma.sql`
            UPDATE "transactions" SET "status" = 'CANCELED'::"TransactionStatus" WHERE "id" = ${second.paymentId}
          `);
        }
      };

      await cycle(now);

      assert.equal((await stateOf(first.subscriptionId))?.help_outcome, 'bot');
      assert.equal((await stateOf(second.subscriptionId))?.help_decided_at ?? null, null);
      assert.deepEqual(await feedRowsOf(second.owner.id), []);
    });

    it('stands down entirely while the automatic help is off — absent settings read as off', async () => {
      await setSettings({});
      const now = nowFor(10);
      const { owner, subscriptionId } = await paidCustomer(now, 25);

      const result = await cycle(now);

      assert.equal(result.standDown, 'disabled');
      assert.deepEqual(world.panelReads, []);
      assert.equal((await stateOf(subscriptionId))?.help_decided_at ?? null, null);
      assert.deepEqual(await feedRowsOf(owner.id), []);
      assert.equal((world.cache.get(CONNECT_HELP_LAST_RESULT_KEY) as ConnectHelpCycleResult).standDown, 'disabled');
    });
  });

  describe('the once-marker', () => {
    it('decides a subscription ONCE when two sweeps and a broadcast staging race for it', async () => {
      await setSettings(ON);
      const winners = new Map<string, number>();
      for (let round = 0; round < 6; round += 1) {
        world = newWorld();
        const now = nowFor(20 + round);
        const { owner, subscriptionId } = await paidCustomer(now, 25);
        // A broadcast stages only verified subscriptions, so the row exists.
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO "subscription_connect_states" ("subscription_id", "checked_at", "created_at", "updated_at")
          VALUES (${subscriptionId}, ${now}, ${now}, ${now})
        `);
        const staging = async (): Promise<void> => {
          // The broadcast staging's claim, as the contract states it: the same
          // guard on the same marker.
          await prisma.$executeRaw(Prisma.sql`
            UPDATE "subscription_connect_states"
               SET "help_decided_at" = ${now}, "help_source" = ${`broadcast:${key('bc')}`},
                   "help_outcome" = 'broadcast', "help_kind" = 'paid', "updated_at" = ${now}
             WHERE "subscription_id" = ${subscriptionId} AND "help_decided_at" IS NULL
          `);
        };
        // Both sweeps must be past their local look and at the panel before
        // either answers, so both reach the claim together.
        const waiting: Array<() => void> = [];
        let stagingRun: Promise<void> = Promise.resolve();
        world.onRead = (id) =>
          id !== subscriptionId
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                waiting.push(resolve);
                if (waiting.length === 2) {
                  if (round % 3 !== 2) stagingRun = staging();
                  for (const release of waiting) release();
                }
              });

        await registerProfiles();
        await Promise.all([sender().runCycle(now), sender().runCycle(now)]);
        await stagingRun;

        const state = await stateOf(subscriptionId);
        assert.notEqual(state?.help_decided_at ?? null, null, `round ${round}: nobody decided`);
        const rows = await feedRowsOf(owner.id);
        const events = notConnectedEvents(subscriptionId);
        const bot = world.botCalls.filter((call) => call.telegramId === String(owner.telegramId));
        if (state?.help_source === 'auto') {
          assert.equal(rows.length, 1, `round ${round}: ${rows.length} feed rows`);
          assert.equal(events.length, 1, `round ${round}: ${events.length} events`);
          assert.equal(bot.length, 1, `round ${round}: ${bot.length} bot sends`);
          assert.equal(state.help_outcome, 'bot');
        } else {
          assert.match(String(state?.help_source), /^broadcast:/, `round ${round}`);
          assert.equal(state?.help_outcome, 'broadcast');
          assert.equal(rows.length, 0, `round ${round}: the sender wrote after staging decided`);
          assert.equal(events.length, 0);
          assert.equal(bot.length, 0);
        }
        const source = state?.help_source?.startsWith('broadcast:') === true ? 'broadcast' : 'auto';
        winners.set(source, (winners.get(source) ?? 0) + 1);
      }
      assert.ok((winners.get('auto') ?? 0) > 0, `the sender never won a round: ${JSON.stringify([...winners])}`);
    });

    it('finishes a resumed ladder ONCE when two sweeps pick it up together', async () => {
      await setSettings(ON);
      const now = nowFor(26);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      world.bot.set(String(owner.telegramId), 'dropped');
      await cycle(now);
      assert.equal((await stateOf(subscriptionId))?.help_deferrals, 1, 'the first pass did not defer');
      world.bot.delete(String(owner.telegramId));

      const waiting: Array<() => void> = [];
      world.onRead = (id) =>
        id !== subscriptionId
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiting.push(resolve);
              if (waiting.length === 2) for (const release of waiting) release();
            });
      await registerProfiles();
      const later = new Date(now.getTime() + 10 * MIN);
      await Promise.all([sender().runCycle(later), sender().runCycle(later)]);

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'bot');
      assert.equal((await feedRowsOf(owner.id)).length, 1);
      assert.deepEqual(
        notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']),
        ['bot'],
        'a resumed ladder finished twice must still be announced once',
      );
      const attempts = state?.help_attempts as Array<{ channel: string; result: string }>;
      assert.equal(
        attempts.filter((attempt) => attempt.result === 'confirmed').length,
        1,
        'only the finish that recorded the outcome may add its steps',
      );
    });

    it('does nothing more when the cycle runs again', async () => {
      await setSettings(ON);
      const now = nowFor(30);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      await cycle(now);
      const decided = await stateOf(subscriptionId);

      await cycle(new Date(now.getTime() + 10 * MIN));
      await cycle(new Date(now.getTime() + 20 * MIN));

      assert.equal((await feedRowsOf(owner.id)).length, 1);
      assert.equal(notConnectedEvents(subscriptionId).length, 1);
      assert.equal(world.botCalls.length, 1);
      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_decided_at?.toISOString(), decided?.help_decided_at?.toISOString());
      assert.equal(state?.help_outcome, 'bot');
    });

    it('merges a second subscription of the same person decided within a day', async () => {
      await setSettings(ON);
      const now = nowFor(31);
      const first = await paidCustomer(now, 30);
      const second = await paidCustomer(now, 26, { owner: first.owner });

      await cycle(now);

      assert.equal((await stateOf(first.subscriptionId))?.help_outcome, 'bot');
      assert.equal((await stateOf(second.subscriptionId))?.help_outcome, 'merged');
      assert.equal((await feedRowsOf(first.owner.id)).length, 1, 'one message per person');
      assert.equal(world.botCalls.length, 1);
      assert.deepEqual(
        notConnectedEvents(second.subscriptionId).map((metadata) => metadata['helpedBy']),
        ['merged'],
      );
    });

    it('does not merge with a sibling helped more than a day ago, or one never verified', async () => {
      await setSettings(ON);
      const now = nowFor(32);
      const owner = await insertUser();
      const old = await paidCustomer(now, 90, { owner });
      const unverified = await paidCustomer(now, 90, { owner });
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_connect_states"
          ("subscription_id", "help_decided_at", "help_source", "help_outcome", "help_kind", "created_at", "updated_at")
        VALUES (${old.subscriptionId}, ${new Date(now.getTime() - 25 * HOUR)}, 'auto', 'bot', 'paid', ${now}, ${now}),
               (${unverified.subscriptionId}, ${new Date(now.getTime() - HOUR)}, 'auto', 'skipped_unverifiable', 'paid', ${now}, ${now})
      `);
      const fresh = await paidCustomer(now, 25, { owner });

      await cycle(now);

      assert.equal((await stateOf(fresh.subscriptionId))?.help_outcome, 'bot');
    });
  });

  describe('the ladder, recorded', () => {
    it('defers a bot that cannot be reached with the same event id, then moves on after three deferrals', async () => {
      await setSettings(ON);
      const now = nowFor(40);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      world.bot.set(String(owner.telegramId), 'dropped');
      world.push.set(owner.id, { attempted: 1, delivered: 1 });

      for (let pass = 0; pass < 3; pass += 1) {
        await cycle(new Date(now.getTime() + pass * 10 * MIN));
        const state = await stateOf(subscriptionId);
        assert.equal(state?.help_outcome, null, `pass ${pass}: finished early`);
        assert.equal(state?.help_deferrals, pass + 1);
        assert.deepEqual(notConnectedEvents(subscriptionId), [], `pass ${pass}: the event came before the outcome`);
      }
      await cycle(new Date(now.getTime() + 30 * MIN));

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'push');
      const rows = await feedRowsOf(owner.id);
      assert.equal(rows.length, 1, 'one feed row across four passes');
      assert.equal(state?.help_event_id, rows[0].id);
      assert.deepEqual(
        world.botCalls.map((call) => call.eventId),
        [rows[0].id, rows[0].id, rows[0].id, rows[0].id],
        'every retry carried the same event id',
      );
      assert.equal(world.pushCalls.length, 1);
      assert.equal(world.pushCalls[0].url, `/dashboard?connect=help&subscriptionId=${subscriptionId}`);
      const attempts = state?.help_attempts as Array<{ channel: string; result: string }>;
      assert.deepEqual(
        attempts.map((attempt) => `${attempt.channel}:${attempt.result}`),
        ['bot:failed', 'bot:failed', 'bot:failed', 'bot:failed', 'push:delivered'],
      );
      assert.deepEqual(
        notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']),
        ['push'],
      );
    });

    it('ends at the banner when no channel reaches the customer', async () => {
      await setSettings(ON);
      const now = nowFor(41);
      const { owner, subscriptionId } = await paidCustomer(now, 25, { user: { telegram: false } });

      await cycle(now);

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'banner');
      assert.deepEqual(
        (state?.help_attempts as Array<{ channel: string; result: string; detail?: string }>).map(
          (attempt) => `${attempt.channel}:${attempt.result}:${attempt.detail ?? ''}`,
        ),
        ['bot:unavailable:no_telegram', 'push:unavailable:no_subscription', 'email:unavailable:smtp_off'],
      );
      assert.equal((await feedRowsOf(owner.id)).length, 1);
    });

    it('honours the customer who switched it off: the feed row, no channel, the event', async () => {
      await setSettings(ON);
      const now = nowFor(42);
      const { owner, subscriptionId } = await paidCustomer(now, 25, { user: { prefs: { connect_help: false } } });

      await cycle(now);

      assert.equal((await stateOf(subscriptionId))?.help_outcome, 'opted_out');
      assert.equal((await feedRowsOf(owner.id)).length, 1);
      assert.equal(world.botCalls.length, 0);
      assert.equal(world.pushCalls.length, 0);
      assert.deepEqual(
        notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']),
        ['opted_out'],
      );
    });

    it('records a switched-off template as skipped_template_off and sends nothing', async () => {
      await setSettings(ON);
      const now = nowFor(43);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      await setTemplateActive('connect_help', false);
      try {
        await cycle(now);
      } finally {
        await setTemplateActive('connect_help', true);
      }

      assert.equal((await stateOf(subscriptionId))?.help_outcome, 'skipped_template_off');
      assert.deepEqual(await feedRowsOf(owner.id), []);
      assert.equal(world.botCalls.length, 0);
    });

    it('emits subscription.not_connected once, with the contract metadata', async () => {
      await setSettings({ ...ON, delayHours: 6 });
      const now = nowFor(44);
      const { owner, subscriptionId } = await paidCustomer(now, 7);

      await cycle(now);

      const events = notConnectedEvents(subscriptionId);
      assert.equal(events.length, 1);
      const metadata = events[0];
      assert.equal(metadata['userId'], owner.id);
      assert.equal(metadata['subscriptionId'], subscriptionId);
      assert.equal(metadata['kind'], 'paid');
      assert.equal(metadata['anchorAt'], new Date(now.getTime() - 7 * HOUR).toISOString());
      assert.equal(metadata['hoursSincePurchase'], 7);
      assert.equal(metadata['helpedBy'], 'bot');
      assert.equal(metadata['planName'], 'Премиум');
      assert.match(String(metadata['note']), /^Оплатил: прошло 7 ч, VPN ни разу не подключался\./);
    });
  });

  describe('every claim ends', () => {
    it('closes a begun ladder when the customer connects before any channel took it', async () => {
      await setSettings(ON);
      const now = nowFor(60);
      const byPanel = await paidCustomer(now, 25);
      const byWebhook = await paidCustomer(now, 26);
      for (const customer of [byPanel, byWebhook]) world.bot.set(String(customer.owner.telegramId), 'dropped');
      await cycle(now);
      for (const customer of [byPanel, byWebhook]) {
        assert.equal((await stateOf(customer.subscriptionId))?.help_deferrals, 1, 'the first pass did not defer');
      }
      // Before the next pass the panel sees traffic on one, and a webhook reports the other.
      world.panel.set(byPanel.subscriptionId, 'connected');
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "subscription_connect_states" SET "first_connected_at" = ${new Date(now.getTime() + 5 * MIN)}
         WHERE "subscription_id" = ${byWebhook.subscriptionId}
      `);
      const asked = world.botCalls.length;

      // The very pass that finds the connection closes the ladder.
      const result = await cycle(new Date(now.getTime() + 10 * MIN));
      for (const [label, customer] of [['the panel', byPanel], ['a webhook', byWebhook]] as const) {
        const state = await stateOf(customer.subscriptionId);
        assert.equal(state?.help_outcome, 'skipped_connected', `connected per ${label}, still «В процессе»`);
        assert.equal(state?.help_deferrals, 1, `connected per ${label}, and deferred again`);
      }
      assert.equal(result.connected, 2);
      await cycle(new Date(now.getTime() + 20 * MIN));

      for (const customer of [byPanel, byWebhook]) {
        assert.equal((await stateOf(customer.subscriptionId))?.help_outcome, 'skipped_connected');
        assert.deepEqual(notConnectedEvents(customer.subscriptionId), [], 'a customer who connected was announced');
      }
      assert.equal(world.botCalls.length, asked, 'a customer who connected was written to again');
      assert.equal(world.pushCalls.length, 0);
    });

    it('closes a begun ladder the panel cannot verify for a day after the decision: skipped_unverifiable', async () => {
      await setSettings(ON);
      const now = nowFor(61);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      world.bot.set(String(owner.telegramId), 'dropped');
      await cycle(now);
      world.panel.set(subscriptionId, 'unavailable');

      const early = await cycle(new Date(now.getTime() + 10 * MIN));
      assert.equal((await stateOf(subscriptionId))?.help_outcome, null, 'closed long before the day was out');
      assert.equal(early.waiting, 1);
      // Remnawave stays down; by now the connection signal has gone blind as well.
      world.signal = 'blind';
      await cycle(new Date(now.getTime() + DAY - MIN));
      assert.equal((await stateOf(subscriptionId))?.help_outcome, null, 'closed a minute before the day was out');

      await cycle(new Date(now.getTime() + DAY + MIN));

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'skipped_unverifiable');
      assert.equal(state?.help_deferrals, 1);
      assert.equal(world.botCalls.length, 1, 'written to while it could not be verified');
      assert.deepEqual(notConnectedEvents(subscriptionId), [], 'never verified again, so never announced');
    });

    it('stops a begun ladder, sending nothing, when the trials, the subscription or the help itself go away', async () => {
      await setSettings({ ...ON, includeTrials: true });
      const now = nowFor(62);
      const trial = await insertUser();
      const trialSub = await insertSubscription(trial, { createdAt: new Date(now.getTime() - 25 * HOUR), isTrial: true });
      const ended = await paidCustomer(now, 26);
      const helpOff = await paidCustomer(now, 27);
      for (const owner of [trial, ended.owner, helpOff.owner]) world.bot.set(String(owner.telegramId), 'dropped');
      await cycle(now);
      for (const subscriptionId of [trialSub, ended.subscriptionId, helpOff.subscriptionId]) {
        assert.equal((await stateOf(subscriptionId))?.help_deferrals, 1, 'the first pass did not defer');
      }
      const asked = world.botCalls.length;

      // While their ladders wait, the trials are switched off and one subscription ends.
      await setSettings({ ...ON, includeTrials: false });
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "subscriptions" SET "status" = 'EXPIRED'::"SubscriptionStatus" WHERE "id" = ${ended.subscriptionId}
      `);
      await cycle(new Date(now.getTime() + 10 * MIN));
      assert.equal((await stateOf(trialSub))?.help_outcome, 'skipped_stopped', 'trials switched off');
      assert.equal((await stateOf(ended.subscriptionId))?.help_outcome, 'skipped_stopped', 'the subscription ended');
      assert.equal((await stateOf(helpOff.subscriptionId))?.help_outcome, null);
      assert.equal(world.botCalls.length, asked + 1, 'a stopped ladder asked the bot');

      // Then the automatic help itself is switched off…
      await setSettings({ ...ON, enabled: false });
      const off = await cycle(new Date(now.getTime() + 20 * MIN));
      assert.equal(off.standDown, 'disabled');
      assert.ok(off.stopped >= 1, 'the disabled pass stopped nothing');
      assert.equal((await stateOf(helpOff.subscriptionId))?.help_outcome, 'skipped_stopped', 'the help switched off');
      // …and on again: nothing begun before goes out by itself.
      await setSettings(ON);
      world.bot.clear();
      await cycle(new Date(now.getTime() + 30 * MIN));
      assert.equal(world.botCalls.length, asked + 1);
      assert.equal(world.pushCalls.length, 0);
      for (const subscriptionId of [trialSub, ended.subscriptionId, helpOff.subscriptionId]) {
        assert.deepEqual(notConnectedEvents(subscriptionId), [], 'a stopped ladder was announced');
      }
    });

    it(`gives up a ladder that throws ${CONNECT_HELP_MAX_FAILURES} times: skipped_failed, nothing sent, the operator told once`, async () => {
      await setSettings(ON);
      const now = nowFor(63);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      const broken = sender({ ladder: 'throws' });
      for (let pass = 0; pass < CONNECT_HELP_MAX_FAILURES; pass += 1) {
        const result = await cycle(new Date(now.getTime() + pass * 10 * MIN), broken);
        assert.equal(result.errors, 1, `pass ${pass}`);
        const state = await stateOf(subscriptionId);
        assert.notEqual(state?.help_decided_at ?? null, null, `pass ${pass}: not claimed`);
        if (pass < CONNECT_HELP_MAX_FAILURES - 1) assert.equal(state?.help_outcome, null, `pass ${pass}: given up early`);
      }
      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'skipped_failed');
      assert.equal(failuresOf(state), CONNECT_HELP_MAX_FAILURES);

      // Mended, the sender does not come back to it.
      await cycle(new Date(now.getTime() + DAY));
      assert.equal((await stateOf(subscriptionId))?.help_outcome, 'skipped_failed');
      assert.deepEqual(await feedRowsOf(owner.id), []);
      assert.equal(world.botCalls.length, 0);
      assert.deepEqual(
        notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']),
        ['skipped_failed'],
      );
    });

    it('asks the one-message-per-person question again on a resume: an account merge sends nothing twice', async () => {
      await setSettings(ON);
      const now = nowFor(64);
      const survivor = await insertUser();
      const helped = await paidCustomer(now, 30, { owner: survivor });
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_connect_states"
          ("subscription_id", "help_decided_at", "help_source", "help_outcome", "help_kind", "created_at", "updated_at")
        VALUES (${helped.subscriptionId}, ${new Date(now.getTime() - HOUR)}, 'auto', 'bot', 'paid', ${now}, ${now})
      `);
      const moved = await paidCustomer(now, 25);
      world.bot.set(String(moved.owner.telegramId), 'dropped');
      await cycle(now);
      assert.equal((await stateOf(moved.subscriptionId))?.help_deferrals, 1, 'the first pass did not defer');
      // The accounts are merged: the waiting subscription now belongs to a person helped an hour ago.
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "subscriptions" SET "user_id" = ${survivor.id} WHERE "id" = ${moved.subscriptionId}
      `);
      world.bot.clear();
      const asked = world.botCalls.length;

      await cycle(new Date(now.getTime() + 10 * MIN));

      assert.equal((await stateOf(moved.subscriptionId))?.help_outcome, 'merged');
      assert.equal(world.botCalls.length, asked, 'the surviving account got a second message');
      assert.equal(world.pushCalls.length, 0);
      const events = notConnectedEvents(moved.subscriptionId);
      assert.deepEqual(events.map((metadata) => metadata['helpedBy']), ['merged']);
      assert.equal(events[0]?.['userId'], survivor.id);
    });

    it('never asks a push again once it went out — the worker died before the outcome was written', async () => {
      await setSettings(ON);
      const now = nowFor(65);
      const { owner, subscriptionId } = await paidCustomer(now, 25, { user: { telegram: false } });
      world.push.set(owner.id, { attempted: 1, delivered: 1 });
      world.dieAt = /SET "help_outcome" = /;

      const died = await cycle(now);
      assert.equal(died.errors, 1);
      const between = await stateOf(subscriptionId);
      assert.equal(between?.help_outcome, null);
      assert.deepEqual(stepsOf(between), ['bot:unavailable', 'push:delivered'], 'the push was not on record');

      await cycle(new Date(now.getTime() + 10 * MIN));

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'push');
      assert.equal(world.pushCalls.length, 1, 'the push went out twice');
      assert.deepEqual(stepsOf(state), ['bot:unavailable', 'push:delivered']);
      assert.equal((await feedRowsOf(owner.id)).length, 1);
      assert.deepEqual(notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']), ['push']);
    });

    it('never says «nothing sent» over a push that went out: the help switched off before the outcome was written', async () => {
      await setSettings(ON);
      const now = nowFor(69);
      const { owner, subscriptionId } = await paidCustomer(now, 25, { user: { telegram: false } });
      world.push.set(owner.id, { attempted: 1, delivered: 1 });
      world.dieAt = /SET "help_outcome" = /;
      await cycle(now);
      assert.equal((await stateOf(subscriptionId))?.help_outcome, null);

      await setSettings({ ...ON, enabled: false });
      const off = await cycle(new Date(now.getTime() + 10 * MIN));

      assert.equal((await stateOf(subscriptionId))?.help_outcome, 'push');
      assert.equal(off.sent.push, 1);
      assert.equal(world.pushCalls.length, 1);
    });

    it('finishes on a bot message that went out without asking again — the relay down by the resume, no push', async () => {
      await setSettings(ON);
      const now = nowFor(68);
      const { owner, subscriptionId } = await paidCustomer(now, 25);
      world.push.set(owner.id, { attempted: 1, delivered: 1 });
      world.dieAt = /SET "help_outcome" = /;

      await cycle(now);
      assert.deepEqual(stepsOf(await stateOf(subscriptionId)), ['bot:confirmed'], 'the bot message was not on record');
      // By the next pass the relay is down: asked again, it would be put off and end in a push.
      world.bot.set(String(owner.telegramId), 'dropped');

      await cycle(new Date(now.getTime() + 10 * MIN));

      const state = await stateOf(subscriptionId);
      assert.equal(state?.help_outcome, 'bot');
      assert.equal(state?.help_deferrals, 0);
      assert.equal(world.botCalls.length, 1, 'the bot was asked again');
      assert.equal(world.pushCalls.length, 0, 'a second message went out by push');
      assert.deepEqual(notConnectedEvents(subscriptionId).map((metadata) => metadata['helpedBy']), ['bot']);
    });

    it('never asks again a push a dead run began — and leaves alone one another replica may be sending', async () => {
      await setSettings(ON);
      const now = nowFor(67);
      const { owner, subscriptionId } = await paidCustomer(now, 25, { user: { telegram: false } });
      world.push.set(owner.id, { attempted: 1, delivered: 1 });
      // The push goes out, and the worker dies before its answer is written.
      world.dieAt = /SET "help_attempts" = \(/;
      await cycle(now);
      assert.deepEqual(stepsOf(await stateOf(subscriptionId)), ['bot:unavailable', 'push:sending']);

      // A minute later the step may still be another replica's, mid-send: left alone.
      await cycle(new Date(now.getTime() + MIN));
      assert.equal((await stateOf(subscriptionId))?.help_outcome, null);
      assert.equal(world.pushCalls.length, 1);

      await cycle(new Date(now.getTime() + 11 * MIN));

      const state = await stateOf(subscriptionId);
      assert.equal(world.pushCalls.length, 1, 'a push a dead run began was sent again');
      assert.equal(state?.help_outcome, 'banner', 'the ladder did not go on without the push');
      assert.deepEqual(stepsOf(state), ['bot:unavailable', 'push:interrupted', 'bot:unavailable', 'email:unavailable']);
    });

    it('leaves new candidates their places however many begun ladders wait to resume', async () => {
      await setSettings(ON);
      const now = nowFor(66);
      const waiting: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const { subscriptionId } = await paidCustomer(now, 30 + index);
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO "subscription_connect_states"
            ("subscription_id", "help_decided_at", "help_kind", "help_anchor_at", "help_source", "help_deferrals",
             "created_at", "updated_at")
          VALUES (${subscriptionId}, ${new Date(now.getTime() - (index + 1) * 10 * MIN)}, 'paid',
                  ${new Date(now.getTime() - (30 + index) * HOUR)}, 'auto', 1, ${now}, ${now})
        `);
        waiting.push(subscriptionId);
      }
      const fresh = new Set<string>();
      for (let index = 0; index < 3; index += 1) fresh.add((await paidCustomer(now, 25 + index)).subscriptionId);

      try {
        const rows = await prisma.$queryRaw<ConnectHelpCandidateRow[]>(
          connectHelpCandidatesSql({ now, settings: ON, limit: 5, resumeCap: 2 }),
        );

        assert.equal(rows.filter((row) => row.inFlight).length, 2, 'the resumed ladders were not capped');
        assert.equal(rows.filter((row) => fresh.has(row.subscriptionId)).length, 3, 'a new candidate got no place');
        assert.deepEqual(
          rows.map((row) => row.inFlight),
          [true, true, false, false, false],
          'the resumed ladders do not go first',
        );
      } finally {
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "subscription_connect_states" SET "help_outcome" = 'skipped_stopped'
           WHERE "subscription_id" IN (${Prisma.join(waiting)})
        `);
      }
    });
  });

  describe('the log', () => {
    it('lists the decisions newest first, a page at a time, and filters by outcome', async () => {
      await setSettings(ON);
      const now = nowFor(50);
      const decided: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const { subscriptionId } = await paidCustomer(now, 25 + index);
        decided.push(subscriptionId);
      }
      await cycle(now);
      const status = new ConnectHelpStatusService(
        prisma,
        { current: async () => ({ state: 'live' }) } as never,
        { get: async () => null } as never,
        new NotificationTemplatesService(prisma, { info: () => undefined } as never),
      );

      const mine = new Set(decided);
      const seen: string[] = [];
      let cursor: string | undefined;
      let previous: string | null = null;
      for (let page = 0; page < 200 && seen.length < 3; page += 1) {
        const result = await status.log({ cursor, limit: 2, outcome: 'bot' });
        for (const item of result.items) {
          if (previous !== null) assert.ok(item.decidedAt <= previous, 'newest first');
          previous = item.decidedAt;
          assert.equal(item.outcome, 'bot', 'the filter let another outcome through');
          if (mine.has(item.subscriptionId)) seen.push(item.subscriptionId);
        }
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      assert.deepEqual([...seen].sort(), [...decided].sort(), 'a decision was skipped or repeated across pages');
    });
  });
});
