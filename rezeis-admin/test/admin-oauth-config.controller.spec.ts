import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthProviderType } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import {
  OAuthConfigController,
  OAuthLinksController,
} from '../src/modules/oauth/controllers/admin-oauth.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  assertRouteUngated,
} from './helpers/controller-routes';

describe('OAuthConfigController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, OAuthConfigController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps OAuth provider config routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OAuthConfigController), 'admin/oauth/config');
    // Only this controller is enumerated here — its two siblings in the same
    // source file are deliberately ungated. `OAuthPublicController` is `@Public()`
    // and out of scope; `OAuthLinksController` now has its own test below,
    // because "deliberately ungated" was a claim in a comment and is now an
    // assertion. Within this class the set is closed: a third config route,
    // e.g. a provider delete or a secret reveal, cannot appear without failing
    // here first.
    assertRouteHandlers(OAuthConfigController, ['getAllConfigs', 'updateConfig']);
    // Closed is not the same as gated. A third route added here would fail the
    // line above, but only because it is unexpected — nothing so far requires
    // it to carry a permission, and `RbacGuard` waves an undecorated route
    // through (`src/modules/rbac/guards/rbac.guard.ts:41`). On this controller
    // that would mean writing OAuth provider credentials with no check beyond
    // "is logged in". Empty list: both routes are gated, and unlike the
    // 29 controllers in this tree that declare their permission on the class,
    // this one declares both on the handlers — asserted individually below.
    assertEveryRouteGuarded(OAuthConfigController, []);

    const listRoute = 'GET admin/oauth/config (read provider configs)';
    assertRoute(
      OAuthConfigController.prototype.getAllConfigs,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      OAuthConfigController.prototype.getAllConfigs,
      { resource: 'auth_providers', action: 'view' },
      listRoute,
    );

    const updateRoute = 'PUT admin/oauth/config/:type (write provider config)';
    assertRoute(
      OAuthConfigController.prototype.updateConfig,
      { method: RequestMethod.PUT, path: ':type' },
      updateRoute,
    );
    assertRoutePermission(
      OAuthConfigController.prototype.updateConfig,
      { resource: 'auth_providers', action: 'edit' },
      updateRoute,
    );
  });

  /**
   * `OAuthLinksController` (same source file, ~lines 155-181) is the admin's
   * own linked-account surface: read the providers linked to *your* account,
   * unlink one from *your* account. Both handlers take the subject from
   * `req.user.id` — there is no path or body parameter naming another admin —
   * so the RBAC question "may this admin act on that object" has no object to
   * ask about. Hence `@UseGuards(AdminJwtAuthGuard)` alone, with no `RbacGuard`
   * and no permission on either route. That reading is plausible but was
   * nowhere written down, and it has a sharp edge: because `RbacGuard` is not
   * in the guard list, a `@RequirePermission` added to one of these handlers
   * tomorrow would be INERT — nothing reads the metadata — while reading, to
   * the next person, as protection. So the shape is pinned from both ends: the
   * guard list (adding `RbacGuard` fails here), and the absence of the
   * decorator (adding one fails here). If self-service stops being the intent,
   * the fix is both edits together, not a decorator on its own.
   */
  it('leaves the admin self-service link routes ungated, and outside RbacGuard entirely', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OAuthLinksController), 'admin/oauth/links');
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, OAuthLinksController),
      [AdminJwtAuthGuard],
    );
    assertRouteHandlers(OAuthLinksController, ['getLinkedProviders', 'unlinkProvider']);

    const listLinksRoute = 'GET admin/oauth/links (read own linked providers)';
    assertRoute(
      OAuthLinksController.prototype.getLinkedProviders,
      { method: RequestMethod.GET, path: '/' },
      listLinksRoute,
    );
    assertRouteUngated(
      OAuthLinksController,
      OAuthLinksController.prototype.getLinkedProviders,
      listLinksRoute,
    );

    const unlinkRoute = 'DELETE admin/oauth/links/:type (unlink own provider)';
    assertRoute(
      OAuthLinksController.prototype.unlinkProvider,
      { method: RequestMethod.DELETE, path: ':type' },
      unlinkRoute,
    );
    assertRouteUngated(
      OAuthLinksController,
      OAuthLinksController.prototype.unlinkProvider,
      unlinkRoute,
    );

    // Last, and deliberately so. The two assertions above name one route each
    // and fail with that route's label; this one fails with the SET, which is
    // the message worth having when a third link route appears ungated. All
    // three now resolve the permission the way `RbacGuard` does — handler over
    // class — so a `@RequirePermission` put on `OAuthLinksController` itself is
    // caught by the first of them, on the route it actually gates. That was not
    // true while `assertRouteUngated` read handler metadata alone: a
    // class-level decorator left both handlers' own metadata `undefined`, both
    // per-route assertions passed, and this line was the only thing in the file
    // standing between the controller and an equally inert gate.
    assertEveryRouteGuarded(OAuthLinksController, ['getLinkedProviders', 'unlinkProvider']);
  });

  it('declares auth_providers permissions without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.auth_providers, ['view', 'edit']);
    assert.equal(isValidPermission('auth_providers', 'view'), true);
    assert.equal(isValidPermission('auth_providers', 'edit'), true);
    assert.equal(isValidPermission('auth_providers', 'delete'), false);

    const nonSuperadminSystemGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((permission) => permission.resource === 'auth_providers');
    assert.deepStrictEqual(nonSuperadminSystemGrants, []);
  });

  it('delegates reads and encrypts client secrets before updating provider config', async () => {
    const calls: unknown[] = [];
    const controller = new OAuthConfigController(
      {
        getAllConfigs: async () => {
          calls.push('list');
          return [providerConfig()];
        },
        updateConfig: async (type: AuthProviderType, data: unknown) => {
          calls.push(['update', type, data]);
          return providerConfig({ type, isEnabled: true, clientId: 'client-id' });
        },
      } as never,
      {
        encrypt: (value: string) => `enc(${value})`,
      } as never,
    );

    assert.deepStrictEqual(await controller.getAllConfigs(), [providerConfig()]);
    assert.deepStrictEqual(
      await controller.updateConfig(AuthProviderType.GITHUB, {
        isEnabled: true,
        clientId: 'client-id',
        clientSecret: 'raw-secret',
      }),
      providerConfig({ isEnabled: true, clientId: 'client-id' }),
    );

    assert.deepStrictEqual(calls, [
      'list',
      [
        'update',
        AuthProviderType.GITHUB,
        {
          isEnabled: true,
          clientId: 'client-id',
          clientSecretEnc: 'enc(raw-secret)',
        },
      ],
    ]);
  });
});

interface ProviderConfigFixture {
  readonly id: string;
  readonly type: AuthProviderType;
  readonly isEnabled: boolean;
  readonly displayName: string;
  readonly clientId: string | null;
  readonly frontendDomain: string | null;
  readonly backendDomain: string | null;
  readonly authorizationUrl: string | null;
  readonly tokenUrl: string | null;
  readonly realm: string | null;
  readonly providerDomain: string | null;
  readonly usePkce: boolean;
  readonly allowedEmails: readonly string[];
  readonly allowedTelegramIds: readonly bigint[];
}

function providerConfig(overrides: Partial<ProviderConfigFixture> = {}): ProviderConfigFixture {
  return {
    id: 'provider-1',
    type: AuthProviderType.GITHUB,
    isEnabled: false,
    displayName: 'GitHub',
    clientId: null,
    frontendDomain: null,
    backendDomain: null,
    authorizationUrl: null,
    tokenUrl: null,
    realm: null,
    providerDomain: null,
    usePkce: false,
    allowedEmails: [],
    allowedTelegramIds: [],
    ...overrides,
  };
}
