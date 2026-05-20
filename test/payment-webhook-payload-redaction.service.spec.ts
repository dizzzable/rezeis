import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

describe('PaymentWebhookPayloadRedactionService', () => {
  it('redacts sensitive keys recursively without removing operational fields', () => {
    const service = new PaymentWebhookPayloadRedactionService();

    const result = service.redact({
      paymentId: 'payment-1',
      apiKey: 'secret',
      nested: {
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
      apiKey: '***redacted***',
      nested: {
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
