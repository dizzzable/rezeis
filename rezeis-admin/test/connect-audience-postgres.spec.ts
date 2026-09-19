import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';
import { connectBucketSql } from '../src/modules/connect-audience/connect-audience.sql';
import {
  CONNECT_AUDIENCE_MAX_USERS,
  CONNECT_AUDIENCE_TOO_LARGE_MESSAGE,
  ConnectAudienceService,
  ConnectAudienceTooLargeError,
} from '../src/modules/connect-audience/services/connect-audience.service';
import { moneyForSubscriptionSql, trialBucketSql } from '../src/modules/connect-signal/connect-sql';
import type { ConnectSignalHealth } from '../src/modules/connect-signal/services/connect-signal-health.service';

/**
 * «КУПИЛ, НО НЕ ПОДКЛЮЧИЛСЯ» AS PEOPLE, AGAINST REAL ROWS.
 *
 * `ConnectAudienceService` composes WP4a's per-subscription definitions into
 * lists and counts of people, and writes the once-marker when a broadcast is
 * staged. Everything here runs the service's own statements on PostgreSQL:
 *
 *   • every row the owner decided a bucket for (native, partner balance, paid
 *     trial, free trial, 0 ₽ promo, gift, imported, add-on, combined renewal),
 *     plus the ones the audience itself decides (blocked, two subscriptions of
 *     one person, helped, unverified three ways, connected, expired, outside);
 *   • the marker: once, only for recipients, never over another marker, both
 *     or neither with the caller's transaction, one winner in a race;
 *   • the 20 000 cap, at 20 000 and at 20 001;
 *   • staging end to end: `stageRecipients` stages the people and marks
 *     exactly the recipients' subscriptions, in one transaction.
 *
 * The first three run on SYNTHETIC CLOCKS years from today, so no row another
 * spec left behind can fall in their windows and every count is this file's
 * own. The service takes `now`; nothing in these statements reads the real one.
 *
 * Run it on a UTC database AND on one whose `timezone` is not UTC: every
 * instant is bound, and the comparisons that check a written instant are made
 * in SQL, where the adapter's shift applies to both sides alike.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `caud-${process.pid}-${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let prisma: PrismaService;
let seq = 0;

function key(label: string): string {
  seq += 1;
  return `${prefix}-${label}-${seq}`;
}

const HEALTH: ConnectSignalHealth = {
  state: 'live',
  checkedCoverage: 1,
  lastOkAt: '2031-01-01T00:00:00.000Z',
  lastUserWebhookAt: null,
  coverage: { total: 0, connected: 0, verified: 0, unverified: 0 },
  probe: {
    lastCycleAt: null,
    lastFailAt: null,
    lastReason: null,
    failingSince: null,
    firstPassCompletedAt: '2031-01-01T00:00:00.000Z',
    backlog: 0,
    firstPassHours: 0,
  },
};

function audienceService(): ConnectAudienceService {
  return new ConnectAudienceService(prisma, { current: async () => HEALTH } as never);
}

async function user(
  label: string,
  options: { readonly blocked?: boolean; readonly surface?: string; readonly prefs?: unknown } = {},
): Promise<string> {
  const id = key(`user-${label}`);
  const prefs = options.prefs === undefined ? null : JSON.stringify(options.prefs);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "is_blocked", "last_surface", "notification_prefs", "updated_at")
    VALUES (${id}, ${`${id}-ref`}, ${options.blocked ?? false}, ${options.surface ?? null}, ${prefs}::jsonb, ${new Date()})
  `);
  return id;
}

async function subscription(input: {
  readonly userId: string;
  readonly createdAt: Date;
  readonly status?: 'ACTIVE' | 'LIMITED' | 'EXPIRED' | 'DELETED';
  readonly isTrial?: boolean;
  readonly snapshot?: Record<string, unknown>;
}): Promise<string> {
  const id = key('sub');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscriptions" ("id", "user_id", "status", "is_trial", "plan_snapshot", "remnawave_id",
                                 "created_at", "updated_at")
    VALUES (${id}, ${input.userId}, ${input.status ?? 'ACTIVE'}::"SubscriptionStatus", ${input.isTrial ?? false},
            ${JSON.stringify(input.snapshot ?? { name: 'Standard' })}::jsonb, ${id}, ${input.createdAt}, ${input.createdAt})
  `);
  return id;
}

async function payment(input: {
  readonly userId: string;
  readonly subscriptionId: string | null;
  readonly purchaseType: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
  readonly amount: number;
  readonly createdAt: Date;
  readonly fulfilledAt?: Date;
  readonly gateway?: 'PLATEGA' | 'PARTNER_BALANCE';
  readonly snapshot?: Record<string, unknown>;
  readonly items?: readonly string[];
}): Promise<string> {
  const id = key('tx');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type", "gateway_type", "currency",
       "amount", "plan_snapshot", "fulfilled_at", "created_at", "updated_at")
    VALUES (${id}, ${`${id}-pay`}, ${input.userId}, ${input.subscriptionId}, 'COMPLETED'::"TransactionStatus",
            ${input.purchaseType}::"PurchaseType", ${input.gateway ?? 'PLATEGA'}::"PaymentGatewayType",
            'RUB'::"Currency", ${input.amount}, ${JSON.stringify(input.snapshot ?? {})}::jsonb,
            ${input.fulfilledAt ?? input.createdAt}::timestamptz, ${input.createdAt}, ${input.createdAt})
  `);
  for (const subscriptionId of input.items ?? []) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "transaction_items"
        ("id", "transaction_id", "subscription_id", "plan_id", "duration_days", "amount", "currency", "created_at")
      VALUES (${key('item')}, ${id}, ${subscriptionId}, 'plan-standard', 30, ${input.amount}, 'RUB'::"Currency",
              ${input.createdAt})
    `);
  }
  return id;
}

async function state(
  subscriptionId: string,
  input: {
    readonly checkedAt?: Date | null;
    readonly firstConnectedAt?: Date | null;
    readonly profileMissingAt?: Date | null;
    readonly helpDecidedAt?: Date | null;
    readonly helpOutcome?: string | null;
    readonly helpSource?: string | null;
    readonly helpAttempts?: readonly unknown[];
    readonly helpEventId?: string | null;
  },
): Promise<void> {
  const at = input.checkedAt ?? new Date();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states"
      ("subscription_id", "first_connected_at", "checked_at", "profile_missing_at", "help_decided_at",
       "help_outcome", "help_source", "help_attempts", "help_event_id", "created_at", "updated_at")
    VALUES (${subscriptionId}, ${input.firstConnectedAt ?? null}::timestamptz, ${input.checkedAt ?? null}::timestamptz,
            ${input.profileMissingAt ?? null}::timestamptz, ${input.helpDecidedAt ?? null}::timestamptz,
            ${input.helpOutcome ?? null}, ${input.helpSource ?? null},
            ${JSON.stringify(input.helpAttempts ?? [])}::jsonb, ${input.helpEventId ?? null}, ${at}, ${at})
  `);
}

/**
 * The automatic sender's claim, as `connect-help.sql.ts` `claimSql` writes it
 * for a ladder about to run: the once-marker set, no outcome yet. Mirrored
 * here rather than imported, so this spec states the contract it relies on —
 * `UPDATE … WHERE help_decided_at IS NULL`, one row = ours — instead of
 * following that file's edits. Returns how many rows it claimed (0 or 1).
 */
