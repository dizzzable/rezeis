import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = join(__dirname, '..');
const migrationsDir = join(projectRoot, 'prisma', 'migrations');
const schema = readFileSync(join(projectRoot, 'prisma', 'schema.prisma'), 'utf8');
const entrypoint = readFileSync(join(projectRoot, 'docker-entrypoint.sh'), 'utf8');
const reconcileMigrationName = '20260806170000_reconcile_prisma_schema_drift';
/**
 * The newest migration that existed when the reconciliation was written. It is
 * the upper bound of the history the reconciliation corrects — everything up to
 * and including it must sort before the reconciliation, and everything after it
 * is ordinary later work with nothing to say about drift.
 */
const LAST_MIGRATION_BEFORE_RECONCILE = '20260806160000_drop_remnawave_webhook_is_processed_index';
const reconcileSql = readFileSync(
  join(migrationsDir, reconcileMigrationName, 'migration.sql'),
  'utf8',
);

interface LiveIndex {
  table: string;
  partial: boolean;
  unique: boolean;
}

/**
 * Replay the index DDL of the whole migration history and return the indexes a
 * fully-migrated database is left holding.
 */
function replayIndexHistory(): Map<string, LiveIndex> {
  const live = new Map<string, LiveIndex>();
  const migrations = readdirSync(migrationsDir)
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort();

  for (const migration of migrations) {
    const sql = readFileSync(join(migrationsDir, migration, 'migration.sql'), 'utf8');
    for (const statement of sql.replace(/^\s*--.*$/gm, '').split(';')) {
      const created = statement.match(
        /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"?(?:public"\.")?([A-Za-z0-9_]+)"?\s*(?:USING\s+\w+\s*)?\(/i,
      );
      if (created) {
        live.set(created[2] ?? '', {
          table: created[3] ?? '',
          partial: /\bWHERE\b/i.test(statement),
          unique: Boolean(created[1]),
        });
        continue;
      }

      const dropped = statement.match(
        /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"public"\.)?"([^"]+)"/i,
      );
      if (dropped) {
        live.delete(dropped[1] ?? '');
        continue;
      }

      // A dropped table takes its indexes with it.
      const droppedTable = statement.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i);
      if (droppedTable) {
        for (const [name, index] of live) {
          if (index.table === droppedTable[1]) {
            live.delete(name);
          }
        }
        continue;
      }

      const renamed = statement.match(
        /ALTER\s+INDEX\s+(?:"public"\.)?"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/i,
      );
      if (renamed) {
        const previous = live.get(renamed[1] ?? '');
        live.delete(renamed[1] ?? '');
        if (previous) {
          live.set(renamed[2] ?? '', previous);
        }
      }
    }
  }

  return live;
}

/**
 * Every index name `schema.prisma` implies: the explicit `map:` when one is
 * given, otherwise the name Prisma derives — `<table>_<columns>_idx`, built
 * from the mapped table and column names.
 */
function declaredIndexNames(): Set<string> {
  const declared = new Set<string>();

  for (const model of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const body = model[2] ?? '';
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model[1] ?? '';

    const columnOf = new Map<string, string>();
    for (const line of body.split('\n')) {
      const field = line.match(/^\s{2}(\w+)\s+\S+/);
      if (!field) {
        continue;
      }
      columnOf.set(field[1] ?? '', line.match(/@map\("([^"]+)"\)/)?.[1] ?? field[1] ?? '');
    }

    for (const index of body.matchAll(/@@index\(\[([^\]]+)\]([^)]*)\)/g)) {
      const explicitName = index[2]?.match(/map:\s*"([^"]+)"/)?.[1];
      if (explicitName) {
        declared.add(explicitName);
        continue;
      }
      // Strip any `(sort: Desc)` modifier down to the bare field name.
      const columns = (index[1] ?? '')
        .split(',')
        .map((field) => field.trim().replace(/\(.*$/, ''))
        .map((field) => columnOf.get(field) ?? field);
      declared.add(`${table}_${columns.join('_')}_idx`);
    }
  }

  return declared;
}

