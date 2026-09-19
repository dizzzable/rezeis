import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * A transaction's `gatewayData` is not written back from a copy read earlier.
 * ═════════════════════════════════════════════════════════════════════════════
 * Every path that wrote `gatewayData` used to build the whole object from a
 * copy it had read before — `{ ...read, ...patch }`, `mergeGatewayData(read,
 * patch)` — and write that back. Between the read and the write sat a provider
 * call, a tax-service call or a reversal of a dozen steps, and whatever another
 * path wrote in between was lost. Checked on PostgreSQL 17 with the real paths:
 * a refund's own record erased in 19 of 20 full refunds, a partial refund's
 * ledger entry erased so the payment was never reversed, a tax receipt erased
 * so income stayed declared for money that had gone back.
 *
 * So a write is one statement, merged by PostgreSQL onto what the row holds at
 * that moment: `writeTransactionGatewayData`
 * (`src/modules/payments/utils/transaction-gateway-data.util.ts`). This fails on
 * a `gatewayData:` value that merges — a spread, or a call to a `merge…`
 * function — anywhere in `src/**` outside the allowlist below, and on a
 * statement assigning `"gateway_data"` anywhere but that helper. Each allowlist
 * entry says why it may stay, and pins how many such writes its file has, so a
 * new one next to an allowed one fails too.
 */

const projectRoot = join(__dirname, '..');
const HELPER = 'src/modules/payments/utils/transaction-gateway-data.util.ts';

interface Allowed {
  readonly file: string;
  /** Text every allowed write in the file contains. */
  readonly contains: string;
  /** How many writes the file has that contain it. */
  readonly count: number;
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: 'src/modules/payments/services/partner-balance-payment.service.ts',
    contains: 'mergeGatewayData(current?.gatewayData',
    count: 5,
    reason:
      'Partner-balance payments only. Nothing else writes these rows: no provider notification, refund, ' +
      '«Мой налог» job or expiry-sweep poll reaches a PARTNER_BALANCE transaction — the sweep only cancels, and ' +
      "a status change is not a gatewayData write. Among this file's own writers, the settle and retire writes " +
      'are claims on the owed-refund marker, re-checked by PostgreSQL under the row lock, and the other two ' +
      'run on a row no settle can reach. Not converted: the file is in active work elsewhere (WP2).',
  },
  {
    file: 'src/modules/referrals/services/referral-qualification.service.ts',
    contains: '...gatewayData',
    count: 1,
    reason:
      'RACING, left for its owner — `stampReferralReversal` reads the payment without a lock on it (the lock ' +
      'held is the referral row) and writes the copy back, inside the refund reversal. A «Мой налог» receipt or ' +
      'a panel refund landing in that window is erased. Outside the payments module; the fix is one call to ' +
      '`writeTransactionGatewayData`.',
  },
];

/** Source text with comments blanked out and line breaks kept, so offsets and lines still line up. */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    const quote = source[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** The expression after `gatewayData:` at `start`, up to the `,` / `}` / `)` that ends it. */
function valueAt(code: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const char = code[i];
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== char) j += code[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if ((char === ',' || char === ';') && depth === 0) break;
    i += 1;
  }
  return code.slice(start, i);
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly value: string;
}

/**
 * Whether `value` spreads something read before: a named value (`...current`,
 * `...readGatewayData(row.gatewayData)`), or a parenthesised one that mentions
 * `gatewayData`. `...(cond ? { a } : {})` builds keys fresh and is not one.
 */
function spreadsAReadValue(value: string): boolean {
  for (const match of value.matchAll(/\.\.\.\s*/g)) {
    const operand = valueAt(value, (match.index ?? 0) + match[0].length).trim();
    if (!operand.startsWith('(') && !operand.startsWith('{') && !operand.startsWith('[')) return true;
    if (/gatewayData/i.test(operand)) return true;
  }
  return false;
}

