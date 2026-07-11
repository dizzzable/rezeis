import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWebhookSignature } from '../src/common/http/webhook-signature.util';
import { verifyWebhookSignature } from '../src/common/http/webhook-signature.util';

describe('verifyWebhookSignature', () => {
  const secret = 'partner-secret-abc';
  const body = JSON.stringify({ questId: 'q1', externalUserId: 'ext-9', nonce: 'n-1' });

  it('accepts a signature built with the same secret and body within the freshness window', () => {
    const { header } = buildWebhookSignature({ secret, body });
    const result = verifyWebhookSignature({ secret, body, header });
    assert.equal(result.valid, true);
  });

  it('rejects a signature built with a different secret', () => {
    const { header } = buildWebhookSignature({ secret: 'other-secret', body });
    const result = verifyWebhookSignature({ secret, body, header });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'bad_signature');
  });

  it('rejects a tampered body under the same t= timestamp', () => {
    const { header } = buildWebhookSignature({ secret, body });
    const result = verifyWebhookSignature({ secret, body: body + 'tampered', header });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'bad_signature');
  });

  it('rejects a stale timestamp beyond the freshness window', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 10 * 60;
    const { header } = buildWebhookSignature({ secret, body, timestampSec: staleTs });
    const result = verifyWebhookSignature({ secret, body, header, maxAgeSec: 300 });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'stale');
  });

  it('rejects a malformed header', () => {
    for (const header of ['', 'garbage', 't=abc,v1=', 'v1=deadbeef', 't=123']) {
      const result = verifyWebhookSignature({ secret, body, header });
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed');
    }
  });

  it('exposes the parsed timestamp for nonce/audit bookkeeping on success', () => {
    const ts = Math.floor(Date.now() / 1000);
    const { header } = buildWebhookSignature({ secret, body, timestampSec: ts });
    const result = verifyWebhookSignature({ secret, body, header });
    assert.equal(result.valid, true);
    assert.equal(result.timestamp, ts);
  });
});
