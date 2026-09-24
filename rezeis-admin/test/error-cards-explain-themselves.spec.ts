import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { EVENT_TYPES } from '../src/common/services/system-events.service';

/**
 * Every ERROR a panel producer raises is drawn as an incident card
 * (`formatErrorEventCardHtml`), and that card prints exactly two things a
 * human wrote: `why` («Почему это важно») and `nextSteps` («Что проверить
 * дальше»). A producer that leaves them out is given the defaults —
 * «Необработанная ошибка в панели администратора», «Проверьте логи сервиса» —
 * over a Remnawave refusal, money owed to a partner, a backup that did not
 * happen. Until 0.9.7.68 fifteen producers did.
 *
 * So every emission that becomes that card spells out both keys at the call
 * site: an ERROR of any type, AND a type whose name ends in `.error` at any
 * severity — `isErrorEvent` draws `system.error` raised through `warn()` as the
 * same incident card, and the first version of this guard, which looked at
 * `.error()` and `severity: 'ERROR'` only, missed exactly such a producer.
 * Found through the TypeScript AST: the copy is prose full of parentheses and
 * quotes, which a regex cannot count its way through.
 */

const SRC = join(__dirname, '..', 'src');
const RECEIVERS = new Set(['events', 'systemEvents', 'systemEventsService']);

/** `EVENT_TYPES.X` spellings of every type drawn as an incident card at any severity. */
const INCIDENT_TYPES = new Set(
  Object.entries(EVENT_TYPES)
    .filter(([, value]) => value.endsWith('.error'))
    .map(([key]) => `EVENT_TYPES.${key}`),
);

/** Files whose incident emissions are not a producer's own, each with the reason. */
const EXEMPT = new Map<string, string>([
  [
    'modules/system-events-ingest/internal-system-events.controller.ts',
    "relays the cabinet's own errors; the surface defaults and `scopeWhy` are written for those",
  ],
  [
    'modules/client-errors/client-errors.controller.ts',
    "relays the admin SPA's own crash reports, which the stack-trace defaults are written for",
  ],
]);

interface Emission {
  readonly file: string;
  readonly line: number;
  readonly metadata: ts.Node | undefined;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** `this.events` → `events`; a bare parameter → its name. */
function receiverName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && member.name.getText() === name) return member.initializer;
    if (ts.isShorthandPropertyAssignment(member) && member.name.text === name) return member.name;
  }
  return undefined;
}

function errorEmissions(file: string): Emission[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Emission[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = receiverName(node.expression.expression);
      if (receiver !== null && RECEIVERS.has(receiver)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const method = node.expression.name.text;
        const [first] = node.arguments;
        if (method === 'error') {
          found.push({ file, line, metadata: node.arguments[3] });
        } else if ((method === 'warn' || method === 'info') && first !== undefined && INCIDENT_TYPES.has(first.getText())) {
          found.push({ file, line, metadata: node.arguments[3] });
        } else if (method === 'emit') {
          if (first !== undefined && ts.isObjectLiteralExpression(first)) {
            const severity = property(first, 'severity');
            const type = property(first, 'type');
            if (
              (severity !== undefined && severity.getText().includes("'ERROR'")) ||
              (type !== undefined && INCIDENT_TYPES.has(type.getText()))
            ) {
              found.push({ file, line, metadata: property(first, 'metadata') });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether the metadata names `key` anywhere — a conditional spread counts. */
function namesKey(metadata: ts.Node | undefined, key: string): boolean {
  if (metadata === undefined) return false;
  let hit = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === key) {
      hit = true;
    }
    if (!hit) ts.forEachChild(node, visit);
  };
  visit(metadata);
  return hit;
}

const relativeToSrc = (file: string): string => relative(SRC, file).split(sep).join('/');

const ALL = tsFiles(SRC).flatMap(errorEmissions);
const GUARDED = ALL.filter((emission) => !EXEMPT.has(relativeToSrc(emission.file)));

describe('every ERROR card says why it matters and what to check next', () => {
  it('finds the emissions it guards, in every form they are written', () => {
    const perFile = (suffix: string): number =>
      GUARDED.filter((emission) => relativeToSrc(emission.file) === suffix).length;
    // `this.events.error(…)`
    assert.equal(perFile('modules/profile-sync/profile-sync.processor.ts'), 5);
    // `this.systemEvents.error(…)`
    assert.equal(perFile('modules/broadcast/services/broadcast-reconciler.service.ts'), 2);
    // `this.systemEventsService.error(…)` and `.emit({ severity: 'ERROR' })`
    assert.equal(perFile('modules/backup/backup.processor.ts'), 3);
    // `this.systemEvents?.emit({ severity: cond ? 'ERROR' : 'WARNING' })`
    assert.equal(perFile('modules/push/services/web-push.service.ts'), 1);
    // `this.events.warn(EVENT_TYPES.REIWA_ERROR, …)` — an incident card at
    // WARNING. The one guarded producer of that form (an upgrade over a queued
    // term with renewal add-ons) went with the renewal add-ons on 24.09.2026,
    // so the form is proved on the exempt relay, found before the exemption.
    const relay = 'modules/system-events-ingest/internal-system-events.controller.ts';
    const warnLine =
      readFileSync(join(SRC, ...relay.split('/')), 'utf8')
        .split(/\r?\n/)
        .findIndex((text) => text.includes('.warn(EVENT_TYPES.REIWA_ERROR')) + 1;
    assert.ok(warnLine > 0, `${relay} no longer raises its incident card at WARNING`);
    assert.ok(
      ALL.some((emission) => relativeToSrc(emission.file) === relay && emission.line === warnLine),
      `the scan does not find ${relay}:${warnLine}`,
    );
    assert.ok(GUARDED.length >= 20, `only ${GUARDED.length} ERROR emissions found — the scan has gone blind`);
  });

  it('each carries `why` and `nextSteps`', () => {
    const missing = GUARDED.filter(
      (emission) => !namesKey(emission.metadata, 'why') || !namesKey(emission.metadata, 'nextSteps'),
    ).map((emission) => `${relativeToSrc(emission.file)}:${emission.line}`);
    assert.deepEqual(missing, []);
  });

  it('every exemption still names a file that raises an ERROR', () => {
    for (const [file, reason] of EXEMPT) {
      const path = join(SRC, ...file.split('/'));
      assert.ok(existsSync(path), `exempt file ${file} (${reason}) no longer exists`);
      assert.ok(errorEmissions(path).length > 0, `exempt file ${file} (${reason}) raises no ERROR any more`);
    }
  });
});
