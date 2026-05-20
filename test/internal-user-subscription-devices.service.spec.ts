import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailService } from '../src/modules/email/services/email.service';
import { InternalUserSessionQueryDto } from '../src/modules/internal-user/dto/internal-user-session-query.dto';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

interface MockPrismaService {
  readonly authChallenge: {
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    create: (...args: readonly unknown[]) => Promise<unknown>;
    update: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly plan: {
    findMany: (...args: readonly unknown[]) => Promise<readonly unknown[]>;
  };
  readonly webAccount: {
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
    updateMany: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly user: {
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    findMany: (...args: readonly unknown[]) => Promise<readonly unknown[]>;
    updateMany: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly subscription: {
    findMany: (...args: readonly unknown[]) => Promise<readonly unknown[]>;
  };
}

describe('InternalUserService (subscription devices)', () => {
  it('returns current-subscription devices plus scalar metadata', async () => {
    const remnawaveCalls: string[] = [];
    const remnawaveApiService = {
      getUserSubscriptionDevices: async (input: {
        readonly remnawaveSubscriptionId: string;
      }): Promise<{
        readonly devices: readonly {
          readonly hwid: string;
          readonly deviceName: string | null;
          readonly platform: string | null;
          readonly osVersion: string | null;
          readonly appVersion: string | null;
          readonly userAgent: string | null;
          readonly ipAddress: string | null;
          readonly lastSeenAt: string | null;
          readonly createdAt: string | null;
        }[];
        readonly deviceCount: number;
      }> => {
        remnawaveCalls.push(input.remnawaveSubscriptionId);
        return {
          devices: [
            {
              hwid: 'hwid-1',
              deviceName: 'iPhone 15 Pro',
              platform: 'ios',
              osVersion: '17.4',
              appVersion: null,
              userAgent: 'Rezeis/1.0',
              ipAddress: '203.0.113.10',
              lastSeenAt: '2026-04-20T11:30:00.000Z',
              createdAt: '2026-04-19T10:00:00.000Z',
            },
          ],
          deviceCount: 1,
        };
      },
      revokeUserSubscriptionDevice: async (): Promise<void> => undefined,
    } as unknown as RemnawaveApiService;
    const prismaService = createMockPrismaService({
      subscription: {
        remnawaveId: 'subscription-uuid-1',
        status: SubscriptionStatus.ACTIVE,
        deviceLimit: 2,
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      remnawaveApiService,
    );

    const actualDevices = await service.getSubscriptionDevices({
      email: 'user@example.com',
    } as InternalUserSessionQueryDto);

    assert.deepStrictEqual(remnawaveCalls, ['subscription-uuid-1']);
    assert.deepStrictEqual(actualDevices, {
      devices: [
        {
          hwid: 'hwid-1',
          deviceName: 'iPhone 15 Pro',
          platform: 'ios',
          osVersion: '17.4',
          appVersion: null,
          userAgent: 'Rezeis/1.0',
          ipAddress: '203.0.113.10',
          lastSeenAt: '2026-04-20T11:30:00.000Z',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
      deviceCount: 1,
      deviceLimit: 2,
      isLimitReached: false,
      blockedMessage: null,
      maxDevicesMessage: null,
    });
  });

  it('derives blocked/max-devices messages from current subscription status and limits', async () => {
    const remnawaveApiService = {
      getUserSubscriptionDevices: async (): Promise<{
        readonly devices: readonly {
          readonly hwid: string;
          readonly deviceName: string | null;
          readonly platform: string | null;
          readonly osVersion: string | null;
          readonly appVersion: string | null;
          readonly userAgent: string | null;
          readonly ipAddress: string | null;
          readonly lastSeenAt: string | null;
          readonly createdAt: string | null;
        }[];
        readonly deviceCount: number;
      }> => ({
        devices: [
          {
            hwid: 'hwid-1',
            deviceName: null,
            platform: null,
            osVersion: null,
            appVersion: null,
            userAgent: null,
            ipAddress: null,
            lastSeenAt: null,
            createdAt: null,
          },
        ],
        deviceCount: 1,
      }),
      revokeUserSubscriptionDevice: async (): Promise<void> => undefined,
    } as unknown as RemnawaveApiService;
    const prismaService = createMockPrismaService({
      subscription: {
        remnawaveId: 'subscription-uuid-1',
        status: SubscriptionStatus.LIMITED,
        deviceLimit: 1,
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      remnawaveApiService,
    );

    const actualDevices = await service.getSubscriptionDevices({
      email: 'user@example.com',
    } as InternalUserSessionQueryDto);

    assert.equal(actualDevices.isLimitReached, true);
    assert.equal(actualDevices.blockedMessage, 'Device registration is blocked while your account is limited.');
    assert.equal(
      actualDevices.maxDevicesMessage,
      'You have reached the maximum number of allowed devices for this subscription.',
    );
  });

  it('revokes one device by trimmed hwid and returns refreshed current-subscription devices', async () => {
    const revokeCalls: Array<{ readonly remnawaveSubscriptionId: string; readonly hwid: string }> = [];
    let getDevicesCallsCount = 0;
    const remnawaveApiService = {
      getUserSubscriptionDevices: async (): Promise<{
        readonly devices: readonly {
          readonly hwid: string;
          readonly deviceName: string | null;
          readonly platform: string | null;
          readonly osVersion: string | null;
          readonly appVersion: string | null;
          readonly userAgent: string | null;
          readonly ipAddress: string | null;
          readonly lastSeenAt: string | null;
          readonly createdAt: string | null;
        }[];
        readonly deviceCount: number;
      }> => {
        getDevicesCallsCount += 1;
        return {
          devices: [],
          deviceCount: 0,
        };
      },
      revokeUserSubscriptionDevice: async (input: {
        readonly remnawaveSubscriptionId: string;
        readonly hwid: string;
      }): Promise<void> => {
        revokeCalls.push(input);
      },
    } as unknown as RemnawaveApiService;
    const prismaService = createMockPrismaService({
      subscription: {
        remnawaveId: 'subscription-uuid-1',
        status: SubscriptionStatus.ACTIVE,
        deviceLimit: 3,
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      remnawaveApiService,
    );

    const actualDevices = await service.revokeSubscriptionDevice({
      query: { email: 'user@example.com' } as InternalUserSessionQueryDto,
      hwid: '  hwid-to-delete  ',
    });

    assert.deepStrictEqual(revokeCalls, [
      {
        remnawaveSubscriptionId: 'subscription-uuid-1',
        hwid: 'hwid-to-delete',
      },
    ]);
    assert.equal(getDevicesCallsCount, 1);
    assert.deepStrictEqual(actualDevices, {
      devices: [],
      deviceCount: 0,
      deviceLimit: 3,
      isLimitReached: false,
      blockedMessage: null,
      maxDevicesMessage: null,
    });
  });
});

function createMockPrismaService(input: {
  readonly subscription: {
    readonly remnawaveId: string;
    readonly status: SubscriptionStatus;
    readonly deviceLimit: number;
  };
}): MockPrismaService {
  return {
    authChallenge: {
      findFirst: async (): Promise<unknown> => null,
      create: async (): Promise<unknown> => null,
      update: async (): Promise<unknown> => null,
    },
    plan: {
      findMany: async (): Promise<readonly unknown[]> => [],
    },
    webAccount: {
      findUnique: async (): Promise<unknown> => null,
      updateMany: async (): Promise<unknown> => ({ count: 0 }),
    },
    user: {
      findUnique: async (): Promise<unknown> => ({
        id: 'user-1',
        telegramId: null,
        username: 'rezeis-user',
        name: 'Rezeis User',
        email: 'user@example.com',
        role: 'USER',
        language: 'EN',
        personalDiscount: 0,
        purchaseDiscount: 0,
        points: 0,
        maxSubscriptions: 1,
        isBlocked: false,
        isBotBlocked: false,
        isRulesAccepted: true,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        updatedAt: new Date('2026-04-20T00:00:00.000Z'),
        webAccount: null,
      }),
      findFirst: async (): Promise<unknown> => null,
      findMany: async (): Promise<readonly unknown[]> => [],
      updateMany: async (): Promise<unknown> => ({ count: 0 }),
    },
    subscription: {
      findMany: async (): Promise<readonly unknown[]> => [
        {
          id: 'subscription-1',
          userId: 'user-1',
          remnawaveId: input.subscription.remnawaveId,
          status: input.subscription.status,
          isTrial: false,
          planSnapshot: { name: 'Plan', type: 'TRAFFIC' },
          trafficLimit: null,
          deviceLimit: input.subscription.deviceLimit,
          configUrl: null,
          startedAt: new Date('2026-04-01T00:00:00.000Z'),
          expiresAt: new Date('2026-05-01T00:00:00.000Z'),
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
          updatedAt: new Date('2026-04-20T00:00:00.000Z'),
        },
      ],
    },
  };
}

function createPasswordHashServiceMock(): PasswordHashService {
  return {
    hashPassword: async (): Promise<string> => 'unused-password-hash',
    verifyPassword: async (): Promise<boolean> => false,
    deriveKey: (): Buffer => Buffer.from('unused-derived-key'),
  } as unknown as PasswordHashService;
}

function createEmailServiceMock(): EmailService {
  return {
    sendLinkedAccountVerificationCode: async (): Promise<void> => undefined,
    sendLinkedAccountPasswordResetLink: async (): Promise<void> => undefined,
  } as unknown as EmailService;
}
