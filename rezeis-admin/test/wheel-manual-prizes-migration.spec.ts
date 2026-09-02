import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const migrationName = '20260902200000_wheel_manual_prizes';
const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'),
  'utf8',
);
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

describe('wheel manual prizes migration', () => {
  it('adds the refusal to the existing enum without recreating it', () => {
    // `ADD VALUE IF NOT EXISTS` is transactional since PostgreSQL 12 and
    // replay-safe on its own. Recreating the type would need every column
    // using it to be rewritten, under a lock, for one new value.
    assert.match(sql, /ALTER TYPE "WheelSpinStatus" ADD VALUE IF NOT EXISTS 'REFUSED';/);
    assert.doesNotMatch(sql, /CREATE TYPE "WheelSpinStatus"/);
    assert.doesNotMatch(sql, /DROP TYPE/);
  });

  it('adds every column nullable, so no existing row is rewritten', () => {
    const columns = sql.match(/ALTER TABLE "wheel_spins"\s+ADD COLUMN[^;]+;/g) ?? [];
    assert.equal(columns.length, 3, 'settled_by, settlement_note, manual_ticket_id');
    for (const statement of columns) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
      assert.doesNotMatch(statement, /NOT NULL/, statement);
      assert.doesNotMatch(statement, /DEFAULT/, statement);
    }
  });

  it('touches no data at all', () => {
    // Nothing is backfilled and nothing is re-stated: the columns are new, the
    // enum value is written by nothing until an operator refuses something,
    // and there are no manual sectors on any wheel yet.
    assert.doesNotMatch(sql, /UPDATE "wheel_spins"/);
    assert.doesNotMatch(sql, /INSERT INTO/);
    assert.doesNotMatch(sql, /DELETE FROM/);
  });

  it('indexes the reverse lookup from a conversation to its spin', () => {
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS "wheel_spins_manual_ticket_id_idx"\s+ON "wheel_spins" \("manual_ticket_id"\)/,
    );
  });

  it('guards the lock timeout and is listed as auto-recoverable', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    assert.ok(
      entrypoint.includes(migrationName),
      `${migrationName} must be listed in is_auto_recoverable_migration`,
    );
  });
});
