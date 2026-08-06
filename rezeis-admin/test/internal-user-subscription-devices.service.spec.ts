import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadGatewayException, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SubscriptionStatus } from '@prisma/client';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalUserDevicesController } from '../src/modules/internal-user/controllers/internal-user-devices.controller';
import {
  strictInvalidContract,
  strictOk,
  strictUnavailable,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
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
        strictGetPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return strictOk({
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
        },
      } as unknown as RemnawaveApiService,
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
        strictGetPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return strictOk({ total: 0, devices: [] });
        },
      } as unknown as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    assert.deepStrictEqual(await controller.listDevices('123456789'), { devices: [], total: 0 });
    assert.deepStrictEqual(remnawaveCalls, []);
  });

  // ── Panel-outage vs genuinely-empty (customer cabinet) ──────────────────
  //
  // These two run the SAME controller method against the SAME subscription and
  // differ only in what the panel answered. If the pair ever agrees, the
  // distinction has been swallowed again.

  it('does NOT report "0 devices" to the cabinet when the panel is unreachable', async () => {
    const remnawaveCalls: string[] = [];
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ activeSubscription: createSubscription() }) as never,
      {
        strictGetPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return strictUnavailable(null);
        },
      } as unknown as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    const failure = await captureRejection(async () => controller.listDevices('123456789'));

    // Self-check: the controller must actually have consulted the panel — a
    // test that passes because the read never happened proves nothing.
    assert.deepStrictEqual(remnawaveCalls, ['rem-user-1']);
    assert.equal(failure instanceof ServiceUnavailableException, true);
    assert.equal((failure as ServiceUnavailableException).getStatus(), 503);
    // The reason is in the RESPONSE body, not only in a log.
    assert.match(String((failure as Error).message), /unavailable/i);
  });

  it('still reports a genuinely empty panel device list to the cabinet as an empty list', async () => {
    const remnawaveCalls: string[] = [];
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ activeSubscription: createSubscription() }) as never,
      {
        strictGetPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return strictOk({ total: 0, devices: [] });
        },
      } as unknown as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    assert.deepStrictEqual(await controller.listDevices('123456789'), { total: 0, devices: [] });
    assert.deepStrictEqual(remnawaveCalls, ['rem-user-1']);
  });

  it('does NOT report "0 devices" for a selected subscription when the panel answers unusably', async () => {
    const remnawaveCalls: string[] = [];
    const controller = new InternalUserDevicesController(
      createMockPrismaService({ ownedSubscription: createSubscription() }) as never,
      {
        strictGetPanelUserDevices: async (remnawaveId: string) => {
          remnawaveCalls.push(remnawaveId);
          return strictInvalidContract('device list "devices" is not an array');
        },
      } as unknown as RemnawaveApiService,
      createEventsMock() as unknown as SystemEventsService,
    );

    const failure = await captureRejection(async () =>
      controller.listSubscriptionDevices('123456789', 'subscription-1'),
    );

    assert.deepStrictEqual(remnawaveCalls, ['rem-user-1']);
    assert.equal(failure instanceof BadGatewayException, true);
    assert.equal((failure as BadGatewayException).getStatus(), 502);
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
        severity: 'INFO',
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

  it('regenerates a subscription link, persists the new config URL BEFORE clearing devices', async () => {
    // One ordered trace for both the panel calls and the local write: the
    // defect was purely an ordering one, so the assertion has to be on the
    // order, not on the set of things that happened.
    const trace: string[] = [];
    const persistedUpdates: unknown[] = [];
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({
        ownedSubscription: createSubscription(),
        onSubscriptionUpdate: (input) => {
          trace.push('persist');
          persistedUpdates.push(input);
        },
      }) as never,
      {
        regeneratePanelUserSubscription: async (remnawaveId: string) => {
          trace.push(`regenerate:${remnawaveId}`);
          return { subscriptionUrl: 'https://remnawave.example/sub/new-link' };
        },
        deleteAllPanelUserDevices: async (remnawaveId: string) => {
          trace.push(`delete-all:${remnawaveId}`);
          return { total: 0 };
        },
      } as unknown as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const actualResponse = await controller.regenerateSubscription('123456789', 'subscription-1');

    assert.deepStrictEqual(trace, [
      'regenerate:rem-user-1',
      'persist',
      'delete-all:rem-user-1',
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
      devicesCleared: true,
    });
    assert.deepStrictEqual(events.calls[0], {
      type: EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      entityType: 'DEVICE',
      severity: 'INFO',
      message: 'Subscription link regenerated by user (all devices revoked)',
      metadata: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
        remnawaveId: 'rem-user-1',
        devicesCleared: true,
      },
    });
  });

  it('keeps the new link when the device wipe fails after the panel already rotated it', async () => {
    // The exact production failure: the panel has rotated the short uuid (every
    // old client link is dead) and the very next call blows up. If the new URL
    // is not already written down, the cabinet serves the dead one forever.
    const persistedUpdates: unknown[] = [];
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({
        ownedSubscription: createSubscription(),
        onSubscriptionUpdate: (input) => persistedUpdates.push(input),
      }) as never,
      {
        regeneratePanelUserSubscription: async () => ({
          subscriptionUrl: 'https://remnawave.example/sub/new-link',
        }),
        deleteAllPanelUserDevices: async () => {
          throw new ServiceUnavailableException('Remnawave integration is unavailable');
        },
      } as unknown as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const actualResponse = await controller.regenerateSubscription('123456789', 'subscription-1');

    // Self-check: assert the URL that was stored, not merely that a write ran —
    // a persist of the OLD url would satisfy a bare "one update happened".
    assert.deepStrictEqual(persistedUpdates, [
      {
        where: { id: 'subscription-1' },
        data: { configUrl: 'https://remnawave.example/sub/new-link' },
      },
    ]);
    // The link works, so the customer is not pushed into re-rotating it; the
    // uncleared devices are reported rather than hidden.
    assert.deepStrictEqual(actualResponse, {
      regenerated: true,
      url: 'https://remnawave.example/sub/new-link',
      devicesCleared: false,
    });
    assert.equal(
      events.calls[0]?.message,
      'Subscription link regenerated by user (devices NOT cleared — panel refused)',
    );
  });

  it('fails loudly instead of reporting success when the new link cannot be persisted', async () => {
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({
        ownedSubscription: createSubscription(),
        onSubscriptionUpdate: () => {
          throw new Error('database write failed');
        },
      }) as never,
      {
        regeneratePanelUserSubscription: async () => ({
          subscriptionUrl: 'https://remnawave.example/sub/new-link',
        }),
        deleteAllPanelUserDevices: async () => {
          throw new Error('the device wipe must never run once the persist has failed');
        },
      } as unknown as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const failure = await captureRejection(async () =>
      controller.regenerateSubscription('123456789', 'subscription-1'),
    );

    assert.equal((failure as Error).message, 'database write failed');
    // An operator has to learn that our stored link is now dead — this is the
    // one state the endpoint cannot repair by itself.
    assert.deepStrictEqual(
      events.calls.map((call) => ({
        type: call.type,
        entityType: call.entityType,
        severity: call.severity,
      })),
      [{ type: EVENT_TYPES.SUBSCRIPTION_SYNCED, entityType: 'SUBSCRIPTION', severity: 'ERROR' }],
    );
    assert.match(String(events.calls[0]?.message), /NOT stored/);
  });

  it('refuses to report success when the panel rotates the link without returning the new one', async () => {
    const persistedUpdates: unknown[] = [];
    const events = createEventsMock();
    const controller = new InternalUserDevicesController(
      createMockPrismaService({
        ownedSubscription: createSubscription(),
        onSubscriptionUpdate: (input) => persistedUpdates.push(input),
      }) as never,
      {
        regeneratePanelUserSubscription: async () => ({ subscriptionUrl: null }),
        deleteAllPanelUserDevices: async () => ({ total: 0 }),
      } as unknown as RemnawaveApiService,
      events as unknown as SystemEventsService,
    );

    const failure = await captureRejection(async () =>
      controller.regenerateSubscription('123456789', 'subscription-1'),
    );

    assert.equal(failure instanceof BadGatewayException, true);
    assert.deepStrictEqual(persistedUpdates, []);
    assert.deepStrictEqual(
      events.calls.map((call) => ({ type: call.type, severity: call.severity })),
      [{ type: EVENT_TYPES.SUBSCRIPTION_SYNCED, severity: 'ERROR' }],
    );
  });
});

/**
 * Runs `action` and returns whatever it threw. Fails the test if it did NOT
 * throw — otherwise every "must reject" assertion below could pass on a method
 * that quietly returned a value.
 */
async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    const resolved = await action();
    assert.fail(`expected a rejection, got ${JSON.stringify(resolved)}`);
  } catch (err: unknown) {
    if (err instanceof assert.AssertionError) throw err;
    return err;
  }
}

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
    readonly severity: 'INFO' | 'ERROR';
  }>;
  readonly info: (type: string, entityType: string, message: string, metadata: unknown) => void;
  readonly error: (type: string, entityType: string, message: string, metadata: unknown) => void;
} {
  const calls: Array<{
    readonly type: string;
    readonly entityType: string;
    readonly message: string;
    readonly metadata: unknown;
    readonly severity: 'INFO' | 'ERROR';
  }> = [];
  return {
    calls,
    info: (type: string, entityType: string, message: string, metadata: unknown): void => {
      calls.push({ type, entityType, message, metadata, severity: 'INFO' });
    },
    error: (type: string, entityType: string, message: string, metadata: unknown): void => {
      calls.push({ type, entityType, message, metadata, severity: 'ERROR' });
    },
  };
}
