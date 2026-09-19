import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  connectHelpFlags,
  dismissConnectHelpBanner,
  hasPendingConnectHelp,
  recordCheck,
  recordConnectEvidence,
  recordProbeFailure,
  recordProfileMissing,
} from '../src/modules/connect-signal/connect-evidence.util';
import {
  coverageSql,
  lastUserWebhookSql,
  probeBacklogSql,
  probeCandidatesSql,
  type ProbeCandidateRow,
} from '../src/modules/connect-signal/connect-probe.sql';
import { pendingHelpSql, verifiedNotConnectedSql } from '../src/modules/connect-signal/connect-sql';
import { ConnectSignalProbeService } from '../src/modules/connect-signal/services/connect-signal-probe.service';
import {
  panelIdentityWhere,
  RemnawaveWebhookService,
} from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * The connection signal against a real PostgreSQL: the writers' upserts, the
 * fan-out over duplicate rows, the cascade, the probe's candidate query and a
 * whole probe cycle — the properties no double can prove.
 *
 * Run it on a database whose `TimeZone` is not UTC as well as on a UTC one:
 * Prisma's pg adapter binds a `Date` as UTC wall time with no offset, so a
 * statement that compared stored times with SQL `now()` would be off by the
 * zone's offset there. The verification-window cases below are written to fail
 * in exactly that case.
 *
 * ISOLATION. CI runs every PostgreSQL spec on one shared database, and the
 * probe reads every eligible row of it. So the probe's cases run at a "now"
 * 400 days ahead: only rows this spec creates, dated relative to that "now",
 * fall inside its 30-day horizon, and nothing it writes lands on another spec's
 * rows.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `csig-${process.pid}-${Date.now()}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A "now" no other spec's rows can reach: see ISOLATION above. */
const FAR_NOW = new Date(Date.now() + 400 * DAY);
/** Panel ids unique to this run, inside a 32-bit `integer`. */
let nextPanelId = 1_500_000_000 + (process.pid % 10_000) * 1_000 + (Date.now() % 997);

let prisma: PrismaService;
let userId: string;
let otherUserId: string;
let seq = 0;

function id(label: string): string {
  seq += 1;
  return `${prefix}-${label}-${seq}`;
}

function panelIdentity(): number {
  nextPanelId += 1;
  return nextPanelId;
}

async function insertUser(): Promise<string> {
  const userKey = id('user');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "updated_at")
    VALUES (${userKey}, ${`${userKey}-ref`}, ${new Date()})
  `);
  return userKey;
}

interface SubInput {
  readonly owner?: string;
  readonly remnawaveId?: string | null;
  readonly panelId?: number | null;
  readonly status?: 'ACTIVE' | 'LIMITED' | 'EXPIRED' | 'DELETED' | 'DISABLED';
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

async function insertSubscription(label: string, input: SubInput = {}): Promise<string> {
  const subscriptionId = id(label);
  const createdAt = input.createdAt ?? new Date();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscriptions"
      ("id", "user_id", "status", "remnawave_id", "remnawave_panel_id", "created_at", "updated_at")
    VALUES (${subscriptionId}, ${input.owner ?? userId}, ${input.status ?? 'ACTIVE'}::"SubscriptionStatus",
            ${input.remnawaveId === undefined ? String(panelIdentity()) : input.remnawaveId},
            ${input.panelId ?? null}::integer, ${createdAt}, ${input.updatedAt ?? createdAt})
  `);
  return subscriptionId;
}

async function insertPayment(input: {
  readonly subscriptionId: string | null;
  readonly createdAt: Date;
  readonly purchaseType?: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
}): Promise<string> {
  const paymentKey = id('tx');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type", "gateway_type", "currency",
       "amount", "plan_snapshot", "fulfilled_at", "created_at", "updated_at")
    VALUES (${paymentKey}, ${`${paymentKey}-pay`}, ${userId}, ${input.subscriptionId},
            'COMPLETED'::"TransactionStatus", ${input.purchaseType ?? 'NEW'}::"PurchaseType",
            'PLATEGA'::"PaymentGatewayType", 'RUB'::"Currency", 499, '{}'::jsonb,
            ${input.createdAt}, ${input.createdAt}, ${input.createdAt})
  `);
  return paymentKey;
}

