import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

describe('PaymentProviderExecutionService checkout execution', () => {
  it('creates YooKassa checkout requests with idempotence key and bounded result', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({
          data: {
            id: 'provider-payment-1',
            status: 'pending',
            metadata: { apiKey: 'raw-provider-secret' },
            confirmation: { confirmation_url: 'https://checkout.example/yookassa' },
          },
        });
      },
    });

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '12.50',
        currency: Currency.RUB,
      }),
      description: 'Plan purchase that should be sent to provider',
    });

    assert.equal(calls.length, 1);
    const call = calls[0] as {
      url: string;
      body: Record<string, unknown>;
      options: { auth: unknown; headers: unknown; validateStatus?: (status: number) => boolean };
    };
    assert.equal(call.url, 'https://api.yookassa.ru/v3/payments');
    assert.deepStrictEqual(call.body, {
      amount: { value: '12.50', currency: Currency.RUB },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: 'https://user.example/payments/result?paymentId=payment-1',
      },
      description: 'Plan purchase that should be sent to provider',
      metadata: {
        paymentId: 'payment-1',
        transactionId: 'transaction-1',
        userId: 'user-1',
        savePaymentMethod: true,
      },
      save_payment_method: true,
    });
    assert.deepStrictEqual(call.options.auth, { username: 'shop-1', password: 'secret-1' });
    assert.deepStrictEqual(call.options.headers, { 'Idempotence-Key': 'payment-1' });
    assert.equal(typeof call.options.validateStatus, 'function');
    assert.equal(call.options.validateStatus?.(500), true);
    assert.equal(result.gatewayId, 'provider-payment-1');
    assert.equal(result.checkoutUrl, 'https://checkout.example/yookassa');
    assert.equal(result.providerMode, 'REDIRECT');
    assert.equal(result.providerStatus, 'pending');
    assert.equal(result.yookassaPaymentPayload !== undefined, true);
    assert.equal(result.gatewayData['savePaymentMethod'], true);
    assert.equal(result.gatewayData['savePaymentMethodReason'], 'legacy_gateway_default');
    assert.equal(result.gatewayData['provider'], 'YOOKASSA');
    assert.equal(result.gatewayData['checkoutUrl'], 'https://checkout.example/yookassa');
  });

  it('does not request save_payment_method without consent when client opts in', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (_url: string, body: unknown) => {
        calls.push(body);
        return of({
          data: {
            id: 'provider-no-consent',
            status: 'pending',
            confirmation: { confirmation_url: 'https://checkout.example/nc' },
          },
        });
      },
    });
    await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-nc',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '10.00',
        currency: Currency.RUB,
      }),
      description: 'no consent',
      savePaymentMethod: true,
      savePaymentMethodConsent: false,
    });
    const body = calls[0] as Record<string, unknown>;
    assert.equal(body['save_payment_method'], undefined);
  });

  it('requests save_payment_method when client opts in with consent', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (_url: string, body: unknown) => {
        calls.push(body);
        return of({
          data: {
            id: 'provider-consent',
            status: 'pending',
            confirmation: { confirmation_url: 'https://checkout.example/c' },
          },
        });
      },
    });
    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-c',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '10.00',
        currency: Currency.RUB,
      }),
      description: 'with consent',
      savePaymentMethod: true,
      savePaymentMethodConsent: true,
    });
    const body = calls[0] as Record<string, unknown>;
    assert.equal(body['save_payment_method'], true);
    assert.equal(result.gatewayData['savePaymentMethodConsent'], true);
    assert.equal(result.gatewayData['savePaymentMethodReason'], 'request_with_consent');
  });

  it('honours per-request savePaymentMethod:false', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (_url: string, body: unknown) => {
        calls.push(body);
        return of({
          data: {
            id: 'provider-opt-out',
            status: 'pending',
            confirmation: { confirmation_url: 'https://checkout.example/o' },
          },
        });
      },
    });
    await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-o',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '10.00',
        currency: Currency.RUB,
      }),
      description: 'opt out',
      savePaymentMethod: false,
    });
    const body = calls[0] as Record<string, unknown>;
    assert.equal(body['save_payment_method'], undefined);
  });

  it('accepts secretKey as YooKassa credential alias for apiKey', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({
          data: {
            id: 'provider-payment-secret',
            status: 'pending',
            confirmation: { confirmation_url: 'https://checkout.example/yookassa-secret' },
          },
        });
      },
    });

    await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', secretKey: 'secret-from-docs' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-secret-alias',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '12.50',
        currency: Currency.RUB,
      }),
      description: 'Plan purchase via secretKey alias',
    });

    assert.equal(calls.length, 1);
    const call = calls[0] as {
      options: { auth: { username: string; password: string }; headers: Record<string, string> };
    };
    assert.equal(call.options.auth.username, 'shop-1');
    assert.equal(call.options.auth.password, 'secret-from-docs');
    assert.equal(call.options.headers['Idempotence-Key'], 'payment-secret-alias');
  });

  it('returns a terminal YooKassa cancellation for an off-session charge', async () => {
    const service = createService({
      post: () =>
        of({
          data: {
            id: 'provider-canceled-1',
            status: 'canceled',
            cancellation_details: { party: 'yoo_kassa', reason: 'permission_revoked' },
          },
        }),
    });

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({ gatewayType: PaymentGatewayType.YOOKASSA }),
      description: 'Autopay renewal',
      paymentMethodId: 'provider-method-1',
      savedPaymentMethodId: 'saved-method-1',
    });

    assert.equal(result.gatewayId, 'provider-canceled-1');
    assert.equal(result.providerStatus, 'canceled');
    assert.equal(result.checkoutUrl, null);
    assert.equal(result.providerMode, 'IMMEDIATE');
    assert.deepStrictEqual(result.gatewayData['cancellation_details'], {
      party: 'yoo_kassa',
      reason: 'permission_revoked',
    });
  });

  it('creates Heleket checkout requests with signed payload and callback-safe result', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({ data: { result: { uuid: 'heleket-payment-1', status: 'new', url: 'https://checkout.example/heleket' } } });
      },
    });
    const body = {
      amount: '7.25',
      currency: Currency.USDT,
      order_id: 'payment-heleket-1',
      description: 'Crypto checkout',
      url_success: 'https://user.example/payments/result?paymentId=payment-heleket-1',
      url_return: 'https://user.example/payments/result?paymentId=payment-heleket-1',
    };
    const sign = createHash('md5')
      .update(`${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')}secret-1`)
      .digest('hex');

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.HELEKET,
        settings: { merchantId: 'merchant-1', apiKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-heleket-1',
        gatewayType: PaymentGatewayType.HELEKET,
        amount: '7.25',
        currency: Currency.USDT,
      }),
      description: 'Crypto checkout',
    });

    assert.deepStrictEqual(calls, [{
      url: 'https://api.heleket.com/v1/payment',
      body,
      options: {
        headers: { merchant: 'merchant-1', sign, 'Content-Type': 'application/json' },
      },
    }]);
    assert.equal(result.gatewayId, 'heleket-payment-1');
    assert.equal(result.checkoutUrl, 'https://checkout.example/heleket');
    assert.equal(result.providerMode, 'REDIRECT');
    assert.equal(result.providerStatus, 'new');
    assert.equal(result.gatewayData.provider, 'HELEKET');
  });

  it('redacts sensitive raw provider response fields before returning gateway data for persistence', async () => {
    const rawProviderResponse = {
      id: 'provider-payment-1',
      status: 'pending',
      link_url: 'https://checkout.example/paypalych',
      customerEmail: 'payer@example.com',
      authorization: 'Bearer raw-access-token',
      nested: {
        providerPaymentId: 'pay_1234567890abcdef',
        signature: 'raw-signature',
        amount: '9.99',
      },
    };
    const service = createService({
      post: () => of({ data: rawProviderResponse }),
    });

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.PAYPALYCH,
        settings: {
          shopId: 'shop-1',
          apiKey: 'api-key-1',
        },
      }),
      transaction: createTransaction({ gatewayType: PaymentGatewayType.PAYPALYCH }),
      description: 'Plan purchase',
    });
    const providerResponse = result.gatewayData.providerResponse as Record<string, unknown>;
    const serialized = JSON.stringify(result.gatewayData);

    assert.equal(result.checkoutUrl, 'https://checkout.example/paypalych');
    assert.equal(providerResponse.id, '***redacted***');
    assert.equal(providerResponse.authorization, '***redacted***');
    assert.equal(providerResponse.customerEmail, '[email hidden]');
    assert.deepStrictEqual(providerResponse.nested, {
      providerPaymentId: '***redacted***',
      signature: '***redacted***',
      amount: '9.99',
    });
    assert.equal(serialized.includes('raw-access-token'), false);
    assert.equal(serialized.includes('raw-signature'), false);
    assert.equal(serialized.includes('payer@example.com'), false);
    assert.equal(serialized.includes('provider-payment-1'), false);
    assert.equal(serialized.includes('pay_1234567890abcdef'), false);
  });

  it('uses explicit success and failure URL overrides for redirect gateways', async () => {
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({ data: { transactionId: 'platega-1', redirect: 'https://checkout.example/platega', status: 'PENDING' } });
      },
    });

    await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.PLATEGA,
        settings: { merchantId: 'merchant-1', secret: 'secret-1', paymentMethod: 4 },
      }),
      transaction: createTransaction({ gatewayType: PaymentGatewayType.PLATEGA }),
      description: 'Platega checkout',
      successUrl: 'https://reiwa.example/success',
      failUrl: 'https://reiwa.example/fail',
    });

    assert.deepStrictEqual(calls, [{
      url: 'https://app.platega.io/transaction/process',
      body: {
        paymentMethod: 4,
        paymentDetails: { amount: 9.99, currency: Currency.USD },
        description: 'Platega checkout',
        payload: 'payment-1',
        return: 'https://reiwa.example/success',
        failedUrl: 'https://reiwa.example/fail',
      },
      options: {
        headers: { 'X-MerchantId': 'merchant-1', 'X-Secret': 'secret-1' },
      },
    }]);
  });

  it('normalizes raw provider failures before throwing from checkout creation', async () => {
    const rawProviderFailure =
      'Platega checkout rejected https://app.platega.io/transaction/process X-Secret=provider-secret paymentId=pay_12345678901234567890';
    const service = createService({
      post: () => throwError(() => new Error(rawProviderFailure)),
    });

    await assert.rejects(
      service.createCheckout({
        gateway: createGateway({
          type: PaymentGatewayType.PLATEGA,
          settings: { merchantId: 'merchant-1', secret: 'secret-1' },
        }),
        transaction: createTransaction({ gatewayType: PaymentGatewayType.PLATEGA }),
        description: 'Plan purchase',
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof ServiceUnavailableException, true);
        assert.equal(serialized.includes(rawProviderFailure), false);
        assert.equal(serialized.includes('provider-secret'), false);
        assert.equal(serialized.includes('pay_12345678901234567890'), false);
        assert.equal(serialized.includes('https://app.platega.io'), false);
        assert.equal(serialized.includes('PAYMENT_PROVIDER_ERROR'), true);
        return true;
      },
    );
  });

  it('redacts Antilopay provider-declared error messages before throwing', async () => {
    const rawProviderError = [
      'invalid signature',
      'checkoutUrl=https://lk.antilopay.com/pay?token=raw-provider-token-secret',
      'payment_id=pay_1234567890abcdef',
      'payer@example.com',
    ].join(' ');
    const service = createService({
      post: () => of({ data: { code: 401, error: rawProviderError } }),
    });

    await assert.rejects(
      service.createCheckout({
        gateway: createGateway({
          type: PaymentGatewayType.ANTILOPAY,
          settings: {
            projectIdentificator: 'project-1',
            secretId: 'secret-id-1',
            privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
          },
        }),
        transaction: createTransaction({ gatewayType: PaymentGatewayType.ANTILOPAY }),
        description: 'Plan purchase',
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof BadRequestException, true);
        assert.equal(serialized.includes('Antilopay error 401'), true);
        assert.equal(serialized.includes('[url hidden]'), true);
        assert.equal(serialized.includes('[identifier hidden]'), true);
        assert.equal(serialized.includes('[email hidden]'), true);
        assert.equal(serialized.includes(rawProviderError), false);
        assert.equal(serialized.includes('raw-provider-token-secret'), false);
        assert.equal(serialized.includes('lk.antilopay.com'), false);
        assert.equal(serialized.includes('pay_1234567890abcdef'), false);
        assert.equal(serialized.includes('payer@example.com'), false);
        return true;
      },
    );
  });
});

