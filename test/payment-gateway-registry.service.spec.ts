import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType } from '@prisma/client';

import { PaymentGatewayMoveDirection } from '../src/modules/payments/dto/move-payment-gateway.dto';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';

describe('PaymentGatewayRegistryService', () => {
  it('creates default gateways idempotently', async () => {
    const { service } = createService([]);

    const firstCreate = await service.createDefaults();
    const secondCreate = await service.createDefaults();

    assert.equal(firstCreate.length, 6);
    assert.equal(secondCreate.length, 6);
    assert.deepStrictEqual(
      secondCreate.map((gateway) => gateway.type),
      [
        PaymentGatewayType.TELEGRAM_STARS,
        PaymentGatewayType.YOOKASSA,
        PaymentGatewayType.PLATEGA,
        PaymentGatewayType.HELEKET,
        PaymentGatewayType.CRYPTOMUS,
        PaymentGatewayType.MULENPAY,
      ],
    );
  });

  it('updates active flag, currency, and settings', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
        settings: { shopId: 'shop-old', apiKey: 'key-old' },
      }),
    ]);

    const updatedGateway = await service.updateGateway('gateway-1', {
      isActive: false,
      currency: Currency.RUB,
      settings: { shopId: 'shop-new', apiKey: 'key-new' },
    });

    assert.equal(updatedGateway.isActive, false);
    assert.equal(updatedGateway.currency, Currency.RUB);
    assert.deepStrictEqual(updatedGateway.settings, {
      shopId: 'shop-new',
      apiKey: 'key-new',
    });
  });

  it('moves ordering up and down by swapping orderIndex with nearest gateway', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
      createGateway({
        id: 'gateway-2',
        type: PaymentGatewayType.PLATEGA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 2,
      }),
    ]);

    const movedUp = await service.moveGateway('gateway-2', PaymentGatewayMoveDirection.UP);
    assert.equal(movedUp.orderIndex, 1);

    const movedDown = await service.moveGateway('gateway-2', PaymentGatewayMoveDirection.DOWN);
    assert.equal(movedDown.orderIndex, 2);
  });

  it('rejects invalid scalar settings payloads', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', { settings: 'not-an-object' as never });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_SETTINGS_INVALID',
      },
    );
  });

  it('rejects unknown settings fields for a configured gateway type', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', {
          settings: { shopId: 'shop-1', unexpected: true } as never,
        });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_SETTINGS_INVALID',
      },
    );
  });

  it('normalizes platega paymentMethod aliases into deterministic numeric settings', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.PLATEGA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    const updatedGateway = await service.updateGateway('gateway-1', {
      settings: {
        merchantId: 'merchant-1',
        secret: 'secret-1',
        paymentMethod: 'SBP',
      },
    });

    assert.deepStrictEqual(updatedGateway.settings, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 2,
    });
  });
});

