import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PaymentGatewayType } from '@prisma/client';

import { paymentsConfig } from '../src/common/config/payments.config';
import { PublicPaymentWebhooksController } from '../src/modules/payments/controllers/public-payment-webhooks.controller';
import { PaymentWebhookIngressService } from '../src/modules/payments/services/payment-webhook-ingress.service';
import { TelegramStarsWebhookService } from '../src/modules/payments/services/telegram-stars-webhook.service';

describe('PublicPaymentWebhooksController', () => {
  it('exposes the public payments webhook route contract', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, PublicPaymentWebhooksController),
      'v1/payments/webhooks',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, PublicPaymentWebhooksController.prototype.ingest),
      ':gatewayType',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, PublicPaymentWebhooksController.prototype.ingest),
      RequestMethod.POST,
    );
    assert.equal(Reflect.getMetadata(GUARDS_METADATA, PublicPaymentWebhooksController), undefined);
  });

  it('ignores a client-supplied X-Forwarded-For value when resolving the source IP', async () => {
    const calls: unknown[] = [];
    const controller = new PublicPaymentWebhooksController(
      {
        ingestWebhook: async (input: unknown) => {
          calls.push(input);
          return { accepted: true, duplicate: false, lifecycleStatus: 'ENQUEUED' };
        },
      } as never as PaymentWebhookIngressService,
      {
        handleTelegramUpdate: async () => null,
      } as never as TelegramStarsWebhookService,
      paymentsConfig() as never,
    );

    const rawBody = Buffer.from('{"status":"paid"}', 'utf8');
    const result = await controller.ingest(PaymentGatewayType.YOOKASSA, rawBody, {
      headers: { 'x-forwarded-for': '185.71.76.1' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as never);

    assert.deepStrictEqual(result, {
      accepted: true,
      duplicate: false,
      lifecycleStatus: 'ENQUEUED',
    });
    assert.deepStrictEqual(calls, [
      {
        gatewayType: PaymentGatewayType.YOOKASSA,
        rawBody,
        headers: { 'x-forwarded-for': '185.71.76.1' },
        clientIp: '127.0.0.1',
        verifySignature: true,
      },
    ]);
  });
});
