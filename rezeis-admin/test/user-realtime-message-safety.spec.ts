import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';

/**
 * WHAT A CUSTOMER READS WHEN A LIVE EVENT REACHES THEIR SCREEN.
 *
 * `UserRealtimeService` forwards `projection.message ?? event.message`. The
 * fallback half of that expression is the sentence the EMITTER wrote, and
 * emitters write for the operator's feed. Eleven of the twelve whitelisted
 * events had no message of their own, so what customers actually saw as a toast
 * was:
 *
 *   "Remnawave profile created: rz_<their login>_vpn" — the operator's
 *   configured profile naming scheme wrapped around the customer's own login.
 *
 *   "Payment completed for a BLOCKED customer: SUBSCRIPTION" — telling the
 *   customer they are blocked, with an internal purchase type.
 *
 *   "Promocode X reward synced with delay (enqueue failed: …)" — an internal
 *   queue failure, reason included.
 *
 * None of it is an invariant violation — no IP, host, port or node name — and
 * all of it is operator-facing text on a customer's screen.
 *
 * The type now REQUIRES a message, which is what stops the next entry
 * forgetting. This file is the second half of that: required means present, and
 * present does not mean safe.
 */

const ENTRIES = Object.entries(USER_EVENT_WHITELIST);

/**
 * Words that only ever appear in operator-facing text.
 *
 * Not a scrubber and not a filter — a tripwire. Anything matching here is a
 * sentence written for the wrong reader, and the fix is to rewrite the sentence
 * rather than to pass it through something.
 */
const OPERATOR_WORDS =
  /remnawave|panel|profile|blocked|enqueue|webhook|sync|queue|admin|internal|uuid|hwid_|\bid\b/i;

describe('every event a customer can be sent', () => {
  it('is a list with entries in it', () => {
    // Anti-emptiness anchor: an empty whitelist agrees with every loop below
    // while meaning "customers are told nothing", which is a different product.
    assert.ok(ENTRIES.length >= 10, `whitelist holds ${ENTRIES.length} entries`);
  });

  it('carries a message of its own', () => {
    // Without one the service falls through to the operator's sentence. The
    // type makes this a compile error now; this says so at run time too, for
    // the entry built dynamically or cast into place.
    const missing = ENTRIES.filter(([, projection]) => {
      const message = (projection as { message?: unknown }).message;
      return typeof message !== 'string' || message.trim().length === 0;
    }).map(([type]) => type);

    assert.deepEqual(missing, [], 'these forward the operator sentence to a customer');
  });

  it('says nothing an operator would say', () => {
    const leaking = ENTRIES.filter(([, projection]) => {
      const message = (projection as { message: string }).message;
      return OPERATOR_WORDS.test(message);
    }).map(([type, projection]) => `${type}: ${(projection as { message: string }).message}`);

    assert.deepEqual(leaking, [], 'operator vocabulary on a customer screen');
  });

  it('addresses the customer, not a third party about them', () => {
    // "Payment completed FOR A CUSTOMER" versus "Payment received". The first
    // reads as a log line somebody forwarded by mistake, which is what it was.
    const thirdPerson = ENTRIES.filter(([, projection]) =>
      /\bcustomer\b|\buser\b/i.test((projection as { message: string }).message),
    ).map(([type]) => type);

    assert.deepEqual(thirdPerson, []);
  });
});
