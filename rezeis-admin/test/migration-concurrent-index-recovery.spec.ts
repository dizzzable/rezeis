import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * An interrupted CONCURRENTLY index build must not leave the panel unable to boot.
 * ═════════════════════════════════════════════════════════════════════════════
 * `CREATE INDEX CONCURRENTLY` commits its catalog entry before it builds, so a
 * build that is interrupted — an OOM, a deploy timeout, a cancel — leaves the
 * index behind marked INVALID, and Prisma leaves the migration failed. What the
 * next start then does is decided in `docker-entrypoint.sh`, by two lists:
 *
 *   - `is_auto_recoverable_migration`: without membership, `migrate deploy`
 *     answers P3009 and the API refuses to boot until a human runs
 *     `prisma migrate resolve`;
 *   - `cleanup_retry_artifacts`: without a case that drops the index, the one
 *     retry cannot repair it. With `IF NOT EXISTS` the retry SKIPS the INVALID
 *     index and the migration finishes over a dead index that reports as
 *     present; without it, the retry fails on "already exists".
 *
 * So both halves are one decision, and this is keyed on the SQL rather than on a
 * hand-kept list, like "the lock_timeout bound and its retry are one decision"
 * in `prisma-schema-drift.spec.ts`: the next migration to build an index
 * concurrently has to make the same decision, and a test that must be edited to
 * add one is a test that will be edited to silence one.
 */

const projectRoot = join(__dirname, '..');
const migrationsDir = join(projectRoot, 'prisma', 'migrations');
const entrypoint = readFileSync(join(projectRoot, 'docker-entrypoint.sh'), 'utf8');

/** The migration this rule arrived with; it and everything after it are held to it. */
const RULE_SINCE = '20260918120000_transactions_gateway_id_index';

/**
 * Concurrent builds that shipped before the rule existed, and are held to it no
 * further. Both are released — `20260522140000_performance_indexes` since
 * v0.2.2, `20260910000000_audit_log_action_created_at_index` since v0.9.7.51 —
 * so on every install already past those versions they have finished, and
 * editing a released migration changes its checksum under every such install.
 *
 * What they still cost, stated so nobody reads this list as "safe": an install
 * that is still behind one of them and is interrupted while building it gets
 * P3009 and a manual `prisma migrate resolve`, as before. Moving one under the
 * rule means an allowlist entry and a cleanup case for every index it builds —
 * after replaying it twice against a real database — and then taking it off
 * this list. Nothing newer than the rule may be added here.
 */
const FROZEN_BEFORE_RULE: readonly string[] = [
  '20260522140000_performance_indexes',
  '20260910000000_audit_log_action_created_at_index',
];

/**
 * The executable text of a migration: comments removed, string literals and
 * dollar-quoted bodies kept intact so a `--` or `;` inside one is not mistaken
 * for anything.
 */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end === -1 ? sql.length : end + dollar[0].length;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Every index a migration builds CONCURRENTLY, by name; `<unnamed>` for one Postgres would name. */