const TEST_RSA_PRIVATE_KEY_BASE64 = [
  'MIICXAIBAAKBgQDHZVjF3+Ynt82VfZqoJx82KbJjIxZRv1CtjpPt4C3g6smP2y4u',
  'g2TqluJq/YGDYgubfrJ7MBIKHfWMkwK8UEsq+ML5aWraJqTmQEMRA9+2u/x9K0qz',
  'S2eBFS7CFANWrCTz4/jb4x0yF9atGqWxZizZCSZ4CQ6E+h9obEcWYvhMYwIDAQAB',
  'AoGAPlEiF1IVbISb94r1CMye55XoMPgZFEGu83JGaKqQcfZqkgtL2/i+Fv/BUYH/',
  'rECihfZdLssY2Hge5+X0ElhfE7y+Mlh8GuSDCi9u8uAg40gnza0HwZhrCF9dPJ8f',
  '7kGGKllcBWbtHa6uJ9Fu+moHcjA1fV74EHZIVppBLZesN1ECQQD8Si+lQ3MUqvfn',
  'h8dRSxyibqVAA5JaA3IaxmOmKJoNdtkAEsNCb8Vxpm19sU+rz0j/gkvbHL6HZOvG',
  'yDCuIzElAkEAysdUTYFnfcZPE3a7paehRiOm5Ui0omtyf6pqGKMg1oACaFMSVZO6',
  'HqOZdFkGP5a8PRwpXJrXuK9iK83ybQ7nowJBAIR4HRqR411B7YzHHhSWvfQXUJdc',
  'We+9NFxdGd1N75lo7CNmEYENbrFcJb8WqTAQm6YgypM5XWzNBG8od4GGSsECQExL',
  'ZWKWjuMXenPE7+7EJlG5TeN7yHK8ClZXS2mWprR6/6FcoLlIVnBbCf4N43VGhArq',
  'jLpAV5p/Ef370QRtbA0CQC97t6U9Ml99VbgGhUbEJFX9ISNoLHEJb/2Vgj81pyPk',
  'NnkIkW8rKC7abUzRYo5Hf5fME+0TegQdEGvHhPTgXkI=',
].join('');

