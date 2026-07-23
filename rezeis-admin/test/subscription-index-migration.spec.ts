import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';

const projectRoot = join(__dirname, '..');
const migrationName = '20260724120000_reconcile_subscription_expiry_index';
const migrationSql = readFileSync(
  join(projectRoot, 'prisma', 'migrations', migrationName, 'migration.sql'),
  'utf8',
);
const dropMigrationName = '20260724120500_drop_conflicting_subscription_expiry_index';
const dropMigrationSql = readFileSync(
  join(projectRoot, 'prisma', 'migrations', dropMigrationName, 'migration.sql'),
  'utf8',
);
const swapMigrationName = '20260724121000_swap_subscription_expiry_index';
const swapMigrationSql = readFileSync(
  join(projectRoot, 'prisma', 'migrations', swapMigrationName, 'migration.sql'),
  'utf8',
);
const entrypoint = readFileSync(join(projectRoot, 'docker-entrypoint.sh'), 'utf8');
const schema = readFileSync(join(projectRoot, 'prisma', 'schema.prisma'), 'utf8');

describe('subscription status/expiry index migration', () => {
  it('keeps each concurrent DDL phase in its own top-level statement', () => {
    assert.ok(migrationName < dropMigrationName && dropMigrationName < swapMigrationName);
    const buildStatements = migrationSql
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const dropStatements = dropMigrationSql
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    assert.equal(buildStatements.length, 1);
    assert.equal(dropStatements.length, 1);
    assert.match(
      buildStatements[0] ?? '',
      /^CREATE INDEX CONCURRENTLY "subscriptions_status_expires_at_rebuild_idx"/,
    );
    assert.match(migrationSql, /ON "subscriptions" \("status", "expires_at"\);/);
    assert.doesNotMatch(migrationSql, /WHERE\s+"status"\s*=\s*'ACTIVE'/i);
    assert.match(
      dropStatements[0] ?? '',
      /^DROP INDEX CONCURRENTLY IF EXISTS "public"\."subscriptions_status_expires_at_idx"$/,
    );
  });

  it('renames the replacement idempotently and validates the exact final shape', () => {
    assert.match(
      swapMigrationSql,
      /to_regclass\('public\.subscriptions_status_expires_at_rebuild_idx'\)/,
    );
    assert.match(
      swapMigrationSql,
      /ALTER INDEX "public"\."subscriptions_status_expires_at_rebuild_idx"/,
    );
    assert.doesNotMatch(swapMigrationSql, /DROP INDEX/);
    assert.match(swapMigrationSql, /indexes\.indisvalid/);
    assert.match(swapMigrationSql, /indexes\.indisready/);
    assert.match(swapMigrationSql, /indexes\.indpred IS NULL/);
    assert.match(swapMigrationSql, /indexes\.indkey\[0\] = status_attribute\.attnum/);
    assert.match(swapMigrationSql, /indexes\.indkey\[1\] = expiry_attribute\.attnum/);
    assert.match(
      schema,
      /@@index\(\[status, expiresAt\], map: "subscriptions_status_expires_at_idx"\)/,
    );
  });

  it('keeps failed-migration auto-recovery restricted to retry-safe DDL', () => {
    assert.match(entrypoint, /is_auto_recoverable_migration/);
    assert.match(entrypoint, /20260708120000_perf_composite_indexes/);
    assert.match(entrypoint, new RegExp(migrationName));
    assert.match(entrypoint, new RegExp(dropMigrationName));
    assert.match(entrypoint, new RegExp(swapMigrationName));
    const cleanupPosition = entrypoint.indexOf('cleanup_retry_artifacts "${failed_migration}"');
    const resolvePosition = entrypoint.indexOf(
      'migrate resolve --rolled-back "${failed_migration}"',
    );
    assert.ok(cleanupPosition >= 0 && cleanupPosition < resolvePosition);
    assert.match(
      entrypoint,
      /DROP INDEX CONCURRENTLY IF EXISTS "public"\."subscriptions_status_expires_at_rebuild_idx"/,
    );
    assert.match(entrypoint, /db execute --stdin/);
    assert.match(entrypoint, /is not safe to auto-resolve; manual recovery required/);
    assert.doesNotMatch(entrypoint, /migrate resolve --rolled-back[^\n]*\|\| true/);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl === undefined ? describe.skip : describe;

databaseDescribe('subscription status/expiry index in PostgreSQL', () => {
  it('finishes migration replay with one valid, non-partial canonical index', async () => {
    process.env.DATABASE_URL = databaseUrl;
    const prisma = new PrismaService();
    await prisma.$connect();
    try {
      const indexes = await prisma.$queryRaw<
        Array<{
          indexname: string;
          indexdef: string;
          indisvalid: boolean;
          indisready: boolean;
          predicate: string | null;
        }>
      >`
        SELECT
          index_class.relname AS indexname,
          pg_get_indexdef(indexes.indexrelid) AS indexdef,
          indexes.indisvalid,
          indexes.indisready,
          pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
        FROM pg_index AS indexes
        JOIN pg_class AS index_class ON index_class.oid = indexes.indexrelid
        JOIN pg_class AS table_class ON table_class.oid = indexes.indrelid
        WHERE table_class.relname = 'subscriptions'
          AND index_class.relname IN (
            'subscriptions_status_expires_at_idx',
            'subscriptions_status_expires_at_rebuild_idx'
          )
      `;

      assert.equal(indexes.length, 1);
      assert.equal(indexes[0]?.indexname, 'subscriptions_status_expires_at_idx');
      assert.equal(indexes[0]?.indisvalid, true);
      assert.equal(indexes[0]?.indisready, true);
      assert.equal(indexes[0]?.predicate, null);
      assert.match(indexes[0]?.indexdef ?? '', /\(status, expires_at\)$/);
    } finally {
      await prisma.$disconnect();
    }
  });
});