interface StateRow {
  readonly first_connected_at: Date | null;
  readonly connected_source: string | null;
  readonly checked_at: Date | null;
  readonly check_failures: number;
  readonly profile_missing_at: Date | null;
  readonly banner_dismissed_at: Date | null;
}

async function stateOf(subscriptionId: string): Promise<StateRow | null> {
  const rows = await prisma.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT "first_connected_at", "connected_source", "checked_at", "check_failures", "profile_missing_at",
           "banner_dismissed_at"
      FROM "subscription_connect_states" WHERE "subscription_id" = ${subscriptionId}
  `);
  return rows[0] ?? null;
}

async function setHelp(
  subscriptionId: string,
  help: { readonly outcome: string | null; readonly firstConnectedAt?: Date | null },
): Promise<void> {
  const now = new Date();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states"
      ("subscription_id", "help_decided_at", "help_outcome", "first_connected_at", "created_at", "updated_at")
    VALUES (${subscriptionId}, ${now}, ${help.outcome}, ${help.firstConnectedAt ?? null}::timestamptz, ${now}, ${now})
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "help_outcome" = EXCLUDED."help_outcome",
      "help_decided_at" = EXCLUDED."help_decided_at",
      "first_connected_at" = EXCLUDED."first_connected_at",
      "updated_at" = EXCLUDED."updated_at"
  `);
}

