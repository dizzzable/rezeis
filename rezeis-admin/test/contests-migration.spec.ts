import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const migrationName = '20260903090000_contests';
const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'), 'utf8');
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

describe('contests migration', () => {
  it('lets one person in once', () => {
    // The whole of the fairness argument: uniform over people, not tickets.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "contest_entries_contest_id_user_id_key"\s+ON "contest_entries" \("contest_id", "user_id"\)/,
    );
  });

  it('gives each place to one person, and one person one place', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "contest_winners_contest_id_place_key"\s+ON "contest_winners" \("contest_id", "place"\)/,
    );
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "contest_winners_contest_id_user_id_key"\s+ON "contest_winners" \("contest_id", "user_id"\)/,
    );
  });

  it('reuses the wheel vocabulary instead of inventing a parallel one', () => {
    assert.match(sql, /"kind"\s+"WheelSectorKind" NOT NULL/);
    assert.match(sql, /"status"\s+"WheelSpinStatus" NOT NULL/);
    assert.doesNotMatch(sql, /CREATE TYPE "ContestPrizeKind"/);
    assert.doesNotMatch(sql, /CREATE TYPE "ContestWinnerStatus"/);
  });

  it('adds the new ledger sources without recreating either enum', () => {
    assert.match(sql, /ALTER TYPE "PointsLedgerSource" ADD VALUE IF NOT EXISTS 'WHEEL_PRIZE';/);
    assert.match(sql, /ALTER TYPE "PointsLedgerSource" ADD VALUE IF NOT EXISTS 'CONTEST_PRIZE';/);
    assert.match(sql, /ALTER TYPE "SpinLedgerSource" ADD VALUE IF NOT EXISTS 'CONTEST_PRIZE';/);
    assert.doesNotMatch(sql, /DROP TYPE/);
  });

  it('starts every contest as a draft and seeds nothing', () => {
    assert.match(sql, /"status"\s+"ContestStatus" NOT NULL DEFAULT 'DRAFT'/);
    assert.doesNotMatch(sql, /INSERT INTO/);
  });

  it('keeps a winner readable after the prize row is deleted', () => {
    assert.match(sql, /"prize_snapshot"\s+JSONB NOT NULL/);
    assert.match(
      sql,
      /FOREIGN KEY \("prize_id"\) REFERENCES "contest_prizes"\("id"\)\s+ON DELETE SET NULL/,
    );
  });

  it('guards every statement so a partial run can be replayed', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'ContestStatus'\)/);
    for (const statement of sql.match(/CREATE (UNIQUE )?INDEX[^;]+;/g) ?? []) {
      assert.match(statement, /IF NOT EXISTS/, statement);
    }
    for (const statement of sql.match(/ALTER TABLE "[a-z_]+"\s+ADD COLUMN[^;]+;/g) ?? []) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
    }
    for (const constraint of sql.match(/ADD CONSTRAINT "([a-z_]+)"/g) ?? []) {
      const name = constraint.replace(/ADD CONSTRAINT "|"/g, '');
      assert.match(sql, new RegExp(`conname = '${name}'`), `${name} is added unguarded`);
    }
  });

  it('is listed as auto-recoverable in the entrypoint', () => {
    assert.ok(entrypoint.includes(migrationName), `${migrationName} must be listed in is_auto_recoverable_migration`);
  });
});
