import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminThemePresetsController } from '../src/modules/theme-presets/controllers/admin-theme-presets.controller';
import { SYSTEM_ROLES } from '../src/modules/rbac/rbac.resources';
import {
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
  type RouteHandler,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/theme-presets';

/** A theme-preset route as this spec states it. */
interface ThemePresetRoute {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  readonly path: string;
}

/**
 * Every route here is per-admin self-service, and that is why none of them
 * carries a `@RequirePermission` — a decision, not an omission.
 *
 * The audit that produced this spec flagged the controller on the formal
 * ground that it sits behind `AdminJwtAuthGuard` with no permission. Read
 * against what the routes actually do, gating them would remove a feature
 * without closing anything:
 *
 *   - `active-prefs` (GET + PUT) is the admin's OWN appearance selection,
 *     scoped by `currentAdmin.id` in `ThemePresetsService`. It is mounted for
 *     every admin in the authenticated shell by `useAppearanceSync`, which
 *     retries with exponential backoff on failure and never gives up
 *     (`appearance-sync.ts` — a failed GET leaves `remoteLoadSettled` false).
 *     A gate no default role holds would turn that into a permanent background
 *     403 loop for `operator`, `support` and `finance`, plus a silently
 *     unsaveable dark-mode toggle. That is the "broken interface instead of an
 *     honest no-access" failure in its least visible form.
 *   - The preset CRUD is owner-scoped too: `listPresets` returns own + shared,
 *     `createPreset` writes `ownerId: currentAdmin.id`, and `updatePreset` /
 *     `deletePreset` both go through `findOwnedPreset`, which throws
 *     `ForbiddenException` for a non-owner. No route can read or mutate another
 *     admin's preset, so an RBAC gate adds no isolation the service does not
 *     already enforce.
 *
 * The candidate permission would have been `appearance:view` / `appearance:edit`
 * — held by NO default role except `superadmin` (asserted below). Applying it
 * would have cost three of the four seeded roles their saved themes and their
 * cross-device appearance sync, and bought nothing.
 *
 * What this spec is for: `assertRouteUngated` fails the moment someone adds a
 * `@RequirePermission` to any of these routes, so the decision has to be
 * re-argued rather than drifted into.
 */
describe('AdminThemePresetsController', () => {
  it('is guarded by the admin JWT alone', () => {
    // `RbacGuard` is deliberately ABSENT. Adding it would be inert — no route
    // here declares a permission for it to read — and inert security wiring
    // reads to the next person as protection that exists.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminThemePresetsController), [
      AdminJwtAuthGuard,
    ]);
  });

  it('exposes six self-service routes, every one of them intentionally ungated', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminThemePresetsController), BASE_PATH);
    // Read off the class, so a seventh route — one that reaches across admins,
    // say a "copy a colleague's preset" or an operator-wide default — fails
    // here instead of inheriting this file's blanket "all self-service" claim.
    assertRouteHandlers(AdminThemePresetsController, [
      'create',
      'delete',
      'getActivePrefs',
      'list',
      'saveActivePrefs',
      'update',
    ]);

    const routes: readonly ThemePresetRoute[] = [
      {
        handler: AdminThemePresetsController.prototype.list,
        method: RequestMethod.GET,
        path: '/',
      },
      {
        handler: AdminThemePresetsController.prototype.getActivePrefs,
        method: RequestMethod.GET,
        path: 'active-prefs',
      },
      {
        handler: AdminThemePresetsController.prototype.saveActivePrefs,
        method: RequestMethod.PUT,
        path: 'active-prefs',
      },
      {
        handler: AdminThemePresetsController.prototype.create,
        method: RequestMethod.POST,
        path: '/',
      },
      {
        handler: AdminThemePresetsController.prototype.update,
        method: RequestMethod.PATCH,
        path: ':id',
      },
      {
        handler: AdminThemePresetsController.prototype.delete,
        method: RequestMethod.DELETE,
        path: ':id',
      },
    ];

    for (const route of routes) {
      const label = routeLabel(BASE_PATH, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertRouteUngated(AdminThemePresetsController, route.handler, label);
    }
  });

  it('records that appearance:* would have excluded every default role but superadmin', () => {
    // The reason this controller stays open, stated as an assertion rather than
    // as prose that nobody re-checks. If a future seed grants `appearance` to
    // `operator`, the cost calculation above changes and this line says so.
    const holders = SYSTEM_ROLES.filter((seed) =>
      seed.permissions.some((p) => p.resource === 'appearance'),
    ).map((seed) => seed.name);
    assert.deepStrictEqual(
      holders,
      [],
      'a default system role now holds an `appearance` permission — gating this controller on it ' +
        'no longer costs that role its saved themes, so the "leave it open" decision recorded ' +
        'here should be revisited',
    );
  });
});
