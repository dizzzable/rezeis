import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  HINT_MODES_HEADER,
  parseDrawableModes,
} from '../src/modules/user-hints/controllers/internal-user-hints.controller';

/**
 * A CABINET NEWER THAN ITS PANEL MUST NOT BE REFUSED.
 *
 * The two ship as separate images on separate upgrade schedules, so every field
 * the cabinet starts sending will at some point reach a panel that has never
 * heard of it. What that panel does with it is decided by one line in
 * `main.ts`:
 *
 *     new ValidationPipe({ whitelist: true, transform: true,
 *                          forbidNonWhitelisted: true })
 *
 * `forbidNonWhitelisted` means an unknown key in a validated BODY is a 400, not
 * a strip. The drawable-mode declaration was a body field first, and that would
 * have made a cabinet-first upgrade answer 400 to every hint request — which
 * the cabinet swallows into `{ hint: null }` at debug level. No hints for
 * anybody, on every install that upgraded in that order, with nothing anywhere
 * saying why. The guard written for it defended the wrong axis: it kept the
 * VALUES free-form so an unknown mode name could not be refused, and never
 * asked what happens to the FIELD.
 *
 * A header is not validated by the pipe at all, so an old panel does not read
 * it and a new one does. This file pins both halves of that.
 */

const ROOT = join(__dirname, '..');

describe('the drawable-modes declaration', () => {
  const CONTROLLER = readFileSync(
    join(ROOT, 'src', 'modules', 'user-hints', 'controllers', 'internal-user-hints.controller.ts'),
    'utf8',
  );

  it('travels in a header, not in the request body', () => {
    // If it is ever a body field again, an old panel starts refusing a new
    // cabinet's every request — see the pipe case below.
    const dtoStart = CONTROLLER.indexOf('class HintAudienceDto {');
    const dtoEnd = CONTROLLER.indexOf('\n}', dtoStart);

    assert.ok(dtoStart > 0, 'HintAudienceDto is gone');
    assert.equal(
      CONTROLLER.slice(dtoStart, dtoEnd).includes('modes'),
      false,
      'the mode declaration is back in the body, where an old panel answers 400 to it',
    );
    assert.match(CONTROLLER, /@Headers\(HINT_MODES_HEADER\)/);
  });

  it('is a header name Node will actually deliver', () => {
    // Node lower-cases incoming header names, so `@Headers('X-Reiwa-Hint-Modes')`
    // would read `undefined` for ever — silently resolving every cabinet to
    // MODAL-only, which is the failure this whole negotiation exists to avoid.
    assert.equal(HINT_MODES_HEADER, HINT_MODES_HEADER.toLowerCase());
    assert.match(HINT_MODES_HEADER, /^x-[a-z-]+$/);
  });
});

describe('the pipe that makes a header necessary', () => {
  it('refuses an unknown body field rather than stripping it', () => {
    // THE FACT THE WHOLE DESIGN RESTS ON. `forbidNonWhitelisted` turns an
    // unknown key in a validated body into a 400 instead of a strip — which is
    // why a newer cabinet cannot introduce a body field, and why the drawable
    // modes travel in a header instead.
    //
    // Asserted rather than simulated: reproducing the pipe here needs a
    // decorated fixture class, and `tsx` compiles decorators with the modern
    // transform that class-validator cannot read. What can regress is this
    // line in `main.ts`, and if it is ever turned off the header stops being
    // necessary — which is worth knowing when somebody wonders why it exists.
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    const pipe = /useGlobalPipes\([\s\S]*?new ValidationPipe\(\{([\s\S]*?)\}\)/.exec(main)?.[1];

    assert.ok(pipe, 'the global ValidationPipe is gone from main.ts');
    assert.match(pipe, /forbidNonWhitelisted:\s*true/);
    assert.match(pipe, /whitelist:\s*true/);
  });
});

describe('reading the header', () => {
  it('takes the modes a cabinet names', () => {
    assert.deepEqual(parseDrawableModes('MODAL,TOAST'), ['MODAL', 'TOAST']);
  });

  it('answers null when the cabinet did not say', () => {
    // NOT an empty list. The service resolves `null` to what every cabinet can
    // draw; an empty list would mean "this cabinet draws nothing" and stop
    // hints reaching every install older than the header.
    assert.equal(parseDrawableModes(undefined), null);
    assert.equal(parseDrawableModes(''), null);
    assert.equal(parseDrawableModes('   ,  '), null);
  });

  it('tolerates spacing and case, which a header picks up in transit', () => {
    assert.deepEqual(parseDrawableModes(' modal , Toast '), ['MODAL', 'TOAST']);
  });

  it('keeps a name it has never heard of, for the query to intersect away', () => {
    // Refusing here would put an older panel back in the business of answering
    // 400 to a newer cabinet — the exact failure the header exists to avoid.
    assert.deepEqual(parseDrawableModes('MODAL,BANNER'), ['MODAL', 'BANNER']);
  });

  it('is bounded, because it arrives from the network', () => {
    // The BOUND is the property, not the number. This asserted `=== 8`, and 8
    // was also the point at which truncation started dropping real modes: a
    // cabinet listing MODAL ninth lost every modal, and the case that pinned
    // the cap certified that as correct.
    const flood = Array.from({ length: 500 }, (_, index) => `MODE${index}`).join(',');
    const declared = parseDrawableModes(flood);

    assert.ok(declared !== null);
    assert.ok(declared.length <= 32, `kept ${declared.length} names from a 500-name header`);
  });

  it('cannot truncate a real mode out of an oversized header', () => {
    // What the bound is allowed to cost. Whatever it drops must be names this
    // panel would have discarded anyway — never one the schema declares.
    const flood = [
      ...Array.from({ length: 400 }, (_, index) => `MODE${index}`),
      'MODAL',
      'TOAST',
    ].join(',');

    const declared = parseDrawableModes(flood) ?? [];

    assert.ok(declared.includes('MODAL'), 'MODAL was truncated away');
    assert.ok(declared.includes('TOAST'), 'TOAST was truncated away');
  });
});
