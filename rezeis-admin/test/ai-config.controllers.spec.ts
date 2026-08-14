import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AiConfigModule } from '../src/modules/ai-config/ai-config.module';
import { AdminAiConfigController } from '../src/modules/ai-config/controllers/admin-ai-config.controller';
import { AdminAiInstructionController } from '../src/modules/ai-config/controllers/admin-ai-instruction.controller';
import { InternalAiConfigController } from '../src/modules/ai-config/controllers/internal-ai-config.controller';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEffectiveRoutePermission,
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
  type RouteHandler,
  type RoutePermission,
} from './helpers/controller-routes';

/**
 * The route contract for the three `ai-config` controllers.
 *
 * These three had no spec of any kind, and not because nobody got round to it.
 * Every file in `src/modules/ai-config/**` imported its neighbours WITH a `.js`
 * suffix — `from '../services/ai-config.service.js'`. `tsc` resolves that (it
 * substitutes the `.ts` extension) and the emitted `dist/` runs, because there
 * a real `.js` sits at that path. `ts-node` does not: resolution there is
 * Node's, which looks for a literal `ai-config.service.js` next to a file that
 * is `.ts`, and fails. The whole suite runs through `ts-node/register`, so a
 * spec that so much as imported one of these classes died on load. The module
 * was not under-tested; it was untestable, and silently so.
 *
 * That reached further than the module: `src/app.module.ts` registers
 * `AiConfigModule`, so `app.module.ts` itself would not load under the runner
 * either — no spec in this tree can bootstrap the real application graph while
 * that is true. The suffixes are gone as of this change, and the import list
 * above is what keeps them gone: put one back and this file stops loading.
 */

/** Both admin AI surfaces are gated as a whole on this single pair. */
const SETTINGS_EDIT: RoutePermission = { resource: 'settings', action: 'edit' };

const ADMIN_CONFIG_BASE = 'admin/ai-config';
const ADMIN_INSTRUCTION_BASE = 'admin/ai-instructions';
const INTERNAL_BASE = 'internal/ai-config';

/** One row of a controller's route table, as this spec states it. */
interface RouteContract {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  readonly path: string;
}

// `assertEffectiveRoutePermission` was written here first, and again in the
// broadcast spec, because the shared helper had no effective-permission
// assertion. It has one now, so this file uses it: both admin controllers below
// declare their gate once on the CLASS, where reading the handler alone finds
// nothing. What it catches is the sharp edge of that style — a handler-level
// `@RequirePermission` REPLACES the class one rather than adding to it, so
// decorating `getSettings` with `settings:view` tomorrow would WEAKEN it, and
// that reads in review like tightening.

describe('AiConfigModule wiring', () => {
  it('registers all three AI controllers', () => {
    // Loading this module at all is the regression guard for the `.js`
    // suffixes described above. What it asserts beyond that is cheap and worth
    // having: the per-controller tests below read metadata off imported
    // classes, which they would go on doing quite happily after a controller
    // was dropped from the module and stopped being routed at all.
    const controllers: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiConfigModule);
    assert.deepStrictEqual(controllers, [
      AdminAiConfigController,
      AdminAiInstructionController,
      InternalAiConfigController,
    ]);
  });
});

describe('AdminAiConfigController', () => {
  it('exposes the AI provider-config routes behind settings:edit', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminAiConfigController), ADMIN_CONFIG_BASE);
    // Both guards, in this order. `RbacGuard` being present is what makes every
    // permission assertion below mean anything: drop it from the list and the
    // class-level `@RequirePermission` is still there, still reads as a gate,
    // and enforces nothing.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminAiConfigController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
    assertRouteHandlers(AdminAiConfigController, [
      'fetchModels',
      'getSettings',
      'learnFromTickets',
      'testConnection',
      'updateSettings',
    ]);

    const routes: readonly RouteContract[] = [
      {
        handler: AdminAiConfigController.prototype.getSettings,
        method: RequestMethod.GET,
        path: '/',
      },
      {
        handler: AdminAiConfigController.prototype.updateSettings,
        method: RequestMethod.PATCH,
        path: '/',
      },
      {
        handler: AdminAiConfigController.prototype.testConnection,
        method: RequestMethod.POST,
        path: 'test',
      },
      {
        handler: AdminAiConfigController.prototype.fetchModels,
        method: RequestMethod.GET,
        path: 'models',
      },
      {
        handler: AdminAiConfigController.prototype.learnFromTickets,
        method: RequestMethod.POST,
        path: 'learn-from-tickets',
      },
    ];
    for (const route of routes) {
      const label = routeLabel(ADMIN_CONFIG_BASE, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertEffectiveRoutePermission(
        AdminAiConfigController,
        route.handler,
        [SETTINGS_EDIT],
        label,
      );
    }
    // The rows above say what each LISTED route costs; this says no route on
    // the class escaped having a cost at all. Distinct checks: the enumeration
    // forces a new route to be noticed, but is satisfied by adding a name to
    // it, whereas an undecorated route is one `RbacGuard` waves straight
    // through (`src/modules/rbac/guards/rbac.guard.ts:41`). On this controller
    // that would mean rewriting the provider base URL and API key, or firing
    // `learn-from-tickets` across closed support transcripts, on nothing
    // stronger than "is signed in". Empty list: nothing here is exempt.
    assertEveryRouteGuarded(AdminAiConfigController, []);
  });

  it('names a permission the RBAC catalog actually defines', () => {
    // `@RequirePermission` types the action but takes the resource as a bare
    // `string`, so `'setttings'` would compile. It would not open the route —
    // `RbacService.hasPermission` looks the token up in the granted set and a
    // typo simply never matches, locking every non-DEV admin out of the AI
    // screens — but it would fail as a puzzling 403 rather than as a build
    // error. Pinning the pair keeps the gate's name real.
    assert.equal(isValidPermission(SETTINGS_EDIT.resource, SETTINGS_EDIT.action), true);
  });
});

