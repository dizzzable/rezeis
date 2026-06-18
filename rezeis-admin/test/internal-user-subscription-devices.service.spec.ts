import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SubscriptionStatus } from '@prisma/client';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalUserDevicesController } from '../src/modules/internal-user/controllers/internal-user-devices.controller';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

interface MockPrismaService {
  readonly user: {
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly subscription: {
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    update: (...args: readonly unknown[]) => Promise<unknown>;
  };
}

describe('InternalUserDevicesController', () => {
  it('exposes the current internal devices route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserDevicesController), 'internal/user');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalUserDevicesController), [
      InternalAdminAuthGuard,
    ]);
    assertRoute(RequestMethod.GET, ':userRef/devices', InternalUserDevicesController.prototype.listDevices);
    assertRoute(
      RequestMethod.DELETE,
      ':userRef/devices/:hwid',
      InternalUserDevicesController.prototype.deleteDevice,
    );
    assertRoute(
      RequestMethod.GET,
      ':userRef/subscriptions/:subscriptionId/devices',
      InternalUserDevicesController.prototype.listSubscriptionDevices,
    );
    assertRoute(
      RequestMethod.DELETE,
      ':userRef/subscriptions/:subscriptionId/devices/:hwid',
      InternalUserDevicesController.prototype.deleteSubscriptionDevice,
    );
    assertRoute(
      RequestMethod.POST,
      ':userRef/subscriptions/:subscriptionId/regenerate',
      InternalUserDevicesController.prototype.regenerateSubscription,
    );
  });

  it('lists active-subscription devices through the current Remnawave panel profile API', async () => {
    const remnawaveCalls: string[] = [];
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ activeSubscription: createSubscription() }) as never,
      {
        getPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return {
            total: 1,
            devices: [
              {
                hwid: 'hwid-1',
                platform: 'ios',
                osVersion: '17.4',
                deviceModel: 'iPhone 15 Pro',
                userAgent: 'Rezeis/1.0',
                createdAt: '2026-04-19T10:00:00.000Z',
                lastSeenAt: '2026-04-20T11:30:00.000Z',
              },
            ],
          };
        },
      } as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    const actualDevices = await controller.listDevices('123456789');

    assert.deepStrictEqual(remnawaveCalls, ['rem-user-1']);
    assert.deepStrictEqual(actualDevices, {
      total: 1,
      devices: [
        {
          hwid: 'hwid-1',
          platform: 'ios',
          osVersion: '17.4',
          deviceModel: 'iPhone 15 Pro',
          userAgent: 'Rezeis/1.0',
          createdAt: '2026-04-19T10:00:00.000Z',
          lastSeenAt: '2026-04-20T11:30:00.000Z',
        },
      ],
    });
  });

  it('returns an empty device list when the user has no active Remnawave-backed subscription', async () => {
    const remnawaveCalls: string[] = [];
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ activeSubscription: null }) as never,
      {
        getPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return { total: 0, devices: [] };
        },
      } as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    assert.deepStrictEqual(await controller.listDevices('123456789'), { devices: [], total: 0 });
    assert.deepStrictEqual(remnawaveCalls, []);
  });

  it('deletes an explicit subscription device, emits the current event payload, and returns remaining count', async () => {
    const deleted: Array<{ remnawaveId: string; hwid: string }> = [];
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ ownedSubscription: createSubscription() }) as never,
      {
        deletePanelUserDevice: async (remnawaveId: string, hwid: string) => {
          deleted.push({ remnawaveId, hwid });
          return { total: 2 };
        },
      } as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const actualResponse = await controller.deleteSubscriptionDevice(
      '123456789',
      'subscription-1',
      'hwid-to-delete',
    );

    assert.deepStrictEqual(deleted, [{ remnawaveId: 'rem-user-1', hwid: 'hwid-to-delete' }]);
    assert.deepStrictEqual(actualResponse, { revoked: true, remainingDevices: 2 });
    assert.deepStrictEqual(events.calls, [
      {
        type: EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
        entityType: 'DEVICE',
        message: 'Device revoked by user: hwid-to-delete',
        metadata: {
          userId: 'user-1',
          telegramId: '123456789',
          userName: 'User Name',
          username: 'user_name',
          subscriptionId: 'subscription-1',
          remnawaveId: 'rem-user-1',
          hwid: 'hwid-to-delete',
          remainingDevices: 2,
        },
      },
    ]);
  });

  it('regenerates a subscription link, clears devices, and persists the new config URL', async () => {
    const remnawaveCalls: Array<{ method: string; remnawaveId: string }> = [];
    const persistedUpdates: unknown[] = [];
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({
        ownedSubscription: createSubscription(),
        onSubscriptionUpdate: (input) => persistedUpdates.push(input),
      }) as never,
      {
        regeneratePanelUserSubscription: async (remnawaveId: string) => {
          remnawaveCalls.push({ method: 'regenerate', remnawaveId });
          return { subscriptionUrl: 'https://remnawave.example/sub/new-link' };
        },
        deleteAllPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push({ method: 'delete-all', remnawaveId });
          return { total: 0 };
        },
      } as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const actualResponse = await controller.regenerateSubscription('123456789', 'subscription-1');

    assert.deepStrictEqual(remnawaveCalls, [
      { method: 'regenerate', remnawaveId: 'rem-user-1' },
      { method: 'delete-all', remnawaveId: 'rem-user-1' },
    ]);
    assert.deepStrictEqual(persistedUpdates, [
      {
        where: { id: 'subscription-1' },
        data: { configUrl: 'https://remnawave.example/sub/new-link' },
      },
    ]);
    assert.deepStrictEqual(actualResponse, {
      regenerated: true,
      url: 'https://remnawave.example/sub/new-link',
    });
    assert.deepStrictEqual(events.calls[0], {
      type: EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      entityType: 'DEVICE',
      message: 'Subscription link regenerated by user (all devices revoked)',
      metadata: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
        remnawaveId: 'rem-user-1',
      },
    });
  });
});

