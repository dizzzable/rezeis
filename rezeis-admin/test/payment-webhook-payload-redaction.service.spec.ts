import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

describe('PaymentWebhookPayloadRedactionService', () => {
  it('redacts sensitive keys recursively without removing operational fields', () => {
    const service = new PaymentWebhookPayloadRedactionService();

    const result = service.redact({
      paymentId: 'payment-1',
      id: 'provider-event-1',
      customerEmail: 'payer@example.com',
      checkoutUrl: 'https://provider.example/checkout?token=secret',
      apiKey: 'secret',
      nested: {
        providerPaymentId: 'pay_1234567890abcdef',
        signature: 'signed',
        amount: '10.00',
        items: [
          {
            token: 'token-value',
            status: 'paid',
          },
        ],
      },
    });

    assert.deepStrictEqual(result, {
      paymentId: 'payment-1',
      id: '***redacted***',
      customerEmail: '[email hidden]',
      checkoutUrl: '[url hidden]',
      apiKey: '***redacted***',
      nested: {
        providerPaymentId: '***redacted***',
        signature: '***redacted***',
        amount: '10.00',
        items: [
          {
            token: '***redacted***',
            status: 'paid',
          },
        ],
      },
    });
  });
});
