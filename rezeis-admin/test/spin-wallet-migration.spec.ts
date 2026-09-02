import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const migrationName = '20260902160000_wheel_spin_wallet';
const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'), 'utf8');
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

describe('wheel spin wallet migration', () => {
  it('adds the balance and the free spin clock without rewriting the users table', () => {
    // `users` is the widest, hottest table in this schema. A constant default
    // and a nullable column are added in place; a computed default or a NOT
    // NULL without one would rewrite every row under a lock.
    assert.match(sql, /ALTER TABLE "users"\s+ADD COLUMN IF NOT EXISTS "spin_balance" INTEGER NOT NULL DEFAULT 0;/);
    assert.match(sql, /ALTER TABLE "users"\s+ADD COLUMN IF NOT EXISTS "free_spin_used_at" TIMESTAMPTZ\(3\);/);
    assert.doesNotMatch(sql, /UPDATE "users"/, 'nothing is backfilled: the balance starts at zero for everybody');
  });

  it('creates the journal with the idempotency key and the history index', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "spin_ledger"/);
    assert.match(sql, /"delta"\s+INTEGER NOT NULL/);
    assert.match(sql, /"balance_after"\s+INTEGER NOT NULL/);
    assert.match(sql, /"source"\s+"SpinLedgerSource" NOT NULL/);
    assert.match(sql, /"reference_key" TEXT,/, 'nullable: an operator adjustment carries no key');
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "spin_ledger_source_reference_key_key"\s+ON "spin_ledger" \("source", "reference_key"\)/,
    );
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS "spin_ledger_user_id_created_at_idx"\s+ON "spin_ledger" \("user_id", "created_at" DESC\)/,
    );
    assert.match(sql, /FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)\s+ON DELETE CASCADE/);
  });

  it('declares only the four sources something actually writes', () => {
    // No OPENING_BALANCE here, unlike the points ledger: the column arrives at
    // zero for everybody, so there is no opening row to write and a value
    // nothing writes is a value a reader has to wonder about.
    const enumBlock = sql.slice(sql.indexOf('CREATE TYPE "SpinLedgerSource"'), sql.indexOf('$do$;'));
    for (const value of ['WHEEL_PRIZE', 'PURCHASED', 'SPENT', 'MANUAL_ADJUSTMENT']) {
      assert.match(enumBlock, new RegExp(`'${value}'`), value);
    }
    assert.doesNotMatch(enumBlock, /OPENING_BALANCE/);
  });

  it('guards every statement so a partial run can be replayed', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'SpinLedgerSource'\)/);
    assert.match(sql, /conname = 'spin_ledger_user_id_fkey'/);
    for (const statement of sql.match(/ALTER TABLE "[a-z_]+"\s+ADD COLUMN[^;]+;/g) ?? []) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
    }
  });

  it('is listed as auto-recoverable in the entrypoint', () => {
    assert.ok(
      entrypoint.includes(migrationName),
      `${migrationName} must be in is_auto_recoverable_migration, or a partial first run leaves the API unable to start`,
    );
  });
});
