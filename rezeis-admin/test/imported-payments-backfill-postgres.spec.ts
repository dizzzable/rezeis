import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * The backfill stamps exactly the imported payments it is for, and nothing else.
 * ═══════════════════════════════════════════════════════════════════════════════
 * `20260918160000_backfill_imported_payments_fulfilled_at` sets `fulfilled_at`
 * to `created_at` on COMPLETED payments the four file importers wrote without a
 * stamp. What it must never touch is a NATIVE payment with no stamp — that is a
 * genuinely stranded payment the recovery paths exist for — nor an imported
 * payment the donor did not complete, nor a stamp that is already there.
 *
 * The file's own statements are run here, as Prisma sends them, against rows
 * shaped the way the importers write them. `prisma migrate deploy` has already
 * applied the file to this database before the spec runs, over no rows at all.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const MIGRATION = '20260918160000_backfill_imported_payments_fulfilled_at';
const migrationSql = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql'),
  'utf8',
);
const prefix = `ipb-${process.pid}-${Date.now()}`;
const userId = `${prefix}-user`;
const UPDATED_AT = new Date('2026-09-01T12:00:00.000Z');
let prisma: PrismaService;

interface Seed {
  readonly key: string;
  readonly status: 'COMPLETED' | 'PENDING' | 'CANCELED' | 'FAILED';
  readonly purchaseType: 'NEW' | 'RENEW' | 'ADDITIONAL';
  readonly importedFrom: string | null;
  readonly createdAt: Date;
  readonly fulfilledAt: Date | null;
}

const SEEDS: readonly Seed[] = [
  // What the backfill is for: one completed, unstamped payment from each importer.
  { key: 'bedolaga', status: 'COMPLETED', purchaseType: 'NEW', importedFrom: 'bedolaga', createdAt: new Date('2025-08-20T09:59:00.000Z'), fulfilledAt: null },
  { key: 'remnashop', status: 'COMPLETED', purchaseType: 'RENEW', importedFrom: 'remnashop', createdAt: new Date('2025-11-03T08:15:00.000Z'), fulfilledAt: null },
  { key: 'altshop', status: 'COMPLETED', purchaseType: 'ADDITIONAL', importedFrom: 'altshop', createdAt: new Date('2025-12-14T19:40:00.000Z'), fulfilledAt: null },
  { key: 'stealthnet', status: 'COMPLETED', purchaseType: 'NEW', importedFrom: 'stealthnet', createdAt: new Date('2025-10-01T09:00:00.000Z'), fulfilledAt: null },
  // Already stamped: left exactly as it is.
  { key: 'bedolaga-stamped', status: 'COMPLETED', purchaseType: 'NEW', importedFrom: 'bedolaga', createdAt: new Date('2025-08-21T10:00:00.000Z'), fulfilledAt: new Date('2025-08-21T10:03:00.000Z') },
  // Imported, but the donor did not complete them: nothing to stamp.
  { key: 'stealthnet-pending', status: 'PENDING', purchaseType: 'NEW', importedFrom: 'stealthnet', createdAt: new Date('2025-10-03T09:00:00.000Z'), fulfilledAt: null },
  { key: 'remnashop-canceled', status: 'CANCELED', purchaseType: 'NEW', importedFrom: 'remnashop', createdAt: new Date('2025-11-07T10:00:00.000Z'), fulfilledAt: null },
  { key: 'altshop-failed', status: 'FAILED', purchaseType: 'NEW', importedFrom: 'altshop', createdAt: new Date('2025-12-16T19:40:00.000Z'), fulfilledAt: null },
  // A native payment with no stamp is a stranded one: never stamped from here.
  { key: 'native-stranded', status: 'COMPLETED', purchaseType: 'ADDITIONAL', importedFrom: null, createdAt: new Date(Date.now() - 60 * 60 * 1000), fulfilledAt: null },
  // Only the four file importers write transactions; an unknown marker is not theirs.
  { key: 'unknown-marker', status: 'COMPLETED', purchaseType: 'NEW', importedFrom: '3xui', createdAt: new Date('2025-07-01T00:00:00.000Z'), fulfilledAt: null },
];

