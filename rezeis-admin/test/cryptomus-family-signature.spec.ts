import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { cryptomusFamilySignatureCandidates } from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * Cryptomus and Heleket sign webhooks as
 *   `md5( base64( json_encode(body without "sign") ) + apiKey )`
 * and deliver the signature **inside the body**, not in a header.
 *
 * The previous implementation got both halves wrong for Cryptomus: it read the
 * signature only from a header the provider never sends, and hashed the raw
 * body *including* the `sign` field. Every genuine webhook would have been
 * rejected — money received, nothing delivered, and no alert, because a
 * rejected webhook just leaves the row PENDING until the sweep cancels it.
 *
 * The escaping trap is the second half: the providers hash PHP's `json_encode`
 * output, which renders `/` as `\/`. `JSON.stringify` does not. Both vendors
 * document this explicitly. A payload with no slash hides the bug entirely,
 * which is why it survived — so the slash case below is the important one.
 */

const KEY = 'test-api-key';

/** What the provider would compute, PHP-style. */
function providerSign(payload: Record<string, unknown>, key: string): string {
  const json = JSON.stringify(payload).replace(/\//g, '\\/');
  return createHash('md5').update(`${Buffer.from(json, 'utf8').toString('base64')}${key}`).digest('hex');
}

describe('Cryptomus/Heleket webhook signature', () => {
  it('matches a payload whose values contain no slash', () => {
    const body = { uuid: 'inv-1', order_id: 'payment-1', status: 'paid', amount: '10.00' };
    assert.ok(cryptomusFamilySignatureCandidates(body, KEY).includes(providerSign(body, KEY)));
  });

  it('matches a payload WITH slashes — the case that used to silently fail', () => {
    // `additional_data` is free-form merchant text and `txid`/URLs routinely
    // carry slashes, so this is not a contrived input.
    const body = {
      uuid: 'inv-2',
      order_id: 'payment-2',
      status: 'paid',
      additional_data: 'https://example.com/return?a=1',
    };
    assert.ok(cryptomusFamilySignatureCandidates(body, KEY).includes(providerSign(body, KEY)));
  });

  it('excludes the sign field itself from the digest', () => {
    // Hashing a document that contains the signature can never match.
    const body = { uuid: 'inv-3', status: 'paid' };
    const expected = providerSign(body, KEY);
    const delivered = { ...body, sign: expected };
    assert.ok(cryptomusFamilySignatureCandidates(delivered, KEY).includes(expected));
  });

  it('preserves key order rather than sorting', () => {
    // The providers hash the array as received; re-ordering changes the JSON
    // and therefore the digest.
    const asSent = { status: 'paid', uuid: 'inv-4', order_id: 'payment-4' };
    assert.ok(cryptomusFamilySignatureCandidates(asSent, KEY).includes(providerSign(asSent, KEY)));
  });

  it('does not accept a signature made with a different key', () => {
    const body = { uuid: 'inv-5', status: 'paid' };
    assert.equal(
      cryptomusFamilySignatureCandidates(body, KEY).includes(providerSign(body, 'other-key')),
      false,
    );
  });

  it('does not accept a signature made over tampered content', () => {
    const honest = { uuid: 'inv-6', status: 'paid', amount: '10.00' };
    const tampered = { ...honest, amount: '1000.00' };
    assert.equal(
      cryptomusFamilySignatureCandidates(tampered, KEY).includes(providerSign(honest, KEY)),
      false,
    );
  });

  it('keeps an unescaped variant so a provider that stops escaping still works', () => {
    const body = { uuid: 'inv-7', additional_data: 'a/b' };
    const unescaped = createHash('md5')
      .update(`${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')}${KEY}`)
      .digest('hex');
    assert.ok(cryptomusFamilySignatureCandidates(body, KEY).includes(unescaped));
  });
});