function assertRoute(requestMethod: RequestMethod, path: string, target: unknown): void {
  assert.equal(Reflect.getMetadata(METHOD_METADATA, target), requestMethod);
  assert.equal(Reflect.getMetadata(PATH_METADATA, target), path);
}

function createSubscription(): {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string;
} {
  return {
    id: 'subscription-1',
    userId: 'user-1',
    remnawaveId: 'rem-user-1',
  };
}

function createMockPrismaService(input: {
  readonly activeSubscription?: unknown;
  readonly ownedSubscription?: unknown;
  readonly onSubscriptionUpdate?: (input: unknown) => void;
}): MockPrismaService {
  return {
    user: {
      findUnique: async (args: unknown): Promise<unknown> => {
        const select = (args as { readonly select?: Record<string, unknown> }).select;
        if (select && 'telegramId' in select) {
          return {
            telegramId: BigInt(123456789),
            username: 'user_name',
            name: 'User Name',
          };
        }
        return { id: 'user-1' };
      },
    },
    subscription: {
      findFirst: async (args: unknown): Promise<unknown> => {
        const where = (args as { readonly where?: { readonly status?: unknown } }).where;
        if (where?.status !== undefined) {
          assert.deepStrictEqual(where.status, {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED],
          });
          return input.activeSubscription ?? null;
        }
        return input.ownedSubscription ?? null;
      },
      update: async (args: unknown): Promise<unknown> => {
        input.onSubscriptionUpdate?.(args);
        return null;
      },
    },
  };
}

function createEventsMock(): {
  readonly calls: Array<{
    readonly type: string;
    readonly entityType: string;
    readonly message: string;
    readonly metadata: unknown;
  }>;
  readonly info: (type: string, entityType: string, message: string, metadata: unknown) => void;
} {
  const calls: Array<{
    readonly type: string;
    readonly entityType: string;
    readonly message: string;
    readonly metadata: unknown;
  }> = [];
  return {
    calls,
    info: (type: string, entityType: string, message: string, metadata: unknown): void => {
      calls.push({ type, entityType, message, metadata });
    },
  };
}