/** Every `gatewayData:` value in `source` that merges a value read before: a spread of one, or a `merge…` call. */
function mergingWrites(file: string, source: string): Site[] {
  const code = withoutComments(source);
  const sites: Site[] = [];
  for (const match of code.matchAll(/\bgatewayData\s*:/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const value = valueAt(code, start).replace(/\s+/g, ' ').trim();
    if (spreadsAReadValue(value) || /\bmerge[A-Za-z]*\s*\(/.test(value)) {
      sites.push({ file, line: code.slice(0, match.index).split('\n').length, value });
    }
  }
  return sites;
}

/** Statements assigning `gateway_data` — only the helper may. */
function rawGatewayDataAssignments(source: string): number {
  return [...withoutComments(source).matchAll(/"gateway_data"\s*=/g)].length;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function scan(): { readonly files: number; readonly sites: Site[]; readonly raw: Array<{ file: string; count: number }> } {
  const files = sourceFiles(join(projectRoot, 'src'));
  const sites: Site[] = [];
  const raw: Array<{ file: string; count: number }> = [];
  for (const path of files) {
    const file = relative(projectRoot, path).split('\\').join('/');
    const source = readFileSync(path, 'utf8');
    sites.push(...mergingWrites(file, source));
    const count = rawGatewayDataAssignments(source);
    if (count > 0) raw.push({ file, count });
  }
  return { files: files.length, sites, raw };
}

describe('gatewayData is merged by PostgreSQL, not written back from an old copy', () => {
  it('tells a merge from a fresh value', () => {
    // The detector itself, on code written here: a scan that could never
    // report anything would pass the cases below on any tree.
    const sample = [
      "await tx.transaction.update({ where: { id }, data: { gatewayData: mergeGatewayData(transaction.gatewayData, { a: 1 }) as Prisma.InputJsonValue } });",
      'await tx.transaction.update({ data: { gatewayData: { ...current, [KEY]: now } } });',
      'data: { gatewayData: mergeRefundAudit(live, {\n  refunds: ledger,\n}) },',
      '// data: { gatewayData: mergeGatewayData(a, b) } — a comment, not a write',
      'data: { gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue, checkoutUrl },',
      "return { gatewayData: { provider: 'LAVA', providerResponse: this.redact(data), checkoutUrl } };",
      'const row: { gatewayData: Prisma.JsonValue } = x;',
      'select: { gatewayData: true },',
      "return { gatewayData: { provider: 'YOOKASSA', ...(confirmation ? { confirmation } : {}) } };",
      'data: { gatewayData: { ...(asRecord(current?.gatewayData) ?? {}), restoredAt } },',
    ].join('\n');
    assert.deepEqual(
      mergingWrites('sample.ts', sample).map((site) => site.line),
      [1, 2, 3, 12],
    );
    assert.equal(rawGatewayDataAssignments('const s = Prisma.sql`SET "gateway_data" = x`; // "gateway_data" = y'), 1);
  });

  it('writes gatewayData in src/** only through the one writer, or on the allowlist', () => {
    const { files, sites, raw } = scan();
    assert.ok(files > 900, `only ${files} files under src/ — the scan is looking in the wrong place`);

    const unexplained = sites.filter(
      (site) => !ALLOWED.some((entry) => entry.file === site.file && site.value.includes(entry.contains)),
    );
    assert.deepEqual(
      unexplained.map((site) => `${site.file}:${site.line}: gatewayData: ${site.value.slice(0, 100)}`),
      [],
      'a gatewayData write built from a value read earlier — what any other path writes between the read and ' +
        'this write is lost. Use writeTransactionGatewayData (src/modules/payments/utils/transaction-gateway-data.util.ts), ' +
        'or add it to ALLOWED with the reason no other path can write that row in between',
    );

    for (const entry of ALLOWED) {
      const matched = sites.filter((site) => site.file === entry.file && site.value.includes(entry.contains));
      assert.equal(
        matched.length,
        entry.count,
        `${entry.file} has ${matched.length} allowed merges, not ${entry.count} — a new one needs its own reason, ` +
          'and a converted one leaves the list',
      );
      assert.ok(entry.reason.length > 80, `${entry.file}: say why it may stay`);
    }

    assert.deepEqual(raw, [{ file: HELPER, count: 1 }], 'a statement assigning "gateway_data" outside the one writer');
  });
});
