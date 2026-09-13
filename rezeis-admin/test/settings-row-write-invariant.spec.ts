import assert from 'node:assert/strict';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

/**
 * Nothing writes the settings row except through the lock helper
 * ══════════════════════════════════════════════════════════════
 * `settings` is one row of shared JSON blobs, and every writer merges its own
 * key into a blob it read and writes the whole column back. Twenty-eight write
 * calls on the row lived in ten files and none of them locked it, so two
 * merges that overlapped kept only one change — the SMTP password, the bot
 * token, the VAPID keypair, whichever lost the race. `settings-row-write.util.ts` now
 * takes `SELECT ... FOR UPDATE` before the read and bumps the cache
 * generation after the commit. That only helps the writes that go through it,
 * and the next writer added the old way looks exactly like the twenty-eight
 * did: correct in every test that runs one request at a time.
 *
 * So the rule is structural. A write to the row anywhere in `src/` or
 * `scripts/` outside the helper — or outside a file named, with a reason, in
 * `EXCEPTIONS` below — fails this spec.
 *
 * What counts as a write
 * ──────────────────────
 * The scan runs the TypeScript checker over the real program rather than a
 * regex over text, because the easy evasions are all about spelling:
 *
 *   - a write method (`create`, `update`, `upsert`, `delete`, their `Many` /
 *     `ManyAndReturn` forms) called on anything whose TYPE is Prisma's
 *     `SettingsDelegate`. The receiver's name is irrelevant: `tx`, `prisma`,
 *     `this.prismaService`, a local alias of the client, a parameter typed as
 *     the delegate, a destructured `settings`, `tx['settings']` — all one type;
 *   - the delegate ESCAPING into a value — assigned, destructured, passed as an
 *     argument, returned — instead of being used on the spot for a read. Once
 *     it is inside `upsertById(delegate)` its writes are typed as some generic
 *     interface and are invisible to the rule above, so the escape itself is
 *     the violation;
 *   - `.settings.<write>(` spelled out, whatever the receiver's type. This is
 *     the backstop for `(tx as any).settings.update(`, where the type is gone;
 *   - raw SQL in a string or template literal that writes, truncates, alters or
 *     row-locks the `settings` table. The one lock statement lives in the
 *     helper, and `WheelSectorService` reaches it through `lockSettingsRow`.
 *
 * Plus one rule about the cache: a file that writes inside a transaction it
 * owns (`mutateSettingsRowInTransaction`) must open that transaction with
 * `runSettingsWriteTransaction`, the call that bumps the generation.
 *
 * Blind spots, stated
 * ───────────────────
 *   - The delegate laundered through `any` or `unknown` BEFORE the property
 *     access is not followed: `const s = (tx as any).settings; s.update()`
 *     passes. So does fully reflective access — `Reflect.get`, `Object.values`
 *     over the client, `(tx as any)[name]` with a computed name.
 *   - Raw SQL is recognised only inside a single literal. SQL assembled at
 *     runtime (`'UPDATE ' + table`, `Prisma.raw(variable)`) is not seen, and
 *     neither is a write in a PostgreSQL function or trigger.
 *   - A Prisma client extension (`$extends` with a `query` hook) that writes
 *     the row as a side effect of another model's call is not seen.
 *   - Writes from outside this process are out of reach altogether: the backup
 *     restore replaces the row through `psql`, migrations and an operator's
 *     own SQL session do not go through any code here.
 *   - `test/` is not scanned. Fixtures write the row directly on purpose.
 *   - The transaction rule proves that a file calls both functions, not that
 *     the write actually happens inside the transaction the bump wraps.
 *   - None of this checks that a merge is written from the row the helper read
 *     rather than from something the caller computed earlier. Custom emoji
 *     packs are the known case: the pack list is computed outside the lock.
 *
 * The anchors matter as much as the verdict
 * ─────────────────────────────────────────
 * A type-based scan that silently stops resolving types finds nothing and
 * passes forever. So before the verdict is trusted, the scan is shown a
 * fixture holding every evasion above and must flag each one and nothing
 * else, and it must still find the helper's own writes and a known read in
 * another module of the real tree.
 */

const REPO_ROOT = join(__dirname, '..');
const HELPER = 'src/modules/settings/utils/settings-row-write.util.ts';
const FIXTURE = 'test/__settings-row-write-invariant-fixture__.ts';

/**
 * Files allowed to write the row, and why. Keys are repo-relative with POSIX
 * separators. An entry without a reason is a silenced test, not a decision.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  [HELPER]:
    'The helper itself: the only place that takes the row lock, reads under it, writes the row and bumps the cache generation.',
};

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Members of the delegate that only read, or only describe the model. */
const READ_MEMBERS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'fields',
]);

const TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?settings"?(?![\w"])`;
const RAW_SQL_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|LOCK(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?${TABLE}`,
    'i',
  ),
  new RegExp(String.raw`\bFROM\s+${TABLE}[\s\S]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b`, 'i'),
];

type Rule = 'delegate-write' | 'delegate-escape' | 'raw-sql';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
}

/**
 * Every evasion the rules above claim to catch, and three reads they must not
 * flag. Each line that must be flagged says so with `expect: <rule>`; the test
 * derives its expectation from these markers rather than from line numbers
 * written down beside it.
 */
const FIXTURE_SOURCE = [
  "import { Prisma, PrismaClient } from '@prisma/client';",
  '',
  'declare const prisma: PrismaClient;',
  'declare const tx: Prisma.TransactionClient;',
  'declare const gateway: { readonly settings: Record<string, unknown> };',
  'declare function upsertById(delegate: { update(args: unknown): Promise<unknown> }): Promise<void>;',
  '',
  'export async function evasions(): Promise<void> {',
  "  await tx.settings.update({ where: { id: 1 }, data: { rulesLink: '' } }); // expect: delegate-write",
  '  const db = prisma;',
  '  await db.settings.upsert({ where: { id: 1 }, create: {}, update: {} }); // expect: delegate-write',
  '  await prisma',
  '    .settings /* a comment between the tokens */',
  '    .deleteMany({}); // expect: delegate-write',
  '  const delegate = tx.settings; // expect: delegate-escape',
  '  await delegate.create({ data: {} }); // expect: delegate-write',
  '  const { settings } = tx; // expect: delegate-escape',
  '  await settings.updateMany({ data: {} }); // expect: delegate-write',
  "  await tx['settings'].createMany({ data: [{}] }); // expect: delegate-write",
  "  await tx.settings['update']({ where: { id: 1 }, data: {} }); // expect: delegate-write",
  '  await (tx as any).settings.update({ where: { id: 1 }, data: {} }); // expect: delegate-write',
  '  await upsertById(prisma.settings); // expect: delegate-escape',
  '  await tx.$executeRaw`UPDATE "settings" SET "rules_link" = \'\'`; // expect: raw-sql',
  "  await tx.$executeRawUnsafe('insert into settings (id) values (1)'); // expect: raw-sql",
  '  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "settings" FOR UPDATE`); // expect: raw-sql',
  '  // Reads, and a JSON property that merely shares the name.',
  "  await tx.settings.findFirst({ orderBy: { updatedAt: 'asc' } });",
  '  await prisma.settings.findUnique({ where: { id: 1 } });',
  '  await tx.$queryRaw`SELECT "id" FROM "settings"`;',
  '  void gateway.settings;',
  '}',
  '',
  'export async function viaParameter(delegate: Prisma.SettingsDelegate): Promise<void> {',
  '  await delegate.delete({ where: { id: 1 } }); // expect: delegate-write',
  '}',
  '',
].join('\n');

/** Repo-relative, POSIX-separated — the key shape `EXCEPTIONS` uses. */
function repoPath(fileName: string): string {
  return relative(REPO_ROOT, fileName).split(sep).join('/');
}

function sameFile(a: string, b: string): boolean {
  const normalise = (value: string): string => {
    const posix = value.split('\\').join('/');
    return process.platform === 'win32' ? posix.toLowerCase() : posix;
  };
  return normalise(a) === normalise(b);
}

interface Scan {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly fixture: ts.SourceFile;
}

let memo: Scan | null = null;

/**
 * One program for the real tree, the scripts and the fixture. Built once:
 * resolving the Prisma client's types is most of the cost of this file.
 */
function loadScan(): Scan {
  if (memo !== null) return memo;
  const configPath = join(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  assert.equal(config.error, undefined, 'tsconfig.json must parse');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  const scripts = ts.sys.readDirectory(join(REPO_ROOT, 'scripts'), ['.ts']);
  const fixturePath = join(REPO_ROOT, FIXTURE).split(sep).join('/');
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    declaration: false,
    sourceMap: false,
    rootDir: undefined,
  };
  const host = ts.createCompilerHost(options, true);
  const readSource = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    sameFile(fileName, fixturePath)
      ? ts.createSourceFile(fileName, FIXTURE_SOURCE, languageVersion, true)
      : readSource(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) => sameFile(fileName, fixturePath) || exists(fileName);
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, ...scripts, fixturePath],
    options,
    host,
  });
  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && !repoPath(file.fileName).startsWith('..'))
    .filter((file) => /^(src|scripts)\//.test(repoPath(file.fileName)));
  const fixture = program.getSourceFiles().find((file) => sameFile(file.fileName, fixturePath));
  assert.ok(fixture !== undefined, 'the fixture must be part of the program');
  memo = { program, checker: program.getTypeChecker(), sourceFiles, fixture };
  return memo;
}

