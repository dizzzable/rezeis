import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { Currency, PaymentGatewayType, TransactionStatus } from '@prisma/client';

import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';

describe('PaymentProviderExecutionService refunds', () => {
  it('creates YooKassa refunds with idempotence key and bounded result', async () => {
    const calls: unknown[] = [];
    const service = new PaymentProviderExecutionService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({ data: { id: 'refund-1', status: 'succeeded' } });
      },
    } as never, {} as never);

    const result = await service.createRefund({
      gateway: {
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      } as never,
      transaction: {
        id: 'transaction-1',
        paymentId: 'payment-1',
        gatewayId: 'provider-payment-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        status: TransactionStatus.COMPLETED,
        amount: { toString: () => '12.50' },
        currency: Currency.RUB,
      } as never,
      idempotencyKey: 'refund-key-1',
    });

    assert.deepStrictEqual(calls, [
      {
        url: 'https://api.yookassa.ru/v3/refunds',
        body: { amount: { value: '12.50', currency: Currency.RUB }, payment_id: 'provider-payment-1' },
        options: {
          auth: { username: 'shop-1', password: 'secret-1' },
          headers: { 'Idempotence-Key': 'refund-key-1' },
        },
      },
    ]);
    assert.deepStrictEqual(result, {
      gatewayRefundId: 'refund-1',
      providerStatus: 'succeeded',
      gatewayData: { provider: 'YOOKASSA', providerStatus: 'succeeded' },
    });
  });

  it('creates Heleket refunds with signed payload and bounded result', async () => {
    const calls: unknown[] = [];
    const service = new PaymentProviderExecutionService({
      post: (url: string, body: unknown, options: unknown) => {
        calls.push({ url, body, options });
        return of({ data: { result: { uuid: 'refund-uuid-1', status: 'paid' } } });
      },
    } as never, {} as never);
    const body = {
      uuid: 'heleket-payment-1',
      address: 'TRON-refund-address',
      is_subtract: true,
      amount: '7.25',
    };
    const sign = createHash('md5')
      .update(`${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')}secret-1`)
      .digest('hex');

    const result = await service.createRefund({
      gateway: {
        id: 'gateway-1',
        type: PaymentGatewayType.HELEKET,
        settings: { merchantId: 'merchant-1', apiKey: 'secret-1' },
      } as never,
      transaction: {
        id: 'transaction-1',
        paymentId: 'payment-1',
        gatewayId: 'heleket-payment-1',
        gatewayType: PaymentGatewayType.HELEKET,
        status: TransactionStatus.COMPLETED,
        amount: { toString: () => '7.25' },
        currency: Currency.USDT,
      } as never,
      idempotencyKey: 'refund-key-1',
      refundAddress: 'TRON-refund-address',
      isSubtract: true,
    });

    assert.deepStrictEqual(calls, [
      {
        url: 'https://api.heleket.com/v1/payment/refund',
        body,
        options: {
          headers: { merchant: 'merchant-1', sign, 'Content-Type': 'application/json' },
        },
      },
    ]);
    assert.deepStrictEqual(result, {
      gatewayRefundId: 'refund-uuid-1',
      providerStatus: 'paid',
      gatewayData: { provider: 'HELEKET', providerStatus: 'paid' },
    });
  });

  it('normalizes raw refund provider failures before throwing', async () => {
    const rawProviderFailure = 'YooKassa refund failed https://api.yookassa.ru/v3/refunds provider_uuid=0194f4b6-7cc7-7ecb-9f62-123456789abc token=raw-provider-token-secret';
    const service = new PaymentProviderExecutionService({
      post: () => throwError(() => new Error(rawProviderFailure)),
    } as never, {} as never);

    await assert.rejects(
      service.createRefund({
        gateway: {
          id: 'gateway-1',
          type: PaymentGatewayType.YOOKASSA,
          settings: { shopId: 'shop-1', apiKey: 'secret-1' },
        } as never,
        transaction: {
          id: 'transaction-1',
          paymentId: 'payment-1',
          gatewayId: 'provider-payment-1',
          gatewayType: PaymentGatewayType.YOOKASSA,
          status: TransactionStatus.COMPLETED,
          amount: { toString: () => '12.50' },
          currency: Currency.RUB,
        } as never,
        idempotencyKey: 'refund-key-1',
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(serialized.includes(rawProviderFailure), false);
        assert.equal(serialized.includes('raw-provider-token-secret'), false);
        assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
        assert.equal(serialized.includes('https://api.yookassa.ru'), false);
        assert.equal(serialized.includes('PAYMENT_PROVIDER_ERROR'), true);
        return true;
      },
    );
  });
});

describe('PaymentProviderExecutionService checkout failures', () => {
  it('normalizes raw checkout provider failures before throwing', async () => {
    const rawProviderFailure = 'Platega checkout rejected https://app.platega.io/transaction/process X-Secret=provider-secret paymentId=pay_12345678901234567890';
    const service = new PaymentProviderExecutionService({
      post: () => {
        throw new Error(rawProviderFailure);
      },
    } as never, {
      ruidPublicWebUrl: 'https://user.example',
      adminPublicBaseUrl: 'https://admin.example',
      botToken: null,
    } as never);

    await assert.rejects(
      service.createCheckout({
        gateway: {
          id: 'gateway-1',
          type: PaymentGatewayType.PLATEGA,
          settings: { merchantId: 'merchant-1', secret: 'secret-1' },
        } as never,
        transaction: {
          id: 'transaction-1',
          paymentId: 'payment-1',
          gatewayType: PaymentGatewayType.PLATEGA,
          status: TransactionStatus.PENDING,
          amount: { toString: () => '12.50' },
          currency: Currency.RUB,
        } as never,
        description: 'Plan purchase',
      }),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
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
