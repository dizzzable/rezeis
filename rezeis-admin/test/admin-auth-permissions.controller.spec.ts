import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminAuthPermissionsController } from '../src/modules/rbac/controllers/admin-auth-permissions.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

const BASE = 'admin/auth';

/**
 * `GET admin/auth/permissions` answers "what may I do", not "what may that
 * admin do", and the distinction is the whole reason this controller may stay
 * ungated. The handler takes `@CurrentAdmin()` and forwards exactly three
 * fields of it — `id`, `role`, `rbacRoleId` — to
 * `RbacService.getEffectivePermissions`. There is no path, query or body
 * parameter on the route at all, so there is nothing an admin could send to be
 * told somebody else's permission set.
 *
 * Gating it would also be self-defeating in a way worth writing down: the
 * frontend's `usePermissionStore` calls this once per session to learn which
 * navigation and controls to render. A permission requirement on the route that
 * REPORTS permissions is a bootstrap cycle — an admin whose role lacks it gets
 * a 403 and a UI that believes it may do nothing, which is indistinguishable
 * from a broken session. The response also carries `mustChangePassword`, the
 * flag that forces the password-change screen; denying it would leave the admin
 * silently un-prompted.
 *
 * Pinned from both ends. `RbacGuard` is not among this controller's guards and
 * is not global (`src/app.module.ts:206,214` register only `BlockedIpGuard` and
 * `AdminIpAllowlistGuard`), so a `@RequirePermission` added here would be inert
 * — and inert on the one endpoint whose answer the whole permission UI is built
 * from, which is the worst place in the tree for a decorator that reads as
 * protection and is not.
 */
describe('AdminAuthPermissionsController self-service surface', () => {
  it('is behind admin JWT only — authenticated, never public, and outside RbacGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminAuthPermissionsController), BASE);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminAuthPermissionsController),
      [AdminJwtAuthGuard],
    );
    // `@Public()` here would be a disclosure, not a dead route: the handler
    // would 401 inside `@CurrentAdmin()` rather than leak, but the endpoint
    // would stop being the authenticated read the frontend depends on. The
    // premise of this file is that a logged-in admin is the subject; asserted,
    // not assumed.
    assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, AdminAuthPermissionsController), undefined);
  });

  it('exposes exactly the own-permissions read, ungated by intent', () => {
    // Closed set of one. This is where the dangerous sibling would appear:
    // `GET admin/auth/permissions/:adminId`, or anything else that names a
    // subject, is a different question — "what may THAT admin do" is an
    // administrative read of another account, and it belongs behind an
    // `admins`-style permission with `RbacGuard` actually in the guard list.
    // It cannot be added here without failing this line first.
    assertRouteHandlers(AdminAuthPermissionsController, ['getPermissions']);

    const permissionsPath = 'permissions';
    const permissionsRoute = `${routeLabel(BASE, RequestMethod.GET, permissionsPath)} (read own effective permissions)`;
    assertRoute(
      AdminAuthPermissionsController.prototype.getPermissions,
      { method: RequestMethod.GET, path: permissionsPath },
      permissionsRoute,
    );
    assertRouteUngated(
      AdminAuthPermissionsController,
      AdminAuthPermissionsController.prototype.getPermissions,
      permissionsRoute,
    );

    // Fails with the SET rather than the single label — the message worth
    // having when a second route appears here ungated.
    assertEveryRouteGuarded(AdminAuthPermissionsController, ['getPermissions']);
  });
});
