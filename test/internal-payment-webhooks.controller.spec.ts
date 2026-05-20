import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PaymentGatewayType } from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPaymentWebhooksController } from '../src/modules/payments/controllers/internal-payment-webhooks.controller';
import { PaymentWebhookIngressService } from '../src/modules/payments/services/payment-webhook-ingress.service';

describe('InternalPaymentWebhooksController', () => {
  it('exposes the internal payments webhook route contract', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPaymentWebhooksController),
      'internal/payments/webhooks',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPaymentWebhooksController.prototype.ingest),
      ':gatewayType',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalPaymentWebhooksController.prototype.ingest),
      RequestMethod.POST,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalPaymentWebhooksController),
      [InternalAdminAuthGuard],
    );
  });

  it('delegates webhook ingress with signature verification disabled', async () => {
    const calls: unknown[] = [];
    const controller = new InternalPaymentWebhooksController({
      ingestWebhook: async (input: unknown) => {
        calls.push(input);
        return { accepted: true, duplicate: true, lifecycleStatus: 'ENQUEUED' };
      },
    } as never as PaymentWebhookIngressService);

    const rawBody = Buffer.from('{"status":"paid"}', 'utf8');
    const result = await controller.ingest(
      PaymentGatewayType.CRYPTOMUS,
      rawBody,
      {
        headers: { 'x-internal-api-key': 'secret' },
      } as never,
    );

    assert.deepStrictEqual(result, {
      accepted: true,
      duplicate: true,
      lifecycleStatus: 'ENQUEUED',
    });
    assert.deepStrictEqual(calls, [
      {
        gatewayType: PaymentGatewayType.CRYPTOMUS,
        rawBody,
        headers: { 'x-internal-api-key': 'secret' },
        clientIp: null,
        verifySignature: false,
      },
    ]);
  });
});
