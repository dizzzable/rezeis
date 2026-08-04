import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';

import {
  PaymentWebhookNormalizerService,
  isTrustedLavaIp,
  resolveLavaTrustedNetworks,
} from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * lava.top's webhook is authenticated by a static `X-Api-Key` and nothing else
 * — no signature, nothing bound to the amount. A leaked key is therefore a
 * forged "payment succeeded" from anywhere on the internet. lava.top publishes
 * one notification address, `158.160.60.174`, and its documentation says to
 * whitelist it, so pinning the source is the one extra check available.
 *
 * Both halves must hold: the pin runs **in addition to** the key check, never
 * instead of it. And it must not repeat the YooKassa allowlist bug, where
 * `BlockList.check(addr)` defaulting to `'ipv4'` rejected every peer that a
 * dual-stack socket reported as `::ffff:a.b.c.d`.
 */

const API_KEY = 'lava-webhook-key';
const DOCUMENTED_IP = '158.160.60.174';

const service = new PaymentWebhookNormalizerService();

function lavaBody(fields: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventType: 'payment.success',
      contractId: 'contract-1',
      status: 'completed',
      ...fields,
    }),
    'utf8',
  );
}

function normalizeLava(options: { readonly clientIp: string | null; readonly apiKey?: string }) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.LAVA,
    rawBody: lavaBody(),
    headers: { 'x-api-key': options.apiKey ?? API_KEY },
    clientIp: options.clientIp,
    gatewaySettings: { webhookApiKey: API_KEY, apiKey: 'lava-api-key', offerId: 'offer-1' },
    verifySignature: true,
  });
}

describe('lava.top webhook source-IP pin', () => {
  it('accepts a notification from the documented address', () => {
    const envelope = normalizeLava({ clientIp: DOCUMENTED_IP });
    assert.equal(envelope.paymentId, 'contract-1');
    assert.equal(envelope.eventStatus, 'completed');
  });

  it('accepts the documented address seen through a dual-stack socket', () => {
    // The dangerous case: not a lost edge range but every notification, because
    // Express reports an IPv4 peer as `::ffff:a.b.c.d` on a dual-stack listener.
    assert.equal(normalizeLava({ clientIp: `::ffff:${DOCUMENTED_IP}` }).paymentId, 'contract-1');
  });

  it('rejects a notification from any other address', () => {
    for (const clientIp of ['158.160.60.175', '8.8.8.8', '127.0.0.1', '::1', 'not-an-ip', '']) {
      assert.throws(() => normalizeLava({ clientIp }), /PAYMENT_WEBHOOK_SIGNATURE_INVALID/);
    }
  });

  it('rejects a notification with no resolvable source address', () => {
    assert.throws(() => normalizeLava({ clientIp: null }), /PAYMENT_WEBHOOK_SIGNATURE_INVALID/);
  });

  it('still rejects a wrong API key sent from the documented address', () => {
    // The pin is additive. Anyone can spoof nothing here, but a compromised
    // relay at the right address must not become a free pass.
    assert.throws(
      () => normalizeLava({ clientIp: DOCUMENTED_IP, apiKey: 'wrong-key' }),
      /PAYMENT_WEBHOOK_SIGNATURE_INVALID/,
    );
  });

  it('exposes the same allowlist through isTrustedLavaIp', () => {
    assert.equal(isTrustedLavaIp(DOCUMENTED_IP), true);
    assert.equal(isTrustedLavaIp(`::ffff:${DOCUMENTED_IP}`), true);
    assert.equal(isTrustedLavaIp('158.160.60.173'), false);
  });
});

describe('lava.top allowlist configuration', () => {
  it('falls back to the published address when unset or blank', () => {
    for (const rawValue of [undefined, '', '   ', ',,']) {
      assert.deepEqual(resolveLavaTrustedNetworks(rawValue), [DOCUMENTED_IP]);
    }
  });

  it('accepts a bare address, which is how a renumbering would be pasted', () => {
    // A bare host must not be silently discarded — that would leave an empty
    // allowlist, which rejects everything.
    assert.deepEqual(resolveLavaTrustedNetworks('203.0.113.7'), ['203.0.113.7']);
  });

  it('accepts CIDRs, several entries, and IPv6', () => {
    assert.deepEqual(resolveLavaTrustedNetworks(' 203.0.113.0/24 , 2001:db8::1 ,198.51.100.5'), [
      '203.0.113.0/24',
      '2001:db8::1',
      '198.51.100.5',
    ]);
  });

  it('discards the whole override when any entry is malformed', () => {
    // Half an allowlist is worse than none: the entries that failed vanish
    // without a word, and a dropped address here is a payment that never lands.
    for (const rawValue of [
      '203.0.113.7, nonsense',
      '203.0.113.0/33',
      '2001:db8::1/129',
      '203.0.113.0/24/8',
      '203.0.113.0/',
      // `/0` would trust the entire internet — the one typo that turns the pin
      // into a no-op while still looking configured.
      '0.0.0.0/0',
      '::/0',
    ]) {
      assert.deepEqual(resolveLavaTrustedNetworks(rawValue), [DOCUMENTED_IP]);
    }
  });
});
