import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
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

import { CHECKOUT_LIFETIME_SECONDS } from '../src/modules/payments/constants/checkout-lifetime.constant';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { encryptGatewaySettingsForStorage } from '../src/modules/payments/utils/payment-gateway-settings.util';

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
    // Typed as the request body rather than as its own literal: `deepStrictEqual`
    // asserts the actual value INTO the expected type, and a bare literal here
    // would leave `call.body` unable to name the key checked on the next line.
    const expectedBody: Record<string, unknown> = {
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
        savePaymentMethod: false,
      },
    };
    assert.deepStrictEqual(call.body, expectedBody);
    assert.equal(call.body['save_payment_method'], undefined);
    assert.deepStrictEqual(call.options.auth, { username: 'shop-1', password: 'secret-1' });
    assert.deepStrictEqual(call.options.headers, { 'Idempotence-Key': 'payment-1' });
    assert.equal(typeof call.options.validateStatus, 'function');
    assert.equal(call.options.validateStatus?.(500), true);
    assert.equal(result.gatewayId, 'provider-payment-1');
    assert.equal(result.checkoutUrl, 'https://checkout.example/yookassa');
    assert.equal(result.providerMode, 'REDIRECT');
    assert.equal(result.providerStatus, 'pending');
    assert.equal(result.yookassaPaymentPayload !== undefined, true);
    // Omitted client fields → fail-closed: no silent card bind.
    assert.equal(result.gatewayData['savePaymentMethod'], false);
    assert.equal(result.gatewayData['savePaymentMethodReason'], 'consent_required_omit');
    assert.equal(result.gatewayData['consentAt'], null);
    assert.equal(result.gatewayData['consentVersion'], null);
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
    assert.equal(result.gatewayData['consentVersion'], 'yookassa-autopay-v1');
    assert.equal(typeof result.gatewayData['consentAt'], 'string');
    assert.ok(String(result.gatewayData['consentAt']).length > 0);
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
      // Key order matters here: the signature below is computed over this exact
      // JSON, so it must mirror the payload the service builds.
      lifetime: CHECKOUT_LIFETIME_SECONDS,
      url_success: 'https://user.example/payments/result?paymentId=payment-heleket-1',
      url_return: 'https://user.example/payments/result?paymentId=payment-heleket-1',
      // Heleket has no documented merchant-level webhook address, so without a
      // per-invoice one it would never notify us at all.
      url_callback: 'https://user.example/api/v1/payments/webhooks/HELEKET',
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

/**
 * A real RSA pair, generated once per run.
 *
 * The literal that stood here was not self-consistent: it parsed and it signed,
 * but its signatures could never verify against its own modulus. That went
 * unnoticed because no test ever verified one — and it silently defeats the
 * only assertion that proves the Antilopay key normalization works, so the key
 * has to be genuine rather than merely well-formed.
 */
const TEST_RSA_KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** The setting as an operator who pasted only the base64 body would store it. */
const TEST_RSA_PRIVATE_KEY_BASE64 = TEST_RSA_KEY_PAIR.privateKey
  .replace(/-----(?:BEGIN|END)[^-]*-----/g, '')
  .replace(/\s+/g, '');

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
      expires_in: CHECKOUT_LIFETIME_SECONDS,
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