/** Prisma's generated `SettingsDelegate`, alone or inside a union. */
function isSettingsDelegate(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isSettingsDelegate);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined || symbol.getName() !== 'SettingsDelegate') return false;
  return (symbol.declarations ?? []).some((declaration) =>
    declaration.getSourceFile().fileName.split('\\').join('/').includes('/.prisma/client/'),
  );
}

function memberName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** `x.settings`, `x?.settings` or `x['settings']`. */
function isSettingsAccess(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    memberName(node) === 'settings'
  );
}

/**
 * Where a value goes: the outermost `( )` / `!` wrapper around it, and the node
 * that wrapper sits in.
 */
function useOf(node: ts.Node): { readonly value: ts.Node; readonly use: ts.Node } {
  let value = node;
  while (ts.isParenthesizedExpression(value.parent) || ts.isNonNullExpression(value.parent)) {
    value = value.parent;
  }
  return { value, use: value.parent };
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ${} ');
  }
  return null;
}

function scanFile(scan: Scan, file: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const at = (node: ts.Node, rule: Rule): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ file: repoPath(file.fileName), line: line + 1, rule });
  };
  const typeOf = (node: ts.Node): ts.Type => scan.checker.getTypeAtLocation(node);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = memberName(callee);
      if (
        method !== null &&
        WRITE_METHODS.has(method) &&
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      ) {
        const receiver = callee.expression;
        // Typed: whatever the receiver is called. Spelled: whatever its type.
        if (isSettingsDelegate(typeOf(receiver)) || isSettingsAccess(receiver)) {
          at(ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression, 'delegate-write');
        }
      }
    }

    const dynamicAccess = ts.isElementAccessExpression(node) && memberName(node) === null;
    if ((isSettingsAccess(node) || dynamicAccess) && isSettingsDelegate(typeOf(node))) {
      const { value, use } = useOf(node);
      const member =
        (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) &&
        use.expression === value
          ? memberName(use)
          : null;
      // A read used on the spot is fine; a write is reported by the call rule
      // above. Anything else hands the delegate to code this scan cannot see.
      if (member === null || (!READ_MEMBERS.has(member) && !WRITE_METHODS.has(member))) {
        at(ts.isPropertyAccessExpression(node) ? node.name : node, 'delegate-escape');
      }
    }

    if (ts.isBindingElement(node)) {
      const bound = node.propertyName ?? node.name;
      if (ts.isIdentifier(bound) && bound.text === 'settings' && isSettingsDelegate(typeOf(node))) {
        at(node, 'delegate-escape');
      }
    }

    const text = literalText(node);
    if (text !== null && RAW_SQL_PATTERNS.some((pattern) => pattern.test(text))) {
      at(node, 'raw-sql');
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(file);

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.line}:${finding.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanTree(scan: Scan): Finding[] {
  return scan.sourceFiles.flatMap((file) => scanFile(scan, file));
}

/** Calls to a function exported by the helper, alias-proof. */
function callsHelperFunction(scan: Scan, file: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let symbol = scan.checker.getSymbolAtLocation(node.expression);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = scan.checker.getAliasedSymbol(symbol);
      }
      const declaredInHelper = (symbol?.declarations ?? []).some(
        (declaration) => repoPath(declaration.getSourceFile().fileName) === HELPER,
      );
      if (declaredInHelper && symbol?.getName() === name) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

function describeFinding(finding: Finding): string {
  const what: Record<Rule, string> = {
    'delegate-write': 'writes the settings row through the Prisma delegate',
    'delegate-escape': 'lets the settings delegate escape into a value',
    'raw-sql': 'writes or locks the settings table in raw SQL',
  };
  return `${finding.file}:${finding.line} ${what[finding.rule]}`;
}

describe('the settings row is written through the lock helper, or by name', () => {
  it('builds the whole program the verdict is drawn from', () => {
    const scan = loadScan();
    // A scan over a wrong root finds nothing and passes forever.
    assert.ok(
      scan.sourceFiles.length > 500,
      `expected the src tree, found ${scan.sourceFiles.length} files`,
    );
    const files = new Set(scan.sourceFiles.map((file) => repoPath(file.fileName)));
    assert.ok(files.has(HELPER), 'the helper must be part of the scanned program');
    assert.ok(
      files.has('src/modules/settings/services/settings.service.ts'),
      'the settings service must be part of the scanned program',
    );
  });

  it('flags every evasion it is shown, and none of the reads beside them', () => {
    const scan = loadScan();
    const expected = FIXTURE_SOURCE.split('\n').flatMap((line, index) => {
      const marker = /\/\/ expect: ([a-z-]+)/.exec(line);
      return marker === null ? [] : [`${index + 1}:${marker[1]}`];
    });
    assert.ok(expected.length >= 14, `the fixture lost its markers: ${expected.join(', ')}`);
    const actual = scanFile(scan, scan.fixture).map((finding) => `${finding.line}:${finding.rule}`);
    assert.deepStrictEqual(
      [...actual].sort(),
      [...expected].sort(),
      'the scan must flag exactly the marked lines of the fixture',
    );
  });

  it('still sees the writes and the reads that are known to exist', () => {
    const scan = loadScan();
    const helper = scan.sourceFiles.find((file) => repoPath(file.fileName) === HELPER);
    assert.ok(helper !== undefined);
    const helperWrites = scanFile(scan, helper).filter((finding) => finding.rule === 'delegate-write');
    // `ensureSettingsRow` and `insertSettingsRow` create, `lockReadAndMutate` updates.
    assert.ok(
      helperWrites.length >= 3,
      `the helper's own writes must be detected; found ${JSON.stringify(helperWrites)}`,
    );
    assert.ok(
      scanFile(scan, helper).some((finding) => finding.rule === 'raw-sql'),
      "the helper's lock statement must be detected as raw SQL on the table",
    );

    // The delegate type has to resolve in an unrelated module as well, or the
    // typed rules are only working inside the one file they were tried on.
    const events = scan.sourceFiles.find(
      (file) => repoPath(file.fileName) === 'src/common/services/system-events.service.ts',
    );
    assert.ok(events !== undefined);
    let reads = 0;
    const visit = (node: ts.Node): void => {
      if (isSettingsAccess(node) && isSettingsDelegate(scan.checker.getTypeAtLocation(node))) reads += 1;
      ts.forEachChild(node, visit);
    };
    visit(events);
    assert.ok(reads >= 1, 'a known settings read in system-events.service.ts must resolve to the delegate');
  });

  it('fails on any write outside the helper or a documented exception', () => {
    const offenders = scanTree(loadScan())
      .filter((finding) => !(finding.file in EXCEPTIONS))
      .map(describeFinding);
    assert.deepStrictEqual(
      offenders,
      [],
      'write the row through mutateSettingsRow / mutateExistingSettingsRow / ' +
        'mutateSettingsRowInTransaction (src/modules/settings/utils/settings-row-write.util.ts), ' +
        'or add the file to EXCEPTIONS in this spec with the reason it cannot',
    );
  });

  it('keeps the exception list from outliving its entries', () => {
    const writers = new Set(scanTree(loadScan()).map((finding) => finding.file));
    const stale = Object.keys(EXCEPTIONS).filter((file) => !writers.has(file));
    assert.deepStrictEqual(stale, [], 'these files no longer write the row and should leave EXCEPTIONS');
  });

  it('states a reason for every exception', () => {
    for (const [file, reason] of Object.entries(EXCEPTIONS)) {
      assert.ok(
        reason.trim().length >= 40,
        `${file}: an exception without a reason is a silenced test, not a decision`,
      );
    }
  });

  it('opens every caller-owned settings transaction through the call that bumps the generation', () => {
    const scan = loadScan();
    const owners = scan.sourceFiles.filter(
      (file) =>
        repoPath(file.fileName) !== HELPER &&
        callsHelperFunction(scan, file, 'mutateSettingsRowInTransaction') > 0,
    );
    // The config import writes inside the per-section transaction it owns.
    assert.ok(
      owners.some(
        (file) =>
          repoPath(file.fileName) === 'src/modules/config-portability/services/config-import.service.ts',
      ),
      'the config import must still be detected as a caller-owned settings transaction',
    );
    const unbumped = owners
      .filter((file) => callsHelperFunction(scan, file, 'runSettingsWriteTransaction') === 0)
      .map((file) => repoPath(file.fileName));
    assert.deepStrictEqual(
      unbumped,
      [],
      'these files write the row in a transaction they own but never open it with ' +
        'runSettingsWriteTransaction, so the SettingsService cache keeps serving the old row',
    );
  });
});
