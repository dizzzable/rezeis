import 'reflect-metadata';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join, relative, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import ts from 'typescript';

import { BackupService } from '../src/modules/backup/services/backup.service';

// `require`, not a namespace import: under `esModuleInterop` a namespace import
// is a COPY of the module's properties, and patching a copy patches nothing
// the service can see (the same note as `backup-dump-output-failure.spec.ts`).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess: typeof import('node:child_process') = require('node:child_process');

/**
 * The landing's data stays (owner's decision, 26.09.2026)
 * ═══════════════════════════════════════════════════════
 * The web landing left the panel in 0.9.7.71, and its data did not: the
 * operator's draft, the published revision and the whole history stay in
 * `landing_configs` and `landing_revisions`, in every backup, and in every
 * restore. Nothing in the code needs the tables any more, which is exactly
 * what makes them easy to lose later:
 *
 *  - delete the two models from `schema.prisma` as dead code, and the next
 *    `prisma migrate dev` writes `DROP TABLE` for both;
 *  - add a "cleanup" migration or job, and the history is gone for good;
 *  - teach the backup a table filter, and a restore no longer brings them back.
 *
 * Each of those goes red here, and says why.
 */

const APP = join(__dirname, '..');
const MIGRATIONS = join(APP, 'prisma', 'migrations');
const CREATED_BY = '20260707000000_add_landing_config';
const TABLES = ['landing_configs', 'landing_revisions'] as const;

// ── The models ──────────────────────────────────────────────────────────────

/** The body of `model <name> { … }` in the schema, or null. */
function modelBlock(schema: string, name: string): string | null {
  const match = new RegExp(`^model ${name} \\{\\r?\\n([\\s\\S]*?)^\\}`, 'm').exec(schema);
  return match === null ? null : (match[1] ?? '');
}

/** The columns `CREATE TABLE "<table>"` gives in the migration that created it. */
function createdColumns(sql: string, table: string): string[] {
  const match = new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\r?\\n\\);`).exec(sql);
  assert.ok(match !== null, `${CREATED_BY} no longer creates "${table}"`);
  return (match[1] ?? '')
    .split(/\r?\n/)
    .map((line) => /^\s*"([a-z_]+)"/.exec(line)?.[1])
    .filter((column): column is string => column !== undefined);
}

describe('the landing tables keep their models', () => {
  const schema = readFileSync(join(APP, 'prisma', 'schema.prisma'), 'utf8');
  const created = readFileSync(join(MIGRATIONS, CREATED_BY, 'migration.sql'), 'utf8');

  for (const [model, table] of [
    ['LandingConfig', 'landing_configs'],
    ['LandingRevision', 'landing_revisions'],
  ] as const) {
    it(`${model} is still in schema.prisma, mapped to "${table}", with every column the table was created with`, () => {
      const block = modelBlock(schema, model);
      assert.ok(
        block !== null,
        `model ${model} is gone from schema.prisma: the next \`prisma migrate dev\` would DROP TABLE "${table}" ` +
          'and every landing an operator built with it. The model is kept on purpose (landing-retired.ts).',
      );
      assert.match(block, new RegExp(`@@map\\("${table}"\\)`), `${model} must stay mapped to "${table}"`);
      const columns = createdColumns(created, table);
      assert.ok(columns.length >= 5, `${table}: read ${columns.length} columns from ${CREATED_BY}`);
      for (const column of columns) {
        assert.match(
          block,
          new RegExp(`@map\\("${column}"\\)`),
          `${model} lost the field for "${table}"."${column}": a migration generated now would DROP COLUMN it`,
        );
      }
    });
  }
});

// ── The migrations ──────────────────────────────────────────────────────────

/** The SQL as statements: comments out, whitespace collapsed, lower case. */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((statement) => statement.length > 0);
}

/**
 * Why a statement would lose landing data, or null. A table named on its own
 * (not as the prefix of an index name such as `landing_revisions_published_at_idx`).
 */
function destroysLandingData(statement: string): string | null {
  const named = TABLES.filter((table) =>
    new RegExp(`(^|[^a-z0-9_])"?${table}"?($|[^a-z0-9_])`).test(statement),
  );
  if (named.length === 0) return null;
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [/^drop table\b/, 'drops the table'],
    [/^truncate\b/, 'empties the table'],
    [/^delete from\b/, 'deletes rows'],
    [/^update\b/, 'rewrites rows'],
    [/^alter table\b.*\bdrop column\b/, 'drops a column'],
    [/^alter table\b.*\brename\b/, 'renames the table or a column away from its model'],
  ];
  for (const [rule, why] of rules) {
    if (rule.test(statement)) return `${why} (${named.join(', ')})`;
  }
  return null;
}

