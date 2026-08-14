import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminTwoFactorController } from '../src/modules/two-factor/controllers/admin-two-factor.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

const BASE = 'admin/2fa';

/**
 * `AdminTwoFactorController` is self-service: an admin turning the second
 * factor on or off for their OWN account. Every one of the five handlers takes
 * its subject from `@CurrentAdmin()` — which reads `request.user` and throws
 * 401 when passport did not populate it
 * (`src/modules/auth/decorators/current-admin.decorator.ts:18`) — and passes
 * `currentAdmin.id` to `TwoFactorService`. No handler accepts an admin id, a
 * login, or any other subject from the path, the query, or the body: the two
 * DTOs involved carry a single `code` string each and nothing else
 * (`src/modules/two-factor/dto/two-factor.dto.ts:3-15`).
 *
 * That is why there is no `@RequirePermission` here, and the reason is worth
 * stating rather than leaving to inference. RBAC answers "may this admin act on
 * that object". On these routes the object IS the acting admin, so the question
 * has no second party to ask about, and any permission put here would only
 * decide which roles are allowed to secure their own account — which reads
 * backwards: the roles most likely to be denied a permission are the ones whose
 * accounts most need a second factor.
 *
 * The shape is pinned from both ends, because each end fails differently:
 *
 *   - The guard list. `RbacGuard` is not global — the only `APP_GUARD`s in this
 *     tree are `BlockedIpGuard` and `AdminIpAllowlistGuard`
 *     (`src/app.module.ts:206,214`) — so nothing reads `REQUIRE_PERMISSION_KEY`
 *     on this controller. A `@RequirePermission` added tomorrow would be INERT
 *     while reading, to the next person, as protection. Asserting the guard
 *     list makes "someone added `RbacGuard` here" a visible decision.
 *   - The absence of the decorator, per route, via `assertRouteUngated`.
 *
 * If self-service stops being the intent, the fix is both edits together plus a
 * subject that is no longer `@CurrentAdmin` — not a decorator on its own.
 */
describe('AdminTwoFactorController self-service surface', () => {
  it('is behind admin JWT only — authenticated, never public, and outside RbacGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminTwoFactorController), BASE);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminTwoFactorController),
      [AdminJwtAuthGuard],
    );
    // The whole self-service argument rests on there being a logged-in admin to
    // BE the subject. `@Public()` on this class would remove `request.user`,
    // and `@CurrentAdmin()` would 401 on every route — the endpoints would not
    // become dangerous, they would become dead. Either way the premise of this
    // file would be false, so it is asserted rather than assumed. Note the
    // sibling module already mixes the two styles in one file: the passkey
    // controllers are a `@Public()` class and a guarded class sharing a base
    // path, so "this class is not the public one" is a real distinction here.
    assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, AdminTwoFactorController), undefined);
  });

  it('exposes exactly the five own-account 2FA routes, each ungated by intent', () => {
    // Closed set. A sixth route — say "disable 2FA for admin :id", the exact
    // endpoint the controller's own header comment promises not to add — cannot
    // appear without failing here first.
    assertRouteHandlers(AdminTwoFactorController, [
      'confirm',
      'disable',
      'enroll',
      'regenerateRecoveryCodes',
      'status',
    ]);

    const statusPath = 'status';
    const statusRoute = `${routeLabel(BASE, RequestMethod.GET, statusPath)} (read own 2FA status)`;
    assertRoute(
      AdminTwoFactorController.prototype.status,
      { method: RequestMethod.GET, path: statusPath },
      statusRoute,
    );
    assertRouteUngated(AdminTwoFactorController, AdminTwoFactorController.prototype.status, statusRoute);

    const enrollPath = 'enroll';
    const enrollRoute = `${routeLabel(BASE, RequestMethod.POST, enrollPath)} (begin own enrollment)`;
    assertRoute(
      AdminTwoFactorController.prototype.enroll,
      { method: RequestMethod.POST, path: enrollPath },
      enrollRoute,
    );
    assertRouteUngated(AdminTwoFactorController, AdminTwoFactorController.prototype.enroll, enrollRoute);

    const confirmPath = 'confirm';
    const confirmRoute = `${routeLabel(BASE, RequestMethod.POST, confirmPath)} (confirm own enrollment)`;
    assertRoute(
      AdminTwoFactorController.prototype.confirm,
      { method: RequestMethod.POST, path: confirmPath },
      confirmRoute,
    );
    assertRouteUngated(AdminTwoFactorController, AdminTwoFactorController.prototype.confirm, confirmRoute);

    // The sharp one. "Turn off the second factor" is the route a reviewer
    // expects to find gated, and it is not — correctly, because the account it
    // disarms is the caller's own and the call still has to present a valid
    // TOTP or recovery code (`two-factor.service.ts` `disable`). What would
    // make it dangerous is a target admin arriving in the body; `TwoFactorDisableDto`
    // has one field, `code`.
    const disablePath = 'disable';
    const disableRoute = `${routeLabel(BASE, RequestMethod.POST, disablePath)} (disable own 2FA)`;
    assertRoute(
      AdminTwoFactorController.prototype.disable,
      { method: RequestMethod.POST, path: disablePath },
      disableRoute,
    );
    assertRouteUngated(AdminTwoFactorController, AdminTwoFactorController.prototype.disable, disableRoute);

    const regeneratePath = 'recovery-codes/regenerate';
    const regenerateRoute = `${routeLabel(BASE, RequestMethod.POST, regeneratePath)} (reissue own recovery codes)`;
    assertRoute(
      AdminTwoFactorController.prototype.regenerateRecoveryCodes,
      { method: RequestMethod.POST, path: regeneratePath },
      regenerateRoute,
    );
    assertRouteUngated(
      AdminTwoFactorController,
      AdminTwoFactorController.prototype.regenerateRecoveryCodes,
      regenerateRoute,
    );

    // Last, and deliberately so. The assertions above name one route each and
    // fail with that route's label; this one fails with the SET, which is the
    // message worth having when a sixth route appears ungated. It also resolves
    // the permission the way `RbacGuard` does — handler over class — so a
    // `@RequirePermission` put on the CLASS is caught by the per-route
    // assertions above, on the routes it actually gates.
    assertEveryRouteGuarded(AdminTwoFactorController, [
      'confirm',
      'disable',
      'enroll',
      'regenerateRecoveryCodes',
      'status',
    ]);
  });
});
