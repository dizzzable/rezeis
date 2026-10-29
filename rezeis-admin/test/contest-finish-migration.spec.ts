import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `20261029120000_contest_finish` runs on live databases and is replayed by
 * the entrypoint when it times out, so every statement has to be safe twice —
 * and the contests drawn before it must not be announced to their entrants
 * all over again by the first sweep.
 */
const migrationName = '20261029120000_contest_finish';
const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'), 'utf8');
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('contest finish migration', () => {
  it('is replayed by the entrypoint when it times out', () => {
    assert.match(entrypoint, new RegExp(`\\b${migrationName}\\)`));
  });

  it('bounds its locks and gives the bound back', () => {
    assert.match(statements, /SET lock_timeout = '5s';/);
    assert.match(statements, /RESET lock_timeout;\s*$/);
  });

  it('adds every column only if it is missing', () => {
    const adds = statements.match(/ADD COLUMN[^;]*;/g) ?? [];
    assert.ok(adds.length >= 14, `expected the contest and entry columns, got ${adds.length}`);
    for (const add of adds) assert.match(add, /ADD COLUMN IF NOT EXISTS/);
  });

  it('creates the notice table, its type and its keys only once', () => {
    assert.match(statements, /CREATE TABLE IF NOT EXISTS "contest_notices"/);
    assert.match(statements, /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'ContestNoticeKind'\)/);
    assert.match(
      statements,
      /CREATE UNIQUE INDEX IF NOT EXISTS "contest_notices_contest_id_kind_user_id_key"\s+ON "contest_notices" \("contest_id", "kind", "user_id"\)/,
    );
    assert.match(statements, /conname = 'contest_notices_contest_id_fkey'/);
    assert.match(statements, /conname = 'contest_notices_user_id_fkey'/);
  });

  it('marks contests drawn before it as told, and touches nothing already marked', () => {
    assert.match(
      statements,
      /UPDATE "contests"\s+SET "results_notified_at" = COALESCE\("drawn_at", "updated_at"\)\s+WHERE "status" = 'DRAWN'\s+AND "results_notified_at" IS NULL;/,
    );
  });

  it('leaves every existing contest as it was: no announcement, no tickets', () => {
    assert.match(statements, /"announce" BOOLEAN NOT NULL DEFAULT false/);
    assert.match(statements, /"tickets_per_purchase" INTEGER NOT NULL DEFAULT 0/);
    assert.match(statements, /"tickets_per_referral" INTEGER NOT NULL DEFAULT 0/);
  });
});
