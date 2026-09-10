import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PUSH_TTL_SECONDS,
  PUSH_TTL_TRANSIENT_SECONDS,
} from '../src/modules/push/services/web-push.service';

/**
 * HOW LONG EACH NOTIFICATION MAY WAIT FOR A CLOSED BROWSER.
 *
 * The service takes a `ttlSeconds` and defaults it to a day. That parameter had
 * NO PRODUCTION CALLER: both `sendToUser` call sites omitted it, so every customer
 * push took the default and the short constant lived only on the operator path.
 * The spec beside this one exercised the parameter through a caller it
 * constructed itself — a guard on a branch nothing reached.
 *
 * What the default has to be measured against is the thing it is about. Two
 * notification types are statements with a deadline attached, and holding them
 * for a day lets them arrive after the deadline has passed:
 * `expires_in_1_days` (which would surface after expiry) and `limited` (which is
 * false the moment the customer tops up).
 *
 * Read out of the source rather than imported: the table is a private const
 * inside a service whose constructor pulls in a dozen collaborators, and what
 * needs pinning is the DECISION, not the object.
 */

const SERVICE = readFileSync(
  join(
    __dirname,
    '..',
    'src',
    'modules',
    'notifications',
    'services',
    'user-notifications.service.ts',
  ),
  'utf8',
);

/** The `PUSH_TTL_BY_TYPE` table, as `{ type: seconds }`. */
const BY_TYPE: Record<string, number> = (() => {
  const block = /PUSH_TTL_BY_TYPE: Readonly<Record<string, number>> = {([^}]*)}/.exec(SERVICE);
  assert.notEqual(block, null, 'the per-type TTL table is gone');
  const table: Record<string, number> = {};
  for (const match of (block as RegExpExecArray)[1].matchAll(
    /^\s*([a-z_0-9]+):\s*([^,]+),/gm,
  )) {
    // The values are written as arithmetic so they read as hours.
    table[match[1]] = Number(new Function(`return (${match[2]})`)());
  }
  return table;
})();

describe('the per-notification push TTL', () => {
  it('is wired to the send at all', () => {
    // Anti-emptiness anchor, and the exact defect this file was written for: a
    // table nobody passes to `sendToUser` is a decision that never happens.
    assert.match(
      SERVICE,
      /ttlSeconds: pushTtlForType/,
      'the table is never handed to the push service',
    );
    assert.ok(Object.keys(BY_TYPE).length >= 2, `parsed ${Object.keys(BY_TYPE).length} entries`);
  });

  it('never lets the last expiry warning outlive the expiry', () => {
    // Sent at the one-day mark. A day-long hold can put it on screen after the
    // subscription has already ended — beside the notice saying it ended.
    const oneDay = BY_TYPE['expires_in_1_days'];
    assert.ok(oneDay !== undefined, 'the last expiry warning takes the day-long default');
    assert.ok(oneDay < 24 * 60 * 60, `expires_in_1_days holds for ${oneDay}s`);
    assert.ok(oneDay >= 60 * 60, 'so short only a customer already looking would see it');
  });

  it('does not hold a statement about right now until tomorrow', () => {
    const limited = BY_TYPE['limited'];
    assert.ok(limited !== undefined, 'traffic exhaustion takes the day-long default');
    assert.ok(limited <= 6 * 60 * 60, `limited holds for ${limited}s`);
  });

  it('leaves everything else on the day-long default', () => {
    // The other direction, and the one that matters most: an expiry warning
    // three days out, a receipt, a support reply and a reward are all as true
    // tomorrow as they were when sent, and a customer who opens their laptop on
    // Monday should still get them. This is the whole reason the default moved
    // off sixty seconds.
    for (const type of [
      'expires_in_3_days',
      'expires_in_2_days',
      'expired',
      'support_reply',
      'points_cashback_credited',
      'partner.earning',
    ]) {
      assert.equal(BY_TYPE[type], undefined, `${type} was given a short TTL`);
    }

    assert.equal(PUSH_TTL_SECONDS, 24 * 60 * 60);
  });

  it('keeps every entry inside the range the service will accept', () => {
    for (const [type, seconds] of Object.entries(BY_TYPE)) {
      assert.ok(Number.isFinite(seconds), `${type} is not a number`);
      assert.ok(seconds >= PUSH_TTL_TRANSIENT_SECONDS, `${type} is shorter than a test push`);
      assert.ok(seconds <= PUSH_TTL_SECONDS, `${type} is longer than the default it overrides`);
    }
  });
});
