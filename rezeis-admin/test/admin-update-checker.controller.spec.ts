import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import {
  AdminUpdateCheckerController,
  InternalUpdateCheckerController,
} from '../src/modules/update-checker/controllers/admin-update-checker.controller';
import {
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
  type RouteHandler,
} from './helpers/controller-routes';

const ADMIN_BASE_PATH = 'admin/update-checker';
const INTERNAL_BASE_PATH = 'internal/system';

/** An update-checker route as this spec states it. */
interface UpdateCheckerRoute {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  readonly path: string;
}

/**
 * Both admin routes stay gated on the admin JWT alone, deliberately.
 *
 * What they return is the panel's own `package.json` version, the latest tag
 * from a public GitHub releases endpoint, and reiwa's reported version. None of
 * it is operator data; the GitHub half is world-readable without any token.
 *
 * What decides it is where the caller sits: `UpdateBanner` is rendered
 * unconditionally in `admin-shell.tsx` and `UpdateIndicator` unconditionally in
 * `admin-topbar.tsx`, so `GET status` fires for EVERY signed-in admin on every
 * shell mount. A permission no default role holds would put a 403 in the
 * top bar of `operator`, `support` and `finance` sessions in exchange for
 * hiding a public version number.
 *
 * `POST refresh` is the one with a real cost — it bypasses the one-hour cache
 * and forces an outbound call, and GitHub rate-limits unauthenticated requests
 * per IP. That is a rate-limiting concern, not an authorization one:
 * `safeCheck` never throws and a burnt rate limit degrades to a cached result
 * with an error string. Recorded here rather than fixed with a permission that
 * would also take the banner away.
 */
describe('AdminUpdateCheckerController', () => {
  it('is guarded by the admin JWT alone', () => {
    // No `RbacGuard`: with no permission on any route it would read nothing,
    // and wiring that enforces nothing is worse than none — it looks like a
    // gate to whoever opens the file next.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminUpdateCheckerController), [
      AdminJwtAuthGuard,
    ]);
  });

  it('exposes two shell-chrome routes, both intentionally ungated', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminUpdateCheckerController), ADMIN_BASE_PATH);
    // A third route here would not be a version read — it would be something
    // like "apply the update", which must not inherit this file's reasoning by
    // silence.
    assertRouteHandlers(AdminUpdateCheckerController, ['getStatus', 'refresh']);

    const routes: readonly UpdateCheckerRoute[] = [
      {
        handler: AdminUpdateCheckerController.prototype.getStatus,
        method: RequestMethod.GET,
        path: 'status',
      },
      {
        handler: AdminUpdateCheckerController.prototype.refresh,
        method: RequestMethod.POST,
        path: 'refresh',
      },
    ];

    for (const route of routes) {
      const label = routeLabel(ADMIN_BASE_PATH, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertRouteUngated(AdminUpdateCheckerController, route.handler, label);
    }
  });
});

/**
 * The reiwa heartbeat is not an admin surface at all: it sits behind
 * `InternalAdminAuthGuard`, the API-token guard every `internal/*` route uses.
 * `RbacGuard` never runs on it, so a `@RequirePermission` added here would
 * restrict nobody while reading as protection — exactly the case
 * `assertRouteUngated` exists to pin down.
 */
describe('InternalUpdateCheckerController', () => {
  it('is guarded by the internal API-token guard', () => {
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalUpdateCheckerController), [
      InternalAdminAuthGuard,
    ]);
  });

  it('exposes the version heartbeat, intentionally ungated', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalUpdateCheckerController),
      INTERNAL_BASE_PATH,
    );
    assertRouteHandlers(InternalUpdateCheckerController, ['reportReiwaVersion']);

    const label = routeLabel(INTERNAL_BASE_PATH, RequestMethod.POST, 'reiwa-version');
    assertRoute(
      InternalUpdateCheckerController.prototype.reportReiwaVersion,
      { method: RequestMethod.POST, path: 'reiwa-version' },
      label,
    );
    assertRouteUngated(
      InternalUpdateCheckerController,
      InternalUpdateCheckerController.prototype.reportReiwaVersion,
      label,
    );
  });
});
