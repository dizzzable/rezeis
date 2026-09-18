import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * A migration that bounds its lock wait takes the bound off again before it ends.
 * ═══════════════════════════════════════════════════════════════════════════════
 * `SET lock_timeout` is a SESSION setting, and `prisma migrate deploy` applies
 * every pending file over one connection. A file that sets the bound and never
 * takes it off hands it to every file applied after it in the same deploy.
 * Checked on PostgreSQL 17 with Prisma 7.9: a probe migration applied right
 * after `20260918160000_backfill_imported_payments_fulfilled_at` read
 * `lock_timeout = 5s` while that file had no RESET, and `0` once it had one.
 * A later file that never chose the bound then fails on a lock it would have
 * waited for — and unless it happens to be on the entrypoint's auto-recovery
 * list, that failure keeps the panel from booting.
 *
 * So from RULE_SINCE on, a file that sets `lock_timeout` ends with
 * `RESET lock_timeout;` — AFTER its last statement, so everything it runs is
 * bounded and nothing after it is. RESET and not `SET lock_timeout = 0`: RESET
 * returns the session to whatever the role or database was configured with,
 * where `= 0` would switch the bound off for every later file instead.
 *
 * Keyed on the SQL itself, like `migration-concurrent-index-recovery.spec.ts`:
 * the next file to adopt the bound has to make the same decision, and a test
 * that has to be edited to add one is a test that will be edited to silence one.
 */

const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');

/** The first migration that took its bound off with RESET; it and everything after it are held to it. */
const RULE_SINCE = '20260829120000_user_hints';

/**
 * Files that set `lock_timeout` before the rule and do not end with a RESET.
 * All are released, so editing one changes its checksum under every install
 * that has applied it; they are held to the rule no further.
 *
 * What they do, stated so nobody reads this list as "fine": the seven that
 * bound the wait put it back with `SET lock_timeout = 0` — some before their
 * last statements, which then run unbounded — and the first one only ever sets
 * `0`. Either way a deploy that applies one of them leaves `0` on the
 * connection for the files after it. Nothing newer than the rule may be added.
 */
const FROZEN_BEFORE_RULE: readonly string[] = [
  '20260708120000_perf_composite_indexes',
  '20260810120000_remnawave_panel_identity',
  '20260810160000_index_subscription_panel_identity',
  '20260823120000_partner_level_accrual_strategy',
  '20260828120000_blocked_identities',
  '20260828160000_blocklist_cascade',
  '20260828180000_device_observations',
  '20260828200000_legal_privacy_policy',
];

/** Length of a string literal or dollar-quoted body starting at `i`, or 0 when none starts there. */
function quotedLength(sql: string, i: number): number {
  if (sql[i] === "'") {
    let j = i + 1;
    while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
    return Math.min(j + 1, sql.length) - i;
  }
  const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i, i + 64));
  if (dollar) {
    const end = sql.indexOf(dollar[0], i + dollar[0].length);
    return (end === -1 ? sql.length : end + dollar[0].length) - i;
  }
  return 0;
}

/**
 * A migration's statements as Postgres will run them: comments dropped, split
 * on the semicolons that end a statement — never on one inside a string or a
 * dollar-quoted body — and whitespace folded.
 */
function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const quoted = quotedLength(sql, i);
    if (quoted > 0) {
      current += sql.slice(i, i + quoted);
      i += quoted;
      continue;
    }
    if (sql[i] === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  statements.push(current);
  return statements.map((statement) => statement.replace(/\s+/g, ' ').trim()).filter((statement) => statement.length > 0);
}

/** A session-level `SET lock_timeout` (a `SET LOCAL` ends with its transaction on its own). */
function setsLockTimeout(statement: string): boolean {
  return /^SET\s+(?:SESSION\s+)?lock_timeout\b/i.test(statement);
}

