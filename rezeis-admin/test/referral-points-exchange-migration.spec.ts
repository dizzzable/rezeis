import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const migrationPath = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20260724193000_add_referral_points_exchange_history',
  'migration.sql',
);

describe('referral point exchange history migration', () => {
  it('adds an immutable exchange ledger with idempotency and linked sync metadata', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    assert.match(sql, /CREATE TYPE "ReferralPointsExchangeType"/);
    assert.match(sql, /CREATE TABLE "referral_points_exchanges"/);
    assert.match(sql, /"points_spent" INTEGER NOT NULL/);
    assert.match(sql, /"profile_sync_job_id" TEXT/);
    assert.match(sql, /"gift_promocode_id" TEXT/);
    assert.match(sql, /UNIQUE INDEX "referral_points_exchanges_user_id_idempotency_key_key"/);
    assert.match(sql, /FOREIGN KEY \("profile_sync_job_id"\).*ON DELETE SET NULL/);
    assert.match(sql, /FOREIGN KEY \("user_id"\).*ON DELETE CASCADE/);
  });
});