const SHOULD_STAMP = new Set(['bedolaga', 'remnashop', 'altshop', 'stealthnet']);

/** The file's statements as Prisma sends them: comment lines dropped, split on `;`. */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Runs the migration file once; the number of rows its UPDATE changed. */
async function runMigration(): Promise<number> {
  const statements = statementsOf(migrationSql);
  assert.deepEqual(
    statements.map((statement) => statement.split(/\s+/, 1)[0]?.toUpperCase()),
    ['SET', 'UPDATE', 'RESET'],
    'the migration is no longer one bounded UPDATE',
  );
  let changed = -1;
  await prisma.$transaction(async (tx) => {
    for (const statement of statements) {
      const count = await tx.$executeRawUnsafe(statement);
      if (/^UPDATE/i.test(statement)) changed = count;
    }
  });
  return changed;
}

interface Row {
  readonly id: string;
  readonly fulfilled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

async function rows(): Promise<Map<string, Row>> {
  const found = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT "id", "fulfilled_at", "created_at", "updated_at"
      FROM "transactions"
     WHERE "id" LIKE ${`${prefix}-%`}
  `);
  return new Map(found.map((row) => [row.id.slice(prefix.length + 1), row]));
}

run('the imported-payments backfill in PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "referral_code", "updated_at")
      VALUES (${userId}, ${`${prefix}-ref`}, now())
    `);
    for (const seed of SEEDS) {
      const snapshot =
        seed.importedFrom === null
          ? { snapshotSource: 'ADDON_PURCHASE', addOnId: 'addon-1', addOnType: 'EXTRA_TRAFFIC', addOnValue: 10, targetSubscriptionId: 'sub-1' }
          : { importedFrom: seed.importedFrom, sourceTransactionId: seed.key };
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "transactions"
          ("id", "payment_id", "user_id", "status", "purchase_type", "gateway_type", "currency", "amount",
           "plan_snapshot", "fulfilled_at", "created_at", "updated_at")
        VALUES
          (${`${prefix}-${seed.key}`}, ${`${prefix}-pay-${seed.key}`}, ${userId},
           ${seed.status}::"TransactionStatus", ${seed.purchaseType}::"PurchaseType", 'PLATEGA'::"PaymentGatewayType",
           'RUB'::"Currency", 199, ${JSON.stringify(snapshot)}::jsonb, ${seed.fulfilledAt}, ${seed.createdAt}, ${UPDATED_AT})
      `);
    }
  });

  after(async () => {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" = ${userId}`);
    await prisma.$disconnect();
  });

  it('stamps each importer’s unstamped completed payments at their creation time, and nothing else', async () => {
    const changed = await runMigration();
    const after = await rows();
    assert.equal(after.size, SEEDS.length, 'the seeded rows are not all there');

    for (const seed of SEEDS) {
      const row = after.get(seed.key);
      assert.ok(row, `no row for ${seed.key}`);
      const expected = SHOULD_STAMP.has(seed.key) ? seed.createdAt : seed.fulfilledAt;
      assert.equal(row.fulfilled_at?.toISOString() ?? null, expected?.toISOString() ?? null, `${seed.key}: fulfilled_at`);
      assert.equal(row.updated_at.toISOString(), UPDATED_AT.toISOString(), `${seed.key}: updated_at moved`);
    }
    // Everything this spec seeded to be stamped was, by this very run; other
    // specs' rows in a shared database may add to the count, never subtract.
    assert.ok(changed >= SHOULD_STAMP.size, `the UPDATE changed ${changed} rows`);
  });

  it('changes nothing when it runs again', async () => {
    const before = await rows();

    const changed = await runMigration();

    assert.equal(changed, 0);
    assert.deepEqual(await rows(), before);
  });
});