describe('PaymentProviderExecutionService — RioPay/Valutix serviceId', () => {
  const engines = [
    {
      type: PaymentGatewayType.RIOPAY,
      url: 'https://api.riopay.online/v1/orders',
    },
    {
      type: PaymentGatewayType.VALUTIX,
      url: 'https://api.panel.valutix.kz/v1/orders',
    },
  ] as const;

  for (const engine of engines) {
    it(`sends ${engine.type} serviceId when the gateway is configured with one`, async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const service = createService({
        post: (url: string, body: Record<string, unknown>) => {
          calls.push({ url, body });
          return of({ data: { id: 'order-1', status: 'PENDING', paymentLink: 'https://pay.example/order-1' } });
        },
      });

      const result = await service.createCheckout({
        gateway: createGateway({ type: engine.type, settings: { apiToken: 'token-1', serviceId: 42 } }),
        transaction: createTransaction({ paymentId: 'payment-svc-1', gatewayType: engine.type }),
        description: 'Plan purchase',
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, engine.url);
      assert.equal(calls[0].body.serviceId, 42);
      assert.equal(calls[0].body.externalId, 'payment-svc-1');
      assert.equal(result.checkoutUrl, 'https://pay.example/order-1');
    });

    it(`sends ${engine.type} serviceId stored as a numeric string`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const service = createService({
        post: (_url: string, body: Record<string, unknown>) => {
          calls.push(body);
          return of({ data: { id: 'order-2', paymentLink: 'https://pay.example/order-2' } });
        },
      });

      await service.createCheckout({
        gateway: createGateway({ type: engine.type, settings: { apiToken: 'token-1', serviceId: ' 7 ' } }),
        transaction: createTransaction({ gatewayType: engine.type }),
        description: 'Plan purchase',
      });

      assert.equal(calls[0].serviceId, 7);
    });

    it(`omits ${engine.type} serviceId entirely on legacy accounts without one`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const service = createService({
        post: (_url: string, body: Record<string, unknown>) => {
          calls.push(body);
          return of({ data: { id: 'order-3', paymentLink: 'https://pay.example/order-3' } });
        },
      });

      await service.createCheckout({
        gateway: createGateway({ type: engine.type, settings: { apiToken: 'token-1' } }),
        transaction: createTransaction({ gatewayType: engine.type }),
        description: 'Plan purchase',
      });

      assert.equal('serviceId' in calls[0], false);
    });
  }
});

// ── Antilopay ──────────────────────────────────────────────────────────────

function wrapBase64At64Columns(value: string): string {
  return (value.match(/.{1,64}/g) ?? []).join('\n');
}

/** The same key as a complete PEM — what pasting a `.pem` file produces. */
const TEST_RSA_PRIVATE_KEY_PEM = TEST_RSA_KEY_PAIR.privateKey;

/** Same key re-encoded as PKCS#8 — the form Antilopay actually issues. */
const TEST_RSA_PRIVATE_KEY_PKCS8_PEM = createPrivateKey(TEST_RSA_PRIVATE_KEY_PEM)
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

const TEST_RSA_PUBLIC_KEY = createPublicKey(TEST_RSA_KEY_PAIR.publicKey);

/**
 * Runs one Antilopay checkout and returns the exact bytes that were signed
 * alongside the signature, so a test can prove the header actually verifies
 * rather than merely that no exception escaped.
 */
async function createAntilopayCheckout(input: {
  readonly privateKey: string;
  readonly vat?: unknown;
  readonly customerEmail?: string | null;
  readonly customerIp?: string | null;
}): Promise<{ readonly body: string; readonly signature: string; readonly payload: Record<string, unknown> }> {
  const calls: Array<{ body: string; options: { headers: Record<string, string> } }> = [];
  const service = createService({
    post: (_url: string, body: string, options: { headers: Record<string, string> }) => {
      calls.push({ body, options });
      return of({ data: { code: 0, payment_id: 'apay-1', payment_url: 'https://lk.antilopay.com/pay/1' } });
    },
  });

  await service.createCheckout({
    gateway: createGateway({
      type: PaymentGatewayType.ANTILOPAY,
      settings: {
        projectIdentificator: 'project-1',
        secretId: 'secret-id-1',
        privateKey: input.privateKey,
        publicKey: 'MFwwDQYJKoZI',
        ...(input.vat === undefined ? {} : { vat: input.vat }),
      },
    }),
    transaction: createTransaction({ paymentId: 'payment-apay-1', gatewayType: PaymentGatewayType.ANTILOPAY }),
    description: 'Plan purchase',
    customerEmail: input.customerEmail,
    customerIp: input.customerIp,
  });

  assert.equal(calls.length, 1);
  return {
    body: calls[0].body,
    signature: calls[0].options.headers['X-Apay-Sign'],
    payload: JSON.parse(calls[0].body) as Record<string, unknown>,
  };
}