function concurrentBuilds(): Map<string, string[]> {
  const builds = new Map<string, string[]>();
  for (const migration of readdirSync(migrationsDir).filter((entry) => /^\d{14}_/.test(entry)).sort()) {
    const sql = stripSqlComments(readFileSync(join(migrationsDir, migration, 'migration.sql'), 'utf8'));
    const names = [
      ...sql.matchAll(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?public"?\s*\.\s*)?"?[A-Za-z0-9_]+"?)/gi,
      ),
    ].map((match) => {
      const name = (match[1] ?? '').replace(/^"?public"?\s*\.\s*/i, '').replace(/"/g, '');
      return name.toUpperCase() === 'ON' ? '<unnamed>' : name;
    });
    if (names.length > 0) builds.set(migration, names);
  }
  return builds;
}

/** The body of one shell function in the entrypoint, `name() {` to the `}` that closes it. */
function shellFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\)\\s*\\{\\n([\\s\\S]*?)^\\}`, 'm').exec(entrypoint);
  assert.ok(match, `docker-entrypoint.sh no longer defines ${name}()`);
  return match[1] ?? '';
}

/** The `case` arms of a function: each label with the text up to its `;;`. */
function caseArms(body: string): Array<{ labels: string[]; body: string }> {
  const arms: Array<{ labels: string[]; body: string }> = [];
  for (const match of body.matchAll(/^\s*([0-9A-Za-z_|*]+)\)\s*\n([\s\S]*?)^\s*;;/gm)) {
    arms.push({ labels: (match[1] ?? '').split('|'), body: match[2] ?? '' });
  }
  return arms;
}

/** Migrations the entrypoint will resolve and replay once after a P3009. */
function autoRecoverable(): Set<string> {
  const recoverable = new Set<string>();
  for (const arm of caseArms(shellFunction('is_auto_recoverable_migration'))) {
    if (!/^\s*return 0\s*$/m.test(arm.body)) continue;
    for (const label of arm.labels) if (label !== '*') recoverable.add(label);
  }
  return recoverable;
}

/**
 * The indexes `cleanup_retry_artifacts` drops before a migration's retry, per
 * migration — counted only where the drop really runs (`db execute`) and a
 * failed drop stops the start (`return 1`) instead of retrying over the index.
 */
function retryCleanups(): Map<string, { dropped: string[]; executes: boolean; failsClosed: boolean }> {
  const cleanups = new Map<string, { dropped: string[]; executes: boolean; failsClosed: boolean }>();
  for (const arm of caseArms(shellFunction('cleanup_retry_artifacts'))) {
    const dropped = [
      ...arm.body.matchAll(/DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"public"\."([A-Za-z0-9_]+)"/g),
    ].map((match) => match[1] ?? '');
    for (const label of arm.labels) {
      cleanups.set(label, {
        dropped,
        executes: /"\$\{PRISMA\}" db execute --stdin/.test(arm.body),
        failsClosed: /^\s*return 1\s*$/m.test(arm.body),
      });
    }
  }
  return cleanups;
}

describe('an interrupted concurrent index build is recovered on the next start', () => {
  it('finds every concurrent build, with IF NOT EXISTS and without it', () => {
    // Anchors for the parser, so a regex that silently matches nothing cannot
    // pass the rule below by having nothing to check.
    const builds = concurrentBuilds();
    assert.deepEqual(builds.get(RULE_SINCE), ['transactions_gateway_id_idx']);
    assert.deepEqual(builds.get('20260724120000_reconcile_subscription_expiry_index'), [
      'subscriptions_status_expires_at_rebuild_idx',
    ]);
    assert.equal(builds.get('20260522140000_performance_indexes')?.length, 7);
    // Prose is not DDL: this header explains why it does NOT build concurrently.
    assert.equal(builds.has('20260810160000_index_subscription_panel_identity'), false);
  });

  it('reads the entrypoint the way the shell does', () => {
    const recoverable = autoRecoverable();
    assert.ok(recoverable.has('20260724120000_reconcile_subscription_expiry_index'));
    assert.ok(recoverable.has('20260708120000_perf_composite_indexes'));
    assert.equal(recoverable.has('*'), false);
    assert.deepEqual(retryCleanups().get('20260724120000_reconcile_subscription_expiry_index'), {
      dropped: ['subscriptions_status_expires_at_rebuild_idx'],
      executes: true,
      failsClosed: true,
    });
    // The drop runs before the failed row is marked rolled back — the order the
    // retry depends on.
    const cleanupAt = entrypoint.indexOf('cleanup_retry_artifacts "${failed_migration}"');
    const resolveAt = entrypoint.indexOf('migrate resolve --rolled-back "${failed_migration}"');
    assert.ok(cleanupAt >= 0 && cleanupAt < resolveAt, 'the cleanup no longer runs before the resolve');
  });

  it('makes every concurrent build recoverable: replayed once, and its index dropped first', () => {
    const recoverable = autoRecoverable();
    const cleanups = retryCleanups();
    const governed = [...concurrentBuilds()].filter(([migration]) => !FROZEN_BEFORE_RULE.includes(migration));

    assert.ok(
      governed.some(([migration]) => migration === RULE_SINCE),
      'the migration the rule arrived with is not among those it checks — the filter is wrong',
    );

    const problems: string[] = [];
    for (const [migration, indexes] of governed) {
      if (!recoverable.has(migration)) {
        problems.push(`${migration}: not in is_auto_recoverable_migration, so an interrupted build is P3009 and no boot`);
      }
      const cleanup = cleanups.get(migration);
      if (cleanup === undefined) {
        problems.push(`${migration}: no cleanup_retry_artifacts case, so the retry cannot replace the INVALID index`);
        continue;
      }
      for (const index of indexes) {
        if (!cleanup.dropped.includes(index)) {
          problems.push(`${migration}: its cleanup does not DROP INDEX CONCURRENTLY IF EXISTS "public"."${index}"`);
        }
      }
      if (!cleanup.executes) problems.push(`${migration}: its cleanup never runs the drop through prisma db execute`);
      if (!cleanup.failsClosed) problems.push(`${migration}: a failed drop does not stop the start (return 1)`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('keeps the frozen list to released builds older than the rule', () => {
    const builds = concurrentBuilds();
    for (const migration of FROZEN_BEFORE_RULE) {
      assert.ok(migration < RULE_SINCE, `${migration} is newer than the rule and must meet it instead`);
      assert.ok(builds.has(migration), `${migration} no longer builds an index concurrently — take it off the list`);
    }
  });
});
