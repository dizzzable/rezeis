import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

/**
 * WHO WRITES `users.telegram_username` / `users.telegram_username_tg_id`.
 *
 * One writer, by design: the Telegram-verified bootstrap
 * (`InternalUserEdgeService.bootstrapByTelegram` — bot `/start` and the Mini
 * App sign-in), which writes the pair from the very update Telegram signed.
 * The pair is worth something only because nothing else can put a value in
 * it: `users.username` has six other writers — every importer, the admin
 * «create user» form — and survives a rebind or a merge naming the previous
 * account. The importers, the admin forms, linking, rebind and merge must
 * never write the pair; a rebind, a link or a merge invalidates it simply by
 * moving `telegram_id`.
 *
 * This walks the syntax tree of every file under `src/` and `scripts/` and
 * lists every place that could put a value into the pair:
 *
 *  • an object-literal property named `telegramUsername` /
 *    `telegramUsernameTgId` whose value is anything but a boolean literal
 *    (`select: { telegramUsername: true }` is a read; `data: {…}`, `create`,
 *    `update`, a spread-in patch object and a `where` are not) — including the
 *    shorthand `{ telegramUsername }` and a quoted or computed key;
 *  • an assignment to such a property (`data.telegramUsername = …`);
 *  • a string or template literal naming the SQL column `telegram_username`,
 *    i.e. raw SQL.
 *
 * A new writer is a design change, not a line of code: it goes into
 * `WRITER` below only after somebody has decided that its value is as good as
 * Telegram's own.
 */

const REPO_ROOT = join(__dirname, '..');
const WRITER = 'src/modules/internal-user/services/internal-user-edge.service.ts';
const FIELDS: ReadonlySet<string> = new Set(['telegramUsername', 'telegramUsernameTgId']);
const SQL_COLUMN = /\btelegram_username(?:_tg_id)?\b/i;
/**
 * SQL that could write the column: a write keyword, then the column. A bare
 * `'telegram_username'` is not SQL — the StealthNet dump parser looks up the
 * DONOR's column of that name to read it (`stealthnet-backup-parser.ts`).
 */
const SQL_WRITE = /\b(?:UPDATE|INSERT\s+INTO|SET|ALTER\s+TABLE|MERGE\s+INTO|COPY)\b[\s\S]*\btelegram_username(?:_tg_id)?\b/i;

type Kind = 'property' | 'shorthand' | 'assignment' | 'raw-sql';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly kind: Kind;
  readonly field: string;
}

function keyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

function isBooleanLiteral(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

function accessedName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function scan(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const record = (node: ts.Node, kind: Kind, field: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({ file: fileName, line, kind, field });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = keyText(node.name);
      if (key !== null && FIELDS.has(key) && !isBooleanLiteral(node.initializer)) record(node, 'property', key);
    } else if (ts.isShorthandPropertyAssignment(node) && FIELDS.has(node.name.text)) {
      record(node, 'shorthand', node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = accessedName(node.left);
      if (target !== null && FIELDS.has(target)) record(node, 'assignment', target);
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
      SQL_WRITE.test(node.text)
    ) {
      record(node, 'raw-sql', node.text.match(SQL_COLUMN)?.[0] ?? 'telegram_username');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules') files.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function scanTree(): Finding[] {
  return ['src', 'scripts']
    .flatMap((directory) => sourceFiles(join(REPO_ROOT, directory)))
    .flatMap((path) => scan(repoPath(path), readFileSync(path, 'utf8')));
}

const EVASIONS = [
  'export {};',
  'declare const tx: any;',
  'declare const nick: string | null;',
  'declare const telegramUsername: string | null;',
  'declare const telegramUsernameTgId: bigint | null;',
  "await tx.user.update({ where: { id: 'u' }, data: { telegramUsername: nick } }); // property",
  "await tx.user.update({ where: { id: 'u' }, data: { telegramUsername, telegramUsernameTgId } }); // shorthand x2",
  "const patch = { 'telegramUsernameTgId': 1n }; // quoted key",
  "const other = { ['telegramUsername']: null }; // computed key",
  'const data: Record<string, unknown> = {};',
  'data.telegramUsername = nick; // assignment',
  "data['telegramUsernameTgId'] = 2n; // element assignment",
  'await tx.$executeRaw`UPDATE "users" SET "telegram_username" = ${nick}`; // raw sql',
  "await tx.$executeRawUnsafe('update users set telegram_username_tg_id = 1'); // raw sql",
  '// Reads, and a type, all left alone:',
  "await tx.user.findMany({ select: { telegramUsername: true, telegramUsernameTgId: false } });",
  'interface Row { readonly telegramUsername: string | null; readonly telegramUsernameTgId: bigint | null }',
  'declare const row: Row;',
  'const read = row.telegramUsername === row.telegramUsernameTgId?.toString();',
  'const { telegramUsername: alias } = row;',
  'declare function colIndex(block: unknown, column: string): number;',
  "const donorColumn = colIndex(null, 'telegram_username'); // a donor dump's own column, read",
  'await tx.$queryRaw`SELECT "telegram_username" FROM "users"`; // a read',
].join('\n');

describe('only the Telegram-verified bootstrap writes the verified @username pair', () => {
  it('the scanner sees every way to write the pair, and no read', () => {
    const found = scan('fixture.ts', EVASIONS).map((finding) => `${finding.line}:${finding.kind}:${finding.field}`);
    assert.deepEqual(found, [
      '6:property:telegramUsername',
      '7:shorthand:telegramUsername',
      '7:shorthand:telegramUsernameTgId',
      '8:property:telegramUsernameTgId',
      '9:property:telegramUsername',
      '11:assignment:telegramUsername',
      '12:assignment:telegramUsernameTgId',
      '13:raw-sql:telegram_username',
      '14:raw-sql:telegram_username_tg_id',
    ]);
  });

  it('nothing but the bootstrap writes it — no importer, admin form, link, rebind or merge', () => {
    const outside = scanTree().filter((finding) => finding.file !== WRITER);
    assert.deepEqual(
      outside.map((finding) => `${finding.file}:${finding.line} ${finding.kind} ${finding.field}`),
      [],
      'a second writer of the verified @username pair — its value is not Telegram\'s own',
    );
  });

  it('the bootstrap writes both halves, and through Prisma rather than raw SQL', () => {
    const writer = scanTree().filter((finding) => finding.file === WRITER);
    assert.deepEqual(writer.filter((finding) => finding.kind === 'raw-sql'), []);
    for (const field of FIELDS) {
      assert.ok(
        writer.filter((finding) => finding.field === field).length >= 2,
        `${field} is written on both the create and the update of the upsert`,
      );
    }
  });
});
