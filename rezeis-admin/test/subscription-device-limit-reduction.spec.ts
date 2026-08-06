/**
 * `subscriptions.device_limit_reduced_at` — the signal that lets
 * `SharingDetectors.detectHwidOverage` tell a downgrade apart from sharing.
 *
 * Two suites, because the mechanism has two halves that fail differently:
 *
 *  1. the DDL itself, asserted from the migration file the way this repo
 *     already asserts its other hand-written migrations
 *     (`subscription-index-migration.spec.ts`,
 *     `referral-points-exchange-migration.spec.ts`);
 *  2. the trigger's BEHAVIOUR, which only a real PostgreSQL can answer and
 *     which therefore runs under `TEST_DATABASE_URL`, exactly like
 *     `add-on-entitlement-postgres-concurrency.spec.ts`. It is SKIPPED in a
 *     plain `npm test` run — read the second suite as the proof that has to be
 *     asked for, not as coverage the default run gives you.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';

import type { PrismaService } from '../src/common/prisma/prisma.service';

const MIGRATION = '20260806120000_subscription_device_limit_reduced_at';

function pathOf(migration: string): string {
  return join(process.cwd(), 'prisma', 'migrations', migration, 'migration.sql');
}

/** The migration with its `--` prose stripped, so a negative assertion tests the DDL. */
function statements(migration: string = MIGRATION): string {
  return readFileSync(pathOf(migration), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Just the `--` prose, for the assertions that guard the recorded rationale. */
function prose(migration: string): string {
  return readFileSync(pathOf(migration), 'utf8')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('--'))
    .join('\n');
}

describe('subscription device-limit reduction migration', () => {
  it('adds a nullable stamp column without a table rewrite', () => {
    const sql = statements();

    assert.match(sql, /ALTER TABLE "subscriptions"/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS "device_limit_reduced_at" TIMESTAMPTZ\(3\)/);
    // Both columns in ONE statement, so the table is locked once, not twice.
    assert.equal(sql.match(/ALTER TABLE "subscriptions"/g)?.length, 1);
    // No DEFAULT and no NOT NULL: either would turn a catalogue-only change
    // into a rewrite of the largest table in the schema. Bounded by `,` as well
    // as `;` now that the statement carries two column clauses.
    assert.doesNotMatch(sql, /"device_limit_reduced_at" TIMESTAMPTZ\(3\)[^,;]*DEFAULT/);
    assert.doesNotMatch(sql, /"device_limit_reduced_at" TIMESTAMPTZ\(3\)[^,;]*NOT NULL/);
    assert.doesNotMatch(sql, /CONCURRENTLY/);
  });

  it('stamps the column from a trigger rather than trusting fifteen call sites', () => {
    const sql = statements();

    assert.match(sql, /CREATE OR REPLACE FUNCTION "stamp_subscription_device_limit_reduction"\(\)/);
    assert.match(
      sql,
      /CREATE TRIGGER "subscriptions_stamp_device_limit_reduction"\s+BEFORE UPDATE OF "device_limit" ON "subscriptions"/,
    );
    // Re-runnable: `prisma migrate deploy` replays, and a bare CREATE TRIGGER
    // over an existing trigger is a hard error.
    assert.match(
      sql,
      /DROP TRIGGER IF EXISTS "subscriptions_stamp_device_limit_reduction" ON "subscriptions";/,
    );
    // The predicate: only a finite NEW limit, and only when it is stricter than
    // OLD — where `<= 0` means unlimited, so unlimited → N counts as stricter.
    assert.match(sql, /NEW\."device_limit" > 0/);
    assert.match(sql, /OLD\."device_limit" <= 0 OR NEW\."device_limit" < OLD\."device_limit"/);
    assert.match(sql, /NEW\."device_limit_reduced_at" := now\(\);/);
  });

  it('is declared in schema.prisma', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    assert.match(
      schema,
      /deviceLimitReducedAt\s+DateTime\?\s+@map\("device_limit_reduced_at"\) @db\.Timestamptz\(3\)/,
    );
  });
});

/**
 * `device_limit_before_reduction` — the ceiling that keeps the excuse BOUNDED.
 *
 * A timestamp alone can only answer "was there a reduction?", and answering only
 * that excuses any overage from a recently-reduced subscription — an immunity a
 * sharer buys with a downgrade that costs them nothing, because the panel limit
 * was never what constrained them. Recording the OLD limit bounds the excuse to
 * the devices the reduction actually accounts for.
 *
 * Both columns are written by ONE assignment block in ONE trigger, so a stamped
 * row without a ceiling is a state this schema cannot reach. The detector treats
 * it as an anomaly to be judged and reported, never as an excuse.
 */
