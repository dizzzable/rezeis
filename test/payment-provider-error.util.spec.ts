import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizePaymentProviderError } from '../src/modules/payments/utils/payment-provider-error.util';

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