function verifyAntilopaySignature(body: string, signature: string): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(body);
  return verifier.verify(TEST_RSA_PUBLIC_KEY, signature, 'base64');
}

describe('PaymentProviderExecutionService — Antilopay signing key normalization', () => {
  // Every one of these is a clipboard shape. Wrapping the setting in armor
  // as-is signs correctly only for the first two; the rest threw
  // ERR_OSSL_UNSUPPORTED on Node 24 / OpenSSL 3.5.5 and surfaced as a bare 503
  // that named nothing, taking the gateway offline until someone guessed.
  const pastedKeyShapes = [
    { name: 'raw base64', key: TEST_RSA_PRIVATE_KEY_BASE64 },
    { name: '64-column-wrapped base64', key: wrapBase64At64Columns(TEST_RSA_PRIVATE_KEY_BASE64) },
    { name: 'a trailing newline', key: `${TEST_RSA_PRIVATE_KEY_BASE64}\n` },
    { name: 'a trailing CRLF', key: `${TEST_RSA_PRIVATE_KEY_BASE64}\r\n` },
    { name: 'full PEM armor', key: TEST_RSA_PRIVATE_KEY_PEM },
    { name: 'full PEM armor and surrounding whitespace', key: `\n  ${TEST_RSA_PRIVATE_KEY_PEM}\n\n` },
    // The armor label is not the defect: Antilopay issues a PKCS#8 key and
    // OpenSSL 3 signs that body under `RSA PRIVATE KEY` just fine.
    { name: 'PKCS#8 PEM armor', key: TEST_RSA_PRIVATE_KEY_PKCS8_PEM },
  ] as const;

  for (const shape of pastedKeyShapes) {
    it(`produces a verifiable signature for a key pasted with ${shape.name}`, async () => {
      const { body, signature } = await createAntilopayCheckout({ privateKey: shape.key });

      assert.equal(typeof signature, 'string');
      assert.ok(signature.length > 0);
      assert.equal(verifyAntilopaySignature(body, signature), true);
    });
  }

  it('signs the exact bytes it posts, so the body cannot drift from the signature', async () => {
    const { body, signature, payload } = await createAntilopayCheckout({
      privateKey: TEST_RSA_PRIVATE_KEY_PEM,
    });

    assert.equal(body, JSON.stringify(payload));
    assert.equal(verifyAntilopaySignature(body, signature), true);
    assert.equal(verifyAntilopaySignature(`${body} `, signature), false);
  });
});

describe('PaymentProviderExecutionService — Antilopay vat', () => {
  // «Поле обязательное, если сно Мерчанта - ОСНО» (Antilopay API, p.14).
  // Without it such a merchant gets error 17 on every single checkout.
  for (const vat of [10, 22, '10', '22'] as const) {
    it(`sends vat ${JSON.stringify(vat)} as the number ${Number(vat)} when configured`, async () => {
      const { payload } = await createAntilopayCheckout({
        privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
        vat,
      });

      assert.equal(payload.vat, Number(vat));
    });
  }

  it('omits vat entirely for a merchant that is not on ОСНО', async () => {
    const { payload } = await createAntilopayCheckout({ privateKey: TEST_RSA_PRIVATE_KEY_BASE64 });

    assert.equal('vat' in payload, false);
  });

  it('omits a legacy stored vat that is outside the documented enum', async () => {
    const { payload } = await createAntilopayCheckout({
      privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
      vat: 20,
    });

    assert.equal('vat' in payload, false);
  });
});

