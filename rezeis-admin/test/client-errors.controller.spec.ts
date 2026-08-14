import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { ClientErrorsController } from '../src/modules/client-errors/client-errors.controller';
import {
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/client-errors';

/**
 * The SPA crash reporter stays open to every authenticated admin, deliberately.
 *
 * `client-logger.ts` POSTs here from `window.error`, `unhandledrejection` and
 * the React error boundary, for every admin, on every unhandled failure. A
 * permission on this route would silence crash reporting for exactly the roles
 * that lack it — and it would do so at the worst possible moment, because the
 * only time this endpoint is called is when the panel is already broken. The
 * operator would lose visibility into a failure precisely for the users hitting
 * it, and see nothing at all: `send()` swallows every error by design, so the
 * 403s would not even surface in the UI.
 *
 * The usual reason to gate a write does not apply. The route reads nothing, and
 * it cannot be used to forge attribution: the handler stamps `admin.id` and
 * `admin.login` from the authenticated principal, not from the body. Every
 * field is length-bounded by `class-validator`, `source` is an `@IsIn`
 * allowlist, and the client redacts tokens, emails and query strings before
 * sending. The residual abuse — an authenticated admin writing noise into the
 * event bus, made cheap by `@SkipThrottle()` — is a rate-limiting question and
 * would not be fixed by an RBAC permission.
 */
describe('ClientErrorsController', () => {
  it('is guarded by the admin JWT alone', () => {
    // `RbacGuard` is absent on purpose. With no permission for it to read it
    // would enforce nothing, and a guard in the list is how the next reader
    // concludes a controller is access-controlled.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, ClientErrorsController), [
      AdminJwtAuthGuard,
    ]);
  });

  it('exposes the single report route, intentionally ungated', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, ClientErrorsController), BASE_PATH);
    // Read off the class: a READ route added here — "list recent client
    // errors" — would be a genuine operator surface over other admins' crash
    // payloads and must not inherit this file's write-only reasoning.
    assertRouteHandlers(ClientErrorsController, ['report']);

    const label = routeLabel(BASE_PATH, RequestMethod.POST, '/');
    assertRoute(
      ClientErrorsController.prototype.report,
      { method: RequestMethod.POST, path: '/' },
      label,
    );
    assertRouteUngated(ClientErrorsController, ClientErrorsController.prototype.report, label);
  });
});
