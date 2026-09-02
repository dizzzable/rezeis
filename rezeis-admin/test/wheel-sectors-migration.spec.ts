import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const migrationName = '20260902180000_wheel_sectors_and_spins';
const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'),
  'utf8',
);
const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');
const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

describe('wheel sectors and spins migration', () => {
  it('creates the four tables the wheel needs and nothing more', () => {
    for (const table of ['wheel_key_pools', 'wheel_sectors', 'wheel_spins', 'wheel_keys']) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`), table);
    }
    // There is deliberately no `wheels` table: one wheel was asked for, and a
    // table with one row in it forever adds a join to every query to say
    // nothing.
    assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS "wheels"/);
  });

  it('gives the spin request handle a unique index per person', () => {
    // This is the whole of idempotency: a replayed request finds its own spin
    // instead of spending a second one.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "wheel_spins_user_id_idempotency_key_key"\s+ON "wheel_spins" \("user_id", "idempotency_key"\)/,
    );
  });

  it('cannot load the same key into one pool twice', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "wheel_keys_pool_id_value_key"\s+ON "wheel_keys" \("pool_id", "value"\)/,
    );
    // And one spin claims at most one key.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS "wheel_keys_claimed_spin_id_key"\s+ON "wheel_keys" \("claimed_spin_id"\)/,
    );
  });

  it('keeps a spin readable after its sector is deleted', () => {
    // The snapshot is the history; the reference is a convenience. Deleting a
    // sector must not erase what somebody remembers winning, which is why the
    // foreign key nulls rather than cascades.
    assert.match(sql, /"sector_snapshot" JSONB NOT NULL/);
    assert.match(
      sql,
      /ADD CONSTRAINT "wheel_spins_sector_id_fkey"\s+FOREIGN KEY \("sector_id"\) REFERENCES "wheel_sectors"\("id"\)\s+ON DELETE SET NULL/,
    );
    // A deleted USER is different: their spins go with them.
    assert.match(
      sql,
      /ADD CONSTRAINT "wheel_spins_user_id_fkey"\s+FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)\s+ON DELETE CASCADE/,
    );
  });

  it('starts every sector switched off', () => {
    assert.match(sql, /"enabled"\s+BOOLEAN NOT NULL DEFAULT false/);
    assert.match(sql, /"wheel_settings" JSONB NOT NULL DEFAULT '\{\}'/);
    assert.doesNotMatch(sql, /INSERT INTO "wheel_sectors"/, 'no sector is seeded');
  });

  it('stores a weight, never a percent', () => {
    // Percents per row have to add up and nothing can make them; weights
    // cannot fail to.
    assert.match(sql, /"weight"\s+INTEGER NOT NULL DEFAULT 0/);
    assert.doesNotMatch(sql, /"chance_percent"|"percent"\s+/);
    assert.match(schema, /weight\s+Int\s+@default\(0\) @map\("weight"\)/);
  });

  it('guards every statement so a partial run can be replayed', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    for (const type of ['WheelSectorKind', 'WheelRarity', 'WheelSpinPayment', 'WheelSpinStatus']) {
      assert.match(
        sql,
        new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${type}'\\)`),
        type,
      );
    }
    for (const statement of sql.match(/ALTER TABLE "[a-z_]+"\s+ADD COLUMN[^;]+;/g) ?? []) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
    }
    for (const statement of sql.match(/CREATE (UNIQUE )?INDEX[^;]+;/g) ?? []) {
      assert.match(statement, /IF NOT EXISTS/, statement);
    }
    for (const constraint of sql.match(/ADD CONSTRAINT "([a-z_]+)"/g) ?? []) {
      const name = constraint.replace(/ADD CONSTRAINT "|"/g, '');
      assert.match(sql, new RegExp(`conname = '${name}'`), `${name} is added unguarded`);
    }
  });

  it('is listed as auto-recoverable in the entrypoint', () => {
    assert.ok(
      entrypoint.includes(migrationName),
      `${migrationName} must be listed in is_auto_recoverable_migration`,
    );
  });

  it('declares the nine sector kinds the code branches on', () => {
    const enumBlock = sql.slice(
      sql.indexOf('CREATE TYPE "WheelSectorKind"'),
      sql.indexOf('CREATE TYPE "WheelRarity"'),
    );
    for (const value of [
      'NOTHING',
      'POINTS',
      'SPINS',
      'DAYS',
      'TRAFFIC',
      'DISCOUNT',
      'PROMOCODE',
      'KEY',
      'MANUAL',
    ]) {
      assert.match(enumBlock, new RegExp(`'${value}'`), value);
    }
  });
});