describe('PaymentProviderExecutionService — Antilopay customer', () => {
  it('sends the payer email supplied by the caller', async () => {
    const { payload } = await createAntilopayCheckout({
      privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
      customerEmail: 'payer@example.org',
    });

    assert.deepStrictEqual(payload.customer, { email: 'payer@example.org' });
  });

  it('falls back to a per-payment address on the public domain, never a .local literal', async () => {
    const { payload } = await createAntilopayCheckout({ privateKey: TEST_RSA_PRIVATE_KEY_BASE64 });
    const customer = payload.customer as Record<string, unknown>;

    // The old constant was `customer@rezeis.local` for every buyer: `.local` is
    // a reserved non-routable TLD (a plausible error 12), and one shared
    // address discarded the payer↔dispute link the callback echoes back.
    assert.equal(customer.email, 'payment-apay-1@user.example');
    assert.equal(String(customer.email).endsWith('.local'), false);
  });

  it('sends customer.ip when the buyer address is known', async () => {
    const { payload } = await createAntilopayCheckout({
      privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
      customerIp: '203.0.113.7',
    });

    assert.equal((payload.customer as Record<string, unknown>).ip, '203.0.113.7');
  });

  it('unwraps the IPv4-mapped form dual-stack Node reports', async () => {
    const { payload } = await createAntilopayCheckout({
      privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
      customerIp: '::ffff:203.0.113.7',
    });

    assert.equal((payload.customer as Record<string, unknown>).ip, '203.0.113.7');
  });

  it('omits customer.ip rather than forwarding an unknown or malformed address', async () => {
    for (const customerIp of [null, undefined, '   ', 'not-an-ip', '999.1.1.1']) {
      const { payload } = await createAntilopayCheckout({
        privateKey: TEST_RSA_PRIVATE_KEY_BASE64,
        customerIp,
      });

      assert.equal(
        'ip' in (payload.customer as Record<string, unknown>),
        false,
        `expected ${JSON.stringify(customerIp)} to be dropped`,
      );
    }
  });
});

// ── SeverPay / Lava payer email ────────────────────────────────────────────

const SEVERPAY_SECRET_TOKEN = 'severpay-secret-1';

/**
 * Runs one SeverPay checkout and returns the body it posted. The whole body is
 * returned rather than the address alone because `client_email` sits inside
 * the key-sorted object SeverPay signs.
 */
async function createSeverpayCheckout(
  input: { readonly customerEmail?: string | null } = {},
): Promise<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const service = createService({
    post: (_url: string, body: Record<string, unknown>) => {
      calls.push(body);
      return of({ data: { status: true, data: { uid: 'sp-1', url: 'https://severpay.io/pay/1' } } });
    },
  });

  await service.createCheckout({
    gateway: createGateway({
      type: PaymentGatewayType.SEVERPAY,
      settings: { mid: '4242', secretToken: SEVERPAY_SECRET_TOKEN },
    }),
    transaction: createTransaction({
      paymentId: 'payment-sp-1',
      gatewayType: PaymentGatewayType.SEVERPAY,
    }),
    description: 'Plan purchase',
    customerEmail: input.customerEmail,
  });

  assert.equal(calls.length, 1);
  return calls[0];
}

/** Runs one Lava checkout and returns the invoice body it posted. */
async function createLavaCheckout(
  input: { readonly customerEmail?: string | null } = {},
): Promise<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const service = createService({
    post: (_url: string, body: Record<string, unknown>) => {
      calls.push(body);
      return of({ data: { id: 'lava-1', status: 'in-progress', paymentUrl: 'https://app.lava.top/pay/1' } });
    },
  });

  await service.createCheckout({
    gateway: createGateway({
      type: PaymentGatewayType.LAVA,
      settings: { apiKey: 'lava-key-1', offerId: 'offer-1' },
    }),
    transaction: createTransaction({
      paymentId: 'payment-lava-1',
      gatewayType: PaymentGatewayType.LAVA,
    }),
    description: 'Plan purchase',
    customerEmail: input.customerEmail,
  });

  assert.equal(calls.length, 1);
  return calls[0];
}