async function sweepClaims(subscriptionId: string, now: Date, client: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    UPDATE "subscription_connect_states"
       SET "help_decided_at" = ${now}::timestamptz,
           "help_kind" = 'paid',
           "help_anchor_at" = ${now}::timestamptz,
           "help_source" = 'auto',
           "help_outcome" = NULL,
           "help_attempts" = '[]'::jsonb,
           "help_deferrals" = 0,
           "help_event_id" = NULL,
           "updated_at" = ${now}::timestamptz
     WHERE "subscription_id" = ${subscriptionId}
       AND "help_decided_at" IS NULL`);
}

/** A person with one paid subscription: NEW money at `paidAt`, optionally read at `checkedAt`. */
async function paidPerson(
  label: string,
  paidAt: Date,
  checkedAt: Date | null,
  options: { readonly blocked?: boolean; readonly surface?: string; readonly prefs?: unknown } = {},
): Promise<{ readonly userId: string; readonly subscriptionId: string }> {
  const userId = await user(label, options);
  const subscriptionId = await subscription({ userId, createdAt: paidAt });
  await payment({ userId, subscriptionId, purchaseType: 'NEW', amount: 499, createdAt: paidAt });
  if (checkedAt !== null) await state(subscriptionId, { checkedAt });
  return { userId, subscriptionId };
}

async function cleanup(): Promise<void> {
  const like = `${prefix}-%`;
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "broadcast_messages" WHERE "broadcast_id" LIKE ${like}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "broadcasts" WHERE "id" LIKE ${like}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${like}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" LIKE ${like}`);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${like}`);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

run('the «не подключился» audience in PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('who is in each bucket, as people', () => {
    // Years from today: nothing any other spec wrote can fall in these windows.
    const NOW = new Date('2031-03-15T12:00:00.000Z');
    const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
    const people: Record<string, string> = {};
    const subs: Record<string, string> = {};

    before(async () => {
      // ── Paid, verified ────────────────────────────────────────────────
      {
        // A native purchase, fulfilled 90 s after checkout.
        const userId = await user('native');
        const s = await subscription({ userId, createdAt: ago(72 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(72 * HOUR), fulfilledAt: new Date(ago(72 * HOUR).getTime() + 90_000) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['native'] = userId;
        subs['native'] = s;
      }
      {
        // From a partner's balance: PAID here (owner, 18.09.2026).
        const userId = await user('partner');
        const s = await subscription({ userId, createdAt: ago(50 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 299, gateway: 'PARTNER_BALANCE', createdAt: ago(50 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['partner'] = userId;
      }
      {
        // A trial plan bought for money: PAID (owner, 18.09.2026).
        const userId = await user('paid-trial');
        const s = await subscription({ userId, createdAt: ago(26 * HOUR), isTrial: true, snapshot: { name: 'Trial', availability: 'TRIAL' } });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 10, snapshot: { availability: 'TRIAL' }, createdAt: ago(26 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['paid-trial'] = userId;
      }
      {
        // An old gift renewed in a combined checkout: the money reaches it
        // through the ITEM, and the renewal is the in-window payment.
        const userId = await user('combined');
        const s = await subscription({ userId, createdAt: ago(20 * DAY) });
        await payment({ userId, subscriptionId: null, purchaseType: 'RENEW', amount: 500, createdAt: ago(30 * HOUR), items: [s] });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['combined'] = userId;
      }
      {
        // Two subscriptions of one person, both verified: ONE person.
        const userId = await user('two-subs');
        for (const hours of [60, 40]) {
          const s = await subscription({ userId, createdAt: ago(hours * HOUR) });
          await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(hours * HOUR) });
          await state(s, { checkedAt: ago(1 * HOUR) });
        }
        people['two-subs'] = userId;
      }
      {
        // One verified subscription and one never read: verified, and NOT
        // also counted among the unverified — the message reaches them.
        const userId = await user('mixed');
        const verifiedSub = await subscription({ userId, createdAt: ago(45 * HOUR) });
        await payment({ userId, subscriptionId: verifiedSub, purchaseType: 'NEW', amount: 499, createdAt: ago(45 * HOUR) });
        await state(verifiedSub, { checkedAt: ago(1 * HOUR) });
        const unreadSub = await subscription({ userId, createdAt: ago(44 * HOUR) });
        await payment({ userId, subscriptionId: unreadSub, purchaseType: 'NEW', amount: 499, createdAt: ago(44 * HOUR) });
        people['mixed'] = userId;
      }
      {
        // LIMITED counts as live.
        const userId = await user('limited');
        const s = await subscription({ userId, createdAt: ago(55 * HOUR), status: 'LIMITED' });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(55 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['limited'] = userId;
      }
      {
        // THE ANCHOR CHOICE: bought 58 h ago, renewed 2 h ago, read 3 h ago —
        // after the first in-window payment, before the second. The earliest
        // in-window payment anchors, so this person is verified: they paid and
        // had not connected when last read. Anchoring on the newest would
        // leave them waiting for a read that proves nothing new.
        const userId = await user('renewed-after-read');
        const s = await subscription({ userId, createdAt: ago(58 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(58 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'RENEW', amount: 499, createdAt: ago(2 * HOUR) });
        await state(s, { checkedAt: ago(3 * HOUR) });
        people['renewed-after-read'] = userId;
      }
      // ── Paid, UNVERIFIED ──────────────────────────────────────────────
      people['no-row'] = (await paidPerson('no-row', ago(48 * HOUR), null)).userId;
      people['stale'] = (await paidPerson('stale', ago(70 * HOUR), ago(25 * HOUR))).userId;
      {
        // A gift renewed for money 2 h ago, read 3 h ago: the only in-window
        // payment came AFTER the read, so the read proves nothing about it.
        const userId = await user('read-before-payment');
        const s = await subscription({ userId, createdAt: ago(10 * DAY) });
        await payment({ userId, subscriptionId: s, purchaseType: 'RENEW', amount: 499, createdAt: ago(2 * HOUR) });
        await state(s, { checkedAt: ago(3 * HOUR) });
        people['read-before-payment'] = userId;
      }
      {
        // Read 2 h ago, reported missing by the panel 1 h ago.
        const { userId, subscriptionId } = await paidPerson('missing', ago(47 * HOUR), null);
        await state(subscriptionId, { checkedAt: ago(2 * HOUR), profileMissingAt: ago(1 * HOUR) });
        people['missing'] = userId;
      }
      // ── Paid, in NEITHER count ────────────────────────────────────────
      people['blocked'] = (await paidPerson('blocked', ago(46 * HOUR), ago(1 * HOUR), { blocked: true })).userId;
      {
        // Helped already (the automatic sender reached them through the bot).
        const { userId, subscriptionId } = await paidPerson('helped', ago(52 * HOUR), null);
        await state(subscriptionId, { checkedAt: ago(1 * HOUR), helpDecidedAt: ago(5 * HOUR), helpOutcome: 'bot', helpSource: 'auto' });
        people['helped'] = userId;
      }
      {
        const { userId, subscriptionId } = await paidPerson('connected', ago(49 * HOUR), null);
        await state(subscriptionId, { checkedAt: ago(1 * HOUR), firstConnectedAt: ago(40 * HOUR) });
        people['connected'] = userId;
      }
      people['outside-7d'] = (await paidPerson('outside-7d', ago(10 * DAY), ago(1 * HOUR))).userId;
      {
        const userId = await user('expired');
        const s = await subscription({ userId, createdAt: ago(51 * HOUR), status: 'EXPIRED' });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(51 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['expired'] = userId;
      }
      {
        // Imported with its payment: the donor's money is not paid money, and
        // an imported subscription is no trial or gift either.
        const userId = await user('imported');
        const s = await subscription({ userId, createdAt: ago(53 * HOUR), snapshot: { importedFrom: 'bedolaga' } });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 299, snapshot: { importedFrom: 'bedolaga' }, createdAt: ago(53 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['imported'] = userId;
      }
      // ── Trial or gift ─────────────────────────────────────────────────
      {
        const userId = await user('free-trial');
        const s = await subscription({ userId, createdAt: ago(30 * HOUR), isTrial: true, snapshot: { name: 'Trial', availability: 'TRIAL' } });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['free-trial'] = userId;
      }
      {
        // Checked out for 0 with a 100 % promo code: a gift.
        const userId = await user('zero-promo');
        const s = await subscription({ userId, createdAt: ago(35 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'NEW', amount: 0, createdAt: ago(35 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['zero-promo'] = userId;
      }
      {
        // An operator's «Выдать подписку»: no payment at all.
        const userId = await user('gift');
        const s = await subscription({ userId, createdAt: ago(40 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['gift'] = userId;
      }
      {
        // A gift with an add-on bought for it: the add-on is not the subscription's money.
        const userId = await user('addon-only');
        const s = await subscription({ userId, createdAt: ago(42 * HOUR) });
        await payment({ userId, subscriptionId: s, purchaseType: 'ADDITIONAL', amount: 99, snapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'addon-1' }, createdAt: ago(20 * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['addon-only'] = userId;
      }
      {
        const userId = await user('trial-no-row');
        await subscription({ userId, createdAt: ago(20 * HOUR), isTrial: true });
        people['trial-no-row'] = userId;
      }
      {
        const userId = await user('old-gift');
        const s = await subscription({ userId, createdAt: ago(10 * DAY) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        people['old-gift'] = userId;
      }
    });

    const names = (ids: readonly string[]): string[] =>
      sorted(ids.map((id) => Object.entries(people).find(([, value]) => value === id)?.[0] ?? `foreign:${id}`));

    it('«Оплатил»: exactly the verified people, each once — partner balance, paid trial and a combined renewal included', async () => {
      const ids = await audienceService().userIds({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.deepStrictEqual(names(ids), sorted([
        'native', 'partner', 'paid-trial', 'combined', 'two-subs', 'mixed', 'limited', 'renewed-after-read',
      ]));
      assert.equal(new Set(ids).size, ids.length, 'a person appears once');
    });

    it('«Оплатил»: the unverified are a number of people, never recipients', async () => {
      const counts = await audienceService().counts({ bucket: 'paid', withinDays: 7, now: NOW });
      // no-row, stale (25 h), read-before-payment, missing. NOT mixed (verified
      // by its other subscription), NOT helped, blocked, connected or expired.
      assert.equal(counts.verified, 8);
      assert.equal(counts.unverified, 4);
      assert.equal(counts.health, HEALTH, 'the health is handed through as it is');
    });

    it('«Пробный период или подарок»: free trial, 0 ₽ promo, gift and an add-on-only gift — never a paid trial or an import', async () => {
      const service = audienceService();
      const ids = await service.userIds({ bucket: 'trial', withinDays: 7, now: NOW });
      assert.deepStrictEqual(names(ids), sorted(['free-trial', 'zero-promo', 'gift', 'addon-only']));
      const counts = await service.counts({ bucket: 'trial', withinDays: 7, now: NOW });
      assert.deepStrictEqual([counts.verified, counts.unverified], [4, 1], 'trial-no-row is the one unverified');
    });

    it('drops the helped by default and brings them back with excludeHelped: false', async () => {
      const service = audienceService();
      const excluded = await service.userIds({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.ok(!excluded.includes(people['helped']!));
      const included = await service.userIds({ bucket: 'paid', withinDays: 7, excludeHelped: false, now: NOW });
      assert.ok(included.includes(people['helped']!));
      assert.equal(included.length, excluded.length + 1);
    });

    it('never counts a blocked person, verified or not', async () => {
      const service = audienceService();
      for (const excludeHelped of [true, false]) {
        const ids = await service.userIds({ bucket: 'paid', withinDays: 30, excludeHelped, now: NOW });
        assert.ok(!ids.includes(people['blocked']!));
      }
    });

    it('widens with the days and takes an explicit hours window for the hint audiences', async () => {
      const service = audienceService();
      const thirty = await service.userIds({ bucket: 'paid', withinDays: 30, now: NOW });
      assert.ok(thirty.includes(people['outside-7d']!), 'paid 10 days ago');
      const trialThirty = await service.userIds({ bucket: 'trial', withinDays: 30, now: NOW });
      assert.ok(trialThirty.includes(people['old-gift']!), 'granted 10 days ago');
      // Payments created between 61 h and 49 h ago, both ends inclusive.
      const hours = await service.userIds({
        bucket: 'paid',
        window: { from: new Date(NOW.getTime() - 61 * HOUR), to: new Date(NOW.getTime() - 49 * HOUR) },
        now: NOW,
      });
      assert.deepStrictEqual(names(hours), sorted(['two-subs', 'renewed-after-read', 'limited', 'partner']));
    });

    it('hands the people out oldest anchor first', async () => {
      const ids = await audienceService().userIds({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.deepStrictEqual(
        ids.map((id) => Object.entries(people).find(([, value]) => value === id)?.[0]),
        ['native', 'two-subs', 'renewed-after-read', 'limited', 'partner', 'mixed', 'combined', 'paid-trial'],
      );
    });

    it('is WP4a’s definition: the paid bucket is moneyForSubscriptionSql(s, { since }), the trial one trialBucketSql', async () => {
      // `to` is this clock's now and no row here is dated after it, so the
      // bucket's upper bound is inert and `since` alone must give the same set.
      const window = { from: new Date(NOW.getTime() - 7 * DAY), to: NOW };
      const mine = Object.values(people);
      const bucketIds = async (bucket: 'paid' | 'trial'): Promise<string[]> => {
        const rows = await prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
          SELECT "b"."subscription_id" AS "id" FROM ${connectBucketSql(bucket, window)} "b"
           WHERE "b"."user_id" = ANY(${mine}::text[])`);
        return sorted(rows.map((row) => row.id));
      };
      const paid = await prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
        SELECT "s"."id" FROM "subscriptions" "s"
         WHERE "s"."user_id" = ANY(${mine}::text[]) AND "s"."status" IN ('ACTIVE', 'LIMITED')
           AND ${moneyForSubscriptionSql('s', { since: window.from })}`);
      const trial = await prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
        SELECT "s"."id" FROM "subscriptions" "s"
         WHERE "s"."user_id" = ANY(${mine}::text[]) AND "s"."status" IN ('ACTIVE', 'LIMITED')
           AND "s"."created_at" >= ${window.from} AND "s"."created_at" <= ${window.to}
           AND ${trialBucketSql('s')}`);
      assert.deepStrictEqual(await bucketIds('paid'), sorted(paid.map((row) => row.id)));
      assert.deepStrictEqual(await bucketIds('trial'), sorted(trial.map((row) => row.id)));
      assert.ok(paid.length >= 10 && trial.length >= 5, 'both buckets are populated');
    });
  });

  describe('the once-marker a staged broadcast writes', () => {
    const NOW = new Date('2031-06-01T12:00:00.000Z');
    const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
    const query = { bucket: 'paid' as const, withinDays: 7, now: NOW };
    let one: { userId: string; subscriptionId: string };
    let twoUser: string;
    const twoSubs: string[] = [];
    let unread: { userId: string; subscriptionId: string };
    let autoHelped: { userId: string; subscriptionId: string };
    let bystander: { userId: string; subscriptionId: string };
    let trialPerson: { userId: string; subscriptionId: string };

    before(async () => {
      one = await paidPerson('m-one', ago(30 * HOUR), ago(1 * HOUR));
      twoUser = await user('m-two');
      for (const hours of [40, 20]) {
        const s = await subscription({ userId: twoUser, createdAt: ago(hours * HOUR) });
        await payment({ userId: twoUser, subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(hours * HOUR) });
        await state(s, { checkedAt: ago(1 * HOUR) });
        twoSubs.push(s);
      }
      unread = await paidPerson('m-unread', ago(30 * HOUR), null);
      autoHelped = await paidPerson('m-auto', ago(30 * HOUR), null);
      await state(autoHelped.subscriptionId, { checkedAt: ago(1 * HOUR), helpDecidedAt: ago(6 * HOUR), helpOutcome: 'bot', helpSource: 'auto' });
      bystander = await paidPerson('m-bystander', ago(30 * HOUR), ago(1 * HOUR));
      const trialUser = await user('m-trial');
      const trialSub = await subscription({ userId: trialUser, createdAt: ago(20 * HOUR), isTrial: true });
      await state(trialSub, { checkedAt: ago(1 * HOUR) });
      trialPerson = { userId: trialUser, subscriptionId: trialSub };
    });

    async function row(subscriptionId: string) {
      const rows = await prisma.$queryRaw<
        Array<{
          readonly decided_now: boolean | null;
          readonly anchor: Date | null;
          readonly help_kind: string | null;
          readonly help_source: string | null;
          readonly help_outcome: string | null;
          readonly help_attempts: unknown;
          readonly help_event_id: string | null;
          readonly updated_at: Date;
          readonly help_decided_at: Date | null;
        }>
      >(Prisma.sql`
        SELECT ("help_decided_at" = ${NOW}::timestamptz) AS "decided_now", "help_anchor_at" AS "anchor",
               "help_kind", "help_source", "help_outcome", "help_attempts", "help_event_id", "updated_at",
               "help_decided_at"
          FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}`);
      return rows[0] ?? null;
    }

    async function anchorIs(subscriptionId: string, expected: Date): Promise<boolean> {
      const rows = await prisma.$queryRaw<Array<{ readonly same: boolean }>>(Prisma.sql`
        SELECT ("help_anchor_at" = ${expected}::timestamptz) AS "same"
          FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}`);
      return rows[0]?.same === true;
    }

    it('marks the recipients’ verified subscriptions once, with the bound clock — and nothing else', async () => {
      const service = audienceService();
      const marked = await service.markHelpedByBroadcast('bc-A', query, {
        userIds: [one.userId, twoUser, unread.userId, autoHelped.userId],
      });
      assert.equal(marked, 3, 'one + both of the second person’s subscriptions');
      for (const subscriptionId of [one.subscriptionId, ...twoSubs]) {
        const marker = await row(subscriptionId);
        assert.equal(marker?.decided_now, true, 'help_decided_at is the bound Date, not SQL now()');
        assert.equal(marker?.help_source, 'broadcast:bc-A');
        assert.equal(marker?.help_outcome, 'broadcast');
        assert.equal(marker?.help_kind, 'paid');
        assert.deepStrictEqual(marker?.help_attempts, []);
        assert.equal(marker?.help_event_id, null);
      }
      assert.ok(await anchorIs(one.subscriptionId, ago(30 * HOUR)), 'anchored on the in-window payment');
      assert.equal(await row(unread.subscriptionId), null, 'an unverified subscription gets no row, let alone a marker');
      const auto = await row(autoHelped.subscriptionId);
      assert.equal(auto?.help_source, 'auto', 'the automatic sender’s marker is never overwritten');
      assert.equal(auto?.help_outcome, 'bot');
      assert.equal((await row(bystander.subscriptionId))?.help_source, null, 'not a recipient: still open to the automatic help');
    });

    it('a second staging — the same broadcast or another — changes nothing', async () => {
      const service = audienceService();
      const before = await Promise.all([one.subscriptionId, ...twoSubs].map(row));
      assert.equal(await service.markHelpedByBroadcast('bc-A', query, { userIds: [one.userId, twoUser] }), 0);
      assert.equal(await service.markHelpedByBroadcast('bc-B', query, { userIds: [one.userId, twoUser] }), 0);
      const afterRows = await Promise.all([one.subscriptionId, ...twoSubs].map(row));
      assert.deepStrictEqual(afterRows, before, 'not even updated_at moved');
    });

    it('once marked, the default audience leaves them out', async () => {
      const ids = await audienceService().userIds(query);
      assert.ok(!ids.includes(one.userId) && !ids.includes(twoUser));
      assert.ok(ids.includes(bystander.userId));
    });

    it('marks a gift as «trial», anchored on the grant', async () => {
      const marked = await audienceService().markHelpedByBroadcast(
        'bc-T',
        { bucket: 'trial', withinDays: 7, now: NOW },
        { userIds: [trialPerson.userId] },
      );
      assert.equal(marked, 1);
      assert.equal((await row(trialPerson.subscriptionId))?.help_kind, 'trial');
      assert.ok(await anchorIs(trialPerson.subscriptionId, ago(20 * HOUR)));
    });

    it('rolls back with the caller’s transaction — staging writes rows and markers together or not at all', async () => {
      const service = audienceService();
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          const marked = await service.markHelpedByBroadcast('bc-C', query, { userIds: [bystander.userId], client: tx });
          assert.equal(marked, 1, 'marked inside the transaction');
          throw new Error('the recipient rows failed');
        }),
        /the recipient rows failed/,
      );
      assert.equal((await row(bystander.subscriptionId))?.help_source, null);
    });

    it('two stagings racing for one subscription: exactly one marks it', async () => {
      const service = audienceService();
      const results = await Promise.all([
        service.markHelpedByBroadcast('bc-D', query, { userIds: [bystander.userId] }),
        service.markHelpedByBroadcast('bc-E', query, { userIds: [bystander.userId] }),
      ]);
      assert.equal(results[0] + results[1], 1, `marked ${results.join(' + ')}`);
      const source = (await row(bystander.subscriptionId))?.help_source;
      assert.ok(source === 'broadcast:bc-D' || source === 'broadcast:bc-E', String(source));
    });
  });

  describe('who counts as helped, and who switched the help off', () => {
    // Its own clock: nothing above or below can fall in these windows.
    const NOW = new Date('2031-09-01T12:00:00.000Z');
    const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
    const query = { bucket: 'paid' as const, withinDays: 7, now: NOW };
    const people: Record<string, { userId: string; subscriptionId: string }> = {};

    /** A verified paid person whose subscription the automatic sender decided with `outcome`. */
    async function decided(label: string, outcome: string | null, extra: Parameters<typeof state>[1] = {}) {
      const person = await paidPerson(label, ago(30 * HOUR), null);
      await state(person.subscriptionId, {
        checkedAt: ago(HOUR),
        helpDecidedAt: ago(5 * HOUR),
        helpOutcome: outcome,
        helpSource: 'auto',
        ...extra,
      });
      people[label] = person;
    }

    before(async () => {
      // NOT helped: the automatic sender decided, and sent nothing.
      await decided('template-off', 'skipped_template_off', {
        helpAttempts: [{ channel: 'bot', result: 'template_off', at: ago(5 * HOUR).toISOString() }],
        helpEventId: 'evt-template-off',
      });
      await decided('unverifiable', 'skipped_unverifiable');
      // A terminal value this spec has never heard of: the allowlist puts it
      // on the not-helped side without anybody listing it.
      await decided('future-skip', 'skipped_some_later_reason');
      // HELPED: help went out, merged into a sibling's, the customer said no,
      // or a ladder still in flight (decided, no outcome yet).
      await decided('bot', 'bot');
      await decided('merged', 'merged');
      await decided('said-no', 'opted_out');
      await decided('in-flight', null);
      // Switched «Помощь с подключением» off in the cabinet: never named.
      people['opted-out'] = await paidPerson('opted-out', ago(30 * HOUR), ago(HOUR), { prefs: { connect_help: false } });
      people['opted-out-unread'] = await paidPerson('opted-out-unread', ago(30 * HOUR), null, {
        prefs: { connect_help: false, payment_failed: true },
      });
      // Other switches, or connect_help anything but JSON false: still in —
      // exactly what `connectHelpOptedOut` reads.
      people['other-switch'] = await paidPerson('other-switch', ago(30 * HOUR), ago(HOUR), { prefs: { payment_failed: false } });
      people['explicit-on'] = await paidPerson('explicit-on', ago(30 * HOUR), ago(HOUR), { prefs: { connect_help: true } });
      people['string-false'] = await paidPerson('string-false', ago(30 * HOUR), ago(HOUR), { prefs: { connect_help: 'false' } });
    });

    const everybody = (): string[] => Object.values(people).map((person) => person.userId);
    const names = (ids: readonly string[]): string[] =>
      sorted(ids.map((id) => Object.entries(people).find(([, person]) => person.userId === id)?.[0] ?? `foreign:${id}`));
    const mine = (ids: readonly string[]): string[] => ids.filter((id) => everybody().includes(id));

    async function row(subscriptionId: string) {
      const rows = await prisma.$queryRaw<
        Array<{
          readonly decided_now: boolean | null;
          readonly help_source: string | null;
          readonly help_outcome: string | null;
          readonly help_attempts: unknown;
          readonly help_event_id: string | null;
        }>
      >(Prisma.sql`
        SELECT ("help_decided_at" = ${NOW}::timestamptz) AS "decided_now", "help_source", "help_outcome",
               "help_attempts", "help_event_id"
          FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}`);
      return rows[0] ?? null;
    }

    it('«Не слать тем, кому уже помогли» drops exactly the HELPED — a decision that sent nothing stays in', async () => {
      const ids = mine(await audienceService().userIds(query));
      assert.deepStrictEqual(
        names(ids),
        sorted(['template-off', 'unverifiable', 'future-skip', 'other-switch', 'explicit-on', 'string-false']),
      );
    });

    it('with the helped kept, the helped and the in-flight come back — the opted-out never do', async () => {
      const ids = mine(await audienceService().userIds({ ...query, excludeHelped: false }));
      assert.deepStrictEqual(
        names(ids),
        sorted([
          'template-off', 'unverifiable', 'future-skip', 'bot', 'merged', 'said-no', 'in-flight',
          'other-switch', 'explicit-on', 'string-false',
        ]),
      );
    });

    it('somebody who switched the help off is in neither count — verified or not', async () => {
      // The window holds only this block's people (the clock is its own).
      const counts = await audienceService().counts({ ...query, excludeHelped: false });
      assert.deepStrictEqual([counts.verified, counts.unverified], [10, 0], 'opted-out-unread is not "not verified"');
    });

    it('the marker takes over a row the automatic sender skipped, and never a helped or an in-flight one', async () => {
      const marked = await audienceService().markHelpedByBroadcast('bc-H', { ...query, excludeHelped: false }, { userIds: everybody() });
      assert.equal(marked, 6, 'three skipped rows and three undecided ones (other-switch, explicit-on, string-false)');

      const takenOver = await row(people['template-off']!.subscriptionId);
      assert.deepStrictEqual(takenOver, {
        decided_now: true,
        help_source: 'broadcast:bc-H',
        help_outcome: 'broadcast',
        help_attempts: [],
        help_event_id: null,
      }, 'the skipped ladder’s bookkeeping is not left under the broadcast’s outcome');
      for (const label of ['unverifiable', 'future-skip', 'other-switch', 'explicit-on', 'string-false']) {
        assert.equal((await row(people[label]!.subscriptionId))?.help_source, 'broadcast:bc-H', label);
      }
      for (const [label, outcome] of [['bot', 'bot'], ['merged', 'merged'], ['said-no', 'opted_out'], ['in-flight', null]] as const) {
        const untouched = await row(people[label]!.subscriptionId);
        assert.equal(untouched?.help_source, 'auto', `${label} was overwritten`);
        assert.equal(untouched?.help_outcome, outcome, label);
        assert.equal(untouched?.decided_now, false, label);
      }
      assert.equal((await row(people['opted-out']!.subscriptionId))?.help_source, null, 'a person who switched the help off was marked');
    });

    it('and once it is the broadcast’s, the default audience leaves it out like any help', async () => {
      const ids = mine(await audienceService().userIds(query));
      assert.deepStrictEqual(ids, []);
    });

    it('the marker and the automatic claim racing for one row: exactly one wins, and the row is the winner’s', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const person = await paidPerson(`race-${attempt}`, ago(30 * HOUR), ago(HOUR));
        const [marked, claimed] = await Promise.all([
          audienceService().markHelpedByBroadcast(`bc-R${attempt}`, query, { userIds: [person.userId] }),
          sweepClaims(person.subscriptionId, NOW),
        ]);
        assert.equal(marked + claimed, 1, `attempt ${attempt}: marked ${marked}, claimed ${claimed}`);
        const final = await row(person.subscriptionId);
        if (marked === 1) {
          assert.deepStrictEqual([final?.help_source, final?.help_outcome], [`broadcast:bc-R${attempt}`, 'broadcast']);
        } else {
          assert.deepStrictEqual([final?.help_source, final?.help_outcome], ['auto', null], 'the marker overwrote a claim in flight');
        }
      }
    });
  });

  describe('the 20 000 cap', () => {
    const NOW = new Date('2032-01-10T12:00:00.000Z');
    const paidAt = new Date(NOW.getTime() - DAY);
    const checkedAt = new Date(NOW.getTime() - HOUR);
    const capPrefix = `${prefix}-cap`;

    async function seed(from: number, to: number): Promise<void> {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "users" ("id", "referral_code", "updated_at")
        SELECT ${capPrefix} || '-u-' || g, ${capPrefix} || '-r-' || g, ${NOW}::timestamptz
          FROM generate_series(${from}::int, ${to}::int) "g"`);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "subscriptions" ("id", "user_id", "status", "is_trial", "plan_snapshot", "remnawave_id",
                                     "created_at", "updated_at")
        SELECT ${capPrefix} || '-s-' || g, ${capPrefix} || '-u-' || g, 'ACTIVE'::"SubscriptionStatus", false,
               '{"name":"Standard"}'::jsonb, ${capPrefix} || '-s-' || g, ${paidAt}::timestamptz, ${paidAt}::timestamptz
          FROM generate_series(${from}::int, ${to}::int) "g"`);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "transactions" ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type",
                                    "gateway_type", "currency", "amount", "plan_snapshot", "fulfilled_at",
                                    "created_at", "updated_at")
        SELECT ${capPrefix} || '-t-' || g, ${capPrefix} || '-p-' || g, ${capPrefix} || '-u-' || g,
               ${capPrefix} || '-s-' || g, 'COMPLETED'::"TransactionStatus", 'NEW'::"PurchaseType",
               'PLATEGA'::"PaymentGatewayType", 'RUB'::"Currency", 499, '{}'::jsonb, ${paidAt}::timestamptz,
               ${paidAt}::timestamptz, ${paidAt}::timestamptz
          FROM generate_series(${from}::int, ${to}::int) "g"`);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_connect_states" ("subscription_id", "checked_at", "created_at", "updated_at")
        SELECT ${capPrefix} || '-s-' || g, ${checkedAt}::timestamptz, ${checkedAt}::timestamptz, ${checkedAt}::timestamptz
          FROM generate_series(${from}::int, ${to}::int) "g"`);
    }

    it('hands out exactly 20 000 people', async () => {
      await seed(1, CONNECT_AUDIENCE_MAX_USERS);
      const service = audienceService();
      const ids = await service.userIds({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.equal(ids.length, CONNECT_AUDIENCE_MAX_USERS);
      const resolution = await service.resolve({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.equal(resolution.userIds?.length, CONNECT_AUDIENCE_MAX_USERS);
      assert.equal(resolution.verified, CONNECT_AUDIENCE_MAX_USERS);
    });

    it('refuses the 20 001st with the design’s sentence — never a silent first 20 000', async () => {
      await seed(CONNECT_AUDIENCE_MAX_USERS + 1, CONNECT_AUDIENCE_MAX_USERS + 1);
      const service = audienceService();
      await assert.rejects(
        service.userIds({ bucket: 'paid', withinDays: 7, now: NOW }),
        (error: unknown) =>
          error instanceof ConnectAudienceTooLargeError &&
          error.message === CONNECT_AUDIENCE_TOO_LARGE_MESSAGE &&
          error.verified === CONNECT_AUDIENCE_MAX_USERS + 1 &&
          error.limit === CONNECT_AUDIENCE_MAX_USERS,
      );
      const resolution = await service.resolve({ bucket: 'paid', withinDays: 7, now: NOW });
      assert.equal(resolution.userIds, null, 'no list over the cap');
      assert.equal(resolution.verified, CONNECT_AUDIENCE_MAX_USERS + 1, 'the count is still exact');
    });
  });

  describe('staging a «не подключился» broadcast, end to end', () => {
    const broadcastId = `${prefix}-bc-stage`;
    let recipient: { userId: string; subscriptionId: string };
    let otherPlatform: { userId: string; subscriptionId: string };
    let unread: { userId: string; subscriptionId: string };
    const events: Array<{ readonly type: string; readonly severity: string }> = [];

    before(async () => {
      // The real clock: `stageRecipients` reads it.
      const now = Date.now();
      recipient = await paidPerson('stage-recipient', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'tma' });
      // Verified too, but the operator's platform chip leaves them out: not a
      // recipient, so their subscription must stay open to the automatic help.
      otherPlatform = await paidPerson('stage-browser', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'browser' });
      unread = await paidPerson('stage-unread', new Date(now - 30 * HOUR), null, { surface: 'tma' });
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "broadcasts" ("id", "status", "audience", "audience_filter", "payload", "created_at", "updated_at")
        VALUES (${broadcastId}, 'DRAFT'::"BroadcastStatus", 'ACTIVE_SUBSCRIBERS'::"BroadcastAudience",
                ${JSON.stringify({
                  subscription: ['ACTIVE', 'LIMITED'],
                  platforms: ['miniapp'],
                  connect: { bucket: 'paid', withinDays: 7, excludeHelped: true },
                })}::jsonb,
                ${JSON.stringify({ text: 'Не получилось подключиться?' })}::jsonb, ${new Date()}, ${new Date()})`);
    });

    function delivery(): BroadcastDeliveryService {
      const record = (severity: string) => (type: string) => {
        events.push({ type, severity });
      };
      return new BroadcastDeliveryService(
        prisma,
        { get: () => undefined } as never,
        { info: record('info'), warn: record('warn'), error: record('error') } as never,
        {} as never,
        {} as never,
        { isEnabled: false } as never,
        { isEnabled: false } as never,
        new BroadcastService(prisma, audienceService()),
      );
    }

    async function marker(subscriptionId: string) {
      const rows = await prisma.$queryRaw<Array<{ readonly help_source: string | null; readonly help_outcome: string | null; readonly help_kind: string | null; readonly updated_at: Date }>>(
        Prisma.sql`SELECT "help_source", "help_outcome", "help_kind", "updated_at"
                     FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}`,
      );
      return rows[0] ?? null;
    }

    it('stages the verified people the other chips allow, and marks exactly their subscriptions', async () => {
      const messageIds = await delivery().stageRecipients(broadcastId);
      const rows = await prisma.$queryRaw<Array<{ readonly user_id: string }>>(Prisma.sql`
        SELECT "user_id" FROM "broadcast_messages" WHERE "broadcast_id" = ${broadcastId}`);
      const mine = rows.map((r) => r.user_id).filter((id) => id.startsWith(prefix));
      assert.deepStrictEqual(mine, [recipient.userId]);
      assert.equal(messageIds.length, rows.length);

      const marked = await marker(recipient.subscriptionId);
      assert.equal(marked?.help_source, `broadcast:${broadcastId}`);
      assert.equal(marked?.help_outcome, 'broadcast');
      assert.equal(marked?.help_kind, 'paid');
      assert.equal((await marker(otherPlatform.subscriptionId))?.help_source, null, 'verified, but no message: unmarked');
      assert.equal(await marker(unread.subscriptionId), null);

      const status = await prisma.$queryRaw<Array<{ readonly status: string; readonly total_count: number }>>(
        Prisma.sql`SELECT "status"::text AS "status", "total_count" FROM "broadcasts" WHERE "id" = ${broadcastId}`,
      );
      assert.deepStrictEqual(status[0], { status: 'PROCESSING', total_count: rows.length });
      // Staging is not the automatic moment: no «не подключился» event, no error.
      assert.ok(events.every((event) => event.type !== 'subscription.not_connected'));
      assert.ok(events.every((event) => event.severity !== 'error'), JSON.stringify(events));
      assert.ok(events.some((event) => event.type === EVENT_TYPES.BROADCAST_STARTED));
    });

    it('a retried start job resumes, and marks nothing twice', async () => {
      const before = await marker(recipient.subscriptionId);
      await delivery().stageRecipients(broadcastId);
      const afterMarker = await marker(recipient.subscriptionId);
      assert.deepStrictEqual(afterMarker, before);
      const count = await prisma.$queryRaw<Array<{ readonly n: number }>>(
        Prisma.sql`SELECT count(*)::int AS "n" FROM "broadcast_messages" WHERE "broadcast_id" = ${broadcastId} AND "user_id" = ${recipient.userId}`,
      );
      assert.equal(count[0]?.n, 1, 'one message row, not two');
    });
  });

  describe('staging after the world moved: resolved before the claim, narrowed in the staging transaction', () => {
    const events: Array<{ readonly type: string; readonly severity: string }> = [];

    async function broadcastRow(id: string, excludeHelped: boolean): Promise<void> {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "broadcasts" ("id", "status", "audience", "audience_filter", "payload", "created_at", "updated_at")
        VALUES (${id}, 'DRAFT'::"BroadcastStatus", 'ACTIVE_SUBSCRIBERS'::"BroadcastAudience",
                ${JSON.stringify({ subscription: ['ACTIVE', 'LIMITED'], connect: { bucket: 'paid', withinDays: 7, excludeHelped } })}::jsonb,
                ${JSON.stringify({ text: 'Не получилось подключиться?' })}::jsonb, ${new Date()}, ${new Date()})`);
    }

    /**
     * Staging whose audience is resolved by the real `checkConnectAudience`,
     * and then — before the claim, the channel post and the recipient rows —
     * `meanwhile` runs: the seconds in which the rest of the panel moves.
     */
    function delivery(meanwhile: () => Promise<void>, resolved: string[][]): BroadcastDeliveryService {
      const broadcasts = new BroadcastService(prisma, audienceService());
      const check = broadcasts.checkConnectAudience.bind(broadcasts);
      broadcasts.checkConnectAudience = async (connect, now) => {
        const verdict = await check(connect, now);
        if (verdict.ok) resolved.push([...verdict.userIds]);
        await meanwhile();
        return verdict;
      };
      const record = (severity: string) => (type: string) => {
        events.push({ type, severity });
      };
      return new BroadcastDeliveryService(
        prisma,
        { get: () => undefined } as never,
        { info: record('info'), warn: record('warn'), error: record('error') } as never,
        {} as never,
        {} as never,
        { isEnabled: false } as never,
        { isEnabled: false } as never,
        broadcasts,
      );
    }

    /**
     * Every user staged for the broadcast. The audience is the real one on the
     * real clock, so people other cases of this file left verified may be in
     * it too; each case asserts on its own people, and on the total against
     * the rows actually written.
     */
    async function stagedUsers(broadcastId: string): Promise<string[]> {
      const rows = await prisma.$queryRaw<Array<{ readonly user_id: string }>>(Prisma.sql`
        SELECT "user_id" FROM "broadcast_messages" WHERE "broadcast_id" = ${broadcastId}`);
      return rows.map((r) => r.user_id);
    }

    async function totalCount(broadcastId: string): Promise<{ readonly status: string; readonly total_count: number } | undefined> {
      const rows = await prisma.$queryRaw<Array<{ readonly status: string; readonly total_count: number }>>(
        Prisma.sql`SELECT "status"::text AS "status", "total_count" FROM "broadcasts" WHERE "id" = ${broadcastId}`,
      );
      return rows[0];
    }

    async function marker(subscriptionId: string) {
      const rows = await prisma.$queryRaw<Array<{ readonly help_source: string | null; readonly help_outcome: string | null }>>(
        Prisma.sql`SELECT "help_source", "help_outcome" FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}`,
      );
      return rows[0] ?? null;
    }

    it('the automatic help claims one in between, another connects, a third switches the help off: only the fourth is staged', async () => {
      const broadcastId = `${prefix}-bc-race`;
      const now = Date.now();
      const claimed = await paidPerson('race-claimed', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'tma' });
      const connected = await paidPerson('race-connected', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'tma' });
      const optingOut = await paidPerson('race-opting-out', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'tma' });
      const stays = await paidPerson('race-stays', new Date(now - 30 * HOUR), new Date(now - HOUR), { surface: 'tma' });
      await broadcastRow(broadcastId, true);
      const resolved: string[][] = [];

      await delivery(async () => {
        assert.equal(await sweepClaims(claimed.subscriptionId, new Date()), 1, 'the automatic help claims it');
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "subscription_connect_states"
             SET "first_connected_at" = ${new Date()}::timestamptz, "connected_source" = 'webhook'
           WHERE "subscription_id" = ${connected.subscriptionId}`);
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "users" SET "notification_prefs" = '{"connect_help": false}'::jsonb WHERE "id" = ${optingOut.userId}`);
      }, resolved).stageRecipients(broadcastId);

      const four = [claimed.userId, connected.userId, optingOut.userId, stays.userId];
      assert.deepStrictEqual(
        sorted((resolved[0] ?? []).filter((id) => four.includes(id))),
        sorted(four),
        'all four were in the audience as it was resolved',
      );
      const staged = await stagedUsers(broadcastId);
      assert.deepStrictEqual(staged.filter((id) => four.includes(id)), [stays.userId]);
      assert.deepStrictEqual(
        await totalCount(broadcastId),
        { status: 'PROCESSING', total_count: staged.length },
        'the total is the rows written, not the list resolved',
      );
      assert.ok(staged.length < (resolved[0] ?? []).length, 'narrowed, so smaller than the resolved list');
      assert.deepStrictEqual(await marker(claimed.subscriptionId), { help_source: 'auto', help_outcome: null }, 'the claim in flight was overwritten');
      assert.equal((await marker(connected.subscriptionId))?.help_source, null, 'a connected customer was marked');
      assert.equal((await marker(optingOut.subscriptionId))?.help_source, null, 'somebody who switched the help off was marked');
      assert.deepStrictEqual(await marker(stays.subscriptionId), { help_source: `broadcast:${broadcastId}`, help_outcome: 'broadcast' });
      assert.ok(events.every((event) => event.severity !== 'error'), JSON.stringify(events));
    });

    it('with the helped kept, a claim in between still gets the message — a connection in between still does not', async () => {
      const broadcastId = `${prefix}-bc-race-kept`;
      const now = Date.now();
      const claimed = await paidPerson('kept-claimed', new Date(now - 30 * HOUR), new Date(now - HOUR));
      const connected = await paidPerson('kept-connected', new Date(now - 30 * HOUR), new Date(now - HOUR));
      await broadcastRow(broadcastId, false);

      await delivery(async () => {
        assert.equal(await sweepClaims(claimed.subscriptionId, new Date()), 1);
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "subscription_connect_states"
             SET "first_connected_at" = ${new Date()}::timestamptz, "connected_source" = 'probe'
           WHERE "subscription_id" = ${connected.subscriptionId}`);
      }, []).stageRecipients(broadcastId);

      const staged = await stagedUsers(broadcastId);
      assert.deepStrictEqual(staged.filter((id) => id === claimed.userId || id === connected.userId), [claimed.userId]);
      assert.deepStrictEqual(await marker(claimed.subscriptionId), { help_source: 'auto', help_outcome: null }, 'still the sender’s');
      assert.equal((await totalCount(broadcastId))?.total_count, staged.length);
    });
  });
});
