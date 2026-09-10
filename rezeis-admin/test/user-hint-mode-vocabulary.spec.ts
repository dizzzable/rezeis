import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { drawableModesForQuery } from '../src/modules/user-hints/services/user-hint-delivery.service';
import { parseDrawableModes } from '../src/modules/user-hints/controllers/internal-user-hints.controller';

/**
 * THE MODE NAMES THAT MAY REACH PRISMA.
 *
 * `{ mode: { in: [...] } }` is an ENUM filter. Prisma does not treat a value
 * outside the enum as "matches nothing" — it throws
 * `PrismaClientValidationError` before the query is ever sent. The comment on
 * that line asserted the opposite for weeks.
 *
 * The blast radius is the whole feature: `nextFor` throws, Nest answers 500,
 * and the cabinet's route swallows a failed ask into `{ hint: null }` at debug
 * level. One cabinet declaring a mode this panel has never heard of therefore
 * stops every hint for every customer, silently, for as long as it keeps
 * asking — and the header exists precisely so that a version mismatch cannot
 * do that.
 *
 * The existing delivery spec could not catch it: its Prisma stand-in resolves
 * the mode term itself with `(mode.in ?? []).includes(...)`, which is exactly
 * the forgiving behaviour the real client does not have. So this file asserts
 * the property that keeps the real client happy — every value that can leave
 * `drawableModesForQuery` is a name the schema declares — and pins the list
 * against `schema.prisma` so the two cannot drift.
 */

const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

/** The `UserHintMode` enum, straight out of the schema. */
const DECLARED: string[] = (() => {
  const block = /enum UserHintMode {([^}]*)}/.exec(SCHEMA);
  assert.notEqual(block, null, 'UserHintMode is gone from schema.prisma');
  return (block as RegExpExecArray)[1]
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+$/.test(line));
})();

describe('the hint modes this panel has', () => {
  it('were parsed out of the schema at all', () => {
    // Anti-emptiness anchor. An empty list makes every filter below reject
    // everything, which reads as "very safe" and means "no hints at all".
    assert.ok(DECLARED.length >= 3, `parsed ${DECLARED.length} modes`);
    assert.ok(DECLARED.includes('MODAL'));
    assert.ok(DECLARED.includes('TOAST'));
  });

  it('never lets a name outside the enum reach the query', () => {
    // THE PROPERTY. Anything else is a 500 and a total hint outage.
    const claims = [
      ['MODAL'],
      ['MODAL', 'TOAST'],
      ['MODAL', 'BANNER'],
      ['BANNER'],
      ['banner', 'SHEET', 'modal'],
      [],
    ];

    for (const claim of claims) {
      const escaping = drawableModesForQuery(claim).filter((mode) => !DECLARED.includes(mode));
      assert.deepEqual(escaping, [], `claim ${claim.join('+') || '(empty)'} reaches Prisma with a name it refuses`);
    }

    assert.deepEqual(
      drawableModesForQuery(null).filter((mode) => !DECLARED.includes(mode)),
      [],
      'the silent-cabinet floor is not a declared mode',
    );
  });

  it('resolves silence to what every cabinet can draw', () => {
    assert.deepEqual(drawableModesForQuery(null), ['MODAL']);
  });

  it('keeps the modes it knows out of a claim that also names one it does not', () => {
    assert.deepEqual(drawableModesForQuery(['MODAL', 'BANNER']), ['MODAL']);
    assert.deepEqual(drawableModesForQuery(['TOAST', 'MODAL']), ['TOAST', 'MODAL']);
  });

  it('hands back nothing for a cabinet that draws nothing this panel has', () => {
    // NOT a fallback to MODAL. A cabinet that says it cannot draw a modal is
    // telling the truth, and a modal handed to it is closed as a dismissal —
    // which `raise()` counts as a prior delivery, so a once-only hint is then
    // gone for that customer for ever. An empty filter holds the delivery
    // instead, and an upgraded panel picks it up.
    assert.deepEqual(drawableModesForQuery(['BANNER']), []);
  });
});

describe('the header a cabinet declares its modes in', () => {
  it('cannot be truncated into losing MODAL', () => {
    // The cap was 8 and cut in wire order, so a cabinet listing MODAL ninth
    // lost every modal — worse than saying nothing at all.
    const many = [...Array(12).keys()].map((index) => `MODE_${index}`);
    const declared = parseDrawableModes([...many, 'MODAL'].join(','));

    assert.notEqual(declared, null);
    assert.deepEqual(drawableModesForQuery(declared), ['MODAL']);
  });

  it('does not spend its budget on repeats', () => {
    const declared = parseDrawableModes('MODAL,MODAL,modal, MODAL ,TOAST');

    assert.deepEqual(declared, ['MODAL', 'TOAST']);
  });

  it('still says nothing when it said nothing', () => {
    assert.equal(parseDrawableModes(undefined), null);
    assert.equal(parseDrawableModes('   '), null);
    assert.equal(parseDrawableModes(',,,'), null);
  });
});