describe('prisma schema/migration drift', () => {
  /**
   * The regression this guards: a hand-written migration creates a performance
   * index, nobody mirrors it into `schema.prisma`, and the next `migrate dev`
   * silently emits a DROP for it. Six indexes, created by two migrations two
   * months apart, had accumulated that way before anyone diffed the two.
   *
   * Unique indexes are out of scope — they come from field-level `@unique` and
   * `@id` as much as from `@@unique`, so deriving their names means
   * re-implementing more of Prisma than this guard is worth. Partial indexes
   * are out of scope because Prisma cannot express a WHERE clause and
   * `migrate diff` leaves them alone for that reason.
   */
  it('declares every plain index the migration history leaves behind', () => {
    const declared = declaredIndexNames();
    const orphans = [...replayIndexHistory()]
      .filter(([, index]) => !index.unique && !index.partial)
      .filter(([name]) => !declared.has(name))
      .map(([name, index]) => `${name} (on ${index.table})`);

    assert.deepEqual(
      orphans,
      [],
      `these indexes exist only in the migration history, so \`prisma migrate dev\` would drop them — declare each one with @@index in schema.prisma:\n  ${orphans.join('\n  ')}`,
    );
  });

  it('keeps the schema side of the reconciliation in place', () => {
    // Lost from the enum by a mis-aligned diff hunk in 3420598; never dropped
    // from the database, and reconciliation still reverses payments from it.
    assert.match(schema, /enum TransactionStatus \{\s*PENDING\s+COMPLETED\s+CANCELED\s+REFUNDED\s+FAILED\s*\}/);
    // The only scalar list that was missing the empty-array default every
    // other list field (and every array column in the database) carries.
    assert.match(schema, /platforms\s+AdPlatform\[\]\s+@default\(\[\]\)\s+@map\("platforms"\)/);
  });

  it('reconciles the database side in one replay-safe forward migration', () => {
    // Newer than every migration it corrects, so it is a forward fix rather
    // than an edit to already-applied history.
    //
    // Bounded by the last migration that predates it, NOT by "every migration
    // in the directory". The unbounded form asserted something the comment
    // above never claimed — that no migration may ever be added after the
    // reconciliation — so the first ordinary feature migration to land turned
    // this red for a reason unrelated to drift.
    //
    // The bounded form has to be written carefully, because the obvious
    // rewrite is vacuous: "every migration at or below the boundary sorts
    // before the reconciliation" follows arithmetically from the boundary
    // itself sorting before it, so the loop could never fail whatever the
    // directory held. What IS falsifiable, and is the actual risk, is a
    // migration wedged BETWEEN the boundary and the reconciliation — authored
    // later but backdated into the history the reconciliation corrects, so it
    // runs before a fix that was never written with it in mind.
    const migrations = readdirSync(migrationsDir).filter((entry) => /^\d{14}_/.test(entry));
    assert.ok(
      migrations.includes(LAST_MIGRATION_BEFORE_RECONCILE),
      'the recorded boundary migration no longer exists — the bound is stale',
    );
    assert.ok(
      LAST_MIGRATION_BEFORE_RECONCILE < reconcileMigrationName,
      'the reconciliation must sort after the history it corrects',
    );
    assert.deepEqual(
      migrations.filter(
        (migration) =>
          migration > LAST_MIGRATION_BEFORE_RECONCILE && migration < reconcileMigrationName,
      ),
      [],
      'a migration was backdated into the window the reconciliation corrects',
    );

    // The three `updated_at` defaults the schema does not declare.
    for (const table of ['admin_theme_presets', 'auth_provider_configs', 'trial_claims']) {
      assert.match(
        reconcileSql,
        new RegExp(`ALTER TABLE "${table}" ALTER COLUMN "updated_at" DROP DEFAULT;`),
      );
    }

    // Renames are guarded both ways so a replay is a no-op instead of an error.
    assert.match(reconcileSql, /RENAME CONSTRAINT "add_on_entitlements_expiry_epoch_term_fkey"/);
    assert.match(reconcileSql, /RENAME CONSTRAINT "add_on_entitlements_term_subscription_fkey"/);
    assert.match(reconcileSql, /DROP CONSTRAINT IF EXISTS "add_on_entitlements_term_id_fkey"/);
    assert.match(reconcileSql, /ON DELETE CASCADE ON UPDATE CASCADE/);
    // Each of the three guarded blocks re-checks the catalog before acting.
    assert.equal(reconcileSql.match(/DO \$\$/g)?.length, 3);
    assert.equal(reconcileSql.match(/NOT EXISTS \(/g)?.length, 3);

    // Catalog-only: nothing here builds an index, so nothing needs
    // CONCURRENTLY. Checked against the executable DDL, not the prose header.
    assert.doesNotMatch(reconcileSql.replace(/^\s*--.*$/gm, ''), /CONCURRENTLY/);
  });

  it('stays off the entrypoint auto-recovery allowlist', () => {
    // The allowlist exists for CONCURRENTLY index builds, which can fail and
    // leave an invalid index behind. This migration is catalog-only DDL that
    // runs once; if it ever fails it should stop for operator review rather
    // than be replayed unattended.
    assert.match(entrypoint, /is_auto_recoverable_migration/);
    assert.ok(!entrypoint.includes(reconcileMigrationName));
  });
});
