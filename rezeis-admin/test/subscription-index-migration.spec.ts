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
const entrypoint = readFileSync(join(projectRoot, 'docker-entrypoint.sh'), 'utf8');
const schema = readFileSync(join(projectRoot, 'prisma', 'schema.prisma'), 'utf8');

describe('subscription status/expiry index migration', () => {
  it('builds the full replacement before swapping the conflicting index name', () => {
    const createPosition = migrationSql.indexOf(
      'CREATE INDEX CONCURRENTLY "subscriptions_status_expires_at_rebuild_idx"',
    );
    const dropCanonicalPosition = migrationSql.indexOf(
      'DROP INDEX CONCURRENTLY IF EXISTS "subscriptions_status_expires_at_idx"',
    );
    const renamePosition = migrationSql.indexOf(
      'RENAME TO "subscriptions_status_expires_at_idx"',
    );

    assert.ok(createPosition >= 0, 'replacement index must be built concurrently');
    assert.ok(dropCanonicalPosition > createPosition, 'old index must remain until replacement exists');
    assert.ok(renamePosition > dropCanonicalPosition, 'replacement must receive the Prisma index name last');
    assert.match(
      migrationSql,
      /ON "subscriptions" \("status", "expires_at"\);/,
    );
    assert.doesNotMatch(migrationSql, /WHERE\s+"status"\s*=\s*'ACTIVE'/i);
    assert.match(
      schema,
      /@@index\(\[status, expiresAt\], map: "subscriptions_status_expires_at_idx"\)/,
    );
  });

  it('keeps failed-migration auto-recovery restricted to retry-safe DDL', () => {
    assert.match(entrypoint, /is_auto_recoverable_migration/);
    assert.match(entrypoint, /20260708120000_perf_composite_indexes/);
    assert.match(entrypoint, new RegExp(migrationName));
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
        Array<{ indexdef: string; indisvalid: boolean; predicate: string | null }>
      >`
        SELECT
          pg_get_indexdef(indexes.indexrelid) AS indexdef,
          indexes.indisvalid,
          pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
        FROM pg_index AS indexes
        JOIN pg_class AS index_class ON index_class.oid = indexes.indexrelid
        JOIN pg_class AS table_class ON table_class.oid = indexes.indrelid
        WHERE table_class.relname = 'subscriptions'
          AND index_class.relname = 'subscriptions_status_expires_at_idx'
      `;

      assert.equal(indexes.length, 1);
      assert.equal(indexes[0]?.indisvalid, true);
      assert.equal(indexes[0]?.predicate, null);
      assert.match(indexes[0]?.indexdef ?? '', /\(status, expires_at\)$/);
    } finally {
      await prisma.$disconnect();
    }
  });
});
