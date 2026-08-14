import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { PasskeyProtectedController } from '../src/modules/oauth/controllers/passkey.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

const BASE = 'admin/passkey';

/**
 * `PasskeyProtectedController` is self-service: an admin registering, renaming
 * and removing passkeys on their OWN account. Every handler reads the subject
 * from `req.user` — populated by `AdminJwtAuthGuard`, never from the request
 * payload — and hands `admin.id` to `PasskeyService`.
 *
 * Two routes DO take a path parameter, and they are the ones worth being
 * careful about, since "delete a passkey by id" is exactly the shape an IDOR
 * takes. The `:id` is the OBJECT, not the subject, and the object is scoped to
 * the subject one layer down: both writes are `updateMany`/`deleteMany` with
 * `where: { id: passkeyId, adminUserId: adminId }`
 * (`src/modules/oauth/services/passkey.service.ts:295-308`). Another admin's
 * credential id therefore matches zero rows — it is not merely un-listed, it is
 * un-writable — and `listPasskeys` filters on `adminUserId` too (`:277-279`).
 * So the pair (subject from the token, object filtered by that subject) holds,
 * and there is no cross-account object for RBAC to arbitrate.
 *
 * That is why there is no `@RequirePermission` here. A permission on these
 * routes would decide which roles may manage their own login credentials, which
 * is not a question RBAC is for; and it would land on a controller whose guard
 * list has no `RbacGuard`, where nothing would read it.
 *
 * Pinned from both ends — the guard list and the absence of the decorator —
 * because `RbacGuard` is not global (`src/app.module.ts:206,214` register only
 * `BlockedIpGuard` and `AdminIpAllowlistGuard`), so a `@RequirePermission`
 * added here tomorrow would restrict no one while reading as protection.
 */
describe('PasskeyProtectedController self-service surface', () => {
  it('is the guarded twin, not the public one, and sits outside RbacGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, PasskeyProtectedController), BASE);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, PasskeyProtectedController),
      [AdminJwtAuthGuard],
    );
    // Not decoration. `PasskeyPublicController` in the same source file carries
    // `@Public()` on the SAME base path `admin/passkey` — the login-side
    // endpoints, deliberately unauthenticated. These two classes are one
    // careless copy-paste apart, and `@Public()` landing on this one would make
    // `req.user` undefined on all five handlers below: `req.user as { id: string }`
    // would yield undefined and the service would be asked for the passkeys of
    // nobody. The self-service claim in this file is only true while this class
    // is the authenticated one, so that is asserted, not assumed.
    assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, PasskeyProtectedController), undefined);
  });

  it('exposes exactly the five own-credential routes, each ungated by intent', () => {
    // Closed set. A sixth route — "list the passkeys of admin :id", or an
    // unscoped delete — cannot appear without failing here first.
    assertRouteHandlers(PasskeyProtectedController, [
      'deletePasskey',
      'getRegistrationOptions',
      'listPasskeys',
      'renamePasskey',
      'verifyRegistration',
    ]);

    const listPath = 'credentials';
    const listRoute = `${routeLabel(BASE, RequestMethod.GET, listPath)} (read own passkeys)`;
    assertRoute(
      PasskeyProtectedController.prototype.listPasskeys,
      { method: RequestMethod.GET, path: listPath },
      listRoute,
    );
    assertRouteUngated(
      PasskeyProtectedController,
      PasskeyProtectedController.prototype.listPasskeys,
      listRoute,
    );

    const optionsPath = 'register/options';
    const optionsRoute = `${routeLabel(BASE, RequestMethod.POST, optionsPath)} (begin own registration)`;
    assertRoute(
      PasskeyProtectedController.prototype.getRegistrationOptions,
      { method: RequestMethod.POST, path: optionsPath },
      optionsRoute,
    );
    assertRouteUngated(
      PasskeyProtectedController,
      PasskeyProtectedController.prototype.getRegistrationOptions,
      optionsRoute,
    );

    const verifyPath = 'register/verify';
    const verifyRoute = `${routeLabel(BASE, RequestMethod.POST, verifyPath)} (store own credential)`;
    assertRoute(
      PasskeyProtectedController.prototype.verifyRegistration,
      { method: RequestMethod.POST, path: verifyPath },
      verifyRoute,
    );
    assertRouteUngated(
      PasskeyProtectedController,
      PasskeyProtectedController.prototype.verifyRegistration,
      verifyRoute,
    );

    // The two `:id` routes. Ungated at the route level on the strength of the
    // owner-scoped `where` clauses cited in this file's header — the scoping is
    // the load-bearing part, and it lives in the service, so a refactor that
    // moves either write to `update`/`delete` by primary key alone would turn
    // both of these into cross-account operations WITHOUT changing anything
    // this spec can see. That trade is stated here so the next reader knows
    // where to look rather than trusting the route shape.
    const renamePath = 'credentials/:id';
    const renameRoute = `${routeLabel(BASE, RequestMethod.PATCH, renamePath)} (rename own passkey)`;
    assertRoute(
      PasskeyProtectedController.prototype.renamePasskey,
      { method: RequestMethod.PATCH, path: renamePath },
      renameRoute,
    );
    assertRouteUngated(
      PasskeyProtectedController,
      PasskeyProtectedController.prototype.renamePasskey,
      renameRoute,
    );

    const deletePath = 'credentials/:id';
    const deleteRoute = `${routeLabel(BASE, RequestMethod.DELETE, deletePath)} (delete own passkey)`;
    assertRoute(
      PasskeyProtectedController.prototype.deletePasskey,
      { method: RequestMethod.DELETE, path: deletePath },
      deleteRoute,
    );
    assertRouteUngated(
      PasskeyProtectedController,
      PasskeyProtectedController.prototype.deletePasskey,
      deleteRoute,
    );

    // Last, and deliberately so: this one fails with the SET rather than with a
    // single route's label, which is the message worth having when a sixth
    // route appears ungated.
    assertEveryRouteGuarded(PasskeyProtectedController, [
      'deletePasskey',
      'getRegistrationOptions',
      'listPasskeys',
      'renamePasskey',
      'verifyRegistration',
    ]);
  });
});
