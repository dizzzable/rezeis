import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = join(__dirname, '..');
const schema = readFileSync(join(projectRoot, 'prisma', 'schema.prisma'), 'utf8');
const migrationName = '20260712130000_add_subscription_add_on_entitlements';
const migrationPath = join(projectRoot, 'prisma', 'migrations', migrationName, 'migration.sql');

function block(source: string, kind: 'enum' | 'model', name: string): string {
  const match = source.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${kind} ${name} must exist`);
  return match[0];
}

describe('subscription add-on entitlement schema', () => {
  it('orders the additive migration after every existing migration', () => {
    const migrations = readdirSync(join(projectRoot, 'prisma', 'migrations'))
      .filter((entry) => /^\d{14}_/.test(entry));
    const priorMigration = '20260712120000_quest_partner_settings';
    assert.ok(migrations.includes(migrationName), `${migrationName} must exist`);
    assert.ok(migrations.includes(priorMigration), `${priorMigration} must exist`);
    assert.ok(migrationName > priorMigration, `${migrationName} must sort after ${priorMigration}`);
  });

  it('adds catalog lifetime, revision, and archival without changing compatibility limits', () => {
    const lifetime = block(schema, 'enum', 'AddOnLifetime');
    assert.match(lifetime, /UNTIL_NEXT_RESET/);
    assert.match(lifetime, /UNTIL_SUBSCRIPTION_END/);

    const addOn = block(schema, 'model', 'AddOn');
    assert.match(addOn, /lifetime\s+AddOnLifetime\s+@default\(UNTIL_NEXT_RESET\)/);
    assert.match(addOn, /revision\s+Int\s+@default\(1\)/);
    assert.match(addOn, /archivedAt\s+DateTime\?/);

    const subscription = block(schema, 'model', 'Subscription');
    assert.match(subscription, /trafficLimit\s+Int\?/);
    assert.match(subscription, /deviceLimit\s+Int\s+@default\(0\)/);
  });

  it('models terms, planned reset epochs, and immutable source-line entitlements', () => {
    const term = block(schema, 'model', 'SubscriptionTerm');
    assert.match(term, /baseTrafficLimitBytes\s+BigInt\?/);
    assert.match(term, /baseDeviceLimit\s+Int\?/);
    assert.match(term, /@@unique\(\[subscriptionId, generation\]\)/);

    const epoch = block(schema, 'model', 'SubscriptionResetEpoch');
    assert.match(epoch, /term\s+SubscriptionTerm[\s\S]*onDelete: Restrict/);
    assert.match(epoch, /@@unique\(\[termId, ordinal\]\)/);
    assert.match(epoch, /@@unique\(\[termId, plannedEndsAt\]\)/);

    const entitlement = block(schema, 'model', 'AddOnEntitlement');
    assert.match(entitlement, /sourceTransactionId\s+String/);
    assert.match(entitlement, /sourceLineKey\s+String/);
    assert.match(entitlement, /quantity\s+Int\s+@default\(1\)/);
    assert.match(entitlement, /expiresAt\s+DateTime\?/);
    assert.match(entitlement, /addOn\s+AddOn\?[\s\S]*onDelete: Restrict/);
    assert.match(entitlement, /expiryEpoch\s+SubscriptionResetEpoch\?[\s\S]*fields: \[expiryEpochId, termId\][\s\S]*references: \[id, termId\][\s\S]*onDelete: Restrict/);
    assert.match(entitlement, /@@unique\(\[sourceTransactionId, sourceLineKey\]\)/);

    const event = block(schema, 'model', 'AddOnEntitlementEvent');
    assert.match(event, /entitlementId\s+String/);
    assert.match(event, /correlationId\s+String/);
    assert.match(event, /commandKey\s+String/);
    assert.match(event, /@@unique\(\[entitlementId, commandKey\]\)/);
  });

  it('adds versioned projection, durable device cleanup, incidents, and sync metadata', () => {
    const projection = block(schema, 'model', 'SubscriptionEffectiveProjection');
    assert.match(projection, /subscriptionId\s+String\s+@unique/);
    assert.match(projection, /desiredRevision\s+BigInt/);
    assert.match(projection, /desiredTrafficLimitBytes\s+BigInt\?/);
    assert.match(projection, /desiredDeviceLimit\s+Int\?/);

    const plan = block(schema, 'model', 'DeviceReductionPlan');
    assert.match(plan, /projectionRevision\s+BigInt/);
    assert.match(plan, /selectedDevices\s+Json/);

    const incident = block(schema, 'model', 'EntitlementIncident');
    assert.match(incident, /kind\s+EntitlementIncidentKind/);
    assert.match(incident, /state\s+EntitlementIncidentState/);

    const syncJob = block(schema, 'model', 'ProfileSyncJob');
    assert.match(syncJob, /desiredRevision\s+BigInt\?/);
    assert.match(syncJob, /aggregateKey\s+String\?/);
    assert.match(syncJob, /cause\s+String\?/);
    assert.match(syncJob, /supersededAt\s+DateTime\?/);
    assert.match(syncJob, /@@index\(\[aggregateKey, desiredRevision\]\)/);
    assert.match(syncJob, /@@index\(\[status, scheduledAt\]\)/);
  });

  it('keeps the hand-written migration additive and aligned with the ledger primitives', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'subscription_terms',
      'subscription_reset_epochs',
      'add_on_entitlements',
      'add_on_entitlement_events',
      'subscription_effective_projections',
      'device_reduction_plans',
      'entitlement_incidents',
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    }

    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
    assert.doesNotMatch(sql, /ALTER\s+COLUMN/i);
    assert.doesNotMatch(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    assert.doesNotMatch(sql, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    assert.doesNotMatch(sql, /EXCEPTION\s+WHEN\s+duplicate_object/i);
    assert.match(sql, /CREATE UNIQUE INDEX "subscription_terms_one_active_idx"[\s\S]*WHERE "status" = 'ACTIVE'/);
    assert.match(sql, /CREATE UNIQUE INDEX "add_on_entitlements_source_transaction_id_source_line_key_key"/);
    assert.match(sql, /CREATE UNIQUE INDEX "add_on_entitlement_events_entitlement_id_command_key_key"/);
    assert.match(sql, /ALTER TABLE "profile_sync_jobs" ADD COLUMN[\s\S]*"aggregate_key"/);
    assert.match(sql, /ADD COLUMN\s+"cause"/);
    assert.match(sql, /ADD COLUMN\s+"desired_revision"/);
    assert.match(sql, /ADD COLUMN\s+"recovery_data"/);
    assert.match(sql, /ADD COLUMN\s+"superseded_at"/);
    assert.match(sql, /ALTER TABLE "add_ons" ADD COLUMN[\s\S]*"archived_at"/);
    assert.match(sql, /ADD COLUMN\s+"lifetime"/);
    assert.match(sql, /ADD COLUMN\s+"revision"/);
    assert.match(sql, /CONSTRAINT "add_ons_revision_check"\s+CHECK/);
    assert.match(sql, /CONSTRAINT "subscription_reset_epochs_term_id_fkey"\s+FOREIGN KEY[\s\S]*ON DELETE RESTRICT/);
    assert.match(sql, /CONSTRAINT "add_on_entitlements_term_subscription_fkey"\s+FOREIGN KEY \("term_id", "subscription_id"\)[\s\S]*ON DELETE RESTRICT/);
    assert.match(sql, /CONSTRAINT "add_on_entitlements_expiry_epoch_term_fkey"\s+FOREIGN KEY \("expiry_epoch_id", "term_id"\)[\s\S]*ON DELETE RESTRICT/);
    for (const constraint of [
      'subscription_terms_generation_check',
      'subscription_reset_epochs_ordinal_check',
      'subscription_reset_epochs_boundary_check',
      'add_on_entitlements_commercial_values_check',
      'add_on_entitlements_boundary_check',
      'subscription_effective_projections_nonnegative_check',
      'device_reduction_plans_nonnegative_check',
    ]) {
      assert.match(sql, new RegExp(`CONSTRAINT "${constraint}"\\s+CHECK`));
    }
  });
});
