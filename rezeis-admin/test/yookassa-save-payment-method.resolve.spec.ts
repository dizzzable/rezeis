import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveYookassaSavePaymentMethod } from '../src/modules/payments/services/payment-provider-execution.service';

describe('resolveYookassaSavePaymentMethod', () => {
  it('never saves on off-session charge', () => {
    const r = resolveYookassaSavePaymentMethod({
      paymentMethodId: 'pm-1',
      gatewayAllows: true,
      requestSave: true,
      consent: true,
    });
    assert.deepEqual(r, { save: false, consent: false, reason: 'off_session' });
  });

  it('never saves when gateway disables binding', () => {
    const r = resolveYookassaSavePaymentMethod({
      paymentMethodId: null,
      gatewayAllows: false,
      requestSave: true,
      consent: true,
    });
    assert.deepEqual(r, { save: false, consent: false, reason: 'gateway_disabled' });
  });

  it('never saves when client opts out', () => {
    const r = resolveYookassaSavePaymentMethod({
      paymentMethodId: null,
      gatewayAllows: true,
      requestSave: false,
      consent: true,
    });
    assert.deepEqual(r, { save: false, consent: false, reason: 'request_opt_out' });
  });

  it('requires consent when client explicitly opts in', () => {
    const denied = resolveYookassaSavePaymentMethod({
      paymentMethodId: null,
      gatewayAllows: true,
      requestSave: true,
      consent: false,
    });
    assert.deepEqual(denied, { save: false, consent: false, reason: 'consent_required' });

    const ok = resolveYookassaSavePaymentMethod({
      paymentMethodId: null,
      gatewayAllows: true,
      requestSave: true,
      consent: true,
    });
    assert.deepEqual(ok, { save: true, consent: true, reason: 'request_with_consent' });
  });

  it('legacy omit keeps gateway-default save without consent stamp', () => {
    const r = resolveYookassaSavePaymentMethod({
      paymentMethodId: null,
      gatewayAllows: true,
      requestSave: undefined,
      consent: undefined,
    });
    assert.deepEqual(r, { save: true, consent: false, reason: 'legacy_gateway_default' });
  });
});
