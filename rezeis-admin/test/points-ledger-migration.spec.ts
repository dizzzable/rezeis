import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const migrationName = '20260902120000_points_ledger_and_cashback';
const migrationPath = join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql');
const sql = readFileSync(migrationPath, 'utf8');
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

describe('points ledger migration', () => {
  it('creates the ledger with the idempotency index and the history index', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "points_ledger"/);
    assert.match(sql, /"delta"\s+INTEGER NOT NULL/);
    assert.match(sql, /"balance_after"\s+INTEGER NOT NULL/);
    assert.match(sql, /"source"\s+"PointsLedgerSource" NOT NULL/);
    assert.match(sql, /"reference_key"\s+TEXT,/, 'the key is nullable: manual adjustments carry none');
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "points_ledger_source_reference_key_key"\s+ON "points_ledger" \("source", "reference_key"\)/,
    );
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS "points_ledger_user_id_created_at_idx"\s+ON "points_ledger" \("user_id", "created_at" DESC\)/,
    );
    assert.match(sql, /FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)\s+ON DELETE CASCADE/);
  });

  it('guards every statement so a partial run can be replayed', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'PointsLedgerSource'\)/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'PointsCashbackMode'\)/);
    assert.match(sql, /conname = 'points_ledger_user_id_fkey'/);
    for (const statement of sql.match(/ALTER TABLE "[a-z_]+"\s+ADD COLUMN[^;]+;/g) ?? []) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
    }
  });

  it('adds the cashback columns with constant defaults and the rule OFF', () => {
    for (const table of ['plans', 'add_ons']) {
      assert.match(
        sql,
        new RegExp(
          `ALTER TABLE "${table}"\\s+ADD COLUMN IF NOT EXISTS "cashback_mode" "PointsCashbackMode" NOT NULL DEFAULT 'INHERIT'`,
        ),
        `${table}.cashback_mode`,
      );
      assert.match(sql, new RegExp(`ALTER TABLE "${table}"\\s+ADD COLUMN IF NOT EXISTS "cashback_percent" INTEGER;`));
    }
    assert.match(sql, /ALTER TABLE "plan_durations"\s+ADD COLUMN IF NOT EXISTS "cashback_points" INTEGER;/);
    assert.match(sql, /ALTER TABLE "add_ons"\s+ADD COLUMN IF NOT EXISTS "cashback_points" INTEGER;/);
    assert.match(
      sql,
      /ALTER TABLE "settings"\s+ADD COLUMN IF NOT EXISTS "points_settings" JSONB NOT NULL DEFAULT '\{\}';/,
      'an empty object is OFF: the update must not start handing out points',
    );
  });

  it('writes one opening-balance row per non-zero balance, and never on top of existing movements', () => {
    const backfill = sql.slice(sql.indexOf('-- == BACKFILL: opening balance'));
    assert.match(backfill, /INSERT INTO "points_ledger"/);
    assert.match(backfill, /'OPENING_BALANCE'/);
    assert.match(backfill, /md5\('points-opening:' \|\| u\."id"\)/, 'a deterministic id, so a replay cannot mint a second row');
    assert.match(backfill, /WHERE u\."points" <> 0/, 'negative balances are carried as they are, not flattered');
    assert.match(
      backfill,
      /NOT EXISTS \(\s*SELECT 1 FROM "points_ledger" l WHERE l\."user_id" = u\."id"\s*\)/,
      'once the application has journaled a movement, a replay must not add an opening row above it',
    );
    assert.match(backfill, /ON CONFLICT DO NOTHING/);
    assert.match(backfill, /u\."points",\s*u\."points",/, 'delta and balance_after are both the balance: the row IS the balance');
  });

  it('is listed as auto-recoverable in the entrypoint', () => {
    assert.ok(
      entrypoint.includes(migrationName),
      `${migrationName} must be in is_auto_recoverable_migration, or a partial first run leaves the API unable to start`,
    );
  });
});
