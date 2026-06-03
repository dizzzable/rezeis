import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';

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

    assert.deepStrictEqual(calls, [{
      url: 'https://api.yookassa.ru/v3/payments',
      body: {
        amount: { value: '12.50', currency: Currency.RUB },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: 'https://user.example/payments/result?paymentId=payment-1',
        },
        description: 'Plan purchase that should be sent to provider',
        metadata: { paymentId: 'payment-1', transactionId: 'transaction-1' },
      },
      options: {
        auth: { username: 'shop-1', password: 'secret-1' },
        headers: { 'Idempotence-Key': 'payment-1' },
      },
    }]);
    assert.deepStrictEqual(result, {
      gatewayId: 'provider-payment-1',
      checkoutUrl: 'https://checkout.example/yookassa',
      providerMode: 'REDIRECT',
      providerStatus: 'pending',
      gatewayData: {
        provider: 'YOOKASSA',
        providerStatus: 'pending',
        providerResponse: {
          id: 'provider-payment-1',
          status: 'pending',
          confirmation: { confirmation_url: 'https://checkout.example/yookassa' },
        },
        checkoutUrl: 'https://checkout.example/yookassa',
      },
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
});

function createService(httpService: { readonly post: (...args: never[]) => unknown }): PaymentProviderExecutionService {
  return new PaymentProviderExecutionService(httpService as never, {
    domain: 'https://user.example',
    botToken: 'bot-token-1',
  } as never);
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