describe('AdminAiInstructionController', () => {
  it('exposes the AI instruction CRUD routes behind settings:edit', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminAiInstructionController),
      ADMIN_INSTRUCTION_BASE,
    );
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminAiInstructionController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
    assertRouteHandlers(AdminAiInstructionController, ['create', 'delete', 'listAll', 'update']);

    const routes: readonly RouteContract[] = [
      {
        handler: AdminAiInstructionController.prototype.listAll,
        method: RequestMethod.GET,
        path: '/',
      },
      {
        handler: AdminAiInstructionController.prototype.create,
        method: RequestMethod.POST,
        path: '/',
      },
      {
        handler: AdminAiInstructionController.prototype.update,
        method: RequestMethod.PATCH,
        path: ':id',
      },
      {
        handler: AdminAiInstructionController.prototype.delete,
        method: RequestMethod.DELETE,
        path: ':id',
      },
    ];
    for (const route of routes) {
      const label = routeLabel(ADMIN_INSTRUCTION_BASE, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertEffectiveRoutePermission(
        AdminAiInstructionController,
        route.handler,
        [SETTINGS_EDIT],
        label,
      );
    }
    // Instructions are the text the support assistant answers users with, and
    // this controller can create, rewrite and delete them. An ungated route
    // here is an unauthenticated-in-practice edit of what the bot says.
    assertEveryRouteGuarded(AdminAiInstructionController, []);
  });
});

describe('InternalAiConfigController', () => {
  it('serves the internal reads behind the internal guard, with no RBAC gate', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalAiConfigController), INTERNAL_BASE);
    // `InternalAdminAuthGuard` ALONE — deliberately. This surface is the
    // trusted BFF, not an admin session, and `GET internal/ai-config/settings`
    // returns `AiConfigService.getSettings()`: the settings with the provider
    // API key DECRYPTED, the value the admin controller is careful to mask
    // before it can reach a browser. So the guard list is pinned from both
    // ends. Adding `RbacGuard` here would put a caller with no admin identity
    // through a permission check, and the pair below pins the other end: with
    // `RbacGuard` absent, a `@RequirePermission` added to one of these handlers
    // would be INERT — nothing reads the metadata — while reading, to the next
    // person, as protection over the one route in this module that hands out a
    // live secret.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalAiConfigController), [
      InternalAdminAuthGuard,
    ]);
    assertRouteHandlers(InternalAiConfigController, ['getPublicInstructions', 'getSettings']);

    const routes: readonly RouteContract[] = [
      {
        handler: InternalAiConfigController.prototype.getSettings,
        method: RequestMethod.GET,
        path: 'settings',
      },
      {
        handler: InternalAiConfigController.prototype.getPublicInstructions,
        method: RequestMethod.GET,
        path: 'instructions',
      },
    ];
    for (const route of routes) {
      const label = routeLabel(INTERNAL_BASE, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertRouteUngated(InternalAiConfigController, route.handler, label);
    }
  });
});

/**
 * Note for whoever owns `test/helpers/controller-routes.ts`:
 * `assertEffectiveRoutePermission` above is the assertion the helper is missing.
 * The helper exports `effectiveRoutePermissions` and documents that 29
 * controllers in this tree gate on the CLASS, but the only permission assertion
 * it offers — `assertRoutePermission` — reads the handler alone and therefore
 * cannot describe any of them. Promoting this function into the helper would
 * stop the next class-gated controller's spec from growing its own copy, which
 * is the exact failure the helper's own header records.
 */