describe('no migration after the landing’s own drops, empties or rewrites its tables', () => {
  it('the detector catches what it must, and lets the harmless through', () => {
    // Anti-vacuity: a detector that answers null to everything passes the scan below.
    for (const bad of [
      'DROP TABLE "landing_revisions"',
      'DROP TABLE IF EXISTS "public"."landing_configs"',
      'TRUNCATE TABLE "landing_revisions"',
      'DELETE FROM "landing_configs" WHERE "key" = \'default\'',
      'UPDATE "landing_revisions" SET "config" = \'{}\'',
      'ALTER TABLE "landing_configs" DROP COLUMN "draft"',
      'ALTER TABLE "landing_revisions" RENAME TO "old_revisions"',
    ]) {
      assert.notEqual(destroysLandingData(statementsOf(bad)[0] ?? ''), null, bad);
    }
    for (const harmless of [
      'CREATE INDEX "landing_revisions_published_at_idx" ON "landing_revisions"("published_at")',
      'DROP INDEX "landing_revisions_published_at_idx"',
      'DROP TABLE "landing_revisions_backup_tmp"',
      'DELETE FROM "admin_permissions" WHERE "resource" = \'landing_config\'',
    ]) {
      assert.equal(destroysLandingData(statementsOf(harmless)[0] ?? ''), null, harmless);
    }
  });

  it('holds for every migration there is', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{14}_/.test(name) && name > CREATED_BY)
      .sort();
    // Anti-emptiness: the patch this spec shipped with already had dozens after it.
    assert.ok(later.length >= 50, `only ${later.length} migrations after ${CREATED_BY}: is the directory right?`);
    const offences: string[] = [];
    for (const name of later) {
      const file = join(MIGRATIONS, name, 'migration.sql');
      if (!existsSync(file)) continue;
      for (const statement of statementsOf(readFileSync(file, 'utf8'))) {
        const why = destroysLandingData(statement);
        if (why !== null) offences.push(`${name}: ${why}: ${statement.slice(0, 120)}`);
      }
    }
    assert.deepEqual(
      offences,
      [],
      'the landing tables hold operators’ data that was kept on purpose when the landing was retired ' +
        '(0.9.7.71). Never drop, empty or rewrite them.',
    );
  });
});

// ── The code ────────────────────────────────────────────────────────────────

/**
 * Where the code reaches the landing rows: a Prisma delegate
 * (`.landingConfig`, `.landingRevision`, or by string) or SQL naming a table.
 * Comments do not count — only the syntax tree is read.
 */
function landingRowAccess(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!/landing/i.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && /^landing(?:Config|Revision)$/.test(node.name.text)) {
      hits.push(`.${node.name.text}`);
    } else if (
      (ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node))
      && (/landing_(?:configs|revisions)/.test(node.text) || /^landing(?:Config|Revision)$/.test(node.text))
    ) {
      hits.push(JSON.stringify(node.text.slice(0, 60)));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('nothing in the panel reads, rewrites or deletes the landing rows', () => {
  const SRC = join(APP, 'src');
  const files = (function walk(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  })(SRC);

  it('the scan sees a delegate call and raw SQL when there is one', () => {
    const probe = join(mkdtempSync(join(os.tmpdir(), 'landing-kept-')), 'probe.ts');
    try {
      writeFileSync(
        probe,
        [
          '// prisma.landingConfig in a comment is not access',
          'await prisma.landingRevision.deleteMany({});',
          'await tx.$executeRawUnsafe(`DELETE FROM "landing_configs" WHERE id = ${id}`);',
        ].join('\n'),
      );
      assert.deepEqual(landingRowAccess(probe), ['.landingRevision', JSON.stringify('DELETE FROM "landing_configs" WHERE id = ')]);
    } finally {
      rmSync(join(probe, '..'), { recursive: true, force: true });
    }
  });

  it('holds for every file under src/', () => {
    assert.ok(files.length > 500, `only ${files.length} files under src/`);
    const found = files.flatMap((file) =>
      landingRowAccess(file).map((hit) => `${relative(SRC, file).split(sep).join('/')}: ${hit}`),
    );
    assert.deepEqual(
      found,
      [],
      'the landing tables are kept for the operators’ data only (0.9.7.71). Code that reads them may be ' +
        'fine — an export, say — but make sure nothing deletes or rewrites a row, then narrow this test.',
    );
  });
});

// ── The backups ─────────────────────────────────────────────────────────────

type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
};

describe('every backup still dumps the landing tables', () => {
  let directory: string;
  let previousLocation: string | undefined;

  before(() => {
    previousLocation = process.env.BACKUP_LOCATION;
    directory = mkdtempSync(join(os.tmpdir(), 'landing-kept-backup-'));
    process.env.BACKUP_LOCATION = directory;
  });

  after(() => {
    if (previousLocation === undefined) delete process.env.BACKUP_LOCATION;
    else process.env.BACKUP_LOCATION = previousLocation;
    rmSync(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('pg_dump is given the whole database: no table or schema filter', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    mock.method(childProcess, 'spawn', (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      const child = new EventEmitter() as FakeChild;
      child.stdout = new Readable({ read() {} });
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      // Refuse to start: the arguments are the question, not the dump.
      setImmediate(() => child.emit('error', new Error('not started in this test')));
      return child;
    });
    const service = new BackupService(
      { host: 'postgres', port: 5432, user: 'rezeis', password: 'not-a-real-password', name: 'rezeis' } as never,
      {} as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
      {} as never,
      { add: async () => ({ id: 'job-1' }) } as never,
    );

    await assert.rejects(
      (service as unknown as { spawnPgDumpToFile(destination: string): Promise<number> }).spawnPgDumpToFile(
        join(directory, 'probe.sql.gz'),
      ),
      /pg_dump spawn failed/,
    );

    const dump = calls.find((call) => call.command === 'pg_dump');
    assert.ok(dump !== undefined, `pg_dump was not spawned: ${JSON.stringify(calls)}`);
    const database = dump.args.indexOf('-d');
    assert.ok(database !== -1 && dump.args[database + 1] === 'rezeis', 'the dump names the whole database');
    const FILTERS = [
      '-t', '--table', '-T', '--exclude-table', '--exclude-table-data', '--exclude-table-and-children',
      '-n', '--schema', '-N', '--exclude-schema', '-s', '--schema-only',
    ];
    const filters = dump.args.filter((arg) =>
      FILTERS.some((flag) => arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`))),
    );
    assert.deepEqual(
      filters,
      [],
      'a filtered dump would leave the landing tables out of every backup, and a restore would lose them',
    );
  });
});