function createService(initialGateways: readonly GatewayRecord[]): {
  readonly service: PaymentGatewayRegistryService;
} {
  const gateways: GatewayRecord[] = initialGateways.map((gateway) => ({ ...gateway }));
  const paymentGatewayClient = {
    findMany: async (...args: readonly unknown[]): Promise<GatewayRecord[]> => {
      const select = (args[0] as { readonly select?: { readonly type?: boolean } } | undefined)?.select;
      if (select?.type) {
        return gateways.map((gateway) => ({ type: gateway.type } as GatewayRecord));
      }
      return sortGateways(gateways).map((gateway) => ({ ...gateway }));
    },
    findUnique: async (args: { readonly where: { readonly id: string } }): Promise<GatewayRecord | null> => {
      const gateway = gateways.find((candidate) => candidate.id === args.where.id);
      return gateway === undefined ? null : { ...gateway };
    },
    findFirst: async (args: {
      readonly where?: { readonly orderIndex?: { readonly lt?: number; readonly gt?: number } };
      readonly orderBy?: readonly { readonly orderIndex?: 'asc' | 'desc'; readonly type?: 'asc' | 'desc' }[];
    }): Promise<GatewayRecord | null> => {
      let filtered = [...gateways];
      const orderIndexFilter = args.where?.orderIndex;
      if (orderIndexFilter?.lt !== undefined) {
        filtered = filtered.filter((gateway) => gateway.orderIndex < orderIndexFilter.lt!);
      }
      if (orderIndexFilter?.gt !== undefined) {
        filtered = filtered.filter((gateway) => gateway.orderIndex > orderIndexFilter.gt!);
      }
      if (args.orderBy !== undefined && args.orderBy.length > 0) {
        filtered.sort((left, right) => {
          const firstSort = args.orderBy![0];
          if (firstSort.orderIndex !== undefined) {
            return firstSort.orderIndex === 'asc'
              ? left.orderIndex - right.orderIndex
              : right.orderIndex - left.orderIndex;
          }
          if (firstSort.type !== undefined) {
            return firstSort.type === 'asc'
              ? left.type.localeCompare(right.type)
              : right.type.localeCompare(left.type);
          }
          return 0;
        });
      }
      const gateway = filtered[0];
      return gateway === undefined ? null : { ...gateway };
    },
    create: async (args: { readonly data: Partial<GatewayRecord> }): Promise<GatewayRecord> => {
      const created: GatewayRecord = {
        id: `gateway-${gateways.length + 1}`,
        type: args.data.type!,
        currency: args.data.currency!,
        isActive: args.data.isActive ?? true,
        orderIndex: args.data.orderIndex ?? 0,
        settings: (args.data.settings as Record<string, unknown>) ?? {},
        updatedAt: new Date('2026-04-19T12:00:00.000Z'),
      };
      gateways.push(created);
      return created;
    },
    update: async (args: {
      readonly where: { readonly id: string };
      readonly data: Record<string, unknown>;
    }): Promise<GatewayRecord> => {
      const gateway = gateways.find((candidate) => candidate.id === args.where.id);
      if (gateway === undefined) {
        throw Object.assign(new Error('not found'), { code: 'P2025' });
      }
      if (args.data.type !== undefined) {
        gateway.type = args.data.type as PaymentGatewayType;
      }
      if (args.data.currency !== undefined) {
        gateway.currency = args.data.currency as Currency;
      }
      if (args.data.isActive !== undefined) {
        gateway.isActive = args.data.isActive as boolean;
      }
      if (args.data.orderIndex !== undefined) {
        gateway.orderIndex = args.data.orderIndex as number;
      }
      if (args.data.settings !== undefined) {
        gateway.settings = args.data.settings as Record<string, unknown>;
      }
      gateway.updatedAt = new Date('2026-04-19T12:00:00.000Z');
      return gateway;
    },
  };
  const prismaService = {
    paymentGateway: paymentGatewayClient,
    planPrice: {
      findMany: async () => [],
    },
    $transaction: async <T>(callback: (client: { readonly paymentGateway: typeof paymentGatewayClient }) => Promise<T>): Promise<T> =>
      callback({
        paymentGateway: paymentGatewayClient,
      }),
  };
  return {
    service: new PaymentGatewayRegistryService(prismaService as never),
  };
}

function createGateway(input: {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly settings?: Record<string, unknown>;
}): GatewayRecord {
  return {
    id: input.id,
    type: input.type,
    currency: input.currency,
    isActive: input.isActive,
    orderIndex: input.orderIndex,
    settings: input.settings ?? {},
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };
}

function sortGateways(gateways: readonly GatewayRecord[]): GatewayRecord[] {
  return [...gateways].sort((left, right) => {
    if (left.orderIndex !== right.orderIndex) {
      return left.orderIndex - right.orderIndex;
    }
    return left.type.localeCompare(right.type);
  });
}

interface GatewayRecord {
  id: string;
  type: PaymentGatewayType;
  orderIndex: number;
  currency: Currency;
  isActive: boolean;
  settings: Record<string, unknown>;
  updatedAt: Date;
}
