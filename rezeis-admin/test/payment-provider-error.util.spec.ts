import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizePaymentProviderError,
  redactPaymentDiagnosticMessage,
} from '../src/modules/payments/utils/payment-provider-error.util';

describe('normalizePaymentProviderError', () => {
  it('preserves bounded domain/provider codes', () => {
    assert.equal(normalizePaymentProviderError(new Error('SUBSCRIPTION_NOT_FOUND')), 'SUBSCRIPTION_NOT_FOUND');
    assert.equal(normalizePaymentProviderError('PAYMENT_PROVIDER_TIMEOUT'), 'PAYMENT_PROVIDER_TIMEOUT');
    assert.equal(normalizePaymentProviderError('REMNAWAVE_PROVIDER_ERROR'), 'REMNAWAVE_PROVIDER_ERROR');
  });

  it('classifies common transient provider failures without raw details', () => {
    assert.equal(normalizePaymentProviderError(new Error('ETIMEDOUT while calling provider')), 'PAYMENT_PROVIDER_TIMEOUT');
    assert.equal(normalizePaymentProviderError(new Error('ECONNREFUSED provider gateway')), 'PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('hides sensitive provider diagnostics behind bounded fallback', () => {
    const raw = 'provider failed https://provider.example/profile/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-provider-token-secret';

    const normalized = normalizePaymentProviderError(new Error(raw), 'PROFILE_SYNC_FAILED');
    const serialized = JSON.stringify({ normalized });

    assert.equal(normalized, 'PROFILE_SYNC_FAILED');
    assert.equal(serialized.includes(raw), false);
    assert.equal(serialized.includes('raw-provider-token-secret'), false);
    assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(serialized.includes('https://provider.example'), false);
  });
});

describe('redactPaymentDiagnosticMessage', () => {
  it('redacts auth headers, cookies, provider ids, and provider URLs', () => {
    const raw = [
      'Authorization: Bearer raw-access-token-123',
      'Proxy-Authorization=Basic raw-basic-secret',
      'Cookie: session=sess-secret-456; refresh=refresh-secret-789',
      'Set-Cookie: payment_session=payment-cookie-secret',
      'provider_id=provider-raw-id-123',
      'gatewayId=gw-raw-id-456',
      'profileUrl=https://provider.example/profile?apiKey=profile-secret',
      'config_url=https://provider.example/config?token=config-secret',
    ].join(' ');

    const redacted = redactPaymentDiagnosticMessage(raw);
    const serialized = JSON.stringify({ redacted });

    assert.ok(redacted !== null);
    assert.equal(redacted.includes('[token hidden]'), true);
    assert.equal(redacted.includes('[cookie hidden]'), true);
    assert.equal(redacted.includes('[identifier hidden]'), true);
    assert.equal(redacted.includes('[url hidden]'), true);
    assert.equal(serialized.includes('raw-access-token-123'), false);
    assert.equal(serialized.includes('raw-basic-secret'), false);
    assert.equal(serialized.includes('sess-secret-456'), false);
    assert.equal(serialized.includes('refresh-secret-789'), false);
    assert.equal(serialized.includes('payment-cookie-secret'), false);
    assert.equal(serialized.includes('provider-raw-id-123'), false);
    assert.equal(serialized.includes('gw-raw-id-456'), false);
    assert.equal(serialized.includes('provider.example'), false);
    assert.equal(serialized.includes('profile-secret'), false);
    assert.equal(serialized.includes('config-secret'), false);
  });
});
