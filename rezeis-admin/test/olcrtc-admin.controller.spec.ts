import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { OlcrtcAdminController } from '../src/modules/olcrtc/olcrtc.admin.controller';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, isValidPermission } from '../src/modules/rbac/rbac.resources';

describe('OlcrtcAdminController', () => {
  it('is guarded by admin JWT and RBAC guards with class-level view permission', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, OlcrtcAdminController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, OlcrtcAdminController), [
      { resource: 'olcrtc', action: 'view' },
    ]);
  });

  it('maps admin OLCRTC routes to explicit RBAC permissions', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OlcrtcAdminController), 'admin/olcrtc');
    assertRoute(OlcrtcAdminController.prototype.getOverview, 'overview', RequestMethod.GET, undefined);
    assertRoute(OlcrtcAdminController.prototype.listTraffic, 'traffic', RequestMethod.GET, undefined);
    assertRoute(OlcrtcAdminController.prototype.createProviderAccount, 'provider-accounts', RequestMethod.POST, 'create');
    assertRoute(OlcrtcAdminController.prototype.updateProviderAccount, 'provider-accounts/:id', RequestMethod.PATCH, 'edit');
    assertRoute(OlcrtcAdminController.prototype.createProfile, 'profiles', RequestMethod.POST, 'create');
    assertRoute(OlcrtcAdminController.prototype.updateProfile, 'profiles/:id', RequestMethod.PATCH, 'edit');
    assertRoute(OlcrtcAdminController.prototype.updateGateway, 'gateways/:id', RequestMethod.PATCH, 'edit');
    assertRoute(OlcrtcAdminController.prototype.updateRoom, 'rooms/:id', RequestMethod.PATCH, 'edit');
    assertRoute(OlcrtcAdminController.prototype.updateSession, 'sessions/:id', RequestMethod.PATCH, 'edit');
    assertRoute(OlcrtcAdminController.prototype.runLifecycle, 'lifecycle/run', RequestMethod.POST, 'run');
  });

  it('declares OLCRTC permissions in the RBAC catalog', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.olcrtc, ['view', 'create', 'edit', 'run']);
    assert.equal(isValidPermission('olcrtc', 'view'), true);
    assert.equal(isValidPermission('olcrtc', 'create'), true);
    assert.equal(isValidPermission('olcrtc', 'edit'), true);
    assert.equal(isValidPermission('olcrtc', 'run'), true);
    assert.equal(isValidPermission('olcrtc', 'delete'), false);
  });

  it('delegates admin operations to OlcrtcAdminService without rewriting payloads', async () => {
    const calls: unknown[] = [];
    const controller = new OlcrtcAdminController({
      getOverview: async () => {
        calls.push('overview');
        return { providerAccounts: [], profiles: [], gateways: [], rooms: [], sessions: [], counts: {} };
      },
      listTrafficLedger: async (query: unknown) => {
        calls.push(['traffic', query]);
        return { items: [] };
      },
      createProviderAccount: async (body: unknown) => {
        calls.push(['createProviderAccount', body]);
        return { id: 'account-1' };
      },
      updateProviderAccount: async (id: string, body: unknown) => {
        calls.push(['updateProviderAccount', id, body]);
        return { id };
      },
      createProfile: async (body: unknown) => {
        calls.push(['createProfile', body]);
        return { id: 'profile-1' };
      },
      updateProfile: async (id: string, body: unknown) => {
        calls.push(['updateProfile', id, body]);
        return { id };
      },
      updateGateway: async (id: string, body: unknown) => {
        calls.push(['updateGateway', id, body]);
        return { id };
      },
      updateRoom: async (id: string, body: unknown) => {
        calls.push(['updateRoom', id, body]);
        return { id };
      },
      updateSession: async (id: string, body: unknown) => {
        calls.push(['updateSession', id, body]);
        return { id };
      },
      runLifecycleOnce: async () => {
        calls.push('lifecycle');
        return { staleGateways: 1, expiredSessions: 2, stuckSessions: 3, expiredRooms: 4 };
      },
    } as never);

    await controller.getOverview();
    await controller.listTraffic({ sessionId: 'session-1', take: 10 });
    await controller.createProviderAccount({ name: 'Jitsi' } as never);
    await controller.updateProviderAccount('account-1', { isEnabled: false });
    await controller.createProfile({ name: 'Jitsi profile' } as never);
    await controller.updateProfile('profile-1', { priority: 5 });
    await controller.updateGateway('gateway-1', { status: 'DRAINING' });
    await controller.updateRoom('room-1', { status: 'INVALID' });
    await controller.updateSession('session-1', { status: 'FAILED' });
    assert.deepStrictEqual(await controller.runLifecycle(), { staleGateways: 1, expiredSessions: 2, stuckSessions: 3, expiredRooms: 4 });

    assert.deepStrictEqual(calls, [
      'overview',
      ['traffic', { sessionId: 'session-1', take: 10 }],
      ['createProviderAccount', { name: 'Jitsi' }],
      ['updateProviderAccount', 'account-1', { isEnabled: false }],
      ['createProfile', { name: 'Jitsi profile' }],
      ['updateProfile', 'profile-1', { priority: 5 }],
      ['updateGateway', 'gateway-1', { status: 'DRAINING' }],
      ['updateRoom', 'room-1', { status: 'INVALID' }],
      ['updateSession', 'session-1', { status: 'FAILED' }],
      'lifecycle',
    ]);
  });
});

function assertRoute(method: unknown, path: string, requestMethod: RequestMethod, action: string | undefined): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  if (action) {
    assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
      { resource: 'olcrtc', action },
    ]);
  } else {
    assert.equal(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), undefined);
  }
}