function createService(httpService: { readonly post: (...args: never[]) => unknown }): PaymentProviderExecutionService {
  return new PaymentProviderExecutionService(httpService as never, {
    domain: 'https://user.example',
    botToken: 'bot-token-1',
  } as never, new PaymentWebhookPayloadRedactionService());
}

function createGateway(input: {
  readonly type: PaymentGatewayType;
  readonly settings: Record<string, unknown>;
}) {
  return {
    id: 'gateway-1',
    type: input.type,
    orderIndex: 1,
    currency: Currency.USD,
    isActive: true,
    settings: input.settings,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  } as never;
}

function createTransaction(input: {
  readonly paymentId?: string;
  readonly gatewayType: PaymentGatewayType;
  readonly amount?: string;
  readonly currency?: Currency;
}) {
  return {
    id: 'transaction-1',
    paymentId: input.paymentId ?? 'payment-1',
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.PENDING,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: input.gatewayType,
    gatewayId: null,
    gatewayData: null,
    currency: input.currency ?? Currency.USD,
    paymentAsset: null,
    amount: { toString: () => input.amount ?? '9.99' },
    planSnapshot: {},
    deviceTypes: [],
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  } as never;
}

describe('PaymentProviderExecutionService — CryptoPay', () => {
  it('creates a CryptoPay invoice with token header, asset, and payload', async () => {
    const calls: Array<{ url: string; body: unknown; options: unknown }> = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({
          data: {
            ok: true,
            result: {
              invoice_id: 555,
              status: 'active',
              bot_invoice_url: 'https://t.me/CryptoBot?start=inv_abc',
            },
          },
        });
      },
    });

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.CRYPTOPAY,
        settings: { apiToken: 'cp-token-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-cp-1',
        gatewayType: PaymentGatewayType.CRYPTOPAY,
        amount: '12.5',
        currency: Currency.USDT,
      }),
      description: 'Crypto checkout',
      successUrl: 'https://user.example/ok',
    });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, 'https://pay.crypt.bot/api/createInvoice');
    assert.deepStrictEqual(call.body, {
      currency_type: 'crypto',
      asset: 'USDT',
      amount: '12.5',
      description: 'Crypto checkout',
      payload: 'payment-cp-1',
      paid_btn_name: 'callback',
      paid_btn_url: 'https://user.example/ok',
    });
    assert.deepStrictEqual(
      (call.options as { headers: Record<string, string> }).headers['Crypto-Pay-API-Token'],
      'cp-token-1',
    );
    assert.equal(result.gatewayId, '555');
    assert.equal(result.checkoutUrl, 'https://t.me/CryptoBot?start=inv_abc');
    assert.equal(result.providerMode, 'REDIRECT');
    assert.equal(result.gatewayData.provider, 'CRYPTOPAY');
  });

  it('rejects CryptoPay checkout when the API token is not configured', async () => {
    const service = createService({ post: () => of({ data: { ok: true, result: {} } }) });

    await assert.rejects(
      service.createCheckout({
        gateway: createGateway({ type: PaymentGatewayType.CRYPTOPAY, settings: {} }),
        transaction: createTransaction({ gatewayType: PaymentGatewayType.CRYPTOPAY, currency: Currency.USDT }),
        description: 'Crypto checkout',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ServiceUnavailableException, true);
        return true;
      },
    );
  });

  it('treats ok=false from createInvoice as a sanitized provider failure', async () => {
    const service = createService({
      post: () => of({ data: { ok: false, error: { code: 'INVOICE_ERROR' } } }),
    });

    await assert.rejects(
      service.createCheckout({
        gateway: createGateway({ type: PaymentGatewayType.CRYPTOPAY, settings: { apiToken: 'cp-token-1' } }),
        transaction: createTransaction({ gatewayType: PaymentGatewayType.CRYPTOPAY, currency: Currency.USDT }),
        description: 'Crypto checkout',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ServiceUnavailableException, true);
        return true;
      },
    );
  });
});
