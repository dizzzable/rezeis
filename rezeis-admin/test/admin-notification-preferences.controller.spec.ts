import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminNotificationPreferencesController } from '../src/modules/push/admin-notification-preferences.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

const BASE = 'admin/notifications/preferences';

/**
 * `AdminNotificationPreferencesController` is self-service: which notification
 * categories the calling admin wants delivered to themselves. Both handlers
 * take `@CurrentAdmin()` and pass the admin itself — not an id parsed from
 * anywhere — to the service, which reads and upserts on `adminId: admin.id`
 * (`src/modules/push/services/admin-notification-preferences.service.ts:39,66-67`).
 * The `PUT` body is `{ category, enabled }`: a category name and a boolean, no
 * subject.
 *
 * This one is ungated for a sharper reason than its neighbours, and getting it
 * wrong would be a regression rather than merely a redundancy. RBAC is already
 * enforced on these routes — PER CATEGORY, inside the service. `getForAdmin`
 * asks `rbacService.hasPermission(admin, def.resource, def.action)` for every
 * category and omits the ones the role does not hold (`:44-46`); `setForAdmin`
 * asks the same and throws `ForbiddenException` otherwise (`:61-63`). So the
 * list an admin sees is already the intersection of their role with the
 * catalogue.
 *
 * A route-level `@RequirePermission` cannot express that. It would have to name
 * ONE resource/action pair for a route whose whole job is to span many, and
 * whichever pair was chosen would deny the entire preferences screen to every
 * admin lacking it — including admins who legitimately hold three of the other
 * categories and would simply lose the ability to turn their own notifications
 * off. The correct gate is the one that is already there, one layer down and
 * per item.
 *
 * Pinned from both ends — the guard list and the per-route absence of the
 * decorator — because `RbacGuard` is not global (`src/app.module.ts:206,214`
 * register only `BlockedIpGuard` and `AdminIpAllowlistGuard`), so a
 * `@RequirePermission` added here tomorrow would be inert: it would read as the
 * controller's access control while the real, finer control sat unmentioned in
 * the service.
 */
describe('AdminNotificationPreferencesController self-service surface', () => {
  it('is behind admin JWT only — authenticated, never public, and outside RbacGuard', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminNotificationPreferencesController),
      BASE,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminNotificationPreferencesController),
      [AdminJwtAuthGuard],
    );
    // The per-category RBAC check that substitutes for a route gate takes the
    // admin's `role` and `rbacRoleId` from `@CurrentAdmin()`. `@Public()` would
    // leave no admin to check, so the finer gate described above would have
    // nothing to run on; the routes would 401 rather than leak, but the premise
    // of this file would be false. Asserted, not assumed.
    assert.equal(
      Reflect.getMetadata(IS_PUBLIC_KEY, AdminNotificationPreferencesController),
      undefined,
    );
  });

  it('exposes exactly the two own-preference routes, each ungated by intent', () => {
    // Closed set. A third route that took an admin id — "set preferences for
    // admin :id" — would be an administrative write on another account and
    // would need a real gate; it cannot appear without failing here first.
    assertRouteHandlers(AdminNotificationPreferencesController, ['list', 'update']);

    // Both are declared with a bare `@Get()` / `@Put()`, which Nest records as
    // `'/'` rather than `''` or `undefined`.
    const listRoute = `${routeLabel(BASE, RequestMethod.GET, '/')} (read own role-permitted categories)`;
    assertRoute(
      AdminNotificationPreferencesController.prototype.list,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRouteUngated(
      AdminNotificationPreferencesController,
      AdminNotificationPreferencesController.prototype.list,
      listRoute,
    );

    const updateRoute = `${routeLabel(BASE, RequestMethod.PUT, '/')} (toggle one own category)`;
    assertRoute(
      AdminNotificationPreferencesController.prototype.update,
      { method: RequestMethod.PUT, path: '/' },
      updateRoute,
    );
    assertRouteUngated(
      AdminNotificationPreferencesController,
      AdminNotificationPreferencesController.prototype.update,
      updateRoute,
    );

    // Fails with the SET rather than a single route's label — the message worth
    // having when a third route appears ungated.
    assertEveryRouteGuarded(AdminNotificationPreferencesController, ['list', 'update']);
  });
});
