import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTrustedYookassaIp } from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * YooKassa signs nothing. Its published source-IP list is the entire
 * authentication story for an incoming "payment succeeded", so this check is
 * load-bearing in both directions: too narrow and real payments never land,
 * too wide and anyone can forge one.
 *
 * The bug this pins: `BlockList.check(addr)` defaults to `type: 'ipv4'` and
 * answers false for every IPv6 form. That silently excluded YooKassa's own
 * documented `2a02:5180::/32`, and on a dual-stack socket — where Express
 * reports peers as `::ffff:a.b.c.d` — it would have rejected *everything*.
 *
 * Ranges per https://yookassa.ru/developers/using-api/webhooks
 */

describe('YooKassa source-IP allowlist', () => {
  for (const ip of [
    '185.71.76.1', // 185.71.76.0/27
    '185.71.77.30', // 185.71.77.0/27
    '77.75.153.60', // 77.75.153.0/25
    '77.75.156.11', // /32 host
    '77.75.156.35', // /32 host
    '77.75.154.200', // 77.75.154.128/25
  ]) {
    it(`accepts documented IPv4 ${ip}`, () => {
      assert.equal(isTrustedYookassaIp(ip), true);
    });
  }

  it('accepts the documented IPv6 range', () => {
    // Regression: this was unreachable while the family argument was omitted.
    assert.equal(isTrustedYookassaIp('2a02:5180::1'), true);
    assert.equal(isTrustedYookassaIp('2a02:5180:ffff::abcd'), true);
  });

  it('accepts an IPv4 peer seen through a dual-stack socket', () => {
    // The dangerous case: not a lost edge range, but every notification.
    assert.equal(isTrustedYookassaIp('::ffff:185.71.76.1'), true);
    assert.equal(isTrustedYookassaIp('::ffff:77.75.156.35'), true);
  });

  for (const ip of [
    '185.71.76.32', // just past the /27
    '77.75.156.12', // neighbour of a /32 host
    '77.75.154.127', // just below the /25
    '8.8.8.8',
    '127.0.0.1',
    '2a02:5181::1', // adjacent /32
    '::ffff:8.8.8.8', // mapped, but not ours
    '::1',
    'not-an-ip',
    '',
  ]) {
    it(`rejects ${ip || '(empty)'}`, () => {
      assert.equal(isTrustedYookassaIp(ip), false);
    });
  }
});
