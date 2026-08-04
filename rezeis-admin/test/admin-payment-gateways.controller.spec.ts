import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentGatewaysController } from '../src/modules/payments/controllers/admin-payment-gateways.controller';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

describe('AdminPaymentGatewaysController', () => {
  it('exposes gateway registry admin routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController), 'admin/payments/gateways');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController.prototype.listGateways),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPaymentGatewaysController.prototype.listGateways),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController.prototype.getGateway),
      ':gatewayId',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController.prototype.updateGateway),
      ':gatewayId',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController.prototype.moveGateway),
      ':gatewayId/move',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController.prototype.createDefaults),
      'defaults',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentGatewaysController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    assertRoute(AdminPaymentGatewaysController.prototype.listGateways, '/', RequestMethod.GET, 'view');
    assertRoute(AdminPaymentGatewaysController.prototype.getSupportedCurrencies, 'supported-currencies', RequestMethod.GET, 'view');
    assertRoute(AdminPaymentGatewaysController.prototype.getGateway, ':gatewayId', RequestMethod.GET, 'view');
    assertRoute(AdminPaymentGatewaysController.prototype.updateGateway, ':gatewayId', RequestMethod.PATCH, 'edit');
    assertRoute(AdminPaymentGatewaysController.prototype.moveGateway, ':gatewayId/move', RequestMethod.PATCH, 'edit');
    assertRoute(AdminPaymentGatewaysController.prototype.createDefaults, 'defaults', RequestMethod.POST, 'edit');
  });

  it('delegates gateway calls unchanged', async () => {
    const { controller, calls } = createController(false);

    assert.deepStrictEqual(await controller.listGateways(ADMIN), [{ id: 'gateway-1' }]);
    assert.deepStrictEqual(await controller.getGateway(ADMIN, 'gateway-1'), { id: 'gateway-1' });
    assert.deepStrictEqual(
      await controller.updateGateway(ADMIN, 'gateway-1', { isActive: false } as never),
      { id: 'gateway-1', isActive: false },
    );
    assert.deepStrictEqual(
      await controller.moveGateway(ADMIN, 'gateway-1', { direction: 'up' } as never),
      { id: 'gateway-1', direction: 'up' },
    );
    assert.deepStrictEqual(await controller.createDefaults(ADMIN), [{ id: 'gateway-default' }]);
    assert.deepStrictEqual(calls, [
      ['list', false],
      ['get', 'gateway-1', false],
      ['update', 'gateway-1', { isActive: false }, false],
      ['move', 'gateway-1', 'up', false],
      ['defaults', false],
    ]);
  });

  it('asks for secrets only when the admin holds payment_gateways:view_secrets', async () => {
    // The elevated permission is resolved per request and passed down rather
    // than gating the route: an admin with plain `payment_gateways:view` must
    // keep listing and configuring gateways, just with the secrets masked.
    const withoutSecrets = createController(false);
    const withSecrets = createController(true);

    await withoutSecrets.controller.listGateways(ADMIN);
    await withSecrets.controller.listGateways(ADMIN);

    assert.deepStrictEqual(withoutSecrets.calls, [['list', false]]);
    assert.deepStrictEqual(withSecrets.calls, [['list', true]]);
    assert.deepStrictEqual(withSecrets.permissionChecks, [
      ['payment_gateways', 'view_secrets'],
    ]);
  });

  it('does not let an edit round-trip reveal a secret the caller cannot read', async () => {
    // A save echoes the stored row back. Without the same permission check on
    // the write path, `edit` alone would be a read primitive for credentials.
    const { controller, calls } = createController(false);

    await controller.updateGateway(ADMIN, 'gateway-1', { isActive: true } as never);
    await controller.moveGateway(ADMIN, 'gateway-1', { direction: 'up' } as never);
    await controller.createDefaults(ADMIN);

    assert.deepStrictEqual(
      calls.map((call) => (call as unknown[])[(call as unknown[]).length - 1]),
      [false, false, false],
    );
  });
});

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: 'role-1' } as never;

function createController(canRevealSecrets: boolean): {
  readonly controller: AdminPaymentGatewaysController;
  readonly calls: unknown[];
  readonly permissionChecks: unknown[];
} {
  const calls: unknown[] = [];
  const permissionChecks: unknown[] = [];
  const controller = new AdminPaymentGatewaysController(
    {
      listGateways: async (revealSecrets: boolean) => {
        calls.push(['list', revealSecrets]);
        return [{ id: 'gateway-1' }];
      },
      getGateway: async (gatewayId: string, revealSecrets: boolean) => {
        calls.push(['get', gatewayId, revealSecrets]);
        return { id: gatewayId };
      },
      updateGateway: async (gatewayId: string, input: unknown, revealSecrets: boolean) => {
        calls.push(['update', gatewayId, input, revealSecrets]);
        return { id: gatewayId, ...((input as Record<string, unknown>) ?? {}) };
      },
      moveGateway: async (gatewayId: string, direction: string, revealSecrets: boolean) => {
        calls.push(['move', gatewayId, direction, revealSecrets]);
        return { id: gatewayId, direction };
      },
      createDefaults: async (revealSecrets: boolean) => {
        calls.push(['defaults', revealSecrets]);
        return [{ id: 'gateway-default' }];
      },
    } as never as PaymentGatewayRegistryService,
    {
      hasPermission: async (_admin: unknown, resource: string, action: string) => {
        permissionChecks.push([resource, action]);
        return canRevealSecrets;
      },
    } as never,
  );
  return { controller, calls, permissionChecks };
}

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'payment_gateways', action },
  ]);
}
