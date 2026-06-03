import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentWebhooksController } from '../src/modules/payments/controllers/admin-payment-webhooks.controller';
import { PaymentWebhookOpsService } from '../src/modules/payments/services/payment-webhook-ops.service';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

describe('AdminPaymentWebhooksController', () => {
  it('exposes webhook ops admin routes', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentWebhooksController),
      'admin/payments/webhooks/events',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentWebhooksController.prototype.listEvents),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPaymentWebhooksController.prototype.listEvents),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentWebhooksController.prototype.getEventDetail),
      ':eventId',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentWebhooksController.prototype.replayEvent),
      ':eventId/replay',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentWebhooksController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    assertRoute(AdminPaymentWebhooksController.prototype.listEvents, '/', RequestMethod.GET, 'view');
    assertRoute(AdminPaymentWebhooksController.prototype.getEventDetail, ':eventId', RequestMethod.GET, 'resolve');
    assertRoute(AdminPaymentWebhooksController.prototype.replayEvent, ':eventId/replay', RequestMethod.POST, 'run');
  });

  it('delegates list/detail/replay calls unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new AdminPaymentWebhooksController({
      listEvents: async (query: unknown) => {
        calls.push(['list', query]);
        return [{ id: 'event-1' }];
      },
      getEventDetail: async (input: unknown) => {
        calls.push(['detail', input]);
        return { id: 'event-1', rawPayload: null };
      },
      replayEvent: async (input: unknown) => {
        calls.push(['replay', input]);
        return { alreadyQueued: false, event: { id: 'event-1' } };
      },
      auditPayloadReveal: async (input: unknown) => {
        calls.push(['audit', input]);
      },
    } as never as PaymentWebhookOpsService);

    assert.deepStrictEqual(await controller.listEvents({ gatewayType: 'YOOKASSA' } as never), [
      { id: 'event-1' },
    ]);
    assert.deepStrictEqual(
      await controller.getEventDetail(
        '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
        { includeRaw: true } as never,
        { id: 'admin-1' } as never,
        {
          headers: { 'x-request-id': 'request-1', 'x-forwarded-for': '203.0.113.10' },
          ip: '127.0.0.1',
        } as never,
      ),
      { id: 'event-1', rawPayload: null },
    );
    assert.deepStrictEqual(
      await controller.replayEvent(
        '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
        { reason: 'manual retry', force: true } as never,
        { id: 'admin-1' } as never,
        {
          headers: { 'x-request-id': 'request-1', 'x-forwarded-for': '203.0.113.10' },
          ip: '127.0.0.1',
        } as never,
      ),
      { alreadyQueued: false, event: { id: 'event-1' } },
    );
    assert.deepStrictEqual(calls, [
      ['list', { gatewayType: 'YOOKASSA' }],
      [
        'audit',
        {
          eventId: '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
          currentAdmin: { id: 'admin-1' },
          requestMetadata: {
            requestId: 'request-1',
            remoteAddress: '203.0.113.10',
            userAgent: null,
          },
        },
      ],
      [
        'detail',
        {
          eventId: '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
          includeRaw: true,
        },
      ],
      [
        'replay',
        {
          eventId: '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
          reason: 'manual retry',
          force: true,
          currentAdmin: { id: 'admin-1' },
          requestMetadata: {
            requestId: 'request-1',
            remoteAddress: '203.0.113.10',
            userAgent: null,
          },
        },
      ],
    ]);
  });
});

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'payment_webhooks', action },
  ]);
}