describe('subscription device-limit ceiling', () => {
  it('adds the ceiling column beside the timestamp, without a table rewrite', () => {
    const sql = statements();

    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS "device_limit_before_reduction" INTEGER/,
    );
    assert.doesNotMatch(sql, /"device_limit_before_reduction" INTEGER[^,;]*DEFAULT/);
    assert.doesNotMatch(sql, /"device_limit_before_reduction" INTEGER[^,;]*NOT NULL/);
  });

  // One event, one assignment block. Two writers of two halves of one fact is
  // how the halves drift apart, and a ceiling paired with the wrong timestamp
  // describes a reduction that never happened.
  it('writes both halves of the fact in a single trigger function', () => {
    const sql = statements();

    // Exactly one function: a second name would leave another body installed
    // and racing this one.
    assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length, 1);
    assert.match(sql, /NEW\."device_limit_reduced_at" := now\(\);/);
    assert.match(
      sql,
      /NEW\."device_limit_before_reduction" := GREATEST\(OLD\."device_limit", 0\);/,
    );
  });

  it('is declared in schema.prisma', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    assert.match(
      schema,
      /deviceLimitBeforeReduction\s+Int\?\s+@map\("device_limit_before_reduction"\)/,
    );
  });

  // NOTE: there is deliberately no "is the newest migration" assertion here.
  // An earlier draft split this work across two files, the second replacing the
  // first's trigger function, so apply-order was load-bearing and worth pinning.
  // Merging them into this one file removed that dependency entirely — the
  // assertion then protected no invariant and simply failed for whoever added
  // the next migration, which is a tripwire, not a guard.

  // The rationale is the only defence against someone re-deriving the wrong
  // conclusion. The premise that killed the first version of this suppression —
  // "Remnawave refuses a registration at or over the limit, so no new device can
  // appear" — is false: the HWID limit is bypassable, which is the only reason
  // this detector has anything to find. If this assertion fails, that warning
  // has been deleted from the one place a future reader will look.
  it('records why the panel-enforcement premise must not be reused', () => {
    const text = prose(MIGRATION);
    assert.match(text, /bypass/i, 'the file does not say the panel limit is bypassable');
    assert.match(text, /USER_HWID_DEVICE_LIMIT_REACHED/);
  });
});

// ── Trigger behaviour (requires TEST_DATABASE_URL) ───────────────────────────

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `dlr-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

run('device-limit reduction trigger', () => {
  const userId = `${prefix}-user`;

  const stampOf = async (id: string): Promise<Date | null> => {
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id: `${prefix}-${id}` },
      select: { deviceLimitReducedAt: true },
    });
    return row.deviceLimitReducedAt;
  };

  const ceilingOf = async (id: string): Promise<number | null> => {
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id: `${prefix}-${id}` },
      select: { deviceLimitBeforeReduction: true },
    });
    return row.deviceLimitBeforeReduction;
  };

  const makeSub = async (id: string, deviceLimit: number): Promise<void> => {
    await prisma.subscription.create({
      data: { id: `${prefix}-${id}`, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit },
    });
  };

  const setLimit = async (id: string, deviceLimit: number): Promise<void> => {
    await prisma.subscription.update({
      where: { id: `${prefix}-${id}` },
      data: { deviceLimit },
    });
  };

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    const { PrismaService: Service } = await import('../src/common/prisma/prisma.service');
    prisma = new Service();
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-ref`, name: 'DLR' } });
  });

  after(async () => {
    if (prisma !== undefined) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });

  // Both halves of the fact, from one event: WHEN the limit was reduced, and
  // WHAT it was reduced from. The second is what bounds the detector's excuse to
  // the devices the customer already held.
  it('stamps a plan downgrade with the limit it reduced from', async () => {
    await makeSub('down', 5);
    assert.equal(await stampOf('down'), null);
    assert.equal(await ceilingOf('down'), null);
    await setLimit('down', 2);
    assert.notEqual(await stampOf('down'), null);
    assert.equal(await ceilingOf('down'), 5);
  });

  // `0` is the canonical "previously unlimited", NOT a missing value: a customer
  // who was entitled to any number of devices has no unexplained remainder, and
  // the detector must be able to tell that apart from "we never recorded it".
  it('records unlimited → finite as a reduction from 0', async () => {
    await makeSub('unl', 0);
    await setLimit('unl', 3);
    assert.notEqual(await stampOf('unl'), null);
    assert.equal(await ceilingOf('unl'), 0);
  });

  it('does not stamp an upgrade, a no-op write, or a finite → unlimited relax', async () => {
    await makeSub('up', 2);
    await setLimit('up', 5);
    assert.equal(await stampOf('up'), null);
    assert.equal(await ceilingOf('up'), null);
    await setLimit('up', 5);
    assert.equal(await stampOf('up'), null);
    await setLimit('up', 0);
    assert.equal(await stampOf('up'), null);
    assert.equal(await ceilingOf('up'), null);
  });

  // A raise deliberately does NOT clear the stamp: after 5 → 2 → 3 the five
  // registered devices are still explained by the original downgrade, and
  // clearing would re-accuse the customer. The detector's window expires it.
  // The ceiling has to survive with it, or the surviving timestamp would land in
  // the "never recorded" branch and restore the blanket excuse.
  it('keeps the stamp and the ceiling when the limit is raised again', async () => {
    await makeSub('bounce', 5);
    await setLimit('bounce', 2);
    const first = await stampOf('bounce');
    await setLimit('bounce', 3);
    assert.deepEqual(await stampOf('bounce'), first);
    assert.equal(await ceilingOf('bounce'), 5);
  });

  // Successive reductions describe successive events. The ceiling tracks the
  // LATEST one, matching its timestamp — the pair always describes the same
  // reduction, never two different ones.
  it('moves the ceiling to the most recent reduction', async () => {
    await makeSub('chain', 10);
    await setLimit('chain', 5);
    assert.equal(await ceilingOf('chain'), 10);
    await setLimit('chain', 2);
    assert.equal(await ceilingOf('chain'), 5);
  });

  it('ignores writes that do not touch the device limit', async () => {
    await makeSub('other', 5);
    await prisma.subscription.update({
      where: { id: `${prefix}-other` },
      data: { configUrl: 'https://example.invalid/sub' },
    });
    assert.equal(await stampOf('other'), null);
  });
});
