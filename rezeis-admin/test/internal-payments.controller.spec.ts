import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPaymentsController } from '../src/modules/payments/controllers/internal-payments.controller';
import { Currency, PaymentGatewayType } from '@prisma/client';

import { PaymentsCheckoutService } from '../src/modules/payments/services/payments-checkout.service';

describe('InternalPaymentsController', () => {
  it('exposes internal payment checkout and status routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPaymentsController), 'internal/payments');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPaymentsController.prototype.listEnabledGateways),
      'gateways',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalPaymentsController.prototype.listEnabledGateways),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPaymentsController.prototype.checkout),
      'checkout',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalPaymentsController.prototype.checkout),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPaymentsController.prototype.getStatus),
      ':paymentId',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalPaymentsController.prototype.getStatus),
      RequestMethod.GET,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalPaymentsController),
      [InternalAdminAuthGuard],
    );
  });

  it('delegates checkout and status calls unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new InternalPaymentsController(
      {
        checkout: async (input: unknown) => {
          calls.push(['checkout', input]);
          return { paymentId: 'payment-1' };
        },
        getPaymentStatus: async (input: unknown) => {
          calls.push(['status', input]);
          return { paymentId: 'payment-1', status: 'PENDING' };
        },
      } as never as PaymentsCheckoutService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    assert.deepStrictEqual(
      await controller.checkout({ userId: 'user-1' } as never),
      { paymentId: 'payment-1' },
    );
    assert.deepStrictEqual(
      await controller.getStatus('payment-1', 'user-1'),
      { paymentId: 'payment-1', status: 'PENDING' },
    );
    assert.deepStrictEqual(calls, [
      ['checkout', { userId: 'user-1' }],
      ['status', { paymentId: 'payment-1', userId: 'user-1', telegramId: undefined }],
    ]);
  });

  it('returns active channel-compatible gateways with default currency first', async () => {
    const controller = new InternalPaymentsController(
      {} as never,
      {} as never,
      {
        // `isConfigured` is part of the admin payload every row carries, and
        // the list now filters on it — an enabled gateway whose credentials
        // are incomplete cannot issue a checkout, so it is not offered. These
        // rows are all configured; that filter has its own coverage in
        // `gateway-offering-safety.spec.ts`.
        listGateways: async () => [
          { id: 'stars', type: PaymentGatewayType.TELEGRAM_STARS, currency: Currency.XTR, isActive: true, isConfigured: true, orderIndex: 1 },
          { id: 'rub', type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, isActive: true, isConfigured: true, orderIndex: 2 },
          { id: 'usd', type: PaymentGatewayType.HELEKET, currency: Currency.USD, isActive: true, isConfigured: true, orderIndex: 1 },
          { id: 'off', type: PaymentGatewayType.PLATEGA, currency: Currency.RUB, isActive: false, isConfigured: true, orderIndex: 0 },
        ],
      } as never,
      {} as never,
      {
        getInternalPlatformPolicy: async () => ({ defaultCurrency: Currency.RUB }),
      } as never,
    );

    assert.deepStrictEqual(await controller.listEnabledGateways('web'), [
      { id: 'rub', type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, orderIndex: 2 },
      { id: 'usd', type: PaymentGatewayType.HELEKET, currency: Currency.USD, orderIndex: 1 },
    ]);
  });
});