describe('PaymentProviderExecutionService — Lava payer email', () => {
  it('sends the payer email supplied by the caller', async () => {
    const body = await createLavaCheckout({ customerEmail: 'payer@example.org' });

    assert.equal(body.email, 'payer@example.org');
  });

  it('falls back to a routable per-payment address, never a .local literal', async () => {
    const body = await createLavaCheckout();

    // Lava treats this as the buyer's own address and mails the invoice there,
    // so the old `${userId}@rezeis.local` reached nobody: `.local` is reserved
    // for multicast DNS and resolves nowhere off-LAN.
    assert.equal(body.email, 'payment-lava-1@user.example');
    assert.equal(String(body.email).endsWith('.local'), false);
  });
});

describe('PaymentProviderExecutionService — SeverPay payer email', () => {
  it('sends the payer email supplied by the caller', async () => {
    const body = await createSeverpayCheckout({ customerEmail: 'payer@example.org' });

    assert.equal(body.client_email, 'payer@example.org');
  });

  it('falls back to a routable per-payment address, never a .local literal', async () => {
    const body = await createSeverpayCheckout();

    assert.equal(body.client_email, 'payment-sp-1@user.example');
    assert.equal(String(body.client_email).endsWith('.local'), false);
  });

  it('signs the body it posts, so the payer email cannot drift from the signature', async () => {
    // The address is now computed rather than a literal, and it is covered by
    // the HMAC — a change that signs one value and posts another would be
    // rejected by SeverPay with nothing here to catch it.
    const body = await createSeverpayCheckout({ customerEmail: 'payer@example.org' });
    const { sign, ...signedFields } = body;
    const expected = createHmac('sha256', SEVERPAY_SECRET_TOKEN)
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(signedFields).sort(([a], [b]) => a.localeCompare(b))),
        ),
      )
      .digest('hex');

    assert.equal(signedFields.client_email, 'payer@example.org');
    assert.equal(sign, expected);
  });
});

describe('PaymentProviderExecutionService reads encrypted gateway settings', () => {
  it('authenticates with the decrypted credential, never the stored ciphertext', async () => {
    process.env.REZEIS_CRYPT_KEY ??= 'provider-exec-spec-key-that-is-32plus!!';
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({
          data: {
            id: 'provider-payment-1',
            status: 'pending',
            confirmation: { confirmation_url: 'https://checkout.example/yookassa' },
          },
        });
      },
    });

    // Exactly what the column holds once secrets are encrypted at rest: the
    // credential is an envelope, the shop id is still readable.
    const storedSettings = encryptGatewaySettingsForStorage(PaymentGatewayType.YOOKASSA, {
      shopId: 'shop-1',
      apiKey: 'live_sk_9f3a72be41d0c8e5',
    });
    assert.equal(String(storedSettings.apiKey).startsWith('PGENC1:'), true);

    await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.YOOKASSA,
        settings: storedSettings as Record<string, unknown>,
      }),
      transaction: createTransaction({
        paymentId: 'payment-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        amount: '12.50',
        currency: Currency.RUB,
      }),
      description: 'Checkout against an encrypted gateway row',
    });

    const call = calls[0] as { options: { auth: { username: string; password: string } } };
    // Every payment path reads settings through `readGatewaySettings`, so the
    // provider gets the real key. Sending the envelope instead would fail auth
    // on a live payment while the panel still showed the gateway as ready.
    assert.deepStrictEqual(call.options.auth, {
      username: 'shop-1',
      password: 'live_sk_9f3a72be41d0c8e5',
    });
  });
});

