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

describe('the refund handle survives redaction', () => {
  it('keeps the Telegram and provider charge ids readable', () => {
    // These are ADDRESSES, not credentials: `refundStarPayment(userId, chargeId)`
    // takes the first, and neither is usable without the bot token. They also
    // live in exactly one place — inside this envelope — because nothing
    // extracts them to a column, so masking them removed the only way an
    // operator could reach them and made a Stars refund a hand-written SQL
    // query. Neither was ever named: `telegram_payment_charge_id` matched the
    // generic "ends in _id" rule, which is why the loss was silent.
    const service = new PaymentWebhookPayloadRedactionService();
    const redacted = service.redact({
      message: {
        successful_payment: {
          telegram_payment_charge_id: 'charge_abc',
          provider_payment_charge_id: 'prov_xyz',
          invoice_payload: 'pay_123',
        },
      },
    }) as { message: { successful_payment: Record<string, unknown> } };

    const payment = redacted.message.successful_payment;
    assert.equal(payment.telegram_payment_charge_id, 'charge_abc');
    assert.equal(payment.provider_payment_charge_id, 'prov_xyz');
  });

  it('still redacts the identifiers that are not refund handles', () => {
    // The exemption is a named list, not a widening of the rule.
    const service = new PaymentWebhookPayloadRedactionService();
    const redacted = service.redact({
      customer_id: 'cus_1',
      api_key: 'secret',
      gatewayRef: 'ref_1',
    }) as Record<string, unknown>;

    assert.equal(redacted.customer_id, '***redacted***');
    assert.equal(redacted.api_key, '***redacted***');
    assert.equal(redacted.gatewayRef, '***redacted***');
  });
});
