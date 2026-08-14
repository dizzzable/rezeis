import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPushController } from '../src/modules/push/admin-push.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

const BASE = 'admin/push';

/**
 * `AdminPushController` is self-service: the browser on the admin's own desk
 * registering itself for web-push, and the admin sending themselves a test
 * notification. Three of the four handlers take `@CurrentAdmin()` and pass
 * `admin.id` to `WebPushService`; the subscription row is written with that id
 * (`subscribeAdmin`), the unsubscribe deletes on `{ adminId, endpoint }`
 * (`src/modules/push/services/web-push.service.ts:212-214`), and the test push
 * fans out only over `where: { adminId }` (`:233-235`). No handler accepts an
 * admin id from the path, the query or the body — the two body shapes carry a
 * `subscription` blob and an `endpoint` string respectively.
 *
 * The fourth, `getPublicKey`, has no subject at all, and it is worth being
 * exact rather than filing it under "self-service" with the others: it returns
 * the deployment's VAPID **public** key (`web-push.service.ts:115-118` reads
 * `config.publicKey`; the private half is only ever read into `vapidDetails`
 * for signing, `:121-125`). A public key that every subscribing browser
 * receives anyway is not an object anyone can be denied access to, so there is
 * likewise nothing for RBAC to arbitrate — for a different reason from its
 * three neighbours, which is why it is said out loud here.
 *
 * SCOPE OF THIS CLAIM. This file states where the SUBJECT comes from. It does
 * not certify that every object these routes touch is owned by that subject:
 * `subscribeAdmin` upserts on `where: { endpoint }` alone, and `endpoint` is
 * globally `@unique` (`prisma/schema.prisma:2343`), so the update branch
 * re-points an existing row at the caller. That is a real cross-admin edge and
 * it has been reported separately; it is a service-layer scoping fix, not a
 * route-gating one, and a `@RequirePermission` here would not close it.
 *
 * Pinned from both ends — guard list and per-route absence of the decorator —
 * because `RbacGuard` is not global (`src/app.module.ts:206,214` register only
 * `BlockedIpGuard` and `AdminIpAllowlistGuard`), so a `@RequirePermission`
 * added here tomorrow would restrict no one while reading as protection.
 */
describe('AdminPushController self-service surface', () => {
  it('is behind admin JWT only — authenticated, never public, and outside RbacGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPushController), BASE);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPushController),
      [AdminJwtAuthGuard],
    );
    // `@Public()` here would matter more than on the neighbouring self-service
    // controllers, and in the one direction that is easy to miss: this class
    // mirrors `InternalPushController`, whose whole difference is that
    // subscriptions bind to an admin rather than a user. Unauthenticated, the
    // three `@CurrentAdmin()` routes would 401 — but the shape of the mistake
    // is "somebody made the push endpoints reachable", which is worth failing
    // on rather than reasoning about.
    assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, AdminPushController), undefined);
  });

  it('exposes exactly the four own-device push routes, each ungated by intent', () => {
    // Closed set. A fifth route — "send a push to admin :id", which is a
    // broadcast primitive rather than self-service, or anything reading another
    // admin's subscriptions — cannot appear without failing here first.
    assertRouteHandlers(AdminPushController, [
      'getPublicKey',
      'sendTest',
      'subscribe',
      'unsubscribe',
    ]);

    const keyPath = 'public-key';
    const keyRoute = `${routeLabel(BASE, RequestMethod.GET, keyPath)} (read deployment VAPID public key)`;
    assertRoute(
      AdminPushController.prototype.getPublicKey,
      { method: RequestMethod.GET, path: keyPath },
      keyRoute,
    );
    assertRouteUngated(AdminPushController, AdminPushController.prototype.getPublicKey, keyRoute);

    const subscribePath = 'subscribe';
    const subscribeRoute = `${routeLabel(BASE, RequestMethod.POST, subscribePath)} (bind own browser)`;
    assertRoute(
      AdminPushController.prototype.subscribe,
      { method: RequestMethod.POST, path: subscribePath },
      subscribeRoute,
    );
    assertRouteUngated(AdminPushController, AdminPushController.prototype.subscribe, subscribeRoute);

    const unsubscribePath = 'unsubscribe';
    const unsubscribeRoute = `${routeLabel(BASE, RequestMethod.POST, unsubscribePath)} (release own browser)`;
    assertRoute(
      AdminPushController.prototype.unsubscribe,
      { method: RequestMethod.POST, path: unsubscribePath },
      unsubscribeRoute,
    );
    assertRouteUngated(
      AdminPushController,
      AdminPushController.prototype.unsubscribe,
      unsubscribeRoute,
    );

    // `POST admin/push/test` is the one that looks like it should be gated,
    // because "send a notification" usually is. It is not a send primitive:
    // the recipient is `admin.id` and the payload is a fixed string, so the
    // most an admin can do with it is notify their own devices.
    const testPath = 'test';
    const testRoute = `${routeLabel(BASE, RequestMethod.POST, testPath)} (self-addressed test push)`;
    assertRoute(
      AdminPushController.prototype.sendTest,
      { method: RequestMethod.POST, path: testPath },
      testRoute,
    );
    assertRouteUngated(AdminPushController, AdminPushController.prototype.sendTest, testRoute);

    // Fails with the SET rather than a single route's label — the message worth
    // having when a fifth route appears ungated.
    assertEveryRouteGuarded(AdminPushController, [
      'getPublicKey',
      'sendTest',
      'subscribe',
      'unsubscribe',
    ]);
  });
});