/**
 * Platega has TWO create endpoints and they are not interchangeable:
 *
 *   `POST /transaction/process`    — `paymentMethod` REQUIRED, answers `redirect` (+ `usdtRate`)
 *   `POST /v2/transaction/process` — NO `paymentMethod`, answers `url` (+ `rate`)
 *
 * The gateway setting picks between them, and the third state is the dangerous
 * one: an ABSENT `paymentMethod` has always meant 2 (СБП QR) and every install
 * that never opened the field is live on it. So «provider's choice» is an
 * explicitly-selected sentinel and never a reinterpretation of «unset» — these
 * tests exist mostly to pin that separation down.
 */
describe('PaymentProviderExecutionService — Platega endpoint selection', () => {
  const PLATEGA_SETTINGS = { merchantId: 'merchant-1', secret: 'secret-1' } as const;

  function createPlategaService(data: Record<string, unknown>): {
    readonly service: PaymentProviderExecutionService;
    readonly calls: Array<{ url: string; body: Record<string, unknown>; options: unknown }>;
  } {
    const calls: Array<{ url: string; body: Record<string, unknown>; options: unknown }> = [];
    const service = createService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body: body as Record<string, unknown>, options });
        return of({ data });
      },
    });
    return { service, calls };
  }

  function plategaCheckout(
    service: PaymentProviderExecutionService,
    settings: Record<string, unknown>,
  ): ReturnType<PaymentProviderExecutionService['createCheckout']> {
    return service.createCheckout({
      gateway: createGateway({ type: PaymentGatewayType.PLATEGA, settings }),
      transaction: createTransaction({ gatewayType: PaymentGatewayType.PLATEGA }),
      description: 'Platega checkout',
      successUrl: 'https://reiwa.example/success',
      failUrl: 'https://reiwa.example/fail',
    });
  }

  const EXPECTED_COMMON_BODY = {
    paymentDetails: { amount: 9.99, currency: Currency.USD },
    description: 'Platega checkout',
    payload: 'payment-1',
    return: 'https://reiwa.example/success',
    failedUrl: 'https://reiwa.example/fail',
  } as const;

  it('keeps a selected method on v1 with the request byte-for-byte unchanged', async () => {
    const { service, calls } = createPlategaService({
      transactionId: 'platega-v1',
      redirect: 'https://checkout.example/platega-v1',
      status: 'PENDING',
      usdtRate: 92.5,
    });

    const result = await plategaCheckout(service, { ...PLATEGA_SETTINGS, paymentMethod: 11 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://app.platega.io/transaction/process');
    assert.deepStrictEqual(calls[0]?.body, { paymentMethod: 11, ...EXPECTED_COMMON_BODY });
    assert.deepStrictEqual(calls[0]?.options, {
      headers: { 'X-MerchantId': 'merchant-1', 'X-Secret': 'secret-1' },
    });
    assert.equal(result.checkoutUrl, 'https://checkout.example/platega-v1');
    assert.equal(result.gatewayId, 'platega-v1');
    assert.equal(result.providerMode, 'REDIRECT');
  });

  it('still resolves an UNSET method to 2 on v1 — the behaviour live gateways run on', async () => {
    const { service, calls } = createPlategaService({
      transactionId: 'platega-default',
      redirect: 'https://checkout.example/platega-default',
      status: 'PENDING',
    });

    await plategaCheckout(service, { ...PLATEGA_SETTINGS });

    // Not «provider's choice». An operator who never touched the field is on
    // СБП QR today and must stay there; repurposing this state would silently
    // move every such install onto a different checkout.
    assert.equal(calls[0]?.url, 'https://app.platega.io/transaction/process');
    assert.equal(calls[0]?.body['paymentMethod'], 2);
  });

  it('routes the provider-choice sentinel to v2 with NO paymentMethod in the body', async () => {
    const { service, calls } = createPlategaService({
      transactionId: 'platega-v2',
      url: 'https://checkout.example/platega-v2',
      status: 'PENDING',
      expiresIn: '2026-04-19T12:30:00.000Z',
      rate: 92.5,
    });

    const result = await plategaCheckout(service, {
      ...PLATEGA_SETTINGS,
      paymentMethod: 'PROVIDER_CHOICE',
    });

    assert.equal(calls[0]?.url, 'https://app.platega.io/v2/transaction/process');
    // v2 documents no `paymentMethod`. A present-but-undefined key would be
    // serialized away by axios anyway, but an absent KEY is what the contract
    // says, so that is what is asserted.
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0]?.body ?? {}, 'paymentMethod'), false);
    assert.deepStrictEqual(calls[0]?.body, { ...EXPECTED_COMMON_BODY });
    assert.deepStrictEqual(calls[0]?.options, {
      headers: { 'X-MerchantId': 'merchant-1', 'X-Secret': 'secret-1' },
    });
    assert.equal(result.checkoutUrl, 'https://checkout.example/platega-v2');
    assert.equal(result.gatewayId, 'platega-v2');
    assert.equal(result.providerMode, 'REDIRECT');
  });

  it('reads `redirect` on v1 and `url` on v2, even when the body carries both', async () => {
    const v1 = createPlategaService({
      transactionId: 'platega-v1',
      redirect: 'https://checkout.example/correct-v1',
      url: 'https://checkout.example/wrong-for-v1',
      status: 'PENDING',
    });
    const v2 = createPlategaService({
      transactionId: 'platega-v2',
      url: 'https://checkout.example/correct-v2',
      redirect: 'https://checkout.example/wrong-for-v2',
      status: 'PENDING',
    });

    const v1Result = await plategaCheckout(v1.service, { ...PLATEGA_SETTINGS, paymentMethod: 11 });
    const v2Result = await plategaCheckout(v2.service, {
      ...PLATEGA_SETTINGS,
      paymentMethod: 'PROVIDER_CHOICE',
    });

    assert.equal(v1Result.checkoutUrl, 'https://checkout.example/correct-v1');
    assert.equal(v2Result.checkoutUrl, 'https://checkout.example/correct-v2');
  });

  it('refuses a create response with no link instead of returning a dead REDIRECT checkout', async () => {
    // Was silent on both paths: `checkoutUrl: null` under `providerMode:
    // 'REDIRECT'` shipped a dead link to the client and left the row PENDING
    // until the 30-minute sweep cancelled it as a LOCAL timeout — a provider
    // refusal mis-filed as our own expiry, which is what distorts the
    // trial-claim quota ledger. YooKassa throws here; Platega now does too.
    const linkless: ReadonlyArray<{
      readonly paymentMethod: number | string;
      readonly data: Record<string, unknown>;
    }> = [
      {
        paymentMethod: 11,
        data: { transactionId: 'platega-v1', status: 'PENDING', usdtRate: 92.5 },
      },
      {
        paymentMethod: 'PROVIDER_CHOICE',
        data: { transactionId: 'platega-v2', status: 'PENDING', rate: 92.5 },
      },
    ];

    for (const { paymentMethod, data } of linkless) {
      const { service } = createPlategaService(data);

      await assert.rejects(
        plategaCheckout(service, { ...PLATEGA_SETTINGS, paymentMethod }),
        (error: unknown) => {
          assert.equal(error instanceof ServiceUnavailableException, true);
          return true;
        },
        `expected paymentMethod ${JSON.stringify(paymentMethod)} to refuse a linkless response`,
      );
    }
  });

  it('treats a blank link as no link, rather than handing it to the client', async () => {
    const { service } = createPlategaService({
      transactionId: 'platega-v2',
      url: '   ',
      status: 'PENDING',
    });

    await assert.rejects(
      plategaCheckout(service, { ...PLATEGA_SETTINGS, paymentMethod: 'PROVIDER_CHOICE' }),
      (error: unknown) => {
        assert.equal(error instanceof ServiceUnavailableException, true);
        return true;
      },
    );
  });
});
