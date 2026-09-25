import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus, SubscriptionTermStatus, type TrafficLimitStrategy } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveProfileFactsService } from '../src/modules/remnawave/services/remnawave-profile-facts.service';
import { stampRemnawaveProfileFacts } from '../src/modules/remnawave/utils/remnawave-profile-facts.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * THE REMNAWAVE PROFILE FACTS ON POSTGRESQL
 * ═════════════════════════════════════════
 * `subscriptions.remnawave_profile_created_at` and
 * `subscriptions.remnawave_last_traffic_reset_at`: the migration that adds and
 * seeds them, the one statement every caller stamps them with, and the helper
 * that reads a profile once when nothing has stamped them yet.
 *
 * The rules are SQL (`COALESCE`, `GREATEST`, a guard in the `WHERE`), so they
 * are proved here and nowhere else: never null over a value, the reset only
 * forward — also when two answers race each other — and a repeat writing
 * nothing.
 *
 * Runs only with TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4facts-${process.pid}-${Date.now()}`;

const MIGRATION = '20260925120000_subscription_remnawave_reset_facts';

/** Thrown at the end of a transaction so that nothing it did is kept. */
class RolledBack extends Error {}

let prisma: PrismaService;
const users: string[] = [];

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

async function newSubscription(
  tag: string,
  data: {
    readonly status?: SubscriptionStatus;
    readonly createdAt?: Date | null;
    readonly lastReset?: Date | null;
    readonly remnawaveId?: string | null;
  } = {},
): Promise<string> {
  const userId = await newUser(tag);
  const id = `${prefix}-${tag}-sub`;
  await prisma.subscription.create({
    data: {
      id,
      userId,
      status: data.status ?? SubscriptionStatus.ACTIVE,
      remnawaveId: data.remnawaveId ?? null,
      remnawaveProfileCreatedAt: data.createdAt ?? null,
      remnawaveLastTrafficResetAt: data.lastReset ?? null,
    },
  });
  return id;
}

async function facts(id: string) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id },
    select: { remnawaveProfileCreatedAt: true, remnawaveLastTrafficResetAt: true, updatedAt: true },
  });
}

const T = (iso: string): Date => new Date(iso);

run('Remnawave profile facts — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  describe('the migration', () => {
    it('seeds the anchor from the newest ROLLING term only, keeps a value already there, and replays as a no-op', async () => {
      const migrationSql = readFileSync(
        join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql'),
        'utf8',
      );
      let observed: Record<string, Date | null> | null = null;
      await assert.rejects(
        prisma.$transaction(
          async (tx) => {
            const seed = async (tag: string, stored: Date | null) => {
              const userId = `${prefix}-mig-${tag}`;
              await tx.user.create({ data: { id: userId, referralCode: userId, name: userId } });
              const id = `${userId}-sub`;
              await tx.subscription.create({ data: { id, userId, remnawaveProfileCreatedAt: stored } });
              return id;
            };
            const term = (
              subscriptionId: string,
              generation: number,
              strategy: TrafficLimitStrategy,
              anchor: Date | null,
            ) =>
              tx.subscriptionTerm.create({
                data: {
                  subscriptionId,
                  generation,
                  status: generation === 1 ? SubscriptionTermStatus.ENDED : SubscriptionTermStatus.ACTIVE,
                  planSnapshot: {},
                  startsAt: T('2026-01-01T00:00:00.000Z'),
                  trafficResetStrategy: strategy,
                  resetAnchorAt: anchor,
                },
              });

            // Two rolling terms: the newer one's anchor wins (a re-provisioned profile).
            const rolling = await seed('rolling', null);
            await term(rolling, 1, 'MONTH_ROLLING', T('2025-01-31T15:00:00.000Z'));
            await term(rolling, 2, 'MONTH_ROLLING', T('2025-06-15T08:30:00.000Z'));
            // A calendar term's anchor is the TERM's start, never the profile's creation.
            const calendar = await seed('calendar', null);
            await term(calendar, 1, 'MONTH', T('2026-03-01T00:00:00.000Z'));
            // The newest rolling term has no anchor yet: the one before it still speaks.
            const partial = await seed('partial', null);
            await term(partial, 1, 'MONTH_ROLLING', T('2025-02-10T10:00:00.000Z'));
            await term(partial, 2, 'MONTH_ROLLING', null);
            // A value already stamped is never replaced by the seed.
            const stamped = await seed('stamped', T('2024-12-24T12:00:00.000Z'));
            await term(stamped, 1, 'MONTH_ROLLING', T('2025-05-05T05:05:05.000Z'));

            const read = async () =>
              Object.fromEntries(
                await Promise.all(
                  [rolling, calendar, partial, stamped].map(async (id) => [
                    id.replace(`${prefix}-mig-`, '').replace('-sub', ''),
                    (await tx.subscription.findUniqueOrThrow({ where: { id } })).remnawaveProfileCreatedAt,
                  ]),
                ),
              ) as Record<string, Date | null>;

            await tx.$executeRawUnsafe(migrationSql);
            const first = await read();
            await tx.$executeRawUnsafe(migrationSql);
            assert.deepEqual(await read(), first, 'a replay changes nothing');
            observed = first;
            throw new RolledBack();
          },
          { maxWait: 15_000, timeout: 60_000 },
        ),
        RolledBack,
      );
      assert.deepEqual(observed, {
        rolling: T('2025-06-15T08:30:00.000Z'),
        calendar: null,
        partial: T('2025-02-10T10:00:00.000Z'),
        stamped: T('2024-12-24T12:00:00.000Z'),
      });
    });
  });

  describe('the stamp', () => {
    it('writes both facts onto a row that has none, whatever its status', async () => {
      for (const status of [
        SubscriptionStatus.LIMITED,
        SubscriptionStatus.EXPIRED,
        SubscriptionStatus.DISABLED,
        SubscriptionStatus.ACTIVE,
      ]) {
        const id = await newSubscription(`fresh-${status.toLowerCase()}`, { status });
        const moved = await stampRemnawaveProfileFacts(prisma, [id], {
          createdAt: T('2025-03-20T09:15:00.000Z'),
          lastTrafficResetAt: T('2026-09-25T00:10:00.123Z'),
        });
        assert.equal(moved, 1, status);
        const row = await facts(id);
        assert.deepEqual(row.remnawaveProfileCreatedAt, T('2025-03-20T09:15:00.000Z'), status);
        assert.deepEqual(row.remnawaveLastTrafficResetAt, T('2026-09-25T00:10:00.123Z'), status);
      }
    });

    it('never takes the reset back: an older one changes nothing, a newer one moves it', async () => {
      const id = await newSubscription('forward', { lastReset: T('2026-09-25T00:10:00.000Z') });
      assert.equal(
        await stampRemnawaveProfileFacts(prisma, [id], { createdAt: null, lastTrafficResetAt: T('2026-09-24T00:10:00.000Z') }),
        0,
      );
      assert.deepEqual((await facts(id)).remnawaveLastTrafficResetAt, T('2026-09-25T00:10:00.000Z'));
      assert.equal(
        await stampRemnawaveProfileFacts(prisma, [id], { createdAt: null, lastTrafficResetAt: T('2026-09-26T00:10:00.000Z') }),
        1,
      );
      assert.deepEqual((await facts(id)).remnawaveLastTrafficResetAt, T('2026-09-26T00:10:00.000Z'));
    });

    it('never writes null over a value', async () => {
      const id = await newSubscription('no-null', {
        createdAt: T('2025-03-20T09:15:00.000Z'),
        lastReset: T('2026-09-25T00:10:00.000Z'),
      });
      // An answer without a createdAt, and a newer reset: the reset moves, the anchor stays.
      await stampRemnawaveProfileFacts(prisma, [id], { createdAt: null, lastTrafficResetAt: T('2026-09-26T00:10:00.000Z') });
      let row = await facts(id);
      assert.deepEqual(row.remnawaveProfileCreatedAt, T('2025-03-20T09:15:00.000Z'));
      assert.deepEqual(row.remnawaveLastTrafficResetAt, T('2026-09-26T00:10:00.000Z'));
      // An answer without a reset: the reset stays.
      await stampRemnawaveProfileFacts(prisma, [id], { createdAt: T('2025-03-20T09:15:00.000Z'), lastTrafficResetAt: null });
      row = await facts(id);
      assert.deepEqual(row.remnawaveProfileCreatedAt, T('2025-03-20T09:15:00.000Z'));
      assert.deepEqual(row.remnawaveLastTrafficResetAt, T('2026-09-26T00:10:00.000Z'));
    });

    it('lets the anchor follow the profile: a re-provisioned profile brings its own createdAt', async () => {
      const id = await newSubscription('reprovisioned', { createdAt: T('2025-03-20T09:15:00.000Z') });
      assert.equal(
        await stampRemnawaveProfileFacts(prisma, [id], { createdAt: T('2026-09-01T12:00:00.000Z'), lastTrafficResetAt: null }),
        1,
      );
      assert.deepEqual((await facts(id)).remnawaveProfileCreatedAt, T('2026-09-01T12:00:00.000Z'));
    });

    it('writes nothing — not even updated_at — when the answer repeats what is stored', async () => {
      const id = await newSubscription('repeat', {
        createdAt: T('2025-03-20T09:15:00.000Z'),
        lastReset: T('2026-09-25T00:10:00.000Z'),
      });
      const before = (await facts(id)).updatedAt;
      const moved = await stampRemnawaveProfileFacts(prisma, [id], {
        createdAt: T('2025-03-20T09:15:00.000Z'),
        lastTrafficResetAt: T('2026-09-25T00:10:00.000Z'),
      });
      assert.equal(moved, 0);
      assert.deepEqual((await facts(id)).updatedAt, before);
    });

    it('lands the later reset whichever of two racing answers commits first', async () => {
      for (const order of ['newer-first', 'older-first'] as const) {
        const id = await newSubscription(`race-${order}`);
        const newer = T('2026-09-25T00:10:00.500Z');
        const older = T('2026-09-24T00:10:00.500Z');
        const [first, second] = order === 'newer-first' ? [newer, older] : [older, newer];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let signalStamped!: () => void;
        const stamped = new Promise<void>((resolve) => {
          signalStamped = resolve;
        });
        // The first answer stamps inside a transaction that stays open, holding
        // the row; the second one's statement queues behind it and must be
        // re-evaluated against what the first committed.
        const holder = prisma.$transaction(
          async (tx) => {
            await stampRemnawaveProfileFacts(tx, [id], { createdAt: null, lastTrafficResetAt: first });
            signalStamped();
            await held;
          },
          { maxWait: 15_000, timeout: 30_000 },
        );
        await stamped;
        const waiter = stampRemnawaveProfileFacts(prisma, [id], { createdAt: null, lastTrafficResetAt: second });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await holder;
        await waiter;
        assert.deepEqual((await facts(id)).remnawaveLastTrafficResetAt, newer, order);
      }
    });
  });

  describe('the read-once helper', () => {
    function helperOver(answer: () => Promise<unknown>) {
      const reads: unknown[] = [];
      const service = new RemnawaveProfileFactsService(prisma, {
        getPanelUserOutcome: async (identity: unknown) => {
          reads.push(identity);
          return answer();
        },
      } as never);
      return { service, reads };
    }

    it('answers the stamped anchor without asking Remnawave', async () => {
      const id = await newSubscription('stamped-anchor', {
        remnawaveId: '9001',
        createdAt: T('2025-03-20T09:15:00.000Z'),
      });
      const { service, reads } = helperOver(async () => assert.fail('no read for a stamped anchor'));
      assert.deepEqual(await service.readProfileCreatedAtOnce(id), T('2025-03-20T09:15:00.000Z'));
      assert.deepEqual(reads, []);
    });

    it('reads the profile once, stamps both facts and the live rolling term, and answers the anchor', async () => {
      const id = await newSubscription('read-once', { remnawaveId: '9002', status: SubscriptionStatus.LIMITED });
      const term = await prisma.subscriptionTerm.create({
        data: {
          subscriptionId: id,
          generation: 1,
          status: SubscriptionTermStatus.ACTIVE,
          planSnapshot: {},
          startsAt: T('2026-09-01T00:00:00.000Z'),
          trafficResetStrategy: 'MONTH_ROLLING',
          resetAnchorAt: null,
        },
      });
      const { service, reads } = helperOver(async () => ({
        kind: 'ok',
        user: { uuid: '9002', createdAt: '2025-07-31T23:30:00.000Z', lastTrafficResetAt: '2026-08-31T00:10:00.000Z' },
      }));

      assert.deepEqual(await service.readProfileCreatedAtOnce(id), T('2025-07-31T23:30:00.000Z'));
      assert.equal(reads.length, 1);
      const row = await facts(id);
      assert.deepEqual(row.remnawaveProfileCreatedAt, T('2025-07-31T23:30:00.000Z'));
      assert.deepEqual(row.remnawaveLastTrafficResetAt, T('2026-08-31T00:10:00.000Z'));
      assert.deepEqual(
        (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: term.id } })).resetAnchorAt,
        T('2025-07-31T23:30:00.000Z'),
      );

      // Stamped now: the next ask is the column.
      assert.deepEqual(await service.readProfileCreatedAtOnce(id), T('2025-07-31T23:30:00.000Z'));
      assert.equal(reads.length, 1);
    });

    it('answers null, and does not ask again for a minute, when Remnawave cannot say', async () => {
      const id = await newSubscription('unavailable', { remnawaveId: '9003' });
      const { service, reads } = helperOver(async () => ({ kind: 'unavailable' }));
      const now = T('2026-09-25T07:00:00.000Z');
      assert.equal(await service.readProfileCreatedAtOnce(id, now), null);
      assert.equal(await service.readProfileCreatedAtOnce(id, new Date(now.getTime() + 59_000)), null);
      assert.equal(reads.length, 1, 'inside the minute the panel is not asked again');
      assert.equal(await service.readProfileCreatedAtOnce(id, new Date(now.getTime() + 61_000)), null);
      assert.equal(reads.length, 2);
      assert.equal((await facts(id)).remnawaveProfileCreatedAt, null);
    });

    it('never reads for a row with no profile, or a DELETED one', async () => {
      const unlinked = await newSubscription('unlinked');
      const deleted = await newSubscription('deleted', { remnawaveId: '9004', status: SubscriptionStatus.DELETED });
      const { service, reads } = helperOver(async () => assert.fail('no read'));
      assert.equal(await service.readProfileCreatedAtOnce(unlinked), null);
      assert.equal(await service.readProfileCreatedAtOnce(deleted), null);
      assert.equal(await service.readProfileCreatedAtOnce(`${prefix}-no-such-row`), null);
      assert.deepEqual(reads, []);
    });

    it('shares one read between callers asking at once', async () => {
      const id = await newSubscription('single-flight', { remnawaveId: '9005' });
      let answer!: (value: unknown) => void;
      const { service, reads } = helperOver(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const first = service.readProfileCreatedAtOnce(id);
      const second = service.readProfileCreatedAtOnce(id);
      while (reads.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      answer({ kind: 'ok', user: { uuid: '9005', createdAt: '2025-01-15T10:00:00.000Z', lastTrafficResetAt: null } });
      assert.deepEqual(await first, T('2025-01-15T10:00:00.000Z'));
      assert.deepEqual(await second, T('2025-01-15T10:00:00.000Z'));
      assert.equal(reads.length, 1);
    });
  });
});
