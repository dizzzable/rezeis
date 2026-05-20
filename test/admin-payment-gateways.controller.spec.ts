import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentGatewaysController } from '../src/modules/payments/controllers/admin-payment-gateways.controller';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';

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
      [AdminJwtAuthGuard],
    );
  });

  it('delegates gateway calls unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new AdminPaymentGatewaysController({
      listGateways: async () => {
        calls.push(['list']);
        return [{ id: 'gateway-1' }];
      },
      getGateway: async (gatewayId: string) => {
        calls.push(['get', gatewayId]);
        return { id: gatewayId };
      },
      updateGateway: async (gatewayId: string, input: unknown) => {
        calls.push(['update', gatewayId, input]);
        return { id: gatewayId, ...((input as Record<string, unknown>) ?? {}) };
      },
      moveGateway: async (gatewayId: string, direction: string) => {
        calls.push(['move', gatewayId, direction]);
        return { id: gatewayId, direction };
      },
      createDefaults: async () => {
        calls.push(['defaults']);
        return [{ id: 'gateway-default' }];
      },
    } as never as PaymentGatewayRegistryService);

    assert.deepStrictEqual(await controller.listGateways(), [{ id: 'gateway-1' }]);
    assert.deepStrictEqual(await controller.getGateway('gateway-1'), { id: 'gateway-1' });
    assert.deepStrictEqual(
      await controller.updateGateway('gateway-1', { isActive: false } as never),
      { id: 'gateway-1', isActive: false },
    );
    assert.deepStrictEqual(
      await controller.moveGateway('gateway-1', { direction: 'up' } as never),
      { id: 'gateway-1', direction: 'up' },
    );
    assert.deepStrictEqual(await controller.createDefaults(), [{ id: 'gateway-default' }]);
    assert.deepStrictEqual(calls, [
      ['list'],
      ['get', 'gateway-1'],
      ['update', 'gateway-1', { isActive: false }],
      ['move', 'gateway-1', 'up'],
      ['defaults'],
    ]);
  });
});
