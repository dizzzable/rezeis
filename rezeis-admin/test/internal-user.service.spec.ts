import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { PlanAvailability, Prisma, SubscriptionStatus } from '@prisma/client';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailDeliveryException } from '../src/modules/email/errors/email-delivery.exception';
import { EmailService } from '../src/modules/email/services/email.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

interface MockPrismaService {
  readonly $transaction?: <T>(
    callback: (transactionClient: MockTransactionClient) => Promise<T>,
  ) => Promise<T>;
  readonly authChallenge: {
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    create: (...args: readonly unknown[]) => Promise<unknown>;
    update: (...args: readonly unknown[]) => Promise<unknown>;
    updateMany?: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly plan: {
    findMany: () => Promise<readonly unknown[]>;
  };
  readonly webAccount: {
    findUnique?: (...args: readonly unknown[]) => Promise<unknown>;
    update?: (...args: readonly unknown[]) => Promise<unknown>;
    updateMany: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly user: {
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    findMany?: (...args: readonly unknown[]) => Promise<readonly unknown[]>;
    updateMany: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly subscription: {
    findMany: () => Promise<readonly unknown[]>;
  };
}

interface MockTransactionClient {
  readonly authChallenge: {
    findFirst: (...args: readonly unknown[]) => Promise<unknown>;
    create: (...args: readonly unknown[]) => Promise<unknown>;
    update?: (...args: readonly unknown[]) => Promise<unknown>;
    updateMany: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly user: {
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly webAccount: {
    update?: (...args: readonly unknown[]) => Promise<unknown>;
    findUnique: (...args: readonly unknown[]) => Promise<unknown>;
  };
  readonly $queryRaw: (...args: readonly unknown[]) => Promise<unknown>;
}

interface MockPasswordHashService {
  hashPassword: (...args: readonly unknown[]) => Promise<string>;
}

interface MockEmailService {
  sendLinkedAccountVerificationCode: (...args: readonly unknown[]) => Promise<void>;
}

describe('InternalUserService', () => {
  it('filters plans down to the safe public slice', async () => {
    const expectedWhere = {
      isActive: true,
      isArchived: false,
      availability: PlanAvailability.ALL,
    };
    let actualWhere: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          actualWhere = (args[0] as { readonly where: unknown }).where;
          return [
            {
              id: 'plan-1',
              orderIndex: 1,
              name: 'Starter',
              description: 'Starter plan',
              tag: 'public',
              icon: null,
              type: 'TRAFFIC',
              trafficLimit: 1024,
              deviceLimit: 1,
              durations: [
                {
                  id: 'duration-1',
                  days: 30,
                  prices: [{ currency: 'USD', price: { toString: (): string => '9.99' } }],
                },
              ],
            },
          ];
        },
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualPlans = await service.getPlans();
    assert.deepStrictEqual(actualWhere, expectedWhere);
    assert.deepStrictEqual(actualPlans, [
      {
        id: 'plan-1',
        orderIndex: 1,
        name: 'Starter',
        description: 'Starter plan',
        tag: 'public',
        icon: null,
        type: 'TRAFFIC',
        trafficLimit: 1024,
        deviceLimit: 1,
        durations: [
          {
            id: 'duration-1',
            days: 30,
            prices: [{ currency: 'USD', price: '9.99' }],
          },
        ],
      },
    ]);
  });

  it('chooses the current active subscription over a newer expired row', async () => {
    const now = Date.now();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => ({
          id: 'user-1',
          telegramId: null,
          username: null,
          name: 'User',
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
          createdAt: new Date(now - 10_000),
          updatedAt: new Date(now - 5_000),
          webAccount: null,
        }),
        findFirst: async (): Promise<unknown> => ({
          id: 'user-1',
          telegramId: null,
          username: null,
          name: 'User',
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
          createdAt: new Date(now - 10_000),
          updatedAt: new Date(now - 5_000),
          webAccount: null,
        }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [
          {
            id: 'subscription-expired',
            userId: 'user-1',
            status: SubscriptionStatus.EXPIRED,
            isTrial: false,
            planSnapshot: { name: 'Expired', type: 'TRAFFIC' },
            trafficLimit: 2048,
            deviceLimit: 1,
            remnawaveId: null,
            configUrl: 'https://expired.example.com',
            startedAt: new Date(now - 90_000),
            expiresAt: new Date(now - 30_000),
            createdAt: new Date(now - 20_000),
            updatedAt: new Date(now - 20_000),
          },
          {
            id: 'subscription-current',
            userId: 'user-1',
            status: SubscriptionStatus.ACTIVE,
            isTrial: true,
            planSnapshot: { name: 'Current', type: 'UNLIMITED', ignored: 'value' },
            trafficLimit: null,
            deviceLimit: 3,
            remnawaveId: null,
            configUrl: 'https://current.example.com',
            startedAt: new Date(now - 60_000),
            expiresAt: new Date(now + 60_000),
            createdAt: new Date(now - 60_000),
            updatedAt: new Date(now - 1_000),
          },
        ],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSubscription = await service.getSubscription({ email: 'user@example.com' });
    assert.deepStrictEqual(actualSubscription, {
      id: 'subscription-current',
      status: SubscriptionStatus.ACTIVE,
      isTrial: true,
      plan: {
        id: null,
        name: 'Current',
        type: 'UNLIMITED',
      },
      trafficLimit: null,
      trafficUsed: null,
      deviceLimit: 3,
      userRemnaId: null,
      profileName: null,
      url: 'https://current.example.com',
      configUrl: 'https://current.example.com',
      startedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 1_000).toISOString(),
    });
  });

  it('builds the aggregated search result from one resolved user snapshot', async () => {
    let userFindUniqueCallsCount: number = 0;
    let userFindManyCallsCount: number = 0;
    let subscriptionFindManyCallsCount: number = 0;
    let actualUserWhere: unknown;
    let actualInsensitiveUserWhere: unknown;
    let actualWebAccountWhere: unknown;
    let actualSubscriptionWhere: unknown;
    const now = Date.now();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          userFindUniqueCallsCount += 1;
          actualUserWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'user-1',
            telegramId: BigInt('123456789'),
            username: 'rezeis-user',
            name: 'Rezeis User',
            email: 'User@Example.com',
            role: 'USER',
            language: 'EN',
            personalDiscount: 0,
            purchaseDiscount: 0,
            points: 0,
            maxSubscriptions: 1,
            isBlocked: false,
            isBotBlocked: false,
            isRulesAccepted: true,
            createdAt: new Date(now - 10_000),
            updatedAt: new Date(now - 5_000),
            webAccount: {
              id: 'web-account-1',
              login: null,
              loginNormalized: null,
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date(now - 9_000),
              updatedAt: new Date(now - 4_000),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          userFindManyCallsCount += 1;
          actualInsensitiveUserWhere = (args[0] as { readonly where: unknown }).where;
          return [];
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          subscriptionFindManyCallsCount += 1;
          actualSubscriptionWhere = (args[0] as { readonly where: unknown }).where;
          return [];
        },
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSearchResult = await service.getSearchResult({ email: '  User@Example.com  ' });
    assert.equal(userFindUniqueCallsCount, 1);
    assert.equal(userFindManyCallsCount, 0);
    assert.equal(subscriptionFindManyCallsCount, 1);
    assert.deepStrictEqual(actualUserWhere, {
      email: 'user@example.com',
    });
    assert.equal(actualInsensitiveUserWhere, undefined);
    assert.equal(actualWebAccountWhere, undefined);
    assert.deepStrictEqual(actualSubscriptionWhere, {
      userId: 'user-1',
      status: {
        not: SubscriptionStatus.DELETED,
      },
    });
    assert.equal(actualSearchResult.session.email, 'User@Example.com');
    assert.equal(actualSearchResult.session.webAccount?.emailNormalized, 'user@example.com');
    assert.equal(actualSearchResult.subscription, null);
  });

  it('resolves a user by linked web-account login using the normalized login key', async () => {
    let actualWebAccountWhere: unknown;
    let actualUserWhere: unknown;
    const now = Date.now();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'web-account-1',
            userId: 'user-1',
            login: 'User_Login',
            loginNormalized: 'user_login',
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUserWhere = (args[0] as { readonly where: unknown }).where;
          return {
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
            createdAt: new Date(now - 10_000),
            updatedAt: new Date(now - 5_000),
            webAccount: {
              id: 'web-account-1',
              login: 'User_Login',
              loginNormalized: 'user_login',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date(now - 9_000),
              updatedAt: new Date(now - 4_000),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.getSession({ login: '  User_Login  ' });
    assert.deepStrictEqual(actualWebAccountWhere, {
      loginNormalized: 'user_login',
    });
    assert.deepStrictEqual(actualUserWhere, {
      id: 'user-1',
    });
    assert.equal(actualSession.webAccount?.login, 'User_Login');
    assert.equal(actualSession.webAccount?.loginNormalized, 'user_login');
  });

  it('rejects missing and ambiguous user identifiers with the same clear contract error', async () => {
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.getSession({});
      },
      {
        name: 'BadRequestException',
        message: 'Exactly one identifier must be provided: userId, telegramId, email, or login',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.getSession({
          email: 'user@example.com',
          telegramId: '123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'Exactly one identifier must be provided: userId, telegramId, email, or login',
      },
    );
  });

  it('prefers the normalized exact user email match before other email resolution branches', async () => {
    let actualUserEmailWhere: unknown;
    let actualInsensitiveWhere: unknown;
    let actualWebAccountWhere: unknown;
    let userFindManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'web-account-2',
            userId: 'user-2',
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUserEmailWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'user-1',
            telegramId: null,
            username: null,
            name: 'User',
            email: 'User@Example.com',
            role: 'USER',
            language: 'EN',
            personalDiscount: 0,
            purchaseDiscount: 0,
            points: 0,
            maxSubscriptions: 1,
            isBlocked: false,
            isBotBlocked: false,
            isRulesAccepted: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          userFindManyCallsCount += 1;
          actualInsensitiveWhere = (args[0] as { readonly where: unknown }).where;
          return [];
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.getSession({ email: '  User@Example.com  ' });
    assert.equal(userFindManyCallsCount, 0);
    assert.deepStrictEqual(actualUserEmailWhere, {
      email: 'user@example.com',
    });
    assert.equal(actualInsensitiveWhere, undefined);
    assert.equal(actualWebAccountWhere, undefined);
    assert.equal(actualSession.email, 'User@Example.com');
    assert.equal(actualSession.webAccount?.emailNormalized, 'user@example.com');
  });

  it('uses a single case-insensitive user email match when the normalized exact user email is absent', async () => {
    let actualExactUserWhere: unknown;
    let actualInsensitiveWhere: unknown;
    let actualWebAccountWhere: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualExactUserWhere = (args[0] as { readonly where: unknown }).where;
          return null;
        },
        findFirst: async (): Promise<unknown> => null,
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          actualInsensitiveWhere = (args[0] as { readonly where: unknown }).where;
          return [
            {
              id: 'user-1',
              telegramId: null,
              username: null,
              name: 'Case Match User',
              email: 'User@Example.com',
              role: 'USER',
              language: 'EN',
              personalDiscount: 0,
              purchaseDiscount: 0,
              points: 0,
              maxSubscriptions: 1,
              isBlocked: false,
              isBotBlocked: false,
              isRulesAccepted: true,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              webAccount: {
                id: 'web-account-1',
                email: 'user@example.com',
                emailNormalized: 'user@example.com',
                emailVerifiedAt: null,
                requiresPasswordChange: false,
                linkPromptSnoozeUntil: null,
                credentialsBootstrappedAt: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              },
            },
          ];
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.getSession({ email: '  User@Example.com  ' });
    assert.deepStrictEqual(actualExactUserWhere, {
      email: 'user@example.com',
    });
    assert.deepStrictEqual(actualInsensitiveWhere, {
      email: {
        equals: 'user@example.com',
        mode: 'insensitive',
      },
    });
    assert.equal(actualWebAccountWhere, undefined);
    assert.equal(actualSession.email, 'User@Example.com');
  });

  it('rejects ambiguous case-insensitive user email collisions', async () => {
    const prismaService: MockPrismaService = {
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
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [
          {
            id: 'user-1',
            webAccount: null,
          },
          {
            id: 'user-2',
            webAccount: null,
          },
        ],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.getSession({ email: '  User@Example.com  ' });
      },
      {
        name: 'BadRequestException',
        message: 'User email lookup is ambiguous',
      },
    );
  });

  it('falls back to normalized web account email when user email does not match', async () => {
    const actualUserWhereCalls: unknown[] = [];
    let actualWebAccountWhere: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'web-account-1',
            userId: 'user-1',
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUserWhereCalls.push((args[0] as { readonly where: unknown }).where);
          const where = (args[0] as { readonly where: { readonly email?: string; readonly id?: string } })
            .where;
          if (where.email !== undefined) {
            return null;
          }
          return {
            id: 'user-1',
            telegramId: null,
            username: null,
            name: 'Fallback User',
            email: null,
            role: 'USER',
            language: 'EN',
            personalDiscount: 0,
            purchaseDiscount: 0,
            points: 0,
            maxSubscriptions: 1,
            isBlocked: false,
            isBotBlocked: false,
            isRulesAccepted: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          };
        },
        findFirst: async (..._args: readonly unknown[]): Promise<unknown> => {
          return null;
        },
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          actualUserWhereCalls.push((args[0] as { readonly where: unknown }).where);
          return [];
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.getSession({ email: '  User@Example.com  ' });
    assert.deepStrictEqual(actualUserWhereCalls, [
      {
        email: 'user@example.com',
      },
      {
        email: {
          equals: 'user@example.com',
          mode: 'insensitive',
        },
      },
      { id: 'user-1' },
    ]);
    assert.deepStrictEqual(actualWebAccountWhere, {
      emailNormalized: 'user@example.com',
    });
    assert.equal(actualSession.email, null);
    assert.equal(actualSession.webAccount?.emailNormalized, 'user@example.com');
  });

  it('builds the aggregated search result through normalized web account email fallback', async () => {
    const actualUserWhereCalls: unknown[] = [];
    let actualWebAccountWhere: unknown;
    let actualSubscriptionWhere: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return {
            id: 'web-account-1',
            userId: 'user-1',
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUserWhereCalls.push((args[0] as { readonly where: unknown }).where);
          const where = (args[0] as { readonly where: { readonly email?: string; readonly id?: string } })
            .where;
          if (where.email !== undefined) {
            return null;
          }
          return {
            id: 'user-1',
            telegramId: null,
            username: null,
            name: 'Aggregate Fallback User',
            email: null,
            role: 'USER',
            language: 'EN',
            personalDiscount: 0,
            purchaseDiscount: 0,
            points: 0,
            maxSubscriptions: 1,
            isBlocked: false,
            isBotBlocked: false,
            isRulesAccepted: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          };
        },
        findFirst: async (..._args: readonly unknown[]): Promise<unknown> => {
          return null;
        },
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          actualUserWhereCalls.push((args[0] as { readonly where: unknown }).where);
          return [];
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (...args: readonly unknown[]): Promise<readonly unknown[]> => {
          actualSubscriptionWhere = (args[0] as { readonly where: unknown }).where;
          return [];
        },
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSearchResult = await service.getSearchResult({ email: '  User@Example.com  ' });
    assert.deepStrictEqual(actualUserWhereCalls, [
      {
        email: 'user@example.com',
      },
      {
        email: {
          equals: 'user@example.com',
          mode: 'insensitive',
        },
      },
      { id: 'user-1' },
    ]);
    assert.deepStrictEqual(actualWebAccountWhere, {
      emailNormalized: 'user@example.com',
    });
    assert.deepStrictEqual(actualSubscriptionWhere, {
      userId: 'user-1',
      status: {
        not: SubscriptionStatus.DELETED,
      },
    });
    assert.equal(actualSearchResult.session.email, null);
    assert.equal(actualSearchResult.session.webAccount?.emailNormalized, 'user@example.com');
    assert.equal(actualSearchResult.subscription, null);
  });

  it('marks rules as accepted and returns the refreshed session payload', async () => {
    let findUniqueCallsCount: number = 0;
    let findFirstCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    let actualUpdateWhere: unknown;
    let actualUpdateData: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          if (findUniqueCallsCount === 1) {
            return {
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
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
              webAccount: null,
            };
          }
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: null,
          };
        },
        findFirst: async (): Promise<unknown> => {
          findFirstCallsCount += 1;
          return null;
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          updateManyCallsCount += 1;
          const updateArgs = args[0] as {
            readonly where: unknown;
            readonly data: unknown;
          };
          actualUpdateWhere = updateArgs.where;
          actualUpdateData = updateArgs.data;
          return { count: 1 };
        },
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.acceptRules({ userId: '11111111-1111-1111-1111-111111111111' });
    assert.equal(findUniqueCallsCount, 1);
    assert.equal(findFirstCallsCount, 0);
    assert.equal(updateManyCallsCount, 1);
    assert.deepStrictEqual(actualUpdateWhere, {
      id: '11111111-1111-1111-1111-111111111111',
      isRulesAccepted: false,
    });
    assert.deepStrictEqual(actualUpdateData, {
      isRulesAccepted: true,
    });
    assert.equal(actualSession.isRulesAccepted, true);
    assert.equal(actualSession.updatedAt, '2026-04-17T05:00:00.000Z');
  });

  it('returns the current session unchanged when rules are already accepted', async () => {
    let findUniqueCallsCount: number = 0;
    let findFirstCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    let actualUpdateWhere: unknown;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return {
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
            updatedAt: new Date('2026-04-16T10:00:00.000Z'),
            webAccount: null,
          };
        },
        findFirst: async (): Promise<unknown> => {
          findFirstCallsCount += 1;
          return null;
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          updateManyCallsCount += 1;
          actualUpdateWhere = (args[0] as { readonly where: unknown }).where;
          return { count: 0 };
        },
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    const actualSession = await service.acceptRules({ userId: '11111111-1111-1111-1111-111111111111' });
    assert.equal(findUniqueCallsCount, 1);
    assert.equal(findFirstCallsCount, 0);
    assert.equal(updateManyCallsCount, 1);
    assert.deepStrictEqual(actualUpdateWhere, {
      id: '11111111-1111-1111-1111-111111111111',
      isRulesAccepted: false,
    });
    assert.equal(actualSession.isRulesAccepted, true);
    assert.equal(actualSession.updatedAt, '2026-04-16T10:00:00.000Z');
  });

  it('snoozes the linked web-account prompt forward and returns the refreshed session payload', async () => {
    let findUniqueCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    let actualUpdateWhere: unknown;
    let actualUpdateData: unknown;
    const refreshedLinkPromptSnoozeUntil = new Date('2026-04-24T05:00:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => new Date('2026-04-17T05:00:00.000Z').getTime();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          updateManyCallsCount += 1;
          const updateArgs = args[0] as {
            readonly where: unknown;
            readonly data: unknown;
          };
          actualUpdateWhere = updateArgs.where;
          actualUpdateData = updateArgs.data;
          return { count: 1 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          const linkPromptSnoozeUntil =
            findUniqueCallsCount === 1 ? null : refreshedLinkPromptSnoozeUntil;
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              login: findUniqueCallsCount === 1 ? null : 'New-Login',
              loginNormalized: findUniqueCallsCount === 1 ? null : 'new-login',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      const actualSession = await service.snoozeWebAccountLinkPrompt({
        userId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(findUniqueCallsCount, 2);
      assert.equal(updateManyCallsCount, 1);
      assert.deepStrictEqual(actualUpdateWhere, {
        userId: '11111111-1111-1111-1111-111111111111',
        requiresPasswordChange: false,
        credentialsBootstrappedAt: null,
        OR: [
          {
            linkPromptSnoozeUntil: null,
          },
          {
            linkPromptSnoozeUntil: {
              lt: refreshedLinkPromptSnoozeUntil,
            },
          },
        ],
      });
      assert.deepStrictEqual(actualUpdateData, {
        linkPromptSnoozeUntil: refreshedLinkPromptSnoozeUntil,
      });
      assert.equal(
        actualSession.webAccount?.linkPromptSnoozeUntil,
        refreshedLinkPromptSnoozeUntil.toISOString(),
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('returns the refreshed session unchanged when the web-account prompt is already snoozed further ahead', async () => {
    let findUniqueCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    let actualUpdateWhere: unknown;
    const existingLinkPromptSnoozeUntil = new Date('2026-04-30T05:00:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => new Date('2026-04-17T05:00:00.000Z').getTime();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          updateManyCallsCount += 1;
          actualUpdateWhere = (args[0] as { readonly where: unknown }).where;
          return { count: 0 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              login: findUniqueCallsCount === 1 ? null : 'New-Login',
              loginNormalized: findUniqueCallsCount === 1 ? null : 'new-login',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: existingLinkPromptSnoozeUntil,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      const actualSession = await service.snoozeWebAccountLinkPrompt({
        userId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(findUniqueCallsCount, 1);
      assert.equal(updateManyCallsCount, 0);
      assert.equal(actualUpdateWhere, undefined);
      assert.equal(
        actualSession.webAccount?.linkPromptSnoozeUntil,
        existingLinkPromptSnoozeUntil.toISOString(),
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects the snooze write path when the resolved user has no web account', async () => {
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 0 };
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: null,
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.snoozeWebAccountLinkPrompt({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount must exist',
      },
    );
    assert.equal(updateManyCallsCount, 0);
  });

  it('rejects the snooze write path when the linked web account is already ready', async () => {
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 0 };
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            email: 'user@example.com',
            emailNormalized: 'user@example.com',
            emailVerifiedAt: new Date('2026-04-01T01:00:00.000Z'),
            requiresPasswordChange: false,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: new Date('2026-04-01T01:00:00.000Z'),
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.snoozeWebAccountLinkPrompt({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount link prompt is not actionable',
      },
    );
    assert.equal(updateManyCallsCount, 0);
  });

  it('sets the linked web-account password and returns the refreshed session payload', async () => {
    let findUniqueCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    let actualHashInput: unknown;
    let actualUpdateWhere: unknown;
    let actualUpdateData: unknown;
    const handoffCompletedAt = new Date('2026-04-17T05:00:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => handoffCompletedAt.getTime();
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          updateManyCallsCount += 1;
          const updateArgs = args[0] as {
            readonly where: unknown;
            readonly data: unknown;
          };
          actualUpdateWhere = updateArgs.where;
          actualUpdateData = updateArgs.data;
          return { count: 1 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          const credentialsBootstrappedAt =
            findUniqueCallsCount === 1 ? null : handoffCompletedAt;
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              login: findUniqueCallsCount === 1 ? null : 'New-Login',
              loginNormalized: findUniqueCallsCount === 1 ? null : 'new-login',
              requiresPasswordChange: findUniqueCallsCount === 1,
              linkPromptSnoozeUntil:
                findUniqueCallsCount === 1 ? new Date('2026-04-20T05:00:00.000Z') : null,
              credentialsBootstrappedAt,
              temporaryPasswordExpiresAt: null,
              passwordHash: null,
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (...args: readonly unknown[]): Promise<string> => {
        actualHashInput = args[0];
        return 'hashed-password';
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        passwordHashService as PasswordHashService,
        createEmailServiceMock(),
      );
      const actualSession = await service.setWebAccountPassword({
        userId: '11111111-1111-1111-1111-111111111111',
        login: 'New-Login',
        password: 'new-password-123',
      });
      assert.equal(findUniqueCallsCount, 2);
      assert.equal(updateManyCallsCount, 1);
      assert.deepStrictEqual(actualHashInput, {
        plainTextPassword: 'new-password-123',
      });
      assert.deepStrictEqual(actualUpdateWhere, {
        userId: '11111111-1111-1111-1111-111111111111',
        requiresPasswordChange: true,
        credentialsBootstrappedAt: null,
      });
      assert.deepStrictEqual(actualUpdateData, {
        login: 'New-Login',
        loginNormalized: 'new-login',
        passwordHash: 'hashed-password',
        credentialsBootstrappedAt: handoffCompletedAt,
        requiresPasswordChange: false,
        temporaryPasswordExpiresAt: null,
        linkPromptSnoozeUntil: null,
      });
      assert.equal(actualSession.webAccount?.requiresPasswordChange, false);
      assert.equal(actualSession.webAccount?.login, 'New-Login');
      assert.equal(actualSession.webAccount?.loginNormalized, 'new-login');
      assert.equal(actualSession.webAccount?.linkPromptSnoozeUntil, null);
      assert.equal(actualSession.webAccount?.credentialsBootstrappedAt, handoffCompletedAt.toISOString());
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('preserves an existing bootstrap timestamp while replacing the linked web-account password', async () => {
    let actualUpdateData: unknown;
    const existingCredentialsBootstrappedAt = new Date('2026-04-01T01:00:00.000Z');
    let findUniqueCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUpdateData = (args[0] as { readonly data: unknown }).data;
          return { count: 1 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              login: 'existing-login',
              loginNormalized: 'existing-login',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: true,
              linkPromptSnoozeUntil: findUniqueCallsCount === 1 ? new Date('2026-04-20T05:00:00.000Z') : null,
              credentialsBootstrappedAt: existingCredentialsBootstrappedAt,
              temporaryPasswordExpiresAt: new Date('2026-04-18T05:00:00.000Z'),
              passwordHash: 'old-password-hash',
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => 'hashed-password',
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await service.setWebAccountPassword({
      userId: '11111111-1111-1111-1111-111111111111',
      login: 'next-login',
      password: 'new-password-123',
    });
    assert.deepStrictEqual(actualUpdateData, {
      login: 'next-login',
      loginNormalized: 'next-login',
      passwordHash: 'hashed-password',
      credentialsBootstrappedAt: existingCredentialsBootstrappedAt,
      requiresPasswordChange: false,
      temporaryPasswordExpiresAt: null,
      linkPromptSnoozeUntil: null,
    });
  });

  it('rejects the password handoff write path when the guarded update affects zero rows', async () => {
    let findUniqueCallsCount: number = 0;
    let hashPasswordCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 0 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return {
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
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            webAccount: {
              id: 'web-account-1',
              login: null,
              loginNormalized: null,
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: true,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              temporaryPasswordExpiresAt: null,
              passwordHash: null,
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: new Date('2026-04-17T05:00:00.000Z'),
            },
          };
        },
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          userId: '11111111-1111-1111-1111-111111111111',
          login: 'new-login',
          password: 'new-password-123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount password handoff is not actionable',
      },
    );
    assert.equal(findUniqueCallsCount, 1);
    assert.equal(hashPasswordCallsCount, 1);
    assert.equal(updateManyCallsCount, 1);
  });

  it('rejects the password handoff write path when the linked login is already taken', async () => {
    let hashPasswordCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test-client',
            meta: { target: ['loginNormalized'] },
          });
          throw error;
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            login: null,
            loginNormalized: null,
            email: 'user@example.com',
            emailNormalized: 'user@example.com',
            emailVerifiedAt: null,
            requiresPasswordChange: true,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: null,
            temporaryPasswordExpiresAt: null,
            passwordHash: null,
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          userId: '11111111-1111-1111-1111-111111111111',
          login: 'taken-login',
          password: 'new-password-123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount login is already taken',
      },
    );
    assert.equal(hashPasswordCallsCount, 1);
    assert.equal(updateManyCallsCount, 1);
  });

  it('rejects the password handoff write path when the login is invalid after trimming', async () => {
    let hashPasswordCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 1 };
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            login: null,
            loginNormalized: null,
            email: 'user@example.com',
            emailNormalized: 'user@example.com',
            emailVerifiedAt: null,
            requiresPasswordChange: true,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: null,
            temporaryPasswordExpiresAt: null,
            passwordHash: null,
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          userId: '11111111-1111-1111-1111-111111111111',
          login: '   ',
          password: 'new-password-123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount login is invalid',
      },
    );
    assert.equal(hashPasswordCallsCount, 0);
    assert.equal(updateManyCallsCount, 0);
  });

  it('rejects the password handoff write path when the resolved user has no web account', async () => {
    let hashPasswordCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 0 };
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: null,
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          userId: '11111111-1111-1111-1111-111111111111',
          login: 'new-login',
          password: 'new-password-123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount must exist',
      },
    );
    assert.equal(hashPasswordCallsCount, 0);
    assert.equal(updateManyCallsCount, 0);
  });

  it('rejects the password handoff write path when the linked web account is already ready', async () => {
    let hashPasswordCallsCount: number = 0;
    let updateManyCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateManyCallsCount += 1;
          return { count: 0 };
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            login: 'ready-login',
            loginNormalized: 'ready-login',
            email: 'user@example.com',
            emailNormalized: 'user@example.com',
            emailVerifiedAt: new Date('2026-04-01T01:00:00.000Z'),
            requiresPasswordChange: false,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: new Date('2026-04-01T01:00:00.000Z'),
            temporaryPasswordExpiresAt: null,
            passwordHash: 'password-hash',
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          userId: '11111111-1111-1111-1111-111111111111',
          login: 'new-login',
          password: 'new-password-123',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount link prompt is not actionable',
      },
    );
    assert.equal(hashPasswordCallsCount, 0);
    assert.equal(updateManyCallsCount, 0);
  });

  it('rejects non-canonical identifiers on the password handoff write path', async () => {
    let findUniqueCallsCount: number = 0;
    let findFirstCallsCount: number = 0;
    let hashPasswordCallsCount: number = 0;
    let updateCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateCallsCount += 1;
          return { count: 0 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return null;
        },
        findFirst: async (): Promise<unknown> => {
          findFirstCallsCount += 1;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'hashed-password';
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          email: 'user@example.com',
          login: 'new-login',
          password: 'new-password-123',
        } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.setWebAccountPassword({
          telegramId: '123456789',
          login: 'new-login',
          password: 'new-password-123',
        } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    assert.equal(findUniqueCallsCount, 0);
    assert.equal(findFirstCallsCount, 0);
    assert.equal(hashPasswordCallsCount, 0);
    assert.equal(updateCallsCount, 0);
  });

  it('rejects non-canonical identifiers on the web-account prompt snooze write path', async () => {
    let findUniqueCallsCount: number = 0;
    let findFirstCallsCount: number = 0;
    let updateCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => {
          updateCallsCount += 1;
          return { count: 0 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return null;
        },
        findFirst: async (): Promise<unknown> => {
          findFirstCallsCount += 1;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.snoozeWebAccountLinkPrompt({ email: 'user@example.com' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.snoozeWebAccountLinkPrompt({ telegramId: '123456789' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    assert.equal(findUniqueCallsCount, 0);
    assert.equal(findFirstCallsCount, 0);
    assert.equal(updateCallsCount, 0);
  });

  it('rejects non-canonical identifiers on the rules acceptance write path', async () => {
    let findUniqueCallsCount: number = 0;
    let findFirstCallsCount: number = 0;
    let updateCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          findUniqueCallsCount += 1;
          return null;
        },
        findFirst: async (): Promise<unknown> => {
          findFirstCallsCount += 1;
          return null;
        },
        updateMany: async (): Promise<unknown> => {
          updateCallsCount += 1;
          return { count: 0 };
        },
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.acceptRules({ email: 'user@example.com' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.acceptRules({ telegramId: '123456789' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    assert.equal(findUniqueCallsCount, 0);
    assert.equal(findFirstCallsCount, 0);
    assert.equal(updateCallsCount, 0);
  });

  it('issues an email verification challenge for the linked unverified web account', async () => {
    let transactionCallsCount: number = 0;
    let userFindUniqueCallsCount: number = 0;
    let authChallengeCreateCallsCount: number = 0;
    let authChallengeCleanupCallsCount: number = 0;
    let emailSendCallsCount: number = 0;
    let lockCallsCount: number = 0;
    let actualLockQuery: unknown;
    let actualCleanupArgs: unknown;
    let actualCreateData: Record<string, unknown> | undefined;
    let actualDeliveredCode: string | undefined;
    let actualDeliveredEmailAddress: string | undefined;
    let actualDeliveredExpiresAt: Date | undefined;
    const actualOperationOrder: string[] = [];
    const beforeLockAt = new Date('2026-04-17T05:00:00.000Z');
    const lockedAt = new Date('2026-04-17T05:02:00.000Z');
    const expiresAt = new Date('2026-04-17T05:17:00.000Z');
    const originalDateNow = Date.now;
    let currentTime = beforeLockAt;
    Date.now = (): number => currentTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          authChallengeCreateCallsCount += 1;
          actualOperationOrder.push('create');
          actualCreateData = createData;
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: lockedAt,
          };
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCleanupCallsCount += 1;
          actualOperationOrder.push('cleanup');
          actualCleanupArgs = args[0];
          return { count: 0 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          userFindUniqueCallsCount += 1;
          return {
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
            updatedAt: lockedAt,
            webAccount: {
              id: 'web-account-1',
              userId: '11111111-1111-1111-1111-111111111111',
              email: 'user@example.com',
              emailNormalized: 'user@example.com',
              emailVerifiedAt: null,
              requiresPasswordChange: false,
              linkPromptSnoozeUntil: null,
              credentialsBootstrappedAt: null,
              createdAt: new Date('2026-04-01T00:30:00.000Z'),
              updatedAt: lockedAt,
            },
          };
        },
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => ({
          id: 'web-account-1',
          userId: '11111111-1111-1111-1111-111111111111',
          email: 'user@example.com',
          emailNormalized: 'user@example.com',
          emailVerifiedAt: null,
          requiresPasswordChange: false,
          linkPromptSnoozeUntil: null,
          credentialsBootstrappedAt: null,
          createdAt: new Date('2026-04-01T00:30:00.000Z'),
          updatedAt: lockedAt,
        }),
      },
      $queryRaw: async (...args: readonly unknown[]): Promise<unknown> => {
        lockCallsCount += 1;
        actualLockQuery = args[0];
        currentTime = lockedAt;
        return [{ id: 'web-account-1' }];
      },
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const emailService = createEmailServiceMock({
      sendLinkedAccountVerificationCode: async (...args: readonly unknown[]): Promise<void> => {
        emailSendCallsCount += 1;
        const input = args[0] as {
          readonly emailAddress: string;
          readonly code: string;
          readonly expiresAt: Date;
        };
        actualDeliveredEmailAddress = input.emailAddress;
        actualDeliveredCode = input.code;
        actualDeliveredExpiresAt = input.expiresAt;
      },
    });
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        emailService,
      );
      const actualResponse = await service.issueWebAccountEmailVerificationChallenge({
        userId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(transactionCallsCount, 1);
      assert.equal(userFindUniqueCallsCount, 1);
      assert.equal(lockCallsCount, 1);
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(authChallengeCleanupCallsCount, 1);
      assert.equal(emailSendCallsCount, 1);
      assert.ok(actualLockQuery);
      assert.match(String((actualLockQuery as { readonly strings: readonly string[] }).strings.join('')), /FOR UPDATE/);
      assert.deepStrictEqual(actualOperationOrder, ['cleanup', 'create']);
      assert.deepStrictEqual(actualCleanupArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'email_verify',
          channel: 'email',
          consumedAt: null,
          expiresAt: {
            gt: lockedAt,
          },
        },
        data: {
          consumedAt: lockedAt,
        },
      });
      assert.equal(actualCreateData?.webAccountId, 'web-account-1');
      assert.equal(actualCreateData?.purpose, 'email_verify');
      assert.equal(actualCreateData?.channel, 'email');
      assert.equal(actualCreateData?.destination, 'user@example.com');
      assert.equal((actualCreateData?.expiresAt as Date).getTime(), expiresAt.getTime());
      assert.equal(actualCreateData?.attemptsLeft, 5);
      assert.equal(typeof actualCreateData?.codeHash, 'string');
      assert.equal(typeof actualCreateData?.tokenHash, 'string');
      assert.notEqual(actualCreateData?.codeHash, actualCreateData?.tokenHash);
      assert.equal(actualDeliveredEmailAddress, 'user@example.com');
      assert.equal(actualDeliveredExpiresAt?.getTime(), expiresAt.getTime());
      assert.match(actualDeliveredCode ?? '', /^\d{6}$/);
      assert.equal(actualCreateData?.codeHash, createChallengeHashForTest(actualDeliveredCode ?? ''));
      assert.deepStrictEqual(actualResponse, {
        webAccountId: 'web-account-1',
        email: 'user@example.com',
        challengeExpiresAt: expiresAt.toISOString(),
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('revokes duplicate pending email verification challenges before creating a fresh one', async () => {
    let authChallengeCreateCallsCount: number = 0;
    let authChallengeCleanupCallsCount: number = 0;
    let actualCleanupArgs: unknown;
    let actualCreateData: Record<string, unknown> | undefined;
    const actualOperationOrder: string[] = [];
    const beforeLockAt = new Date('2026-04-17T05:00:00.000Z');
    const lockedAt = new Date('2026-04-17T05:03:00.000Z');
    const rotatedExpiresAt = new Date('2026-04-17T05:18:00.000Z');
    const originalDateNow = Date.now;
    let currentTime = beforeLockAt;
    Date.now = (): number => currentTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          actualOperationOrder.push('create');
          actualCreateData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'challenge-3',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: actualCreateData.codeHash,
            tokenHash: actualCreateData.tokenHash,
            expiresAt: rotatedExpiresAt,
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: lockedAt,
          };
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCleanupCallsCount += 1;
          actualOperationOrder.push('cleanup');
          actualCleanupArgs = args[0];
          return { count: 2 };
        },
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
          updatedAt: lockedAt,
          webAccount: {
            id: 'web-account-1',
            userId: '11111111-1111-1111-1111-111111111111',
            email: null,
            emailNormalized: 'user@example.com',
            emailVerifiedAt: null,
            requiresPasswordChange: false,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: null,
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: lockedAt,
          },
        }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => ({
          id: 'web-account-1',
          userId: '11111111-1111-1111-1111-111111111111',
          email: null,
          emailNormalized: 'user@example.com',
          emailVerifiedAt: null,
          requiresPasswordChange: false,
          linkPromptSnoozeUntil: null,
          credentialsBootstrappedAt: null,
          createdAt: new Date('2026-04-01T00:30:00.000Z'),
          updatedAt: lockedAt,
        }),
      },
      $queryRaw: async (): Promise<unknown> => {
        currentTime = lockedAt;
        return [{ id: 'web-account-1' }];
      },
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      const actualResponse = await service.issueWebAccountEmailVerificationChallenge({
        userId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(authChallengeCleanupCallsCount, 1);
      assert.deepStrictEqual(actualOperationOrder, ['cleanup', 'create']);
      assert.deepStrictEqual(actualCleanupArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'email_verify',
          channel: 'email',
          consumedAt: null,
          expiresAt: {
            gt: lockedAt,
          },
        },
        data: {
          consumedAt: lockedAt,
        },
      });
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(actualCreateData?.destination, 'user@example.com');
      assert.equal((actualCreateData?.expiresAt as Date).getTime(), rotatedExpiresAt.getTime());
      assert.deepStrictEqual(actualResponse, {
        webAccountId: 'web-account-1',
        email: 'user@example.com',
        challengeExpiresAt: rotatedExpiresAt.toISOString(),
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('fails challenge issuance when email delivery fails after the challenge is stored', async () => {
    let authChallengeCreateCallsCount: number = 0;
    let authChallengeCompensationCallsCount: number = 0;
    let emailSendCallsCount: number = 0;
    let actualCompensationArgs: unknown;
    const expiresAt = new Date('2026-04-17T05:17:00.000Z');
    const revokedAt = new Date('2026-04-17T05:03:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => revokedAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: new Date('2026-04-17T05:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCompensationCallsCount += 1;
          actualCompensationArgs = args[0];
          return { count: 1 };
        },
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const emailService = createEmailServiceMock({
      sendLinkedAccountVerificationCode: async (): Promise<void> => {
        emailSendCallsCount += 1;
        throw new EmailDeliveryException(
          'failed to deliver transactional email',
          'definitely-not-delivered',
        );
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
    );
    try {
      await assert.rejects(
        async (): Promise<void> => {
          await service.issueWebAccountEmailVerificationChallenge({
            userId: '11111111-1111-1111-1111-111111111111',
          });
        },
        {
          name: 'EmailDeliveryException',
          message: 'failed to deliver transactional email',
        },
      );
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(emailSendCallsCount, 1);
      assert.equal(authChallengeCompensationCallsCount, 1);
      assert.deepStrictEqual(actualCompensationArgs, {
        where: {
          id: 'challenge-1',
          consumedAt: null,
        },
        data: {
          consumedAt: revokedAt,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('keeps the delivery failure primary and hides revoke diagnostics when the compensating revoke also fails', async () => {
    const deliveryError = new EmailDeliveryException(
      'failed to deliver transactional email',
      'definitely-not-delivered',
    );
    const revokeError = new Error(
      'failed to revoke issued challenge postgres://admin:secret-password@db.internal/auth token=raw-revoke-token',
    );
    const originalDateNow = Date.now;
    Date.now = (): number => new Date('2026-04-17T05:03:00.000Z').getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt: new Date('2026-04-17T05:17:00.000Z'),
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: new Date('2026-04-17T05:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => {
          throw revokeError;
        },
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const emailService = createEmailServiceMock({
      sendLinkedAccountVerificationCode: async (): Promise<void> => {
        throw deliveryError;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
    );
    try {
      let actualError: unknown;
      try {
        await service.issueWebAccountEmailVerificationChallenge({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      } catch (err: unknown) {
        actualError = err;
      }
      assert.ok(actualError);
      assert.equal(actualError, deliveryError);
      assert.equal(
        (actualError as Error & { revokeError?: unknown }).revokeError,
        'ISSUED_CHALLENGE_REVOKE_FAILED',
      );
      assert.deepStrictEqual(
        (actualError as Error & { suppressedErrors?: readonly unknown[] }).suppressedErrors,
        ['ISSUED_CHALLENGE_REVOKE_FAILED'],
      );
      const serializedError = JSON.stringify(actualError);
      assert.doesNotMatch(serializedError, /secret-password/);
      assert.doesNotMatch(serializedError, /postgres:\/\//);
      assert.doesNotMatch(serializedError, /raw-revoke-token/);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('does not revoke a challenge when SMTP delivery status is uncertain', async () => {
    let authChallengeCompensationCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt: new Date('2026-04-17T05:17:00.000Z'),
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: new Date('2026-04-17T05:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => {
          authChallengeCompensationCallsCount += 1;
          return { count: 1 };
        },
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const emailService = createEmailServiceMock({
      sendLinkedAccountVerificationCode: async (): Promise<void> => {
        throw new EmailDeliveryException(
          'failed to deliver transactional email',
          'possibly-delivered',
        );
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'EmailDeliveryException',
        message: 'failed to deliver transactional email',
      },
    );
    assert.equal(authChallengeCompensationCallsCount, 0);
  });

  it('revokes a just-created challenge when the persisted recipient email is malformed', async () => {
    let authChallengeCreateCallsCount: number = 0;
    let authChallengeCompensationCallsCount: number = 0;
    let actualCompensationArgs: unknown;
    const expiresAt = new Date('2026-04-17T05:17:00.000Z');
    const revokedAt = new Date('2026-04-17T05:03:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => revokedAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: createData.destination,
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: new Date('2026-04-17T05:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createInternalUserRecord({
            emailVerifiedAt: null,
            webAccount: {
              ...createWebAccountRecord({ emailVerifiedAt: null }),
              email: 'user@example.com\r\nBCC:evil@example.com',
              emailNormalized: 'user@example.com\r\nBCC:evil@example.com',
            },
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => ({
          ...createWebAccountRecord({ emailVerifiedAt: null }),
          email: 'user@example.com\r\nBCC:evil@example.com',
          emailNormalized: 'user@example.com\r\nBCC:evil@example.com',
        }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCompensationCallsCount += 1;
          actualCompensationArgs = args[0];
          return { count: 1 };
        },
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const emailService = new EmailService();
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
    );
    try {
      await assert.rejects(
        async (): Promise<void> => {
          await service.issueWebAccountEmailVerificationChallenge({
            userId: '11111111-1111-1111-1111-111111111111',
          });
        },
        {
          name: 'EmailDeliveryException',
          message: 'Refusing to send verification code: invalid email address',
        },
      );
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(authChallengeCompensationCallsCount, 1);
      assert.deepStrictEqual(actualCompensationArgs, {
        where: {
          id: 'challenge-1',
          consumedAt: null,
        },
        data: {
          consumedAt: revokedAt,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects non-canonical identifiers on the email verification issuance write path', async () => {
    let transactionCallsCount: number = 0;
    let authChallengeCreateCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          return null;
        },
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({ email: 'user@example.com' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({ telegramId: '123456789' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    assert.equal(transactionCallsCount, 0);
    assert.equal(authChallengeCreateCallsCount, 0);
  });

  it('completes email verification for the latest actionable linked web account challenge and returns the refreshed session', async () => {
    let transactionCallsCount: number = 0;
    let userFindUniqueCallsCount: number = 0;
    let authChallengeFindFirstCallsCount: number = 0;
    let authChallengeUpdateCallsCount: number = 0;
    let webAccountUpdateCallsCount: number = 0;
    let lockCallsCount: number = 0;
    let actualChallengeLookupArgs: unknown;
    let actualChallengeUpdateArgs: unknown;
    let actualWebAccountUpdateArgs: unknown;
    let currentUserReadIndex: number = 0;
    const completedAt = new Date('2026-04-18T08:30:00.000Z');
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          actualChallengeLookupArgs = args[0];
          return {
            id: 'challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'email_verify',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: createChallengeHashForTest('123456'),
            tokenHash: createChallengeHashForTest('token-1'),
            expiresAt: new Date('2026-04-18T08:45:00.000Z'),
            consumedAt: null,
            attemptsLeft: 5,
            meta: null,
            createdAt: new Date('2026-04-18T08:20:00.000Z'),
          };
        },
        create: async (): Promise<unknown> => null,
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          actualChallengeUpdateArgs = args[0];
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          userFindUniqueCallsCount += 1;
          currentUserReadIndex += 1;
          if (currentUserReadIndex === 1) {
            return createInternalUserRecord({ emailVerifiedAt: null, updatedAt: new Date('2026-04-18T08:25:00.000Z') });
          }
          return createInternalUserRecord({
            emailVerifiedAt: completedAt,
            updatedAt: completedAt,
            credentialsBootstrappedAt: new Date('2026-04-18T08:00:00.000Z'),
          });
        },
      },
      webAccount: {
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          webAccountUpdateCallsCount += 1;
          actualWebAccountUpdateArgs = args[0];
          return null;
        },
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => {
        lockCallsCount += 1;
        return [{ id: 'web-account-1' }];
      },
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const originalDateNow = Date.now;
    Date.now = (): number => completedAt.getTime();
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      const actualResponse = await service.completeWebAccountEmailVerification({
        userId: '11111111-1111-1111-1111-111111111111',
        code: '123456',
      });
      assert.equal(transactionCallsCount, 1);
      assert.equal(userFindUniqueCallsCount, 2);
      assert.equal(lockCallsCount, 1);
      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(authChallengeUpdateCallsCount, 1);
      assert.equal(webAccountUpdateCallsCount, 1);
      assert.deepStrictEqual(actualChallengeLookupArgs, {
        where: {
          webAccountId: 'web-account-1',
          destination: 'user@example.com',
          purpose: 'email_verify',
          channel: 'email',
          consumedAt: null,
          expiresAt: {
            gt: completedAt,
          },
          attemptsLeft: {
            gt: 0,
          },
          codeHash: {
            not: null,
          },
        },
        orderBy: [{ createdAt: 'desc' }],
      });
      assert.deepStrictEqual(actualChallengeUpdateArgs, {
        where: {
          id: 'challenge-1',
        },
        data: {
          consumedAt: completedAt,
        },
      });
      assert.deepStrictEqual(actualWebAccountUpdateArgs, {
        where: {
          id: 'web-account-1',
        },
        data: {
          emailVerifiedAt: completedAt,
        },
      });
      assert.deepStrictEqual(actualResponse, mapExpectedInternalSession({
        emailVerifiedAt: completedAt.toISOString(),
        updatedAt: completedAt.toISOString(),
        credentialsBootstrappedAt: '2026-04-18T08:00:00.000Z',
      }));
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects email verification completion when the resolved user has no web account', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ webAccount: null }),
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        findUnique: async (): Promise<unknown> => null,
      },
      $queryRaw: async (): Promise<unknown> => [],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.completeWebAccountEmailVerification({
          userId: '11111111-1111-1111-1111-111111111111',
          code: '123456',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount must exist',
      },
    );
    assert.equal(authChallengeFindFirstCallsCount, 0);
  });

  it('rejects email verification completion when the linked web account is already verified', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: new Date('2026-04-01T01:00:00.000Z') }),
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        findUnique: async (): Promise<unknown> => null,
      },
      $queryRaw: async (): Promise<unknown> => [],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.completeWebAccountEmailVerification({
          userId: '11111111-1111-1111-1111-111111111111',
          code: '123456',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount email is already verified',
      },
    );
    assert.equal(authChallengeFindFirstCallsCount, 0);
  });

  it('rejects email verification completion when no active code challenge exists', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    let authChallengeUpdateCallsCount: number = 0;
    const currentTime = new Date('2026-04-18T08:30:00.000Z');
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const originalDateNow = Date.now;
    Date.now = (): number => currentTime.getTime();
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      await assert.rejects(
        async (): Promise<void> => {
          await service.completeWebAccountEmailVerification({
            userId: '11111111-1111-1111-1111-111111111111',
            code: '123456',
          });
        },
        {
          name: 'BadRequestException',
          message: 'active email verification challenge not found',
        },
      );
      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(authChallengeUpdateCallsCount, 0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects email verification completion when only a stale challenge for a previous email exists', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    let authChallengeUpdateCallsCount: number = 0;
    let actualChallengeLookupArgs: unknown;
    const currentTime = new Date('2026-04-18T08:30:00.000Z');
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          actualChallengeLookupArgs = args[0];
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        findUnique: async (): Promise<unknown> => ({
          ...createWebAccountRecord({ emailVerifiedAt: null }),
          email: 'current@example.com',
          emailNormalized: 'current@example.com',
        }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const originalDateNow = Date.now;
    Date.now = (): number => currentTime.getTime();
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      await assert.rejects(
        async (): Promise<void> => {
          await service.completeWebAccountEmailVerification({
            userId: '11111111-1111-1111-1111-111111111111',
            code: '123456',
          });
        },
        {
          name: 'BadRequestException',
          message: 'active email verification challenge not found',
        },
      );
      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(authChallengeUpdateCallsCount, 0);
      assert.deepStrictEqual(actualChallengeLookupArgs, {
        where: {
          webAccountId: 'web-account-1',
          destination: 'current@example.com',
          purpose: 'email_verify',
          channel: 'email',
          consumedAt: null,
          expiresAt: {
            gt: currentTime,
          },
          attemptsLeft: {
            gt: 0,
          },
          codeHash: {
            not: null,
          },
        },
        orderBy: [{ createdAt: 'desc' }],
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('decrements attempts left when the submitted email verification code is wrong', async () => {
    let authChallengeUpdateCallsCount: number = 0;
    let webAccountUpdateCallsCount: number = 0;
    let actualChallengeUpdateArgs: unknown;
    const failureTime = new Date('2026-04-18T08:30:00.000Z');
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => ({
          id: 'challenge-1',
          webAccountId: 'web-account-1',
          purpose: 'email_verify',
          channel: 'email',
          destination: 'user@example.com',
          codeHash: createChallengeHashForTest('654321'),
          tokenHash: createChallengeHashForTest('token-1'),
          expiresAt: new Date('2026-04-18T08:45:00.000Z'),
          consumedAt: null,
          attemptsLeft: 3,
          meta: null,
          createdAt: new Date('2026-04-18T08:20:00.000Z'),
        }),
        create: async (): Promise<unknown> => null,
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          actualChallengeUpdateArgs = args[0];
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        update: async (): Promise<unknown> => {
          webAccountUpdateCallsCount += 1;
          return null;
        },
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const originalDateNow = Date.now;
    Date.now = (): number => failureTime.getTime();
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      await assert.rejects(
        async (): Promise<void> => {
          await service.completeWebAccountEmailVerification({
            userId: '11111111-1111-1111-1111-111111111111',
            code: '123456',
          });
        },
        {
          name: 'BadRequestException',
          message: 'invalid email verification code',
        },
      );
      assert.equal(authChallengeUpdateCallsCount, 1);
      assert.equal(webAccountUpdateCallsCount, 0);
      assert.deepStrictEqual(actualChallengeUpdateArgs, {
        where: {
          id: 'challenge-1',
        },
        data: {
          attemptsLeft: 2,
          consumedAt: null,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('consumes the challenge when the wrong email verification code exhausts attempts', async () => {
    let authChallengeUpdateCallsCount: number = 0;
    let actualChallengeUpdateArgs: unknown;
    const failureTime = new Date('2026-04-18T08:30:00.000Z');
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => ({
          id: 'challenge-1',
          webAccountId: 'web-account-1',
          purpose: 'email_verify',
          channel: 'email',
          destination: 'user@example.com',
          codeHash: createChallengeHashForTest('654321'),
          tokenHash: createChallengeHashForTest('token-1'),
          expiresAt: new Date('2026-04-18T08:45:00.000Z'),
          consumedAt: null,
          attemptsLeft: 1,
          meta: null,
          createdAt: new Date('2026-04-18T08:20:00.000Z'),
        }),
        create: async (): Promise<unknown> => null,
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          actualChallengeUpdateArgs = args[0];
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord({ emailVerifiedAt: null }),
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        findUnique: async (): Promise<unknown> => createWebAccountRecord({ emailVerifiedAt: null }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const originalDateNow = Date.now;
    Date.now = (): number => failureTime.getTime();
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );
      await assert.rejects(
        async (): Promise<void> => {
          await service.completeWebAccountEmailVerification({
            userId: '11111111-1111-1111-1111-111111111111',
            code: '123456',
          });
        },
        {
          name: 'BadRequestException',
          message: 'invalid email verification code',
        },
      );
      assert.equal(authChallengeUpdateCallsCount, 1);
      assert.deepStrictEqual(actualChallengeUpdateArgs, {
        where: {
          id: 'challenge-1',
        },
        data: {
          attemptsLeft: 0,
          consumedAt: failureTime,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects non-canonical identifiers on the email verification completion write path', async () => {
    let transactionCallsCount: number = 0;
    const prismaService: MockPrismaService = {
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.completeWebAccountEmailVerification({ email: 'user@example.com', code: '123456' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.completeWebAccountEmailVerification({ telegramId: '123456789', code: '123456' } as never);
      },
      {
        name: 'BadRequestException',
        message: 'userId must be provided',
      },
    );
    assert.equal(transactionCallsCount, 0);
  });


  it('rejects email verification issuance when the resolved user has no web account', async () => {
    let authChallengeCreateCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          return null;
        },
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: null,
        }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          return null;
        },
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount must exist',
      },
    );
    assert.equal(authChallengeCreateCallsCount, 0);
  });

  it('rejects email verification issuance when the linked web account is already verified', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            userId: '11111111-1111-1111-1111-111111111111',
            email: 'user@example.com',
            emailNormalized: 'user@example.com',
            emailVerifiedAt: new Date('2026-04-01T01:00:00.000Z'),
            requiresPasswordChange: false,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: null,
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount email is already verified',
      },
    );
    assert.equal(authChallengeFindFirstCallsCount, 0);
  });

  it('rejects email verification issuance when the linked web account has no email', async () => {
    let authChallengeFindFirstCallsCount: number = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
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
          updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          webAccount: {
            id: 'web-account-1',
            userId: '11111111-1111-1111-1111-111111111111',
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
            requiresPasswordChange: false,
            linkPromptSnoozeUntil: null,
            credentialsBootstrappedAt: null,
            createdAt: new Date('2026-04-01T00:30:00.000Z'),
            updatedAt: new Date('2026-04-17T05:00:00.000Z'),
          },
        }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          return null;
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
      },
      plan: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
      webAccount: {
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
        findFirst: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      subscription: {
        findMany: async (): Promise<readonly unknown[]> => [],
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.issueWebAccountEmailVerificationChallenge({
          userId: '11111111-1111-1111-1111-111111111111',
        });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount email must exist',
      },
    );
    assert.equal(authChallengeFindFirstCallsCount, 0);
  });
});

function createPasswordHashServiceMock(): PasswordHashService {
  const passwordHashService: MockPasswordHashService = {
    hashPassword: async (): Promise<string> => 'unused-password-hash',
  };
  return passwordHashService as PasswordHashService;
}

function createEmailServiceMock(overrides: Partial<MockEmailService> = {}): EmailService {
  const emailService: MockEmailService = {
    sendLinkedAccountVerificationCode: async (): Promise<void> => undefined,
    ...overrides,
  };
  return emailService as EmailService;
}

function createChallengeHashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createInternalUserRecord(input: {
  readonly emailVerifiedAt?: Date | null;
  readonly updatedAt?: Date;
  readonly credentialsBootstrappedAt?: Date | null;
  readonly webAccount?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const updatedAt = input.updatedAt ?? new Date('2026-04-18T08:25:00.000Z');
  const webAccount = input.webAccount === undefined
    ? createWebAccountRecord({
        emailVerifiedAt: input.emailVerifiedAt ?? null,
        updatedAt,
        credentialsBootstrappedAt: input.credentialsBootstrappedAt ?? null,
      })
    : input.webAccount;
  return {
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
    onboardingCompletedAt: null,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt,
    webAccount,
  };
}

function createWebAccountRecord(input: {
  readonly email?: string | null;
  readonly emailNormalized?: string | null;
  readonly emailVerifiedAt?: Date | null;
  readonly updatedAt?: Date;
  readonly credentialsBootstrappedAt?: Date | null;
}): Record<string, unknown> {
  return {
    id: 'web-account-1',
    userId: '11111111-1111-1111-1111-111111111111',
    login: 'user-login',
    loginNormalized: 'user-login',
    email: input.email === undefined ? 'user@example.com' : input.email,
    emailNormalized: input.emailNormalized === undefined ? 'user@example.com' : input.emailNormalized,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    requiresPasswordChange: false,
    linkPromptSnoozeUntil: null,
    credentialsBootstrappedAt: input.credentialsBootstrappedAt ?? null,
    createdAt: new Date('2026-04-01T00:30:00.000Z'),
    updatedAt: input.updatedAt ?? new Date('2026-04-18T08:25:00.000Z'),
  };
}

function mapExpectedInternalSession(input: {
  readonly emailVerifiedAt: string | null;
  readonly updatedAt: string;
  readonly credentialsBootstrappedAt: string | null;
}): Record<string, unknown> {
  return {
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
    onboardingCompleted: false,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: input.updatedAt,
    webAccount: {
      id: 'web-account-1',
      login: 'user-login',
      loginNormalized: 'user-login',
      email: 'user@example.com',
      emailNormalized: 'user@example.com',
      emailVerifiedAt: input.emailVerifiedAt,
      requiresPasswordChange: false,
      linkPromptSnoozeUntil: null,
      credentialsBootstrappedAt: input.credentialsBootstrappedAt,
      createdAt: '2026-04-01T00:30:00.000Z',
      updatedAt: input.updatedAt,
    },
  };
}
