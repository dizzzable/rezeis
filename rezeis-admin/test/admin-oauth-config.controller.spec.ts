import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthProviderType } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { OAuthConfigController } from '../src/modules/oauth/controllers/admin-oauth.controller';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';

describe('OAuthConfigController RBAC', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, OAuthConfigController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps OAuth provider config routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OAuthConfigController), 'admin/oauth/config');
    assertRoute(OAuthConfigController.prototype.getAllConfigs, '/', RequestMethod.GET, 'view');
    assertRoute(OAuthConfigController.prototype.updateConfig, ':type', RequestMethod.PUT, 'edit');
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

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'auth_providers', action },
  ]);
}

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