async function setState(
  subscriptionId: string,
  columns: {
    readonly checkedAt?: Date | null;
    readonly checkFailures?: number;
    readonly profileMissingAt?: Date | null;
    readonly firstConnectedAt?: Date | null;
    readonly updatedAt?: Date;
  },
): Promise<void> {
  const updatedAt = columns.updatedAt ?? new Date();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states"
      ("subscription_id", "checked_at", "check_failures", "profile_missing_at", "first_connected_at",
       "created_at", "updated_at")
    VALUES (${subscriptionId}, ${columns.checkedAt ?? null}::timestamptz, ${columns.checkFailures ?? 0},
            ${columns.profileMissingAt ?? null}::timestamptz, ${columns.firstConnectedAt ?? null}::timestamptz,
            ${updatedAt}, ${updatedAt})
  `);
}

run('the connection signal in PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    userId = await insertUser();
    otherUserId = await insertUser();
    const zone = await prisma.$queryRaw<Array<{ readonly tz: string }>>(
      Prisma.sql`SELECT current_setting('TimeZone') AS "tz"`,
    );
    // Stated, not asserted: the same file is meant to pass in any zone.
    console.log(`[connect-signal-postgres] database TimeZone = ${zone[0]?.tz}`);
  });

  after(async () => {
    const like = `${prefix}-%`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "remnawave_webhook_events" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${like}`);
    await prisma.$disconnect();
  });

  describe('the writers', () => {
    it('keeps the EARLIEST connection whatever order the writers arrive in, racing included', async () => {
      const early = new Date(Date.now() - 3 * DAY);
      const late = new Date(Date.now() - 1 * DAY);
      for (let round = 0; round < 5; round += 1) {
        const subscriptionId = await insertSubscription('race');
        const target = { id: subscriptionId };
        const writers = [
          () => recordConnectEvidence(prisma, { subscriptions: target, at: late, source: 'probe', checkedAt: late }),
          () => recordConnectEvidence(prisma, { subscriptions: target, at: early, source: 'webhook', checkedAt: early }),
          () => recordConnectEvidence(prisma, { subscriptions: target, at: late, source: 'cabinet', checkedAt: late }),
        ];
        const order = round % 2 === 0 ? writers : [...writers].reverse();
        await Promise.all(order.map((write) => write()));

        const state = await stateOf(subscriptionId);
        assert.equal(state?.first_connected_at?.toISOString(), early.toISOString(), `round ${round}`);
        assert.equal(state?.connected_source, 'webhook', 'named by whoever proved the earliest time');
        assert.equal(state?.checked_at?.toISOString(), late.toISOString(), 'the clock keeps the latest read');
      }
    });

    it('lowers a later first connection to an earlier one, and never raises it', async () => {
      const subscriptionId = await insertSubscription('lower');
      const target = { id: subscriptionId };
      const t2 = new Date(Date.now() - 2 * HOUR);
      const t1 = new Date(Date.now() - 5 * HOUR);

      await recordConnectEvidence(prisma, { subscriptions: target, at: t2, source: 'cabinet', checkedAt: t2 });
      await recordConnectEvidence(prisma, { subscriptions: target, at: t1, source: 'probe', checkedAt: null });
      await recordConnectEvidence(prisma, { subscriptions: target, at: t2, source: 'webhook', checkedAt: null });

      const state = await stateOf(subscriptionId);
      assert.equal(state?.first_connected_at?.toISOString(), t1.toISOString());
      assert.equal(state?.connected_source, 'probe');
      assert.equal(state?.checked_at?.toISOString(), t2.toISOString(), 'evidence without a block verifies nothing');
    });

    it('moves the verification clock forward only; failures and "missing" give way to a successful read', async () => {
      const subscriptionId = await insertSubscription('clock');
      const target = { id: subscriptionId };
      const base = Date.now();
      const t = (hoursAgo: number) => new Date(base - hoursAgo * HOUR);

      await recordProbeFailure(prisma, subscriptionId, t(6));
      await recordProbeFailure(prisma, subscriptionId, t(5));
      assert.equal((await stateOf(subscriptionId))?.check_failures, 2);
      assert.equal((await stateOf(subscriptionId))?.checked_at, null, 'a failure verifies nothing');

      await recordProfileMissing(prisma, subscriptionId, t(4));
      let state = await stateOf(subscriptionId);
      assert.equal(state?.profile_missing_at?.toISOString(), t(4).toISOString());
      assert.equal(state?.check_failures, 0, 'the panel answered');

      await recordCheck(prisma, { subscriptions: target, checkedAt: t(3) });
      state = await stateOf(subscriptionId);
      assert.equal(state?.checked_at?.toISOString(), t(3).toISOString());
      assert.equal(state?.profile_missing_at, null, 'a later successful read clears "missing"');

      await recordCheck(prisma, { subscriptions: target, checkedAt: t(9) });
      assert.equal((await stateOf(subscriptionId))?.checked_at?.toISOString(), t(3).toISOString());
    });

    it('leaves a connected row alone on "not connected", and creates a row where there was none', async () => {
      const connected = await insertSubscription('connected');
      const fresh = await insertSubscription('fresh');
      const connectedAt = new Date(Date.now() - DAY);
      await recordConnectEvidence(prisma, {
        subscriptions: { id: connected },
        at: connectedAt,
        source: 'webhook',
        checkedAt: connectedAt,
      });

      const written = await recordCheck(prisma, {
        subscriptions: { id: { in: [connected, fresh] } },
        checkedAt: new Date(),
      });

      assert.deepStrictEqual([...written], [fresh]);
      assert.equal((await stateOf(connected))?.checked_at?.toISOString(), connectedAt.toISOString());
      assert.equal((await stateOf(connected))?.first_connected_at?.toISOString(), connectedAt.toISOString());
      assert.notEqual((await stateOf(fresh))?.checked_at, null);
    });

    it('lands on both rows of a 2.x/3.x duplicate pair — never on a deleted row or a stranger', async () => {
      const panelId = panelIdentity();
      const stale = await insertSubscription('pair-2x', {
        remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        panelId,
      });
      const current = await insertSubscription('pair-3x', { remnawaveId: String(panelId) });
      const deleted = await insertSubscription('pair-deleted', { remnawaveId: String(panelId), status: 'DELETED' });
      const stranger = await insertSubscription('stranger', { remnawaveId: String(panelId + 1) });

      const written = await recordConnectEvidence(prisma, {
        subscriptions: panelIdentityWhere(String(panelId)),
        at: new Date(),
        source: 'webhook',
        checkedAt: new Date(),
      });

      assert.deepStrictEqual([...written].sort(), [current, stale].sort());
      assert.equal(await stateOf(deleted), null);
      assert.equal(await stateOf(stranger), null);
    });

    it('the webhook, end to end: a 3.x first connection marks both rows of the pair', async () => {
      const panelId = panelIdentity();
      const stale = await insertSubscription('hook-2x', { remnawaveId: '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30', panelId });
      const current = await insertSubscription('hook-3x', { remnawaveId: String(panelId) });
      const service = new RemnawaveWebhookService(
        prisma,
        { webhookSecret: null } as never,
        { emit: () => undefined, info: () => undefined } as never,
        { getPanelUserUsage: async () => null } as never,
        { build: async () => ({}) } as never,
        { create: async () => undefined } as never,
      );
      const firstConnectedAt = new Date(Date.now() - 2 * MIN);
      const profileName = `${prefix}-pair`;

      await service.handleEvent(
        'user.first_connected',
        {
          scope: 'user',
          event: 'user.first_connected',
          timestamp: new Date(Date.now() - MIN).toISOString(),
          data: {
            id: panelId,
            username: profileName,
            status: 'ACTIVE',
            userTraffic: {
              usedTrafficBytes: 119,
              lifetimeUsedTrafficBytes: 119,
              onlineAt: firstConnectedAt.toISOString(),
              firstConnectedAt: firstConnectedAt.toISOString(),
              lastConnectedNodeUuid: null,
            },
          },
          meta: { notConnectedAfterHours: null },
        },
        null,
      );
      // The event row the webhook stores for every event — this spec's own.
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "remnawave_webhook_events" SET "id" = ${id('event')}
         WHERE "payload"->'data'->>'username' = ${profileName}
      `);

      for (const subscriptionId of [stale, current]) {
        const state = await stateOf(subscriptionId);
        assert.equal(state?.first_connected_at?.toISOString(), firstConnectedAt.toISOString(), subscriptionId);
        assert.equal(state?.connected_source, 'webhook');
      }
    });

    it('goes with its subscription: deleting the subscription deletes its state', async () => {
      const subscriptionId = await insertSubscription('cascade');
      await recordCheck(prisma, { subscriptions: { id: subscriptionId }, checkedAt: new Date() });
      assert.notEqual(await stateOf(subscriptionId), null);

      await prisma.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" = ${subscriptionId}`);

      assert.equal(await stateOf(subscriptionId), null);
    });

    it('keeps the first dismissal, however often the × is pressed', async () => {
      const subscriptionId = await insertSubscription('dismiss');
      const first = new Date(Date.now() - HOUR);

      await dismissConnectHelpBanner(prisma, subscriptionId, first);
      await dismissConnectHelpBanner(prisma, subscriptionId, new Date());

      assert.equal((await stateOf(subscriptionId))?.banner_dismissed_at?.toISOString(), first.toISOString());
    });
  });

  describe('pending help', () => {
    it('is pending exactly after help was given, on a live subscription that never connected', async () => {
      const person = await insertUser();
      assert.equal(await hasPendingConnectHelp(prisma, person), false, 'no subscription, nothing pending');

      const live = await insertSubscription('pending-live', { owner: person });
      await setHelp(live, { outcome: 'merged' });
      assert.equal(await hasPendingConnectHelp(prisma, person), false, 'merged is not help given');

      await setHelp(live, { outcome: 'push' });
      assert.equal(await hasPendingConnectHelp(prisma, person), true);

      await recordConnectEvidence(prisma, {
        subscriptions: { id: live },
        at: new Date(),
        source: 'cabinet',
        checkedAt: new Date(),
      });
      assert.equal(await hasPendingConnectHelp(prisma, person), false, 'connected since');

      const expired = await insertSubscription('pending-expired', { owner: person, status: 'EXPIRED' });
      await setHelp(expired, { outcome: 'banner' });
      assert.equal(await hasPendingConnectHelp(prisma, person), false, 'an expired subscription waits for nothing');

      const other = await insertSubscription('pending-other', { owner: otherUserId });
      await setHelp(other, { outcome: 'bot' });
      assert.equal(await hasPendingConnectHelp(prisma, person), false, 'someone else’s help is not this person’s');
    });

    it('the SQL definition and the payload’s agree on every outcome, connected or not', async () => {
      const outcomes = [null, 'bot', 'push', 'email', 'banner', 'broadcast', 'opted_out', 'merged', 'skipped_unverifiable', 'skipped_template_off'];
      const cases: Array<{ readonly id: string; readonly outcome: string | null; readonly connected: boolean }> = [];
      for (const outcome of outcomes) {
        for (const connected of [false, true]) {
          const subscriptionId = await insertSubscription(`agree-${outcome ?? 'none'}-${connected}`);
          await setHelp(subscriptionId, { outcome, firstConnectedAt: connected ? new Date() : null });
          cases.push({ id: subscriptionId, outcome, connected });
        }
      }

      const rows = await prisma.$queryRaw<Array<{ readonly id: string; readonly pending: boolean }>>(Prisma.sql`
        SELECT "c"."subscription_id" AS "id", ${pendingHelpSql('c')} AS "pending"
          FROM "subscription_connect_states" "c"
         WHERE "c"."subscription_id" IN (${Prisma.join(cases.map((c) => c.id))})
      `);
      const sql = new Map(rows.map((row) => [row.id, row.pending]));
      let pendingCount = 0;
      for (const item of cases) {
        const flags = connectHelpFlags({
          state: { firstConnectedAt: item.connected ? new Date() : null, helpOutcome: item.outcome, bannerDismissedAt: null },
          connectedNow: false,
          status: 'ACTIVE',
          optedOut: false,
        });
        const payloadPending = flags?.pending === true;
        if (payloadPending) pendingCount += 1;
        assert.equal(sql.get(item.id), payloadPending, `${item.outcome} / connected=${item.connected}`);
      }
      assert.equal(pendingCount, 5, 'five outcomes give help, and only on never-connected rows');
    });
  });

  describe('verified not connected — the clock is bound, never now()', () => {
    it('counts a read within the last 24 hours after the anchor, and nothing older or earlier', async () => {
      // Each case breaks exactly ONE of the two conditions, so neither can hide
      // behind the other: a read before the purchase is still fresh, and a
      // stale read is still after its purchase.
      const now = new Date();
      const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
      const cases = [
        // [label, purchased (the anchor), checked, verified?]
        ['fresh, after a purchase 2 h ago', at(2), at(1), true],
        ['fresh, but BEFORE a purchase 2 h ago', at(2), at(3), false],
        ['after a purchase 30 h ago, and fresh', at(30), at(23), true],
        ['after a purchase 30 h ago, but 25 h old', at(30), at(25), false],
      ] as const;
      const ids: string[] = [];
      for (const [, , checkedAt] of cases) {
        const subscriptionId = await insertSubscription('verified');
        await setState(subscriptionId, { checkedAt });
        ids.push(subscriptionId);
      }
      // The anchor is per row, as a caller's join gives it — here a VALUES list.
      const anchors = Prisma.join(cases.map(([, anchor], index) => Prisma.sql`(${ids[index]!}, ${anchor}::timestamptz)`));
      const rows = await prisma.$queryRaw<Array<{ readonly id: string; readonly verified: boolean }>>(Prisma.sql`
        SELECT "c"."subscription_id" AS "id", ${verifiedNotConnectedSql('c', Prisma.sql`"a"."anchor"`, now)} AS "verified"
          FROM "subscription_connect_states" "c"
          JOIN (VALUES ${anchors}) AS "a" ("subscription_id", "anchor") ON "a"."subscription_id" = "c"."subscription_id"
      `);
      const verified = new Map(rows.map((row) => [row.id, row.verified]));
      cases.forEach(([label, , , expected], index) => {
        assert.equal(verified.get(ids[index]!), expected, label);
      });

      const missing = await insertSubscription('verified-missing');
      await setState(missing, { checkedAt: at(2), profileMissingAt: at(1) });
      const connected = await insertSubscription('verified-connected');
      await setState(connected, { checkedAt: at(1), firstConnectedAt: at(3) });
      const others = await prisma.$queryRaw<Array<{ readonly id: string; readonly verified: boolean }>>(Prisma.sql`
        SELECT "c"."subscription_id" AS "id", ${verifiedNotConnectedSql('c', at(5), now)} AS "verified"
          FROM "subscription_connect_states" "c"
         WHERE "c"."subscription_id" IN (${missing}, ${connected})
      `);
      const other = new Map(others.map((row) => [row.id, row.verified]));
      assert.equal(other.get(missing), false, 'reported missing after the read');
      assert.equal(other.get(connected), false, 'a connected profile is never "verified not connected"');
    });

    it('answers FALSE, never NULL, where there is no state row — so a negation keeps the row', async () => {
      const bare = await insertSubscription('no-state');
      const rows = await prisma.$queryRaw<
        Array<{ readonly verified: boolean | null; readonly pending: boolean | null; readonly kept: number }>
      >(Prisma.sql`
        SELECT ${verifiedNotConnectedSql('c', new Date(0))} AS "verified",
               ${pendingHelpSql('c')} AS "pending",
               (SELECT count(*)::int FROM "subscriptions" "s2"
                  LEFT JOIN "subscription_connect_states" "c2" ON "c2"."subscription_id" = "s2"."id"
                 WHERE "s2"."id" = ${bare}
                   AND NOT ${verifiedNotConnectedSql('c2', new Date(0))}
                   AND NOT ${pendingHelpSql('c2')}) AS "kept"
          FROM "subscriptions" "s"
          LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
         WHERE "s"."id" = ${bare}
      `);
      assert.deepStrictEqual(rows, [{ verified: false, pending: false, kept: 1 }]);
    });
  });

  describe('the probe’s candidate query (at a far "now" — see ISOLATION)', () => {
    const now = FAR_NOW;
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const settingsOff = { enabled: false, delayHours: 24, includeTrials: false };

    async function candidates(settings = settingsOff, limit = 1_000): Promise<ProbeCandidateRow[]> {
      const rows = await prisma.$queryRaw<ProbeCandidateRow[]>(probeCandidatesSql({ now, settings, limit }));
      return rows.filter((row) => row.id.startsWith(prefix));
    }

    let seeded: Record<string, string> = {};

    before(async () => {
      const make = (label: string, input: SubInput) => insertSubscription(label, input);
      seeded = {
        neverNew: await make('never-new', { createdAt: at(1 * DAY) }),
        neverOld: await make('never-old', { createdAt: at(10 * DAY) }),
        checkedOld: await make('checked-5h', { createdAt: at(20 * DAY) }),
        checkedOlder: await make('checked-9h', { createdAt: at(2 * DAY) }),
        checkedRecent: await make('checked-20m', { createdAt: at(3 * DAY) }),
        outside: await make('outside-horizon', { createdAt: at(40 * DAY) }),
        renewed: await make('renewed', { createdAt: at(60 * DAY) }),
        connected: await make('connected', { createdAt: at(5 * DAY) }),
        noProfile: await make('no-profile', { createdAt: at(5 * DAY), remnawaveId: null }),
        expired: await make('expired', { createdAt: at(5 * DAY), status: 'EXPIRED' }),
        limited: await make('limited', { createdAt: at(5 * DAY), status: 'LIMITED' }),
        missing: await make('missing', { createdAt: at(5 * DAY), updatedAt: at(5 * DAY) }),
        missingChanged: await make('missing-changed', { createdAt: at(5 * DAY), updatedAt: at(1 * HOUR) }),
        backingOff: await make('backoff', { createdAt: at(5 * DAY) }),
        backoffOver: await make('backoff-over', { createdAt: at(5 * DAY) }),
        twoFailures: await make('two-failures', { createdAt: at(5 * DAY) }),
        due: await make('due', { createdAt: at(26 * HOUR) }),
      };
      await setState(seeded.checkedOld!, { checkedAt: at(5 * HOUR) });
      await setState(seeded.checkedOlder!, { checkedAt: at(9 * HOUR) });
      await setState(seeded.checkedRecent!, { checkedAt: at(20 * MIN) });
      await setState(seeded.connected!, { checkedAt: at(DAY), firstConnectedAt: at(2 * DAY) });
      await setState(seeded.missing!, { profileMissingAt: at(2 * DAY) });
      await setState(seeded.missingChanged!, { profileMissingAt: at(2 * DAY) });
      // 3 failures: the next try is 2^3 × 10 min = 80 min after the last one.
      await setState(seeded.backingOff!, { checkFailures: 3, updatedAt: at(30 * MIN) });
      await setState(seeded.backoffOver!, { checkFailures: 3, updatedAt: at(90 * MIN) });
      await setState(seeded.twoFailures!, { checkFailures: 2, updatedAt: at(1 * MIN) });
      // A renewal 3 days ago brings an old subscription back into the horizon.
      await insertPayment({ subscriptionId: seeded.renewed!, createdAt: at(3 * DAY), purchaseType: 'RENEW' });
      // Bought 23.5 h ago: with «Помощь с подключением» on at 24 h, due within the hour.
      await insertPayment({ subscriptionId: seeded.due!, createdAt: at(23.5 * HOUR) });
      await setState(seeded.due!, { checkedAt: at(20 * MIN) });
    });

    it('takes exactly the live, unconnected, readable subscriptions of the horizon', async () => {
      const picked = new Set((await candidates()).map((row) => row.id));

      for (const key of ['neverNew', 'neverOld', 'checkedOld', 'checkedOlder', 'renewed', 'limited', 'missingChanged', 'backoffOver', 'twoFailures']) {
        assert.ok(picked.has(seeded[key]!), `${key} should be read`);
      }
      for (const key of ['outside', 'connected', 'noProfile', 'expired', 'missing', 'backingOff', 'checkedRecent', 'due']) {
        assert.ok(!picked.has(seeded[key]!), `${key} should not be read`);
      }
    });

    it('reads the never-read first, newest first, then the longest-unread', async () => {
      const order = (await candidates())
        .map((row) => row.id)
        .filter((rowId) => [seeded.neverNew, seeded.neverOld, seeded.checkedOld, seeded.checkedOlder].includes(rowId));

      assert.deepStrictEqual(order, [seeded.neverNew, seeded.neverOld, seeded.checkedOlder, seeded.checkedOld]);
    });

    it('puts what the sender decides within the hour first — even when it was read minutes ago', async () => {
      const rows = await candidates({ enabled: true, delayHours: 24, includeTrials: false });

      assert.equal(rows[0]?.id, seeded.due);
      assert.equal(rows[0]?.dueSoon, true);
      assert.equal(rows.filter((row) => row.dueSoon).length, 1);
    });

    it('stops at the limit', async () => {
      const rows = await prisma.$queryRaw<ProbeCandidateRow[]>(probeCandidatesSql({ now, settings: settingsOff, limit: 3 }));
      assert.equal(rows.length, 3);
    });

    it('counts the subscriptions never tried as the backlog', async () => {
      const rows = await prisma.$queryRaw<Array<{ readonly backlog: number }>>(probeBacklogSql(now));
      // neverNew, neverOld, renewed, limited, missingChanged — no read, no failure.
      assert.equal(Number(rows[0]?.backlog), 5);
    });
  });

  describe('a whole probe cycle against the database', () => {
    it('writes what each read proves, and nothing a failed read cannot prove', async () => {
      // 50 days on: no row of the candidate cases is inside this horizon.
      const now = new Date(FAR_NOW.getTime() + 50 * DAY);
      const at = (msAgo: number) => new Date(now.getTime() - msAgo);
      const panelIds = { connected: panelIdentity(), never: panelIdentity(), missing: panelIdentity(), down: panelIdentity() };
      const ids = {
        connected: await insertSubscription('cycle-connected', { remnawaveId: String(panelIds.connected), createdAt: at(DAY) }),
        never: await insertSubscription('cycle-never', { remnawaveId: String(panelIds.never), createdAt: at(DAY) }),
        missing: await insertSubscription('cycle-missing', { remnawaveId: String(panelIds.missing), createdAt: at(DAY) }),
        down: await insertSubscription('cycle-down', { remnawaveId: String(panelIds.down), createdAt: at(DAY) }),
      };
      const connectedAt = new Date(Date.now() - 3 * HOUR);
      const reads: string[] = [];
      const api = {
        getPanelShape: async () => ({ addressing: 'id' }),
        getPanelUserOutcome: async (identity: { remnawaveId: string }) => {
          reads.push(identity.remnawaveId);
          switch (identity.remnawaveId) {
            case String(panelIds.connected):
              return {
                kind: 'ok',
                user: {
                  userTraffic: {
                    usedTrafficBytes: 0,
                    lifetimeUsedTrafficBytes: 77,
                    onlineAt: null,
                    firstConnectedAt: connectedAt.toISOString(),
                  },
                },
              };
            case String(panelIds.never):
              return {
                kind: 'ok',
                user: { userTraffic: { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null } },
              };
            case String(panelIds.missing):
              return { kind: 'missing' };
            default:
              return { kind: 'unavailable' };
          }
        },
      };
      let status: unknown = null;
      const probe = new ConnectSignalProbeService(
        prisma,
        api as never,
        { get: async () => status, set: async (_key: string, value: unknown) => { status = value; } } as never,
        { info: () => undefined } as never,
      );

      const result = await probe.runCycle(now);

      assert.deepStrictEqual(reads.sort(), Object.values(panelIds).map(String).sort(), 'only this case’s rows');
      assert.deepStrictEqual(
        { connected: result.connected, notConnected: result.notConnected, missing: result.missing, failed: result.failed },
        { connected: 1, notConnected: 1, missing: 1, failed: 1 },
      );
      const connected = await stateOf(ids.connected);
      assert.equal(connected?.first_connected_at?.toISOString(), connectedAt.toISOString());
      assert.equal(connected?.connected_source, 'probe');
      assert.notEqual((await stateOf(ids.never))?.checked_at, null);
      assert.equal((await stateOf(ids.never))?.first_connected_at, null);
      assert.notEqual((await stateOf(ids.missing))?.profile_missing_at, null);
      assert.equal((await stateOf(ids.missing))?.checked_at, null);
      const down = await stateOf(ids.down);
      assert.equal(down?.check_failures, 1);
      assert.equal(down?.checked_at, null, 'an outage verifies nothing');
    });
  });

  describe('the health inputs (at a far "now")', () => {
    it('measures coverage over the horizon: connected, verified within 24 h, and the rest', async () => {
      // 100 days on: neither the candidate rows nor the cycle's are inside.
      const now = new Date(FAR_NOW.getTime() + 100 * DAY);
      const at = (msAgo: number) => new Date(now.getTime() - msAgo);
      const connected = await insertSubscription('cov-connected', { createdAt: at(DAY) });
      const verified = await insertSubscription('cov-verified', { createdAt: at(DAY) });
      const stale = await insertSubscription('cov-stale', { createdAt: at(DAY) });
      await insertSubscription('cov-never', { createdAt: at(DAY) });
      await insertSubscription('cov-old', { createdAt: at(45 * DAY) });
      await setState(connected, { firstConnectedAt: at(2 * HOUR), checkedAt: at(2 * HOUR) });
      await setState(verified, { checkedAt: at(23 * HOUR) });
      await setState(stale, { checkedAt: at(25 * HOUR) });

      const rows = await prisma.$queryRaw<Array<{ total: number; connected: number; verified: number }>>(coverageSql(now));

      assert.deepStrictEqual(
        { total: Number(rows[0]?.total), connected: Number(rows[0]?.connected), verified: Number(rows[0]?.verified) },
        { total: 4, connected: 1, verified: 1 },
      );
    });

    it('finds the newest user webhook of the last day, and ignores the rest', async () => {
      const now = new Date(FAR_NOW.getTime() + 200 * DAY);
      const insertEvent = async (eventType: string, createdAt: Date) =>
        prisma.$executeRaw(Prisma.sql`
          INSERT INTO "remnawave_webhook_events" ("id", "event_type", "payload", "created_at")
          VALUES (${id('event')}, ${eventType}, '{}'::jsonb, ${createdAt})
        `);
      await insertEvent('user.modified', new Date(now.getTime() - 3 * HOUR));
      await insertEvent('USER_EXPIRED', new Date(now.getTime() - 2 * HOUR));
      await insertEvent('node.connection_lost', new Date(now.getTime() - HOUR));
      // Not a user event, whatever its prefix: the webhook does not read it as one.
      await insertEvent('user_hwid_devices.added', new Date(now.getTime() - 30 * 60 * 1000));
      await insertEvent('user.modified', new Date(now.getTime() - 30 * HOUR));

      const rows = await prisma.$queryRaw<Array<{ readonly at: Date }>>(lastUserWebhookSql(now, DAY));

      assert.equal(rows[0]?.at.toISOString(), new Date(now.getTime() - 2 * HOUR).toISOString());
      const none = await prisma.$queryRaw<Array<{ readonly at: Date }>>(
        lastUserWebhookSql(new Date(now.getTime() + 2 * DAY), DAY),
      );
      assert.equal(none.length, 0);
    });
  });
});
