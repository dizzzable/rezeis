import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentWebhooksController } from '../src/modules/payments/controllers/admin-payment-webhooks.controller';
import { PaymentWebhookOpsService } from '../src/modules/payments/services/payment-webhook-ops.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/payments/webhooks/events';

describe('AdminPaymentWebhooksController', () => {
  it('exposes webhook ops admin routes', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentWebhooksController),
      BASE_PATH,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentWebhooksController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    // Read off the class instead of remembered here: these routes replay
    // provider callbacks and reveal raw payloads, and a fourth one added later
    // — a bulk replay, a purge — would otherwise inherit this test's blessing
    // without ever being looked at.
    assertRouteHandlers(AdminPaymentWebhooksController, [
      'listEvents',
      'getEventDetail',
      'replayEvent',
    ]);

    const listRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (list events)`;
    assertRoute(
      AdminPaymentWebhooksController.prototype.listEvents,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminPaymentWebhooksController.prototype.listEvents,
      { resource: 'payment_webhooks', action: 'view' },
      listRoute,
    );

    const detailRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, ':eventId')} (event detail)`;
    assertRoute(
      AdminPaymentWebhooksController.prototype.getEventDetail,
      { method: RequestMethod.GET, path: ':eventId' },
      detailRoute,
    );
    assertRoutePermission(
      AdminPaymentWebhooksController.prototype.getEventDetail,
      { resource: 'payment_webhooks', action: 'resolve' },
      detailRoute,
    );

    const replayRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, ':eventId/replay')} (replay event)`;
    assertRoute(
      AdminPaymentWebhooksController.prototype.replayEvent,
      { method: RequestMethod.POST, path: ':eventId/replay' },
      replayRoute,
    );
    assertRoutePermission(
      AdminPaymentWebhooksController.prototype.replayEvent,
      { resource: 'payment_webhooks', action: 'run' },
      replayRoute,
    );
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The two are not the same check: the
    // enumeration forces a new route to be noticed, but it is satisfied by
    // adding a name to it — and a route that never gets a row here is one
    // `RbacGuard` waves through (`rbac.guard.ts:41`), open to any signed-in
    // admin rather than refused. On this controller that is raw provider
    // payloads and the replay trigger. No route here is exempt, hence no list.
    assertEveryRouteGuarded(AdminPaymentWebhooksController);
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
        buildWebhookOpsRequest(),
      ),
      { id: 'event-1', rawPayload: null },
    );
    assert.deepStrictEqual(
      await controller.replayEvent(
        '4f49b8c6-a8e6-42f2-8de8-eacdcbf6ed50',
        { reason: 'manual retry', force: true } as never,
        { id: 'admin-1' } as never,
        buildWebhookOpsRequest(),
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

/**
 * The request both audited routes receive.
 *
 * `req.ip` (trust-proxy resolved) is the only trusted source; a spoofable
 * X-Forwarded-For is deliberately ignored. It carries a DIFFERENT address on
 * purpose, so the `remoteAddress` assertions above fail the moment anyone
 * starts trusting the header again — without it the comment claimed a rule the
 * test never exercised.
 *
 * Typed as a `Pick` and widened once (a whole Express request cannot be built
 * here) so a renamed or retyped member still breaks this file.
 */
function buildWebhookOpsRequest(): Request {
  const request: Pick<Request, 'headers' | 'ip'> = {
    headers: {
      'x-request-id': 'request-1',
      'x-forwarded-for': '198.51.100.9',
    },
    ip: '203.0.113.10',
  };
  return request as Request;
}