interface Bound {
  /** The file sets `lock_timeout` for the session. */
  readonly sets: boolean;
  /** Its last statement is `RESET lock_timeout`. */
  readonly resetLast: boolean;
}

function lockTimeoutBound(sql: string): Bound {
  const statements = statementsOf(sql);
  return {
    sets: statements.some(setsLockTimeout),
    resetLast: /^RESET\s+lock_timeout$/i.test(statements[statements.length - 1] ?? ''),
  };
}

function migrations(): Array<{ readonly name: string; readonly bound: Bound }> {
  return readdirSync(migrationsDir)
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort()
    .map((name) => ({ name, bound: lockTimeoutBound(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')) }));
}

describe('a migration that bounds its lock wait takes the bound off before it ends', () => {
  it('tells a bound from a mention, and a closing RESET from one with work after it', () => {
    // The detector itself, on SQL written here: a check that could never
    // report anything would pass the two cases below on any tree.
    assert.deepEqual(
      lockTimeoutBound("-- Bounded, as every file here does it.\nSET lock_timeout = '5s';\nCREATE TABLE a (id int);\nRESET lock_timeout;\n"),
      { sets: true, resetLast: true },
    );
    assert.deepEqual(
      lockTimeoutBound("SET lock_timeout = '5s';\nRESET lock_timeout;\nCREATE TABLE a (id int);\n"),
      { sets: true, resetLast: false },
      'work after the RESET runs unbounded',
    );
    assert.deepEqual(
      lockTimeoutBound("SET lock_timeout = '5s';\nCREATE TABLE a (id int);\nSET lock_timeout = 0;\n"),
      { sets: true, resetLast: false },
      '`= 0` is not a RESET',
    );
    assert.deepEqual(
      lockTimeoutBound("-- SET lock_timeout = '5s';\nSELECT 'SET lock_timeout = 1';\n/* SET lock_timeout = 2; */\n"),
      { sets: false, resetLast: false },
      'a comment or a string is not a bound',
    );
    assert.deepEqual(
      lockTimeoutBound("SET lock_timeout = '5s';\nDO $$ BEGIN PERFORM 1; END $$;\nRESET lock_timeout;\n-- done\n"),
      { sets: true, resetLast: true },
      'a comment after the RESET is not a statement',
    );
    assert.deepEqual(
      lockTimeoutBound(
        "CREATE FUNCTION bounded() RETURNS void AS $$\nBEGIN\n  PERFORM 1;\n  SET lock_timeout = '1s';\nEND\n$$ LANGUAGE plpgsql;\n",
      ),
      { sets: false, resetLast: false },
      'a SET inside a function body is not run by the migration',
    );
    assert.deepEqual(lockTimeoutBound("SET LOCAL lock_timeout = '5s';\nCREATE TABLE a (id int);\n"), {
      sets: false,
      resetLast: false,
    });
  });

  it('ends every migration from the rule on that sets the bound with RESET lock_timeout', () => {
    const held = migrations().filter((migration) => migration.name >= RULE_SINCE && migration.bound.sets);
    assert.ok(held.length >= 15, `only ${held.length} bounded migrations since ${RULE_SINCE} — the scan is wrong`);

    const open = held.filter((migration) => !migration.bound.resetLast).map((migration) => migration.name);
    assert.deepEqual(
      open,
      [],
      'these set lock_timeout for the whole deploy session and leave it set for every file applied after them — ' +
        `end each with \`RESET lock_timeout;\` after its last statement: ${open.join(', ')}`,
    );
  });

  it('keeps the files from before the rule to a closed list', () => {
    for (const name of FROZEN_BEFORE_RULE) assert.ok(name < RULE_SINCE, `${name} is not older than the rule`);
    const older = migrations()
      .filter((migration) => migration.name < RULE_SINCE && migration.bound.sets && !migration.bound.resetLast)
      .map((migration) => migration.name);
    assert.deepEqual(older, [...FROZEN_BEFORE_RULE]);
  });
});
