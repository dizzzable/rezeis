import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailDeliveryException } from '../src/modules/email/errors/email-delivery.exception';
import { EmailService } from '../src/modules/email/services/email.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import {
  TelegramPasswordRecoveryDeliveryException,
  TelegramPasswordRecoveryDeliveryService,
} from '../src/modules/internal-user/services/telegram-password-recovery-delivery.service';

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
  sendLinkedAccountPasswordResetLink: (...args: readonly unknown[]) => Promise<void>;
}

interface MockTelegramPasswordRecoveryDeliveryService {
  sendLinkedAccountPasswordResetLink: (...args: readonly unknown[]) => Promise<void>;
}

describe('internal user password recovery service', () => {
  it('silently succeeds when no web account matches the normalized recovery email', async () => {
    let transactionCallsCount = 0;
    let emailSendCallsCount = 0;
    let actualFindUniqueWhere: unknown;
    const prismaService: MockPrismaService = createBasePrismaService({
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualFindUniqueWhere = (args[0] as { readonly where: unknown }).where;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
    });
    const emailService = createEmailServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        emailSendCallsCount += 1;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
      undefined,
      undefined,
      { ruidPublicWebUrl: null } as never,
    );

    const actualResponse = await service.requestWebAccountPasswordRecovery({
      email: '  USER@Example.com  ',
    });

    assert.deepStrictEqual(actualFindUniqueWhere, {
      emailNormalized: 'user@example.com',
    });
    assert.equal(transactionCallsCount, 0);
    assert.equal(emailSendCallsCount, 0);
    assert.deepStrictEqual(actualResponse, {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    });
  });

  it('silently succeeds when the matching web account is not actionable for password recovery', async () => {
    let transactionCallsCount = 0;
    let emailSendCallsCount = 0;
    const prismaService: MockPrismaService = createBasePrismaService({
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: null,
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
    });
    const emailService = createEmailServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        emailSendCallsCount += 1;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
      undefined,
      undefined,
      { ruidPublicWebUrl: null } as never,
    );

    const actualResponse = await service.requestWebAccountPasswordRecovery({
      email: 'user@example.com',
    });

    assert.equal(transactionCallsCount, 0);
    assert.equal(emailSendCallsCount, 0);
    assert.deepStrictEqual(actualResponse, {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    });
  });

  it('issues a single-use password reset challenge, rotates prior reset challenges, and sends the reset link email', async () => {
    let transactionCallsCount = 0;
    let webAccountFindUniqueCallsCount = 0;
    let authChallengeCreateCallsCount = 0;
    let authChallengeCleanupCallsCount = 0;
    let emailSendCallsCount = 0;
    let lockCallsCount = 0;
    let actualFindUniqueWhere: unknown;
    let actualLockQuery: unknown;
    let actualCleanupArgs: unknown;
    let actualCreateData: Record<string, unknown> | undefined;
    let actualEmailInput:
      | {
          readonly emailAddress: string;
          readonly resetUrl: string;
          readonly expiresAt: Date;
        }
      | undefined;
    const operationOrder: string[] = [];
    const beforeLockAt = new Date('2026-04-20T10:00:00.000Z');
    const lockedAt = new Date('2026-04-20T10:02:00.000Z');
    const expiresAt = new Date('2026-04-20T10:17:00.000Z');
    const originalDateNow = Date.now;
    let currentTime = beforeLockAt;
    Date.now = (): number => currentTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          operationOrder.push('create');
          actualCreateData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: null,
            tokenHash: actualCreateData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: lockedAt,
          };
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCleanupCallsCount += 1;
          operationOrder.push('cleanup');
          actualCleanupArgs = args[0];
          return { count: 2 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
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
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          webAccountFindUniqueCallsCount += 1;
          actualFindUniqueWhere = (args[0] as { readonly where: unknown }).where;
          return createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
            updatedAt: beforeLockAt,
          });
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const emailService = createEmailServiceMock({
      sendLinkedAccountPasswordResetLink: async (...args: readonly unknown[]): Promise<void> => {
        emailSendCallsCount += 1;
        actualEmailInput = args[0] as {
          readonly emailAddress: string;
          readonly resetUrl: string;
          readonly expiresAt: Date;
        };
      },
    });
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        emailService,
        undefined,
        undefined,
        { ruidPublicWebUrl: 'https://public.example.com/app' } as never,
      );

      const actualResponse = await service.requestWebAccountPasswordRecovery({
        email: 'USER@example.com',
      });

      assert.equal(webAccountFindUniqueCallsCount, 1);
      assert.deepStrictEqual(actualFindUniqueWhere, {
        emailNormalized: 'user@example.com',
      });
      assert.equal(transactionCallsCount, 1);
      assert.equal(lockCallsCount, 1);
      assert.equal(authChallengeCleanupCallsCount, 1);
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(emailSendCallsCount, 1);
      assert.match(String((actualLockQuery as { readonly strings: readonly string[] }).strings.join('')), /FOR UPDATE/);
      assert.deepStrictEqual(operationOrder, ['cleanup', 'create']);
      assert.deepStrictEqual(actualCleanupArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
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
      assert.equal(actualCreateData?.purpose, 'password_reset');
      assert.equal(actualCreateData?.channel, 'email');
      assert.equal(actualCreateData?.destination, 'user@example.com');
      assert.equal(actualCreateData?.codeHash, null);
      assert.equal(typeof actualCreateData?.tokenHash, 'string');
      assert.equal((actualCreateData?.expiresAt as Date).getTime(), expiresAt.getTime());
      assert.equal(actualCreateData?.attemptsLeft, 1);
      assert.equal(actualEmailInput?.emailAddress, 'user@example.com');
      assert.equal(actualEmailInput?.expiresAt.getTime(), expiresAt.getTime());
      assert.ok(actualEmailInput?.resetUrl);
      const resetUrl = new URL(actualEmailInput?.resetUrl ?? '');
      assert.equal(resetUrl.origin, 'https://public.example.com');
      assert.equal(resetUrl.pathname, '/app/password-reset');
      const token = resetUrl.searchParams.get('token');
      assert.ok(token);
      assert.equal(actualCreateData?.tokenHash, createChallengeHashForTest(token ?? ''));
      assert.deepStrictEqual(actualResponse, {
        message: 'If the account is eligible, a password reset link will be sent shortly.',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('returns the neutral success response and revokes the issued password reset challenge when email delivery definitely fails', async () => {
    let authChallengeCompensationCallsCount = 0;
    let actualCompensationArgs: unknown;
    const expiresAt = new Date('2026-04-20T10:17:00.000Z');
    const revokedAt = new Date('2026-04-20T10:03:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => revokedAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'email',
            destination: 'user@example.com',
            codeHash: null,
            tokenHash: createData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
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
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const emailService = createEmailServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        throw new EmailDeliveryException('definitely-not-delivered');
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      emailService,
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app' } as never,
    );
    try {
      const actualResponse = await service.requestWebAccountPasswordRecovery({
        email: 'user@example.com',
      });
      assert.deepStrictEqual(actualResponse, {
        message: 'If the account is eligible, a password reset link will be sent shortly.',
      });
      assert.equal(authChallengeCompensationCallsCount, 1);
      assert.deepStrictEqual(actualCompensationArgs, {
        where: {
          id: 'reset-challenge-1',
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

  it('returns the neutral success response when the public web URL is unavailable for an actionable account', async () => {
    const prismaService: MockPrismaService = createBasePrismaService({
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: null } as never,
    );

    const actualResponse = await service.requestWebAccountPasswordRecovery({
      email: 'user@example.com',
    });

    assert.deepStrictEqual(actualResponse, {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    });
  });

  it('silently succeeds for Telegram recovery when no web account matches the normalized recovery email', async () => {
    let transactionCallsCount = 0;
    let telegramSendCallsCount = 0;
    let actualFindUniqueWhere: unknown;
    const prismaService: MockPrismaService = createBasePrismaService({
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualFindUniqueWhere = (args[0] as { readonly where: unknown }).where;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        telegramSendCallsCount += 1;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app', botToken: 'bot-token-123' } as never,
      telegramDeliveryService,
    );

    const actualResponse = await service.requestWebAccountPasswordRecoveryTelegram({
      email: '  USER@Example.com  ',
    });

    assert.deepStrictEqual(actualFindUniqueWhere, {
      emailNormalized: 'user@example.com',
    });
    assert.equal(transactionCallsCount, 0);
    assert.equal(telegramSendCallsCount, 0);
    assert.deepStrictEqual(actualResponse, {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    });
  });

  it('does not fall back to raw process environment for Telegram recovery public URL or bot token', async () => {
    const originalPublicWebUrl = process.env.RUID_PUBLIC_WEB_URL;
    const originalBotToken = process.env.BOT_TOKEN;
    process.env.RUID_PUBLIC_WEB_URL = 'https://raw-env.example.com/app';
    process.env.BOT_TOKEN = 'raw-env-bot-token';
    try {
      let transactionCallsCount = 0;
      let telegramSendCallsCount = 0;
      const prismaService: MockPrismaService = createBasePrismaService({
        webAccount: {
          findUnique: async (): Promise<unknown> =>
            createWebAccountRecord({
              emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
              passwordHash: 'stored-password-hash',
              login: 'user-login',
              loginNormalized: 'user-login',
            }),
          updateMany: async (): Promise<unknown> => ({ count: 0 }),
        },
        user: {
          findUnique: async (): Promise<unknown> =>
            createUserRecord({
              telegramId: BigInt('123456789'),
            }),
          findFirst: async (): Promise<unknown> => null,
          updateMany: async (): Promise<unknown> => ({ count: 0 }),
        },
        $transaction: async <T>(
          callback: (transactionClient: MockTransactionClient) => Promise<T>,
        ): Promise<T> => {
          transactionCallsCount += 1;
          return callback({} as MockTransactionClient);
        },
      });
      const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
        sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
          telegramSendCallsCount += 1;
        },
      });
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
        undefined,
        undefined,
        undefined,
        telegramDeliveryService,
      );

      const actualResponse = await service.requestWebAccountPasswordRecoveryTelegram({
        email: 'user@example.com',
      });

      assert.equal(transactionCallsCount, 0);
      assert.equal(telegramSendCallsCount, 0);
      assert.deepStrictEqual(actualResponse, {
        message: 'If the account is eligible, a password reset link will be sent shortly.',
      });
    } finally {
      if (originalPublicWebUrl === undefined) {
        delete process.env.RUID_PUBLIC_WEB_URL;
      } else {
        process.env.RUID_PUBLIC_WEB_URL = originalPublicWebUrl;
      }
      if (originalBotToken === undefined) {
        delete process.env.BOT_TOKEN;
      } else {
        process.env.BOT_TOKEN = originalBotToken;
      }
    }
  });

  it('issues a single-use Telegram password reset challenge and sends the reset link message', async () => {
    let transactionCallsCount = 0;
    let webAccountFindUniqueCallsCount = 0;
    let authChallengeCreateCallsCount = 0;
    let authChallengeCleanupCallsCount = 0;
    let telegramSendCallsCount = 0;
    let lockCallsCount = 0;
    let actualFindUniqueWhere: unknown;
    let actualLockQuery: unknown;
    let actualCleanupArgs: unknown;
    let actualCreateData: Record<string, unknown> | undefined;
    let actualTelegramInput:
      | {
          readonly telegramId: string;
          readonly code: string;
          readonly resetUrl: string;
          readonly expiresAt: Date;
        }
      | undefined;
    const operationOrder: string[] = [];
    const beforeLockAt = new Date('2026-04-20T10:00:00.000Z');
    const lockedAt = new Date('2026-04-20T10:02:00.000Z');
    const expiresAt = new Date('2026-04-20T10:17:00.000Z');
    const originalDateNow = Date.now;
    let currentTime = beforeLockAt;
    Date.now = (): number => currentTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCreateCallsCount += 1;
          operationOrder.push('create');
          actualCreateData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: actualCreateData.codeHash,
            tokenHash: actualCreateData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: lockedAt,
          };
        },
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeCleanupCallsCount += 1;
          operationOrder.push('cleanup');
          actualCleanupArgs = args[0];
          return { count: 2 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
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
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(
        callback: (input: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          webAccountFindUniqueCallsCount += 1;
          actualFindUniqueWhere = (args[0] as { readonly where: unknown }).where;
          return createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
            updatedAt: beforeLockAt,
          });
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (...args: readonly unknown[]): Promise<void> => {
        telegramSendCallsCount += 1;
        actualTelegramInput = args[0] as {
          readonly telegramId: string;
          readonly code: string;
          readonly resetUrl: string;
          readonly expiresAt: Date;
        };
      },
    });
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
        undefined,
        undefined,
        { ruidPublicWebUrl: 'https://public.example.com/app', botToken: 'bot-token-123' } as never,
        telegramDeliveryService,
      );

      const actualResponse = await service.requestWebAccountPasswordRecoveryTelegram({
        email: 'USER@example.com',
      });

      assert.equal(webAccountFindUniqueCallsCount, 1);
      assert.deepStrictEqual(actualFindUniqueWhere, {
        emailNormalized: 'user@example.com',
      });
      assert.equal(transactionCallsCount, 1);
      assert.equal(lockCallsCount, 1);
      assert.equal(authChallengeCleanupCallsCount, 1);
      assert.equal(authChallengeCreateCallsCount, 1);
      assert.equal(telegramSendCallsCount, 1);
      assert.match(
        String((actualLockQuery as { readonly strings: readonly string[] }).strings.join('')),
        /FOR UPDATE/,
      );
      assert.deepStrictEqual(operationOrder, ['cleanup', 'create']);
      assert.deepStrictEqual(actualCleanupArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
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
      assert.equal(actualCreateData?.purpose, 'password_reset');
      assert.equal(actualCreateData?.channel, 'telegram');
      assert.equal(actualCreateData?.destination, '123456789');
      assert.equal(typeof actualCreateData?.codeHash, 'string');
      assert.equal(typeof actualCreateData?.tokenHash, 'string');
      assert.equal((actualCreateData?.expiresAt as Date).getTime(), expiresAt.getTime());
      assert.equal(actualCreateData?.attemptsLeft, 1);
      assert.equal(actualTelegramInput?.telegramId, '123456789');
      assert.match(actualTelegramInput?.code ?? '', /^\d{6}$/);
      assert.equal(actualCreateData?.codeHash, createChallengeHashForTest(actualTelegramInput?.code ?? ''));
      assert.equal(actualTelegramInput?.expiresAt.getTime(), expiresAt.getTime());
      assert.ok(actualTelegramInput?.resetUrl);
      const resetUrl = new URL(actualTelegramInput?.resetUrl ?? '');
      assert.equal(resetUrl.origin, 'https://public.example.com');
      assert.equal(resetUrl.pathname, '/app/password-reset');
      const token = resetUrl.searchParams.get('token');
      assert.ok(token);
      assert.equal(actualCreateData?.tokenHash, createChallengeHashForTest(token ?? ''));
      assert.deepStrictEqual(actualResponse, {
        message: 'If the account is eligible, a password reset link will be sent shortly.',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('silently succeeds for Telegram recovery when the matching user has blocked the bot', async () => {
    let transactionCallsCount = 0;
    let telegramSendCallsCount = 0;
    const prismaService: MockPrismaService = createBasePrismaService({
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: true,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        telegramSendCallsCount += 1;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app', botToken: 'bot-token-123' } as never,
      telegramDeliveryService,
    );

    const actualResponse = await service.requestWebAccountPasswordRecoveryTelegram({
      email: 'user@example.com',
    });

    assert.equal(transactionCallsCount, 0);
    assert.equal(telegramSendCallsCount, 0);
    assert.deepStrictEqual(actualResponse, {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    });
  });

  it('fails actionable Telegram recovery requests safely when BOT_TOKEN is not configured', async () => {
    let transactionCallsCount = 0;
    let telegramSendCallsCount = 0;
    const prismaService: MockPrismaService = createBasePrismaService({
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => {
        transactionCallsCount += 1;
        return callback({} as MockTransactionClient);
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        telegramSendCallsCount += 1;
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app', botToken: null } as never,
      telegramDeliveryService,
    );

    await assert.rejects(
      async (): Promise<void> => {
        await service.requestWebAccountPasswordRecoveryTelegram({
          email: 'user@example.com',
        });
      },
      {
        name: 'ServiceUnavailableException',
        message: 'BOT_TOKEN is not configured',
      },
    );
    assert.equal(transactionCallsCount, 0);
    assert.equal(telegramSendCallsCount, 0);
  });

  it('revokes the issued Telegram password reset challenge and surfaces a definite delivery failure', async () => {
    let authChallengeCompensationCallsCount = 0;
    let actualCompensationArgs: unknown;
    const expiresAt = new Date('2026-04-20T10:17:00.000Z');
    const revokedAt = new Date('2026-04-20T10:03:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => revokedAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt,
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
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
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        throw new TelegramPasswordRecoveryDeliveryException('definitely-not-delivered');
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app', botToken: 'bot-token-123' } as never,
      telegramDeliveryService,
    );
    try {
      await assert.rejects(
        async (): Promise<void> => {
          await service.requestWebAccountPasswordRecoveryTelegram({
            email: 'user@example.com',
          });
        },
        {
          name: 'TelegramPasswordRecoveryDeliveryException',
          message: 'failed to deliver Telegram password recovery message',
        },
      );
      assert.equal(authChallengeCompensationCallsCount, 1);
      assert.deepStrictEqual(actualCompensationArgs, {
        where: {
          id: 'reset-challenge-1',
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

  it('surfaces uncertain Telegram delivery failures without revoking the issued challenge', async () => {
    let authChallengeCompensationCallsCount = 0;
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (...args: readonly unknown[]): Promise<unknown> => {
          const createData = (args[0] as { readonly data: Record<string, unknown> }).data;
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: createData.codeHash,
            tokenHash: createData.tokenHash,
            expiresAt: new Date('2026-04-20T10:17:00.000Z'),
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:02:00.000Z'),
          };
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => {
          authChallengeCompensationCallsCount += 1;
          return { count: 1 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'stored-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const telegramDeliveryService = createTelegramPasswordRecoveryDeliveryServiceMock({
      sendLinkedAccountPasswordResetLink: async (): Promise<void> => {
        throw new TelegramPasswordRecoveryDeliveryException('delivery-status-uncertain');
      },
    });
    const service = new InternalUserService(
      prismaService as never,
      createPasswordHashServiceMock(),
      createEmailServiceMock(),
      undefined,
      undefined,
      { ruidPublicWebUrl: 'https://public.example.com/app', botToken: 'bot-token-123' } as never,
      telegramDeliveryService,
    );

    await assert.rejects(
      async (): Promise<void> => {
        await service.requestWebAccountPasswordRecoveryTelegram({
          email: 'user@example.com',
        });
      },
      {
        name: 'TelegramPasswordRecoveryDeliveryException',
        message: 'failed to deliver Telegram password recovery message',
      },
    );
    assert.equal(authChallengeCompensationCallsCount, 0);
  });

  it('resets the linked web-account password from a valid reset challenge token', async () => {
    let transactionCallsCount = 0;
    let challengeLookupCallsCount = 0;
    let challengeRecheckCallsCount = 0;
    let webAccountFindUniqueCallsCount = 0;
    let lockCallsCount = 0;
    let hashPasswordCallsCount = 0;
    let actualHashInput: unknown;
    let actualFirstChallengeLookupArgs: unknown;
    let actualSecondChallengeLookupArgs: unknown;
    let actualWebAccountUpdateArgs: unknown;
    let actualChallengeConsumeArgs: unknown;
    let actualLockQuery: unknown;
    const resetAt = new Date('2026-04-20T10:30:00.000Z');
    const token = 'reset-token-123';
    const tokenHash = createChallengeHashForTest(token);
    const originalDateNow = Date.now;
    Date.now = (): number => resetAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          const input = args[0] as { readonly where: Record<string, unknown> };
          if ('id' in input.where) {
            challengeRecheckCallsCount += 1;
            actualSecondChallengeLookupArgs = args[0];
          } else {
            challengeLookupCallsCount += 1;
          actualFirstChallengeLookupArgs = args[0];
          }
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: 'user@example.com',
            codeHash: createChallengeHashForTest('654321'),
            tokenHash,
            expiresAt: new Date('2026-04-20T10:45:00.000Z'),
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:20:00.000Z'),
          };
        },
        create: async (): Promise<unknown> => null,
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          actualChallengeConsumeArgs = args[0];
          return { count: 2 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => {
          webAccountFindUniqueCallsCount += 1;
          return createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
            requiresPasswordChange: true,
            temporaryPasswordExpiresAt: new Date('2026-04-21T10:00:00.000Z'),
            tokenVersion: 7,
          });
        },
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountUpdateArgs = args[0];
          return null;
        },
      },
      $queryRaw: async (...args: readonly unknown[]): Promise<unknown> => {
        lockCallsCount += 1;
        actualLockQuery = args[0];
        return [{ id: 'web-account-1' }];
      },
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      webAccount: {
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (...args: readonly unknown[]): Promise<string> => {
        hashPasswordCallsCount += 1;
        actualHashInput = args[0];
        return 'next-password-hash';
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        passwordHashService as PasswordHashService,
        createEmailServiceMock(),
      );

      const actualResponse = await service.resetWebAccountPasswordByLink({
        token,
        password: 'new-password-123',
      });

      assert.equal(transactionCallsCount, 1);
      assert.equal(challengeLookupCallsCount, 1);
      assert.equal(challengeRecheckCallsCount, 1);
      assert.equal(lockCallsCount, 1);
      assert.equal(webAccountFindUniqueCallsCount, 1);
      assert.equal(hashPasswordCallsCount, 1);
      assert.deepStrictEqual(actualHashInput, {
        plainTextPassword: 'new-password-123',
      });
      assert.deepStrictEqual(actualFirstChallengeLookupArgs, {
        where: {
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
          consumedAt: null,
          expiresAt: {
            gt: resetAt,
          },
          attemptsLeft: {
            gt: 0,
          },
          tokenHash,
        },
        orderBy: [{ createdAt: 'desc' }],
      });
      assert.deepStrictEqual(actualSecondChallengeLookupArgs, {
        where: {
          id: 'reset-challenge-1',
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
          consumedAt: null,
          expiresAt: {
            gt: resetAt,
          },
          attemptsLeft: {
            gt: 0,
          },
          tokenHash,
        },
      });
      assert.match(String((actualLockQuery as { readonly strings: readonly string[] }).strings.join('')), /FOR UPDATE/);
      assert.deepStrictEqual(actualWebAccountUpdateArgs, {
        where: {
          id: 'web-account-1',
        },
        data: {
          passwordHash: 'next-password-hash',
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
          tokenVersion: {
            increment: 1,
          },
        },
      });
      assert.deepStrictEqual(actualChallengeConsumeArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
          consumedAt: null,
        },
        data: {
          consumedAt: resetAt,
        },
      });
      assert.deepStrictEqual(actualResponse, {
        message: 'Password has been reset successfully.',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects password reset-by-link when the token does not match an active challenge', async () => {
    let hashPasswordCallsCount = 0;
    const resetAt = new Date('2026-04-20T10:30:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => resetAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => null,
      },
      $queryRaw: async (): Promise<unknown> => [],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
    });
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'unused-password-hash';
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        passwordHashService as PasswordHashService,
        createEmailServiceMock(),
      );

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByLink({
            token: 'missing-token',
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'Invalid or expired password reset link',
        },
      );
      assert.equal(hashPasswordCallsCount, 0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects password reset-by-link when the challenge is consumed after the row lock is acquired', async () => {
    let hashPasswordCallsCount = 0;
    const resetAt = new Date('2026-04-20T10:30:00.000Z');
    const token = 'reset-token-123';
    const tokenHash = createChallengeHashForTest(token);
    const originalDateNow = Date.now;
    Date.now = (): number => resetAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          const where = (args[0] as { readonly where: Record<string, unknown> }).where;
          if ('id' in where) {
            return null;
          }
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: 'user@example.com',
            codeHash: createChallengeHashForTest('654321'),
            tokenHash,
            expiresAt: new Date('2026-04-20T10:45:00.000Z'),
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:20:00.000Z'),
          };
        },
        create: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
    });
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (): Promise<string> => {
        hashPasswordCallsCount += 1;
        return 'unused-password-hash';
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        passwordHashService as PasswordHashService,
        createEmailServiceMock(),
      );

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByLink({
            token,
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'Invalid or expired password reset link',
        },
      );
      assert.equal(hashPasswordCallsCount, 0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('distinguishes consumed vs never-issued token in reset-by-link when active lookup returns null', async () => {
    let authChallengeFindFirstCallsCount = 0;
    const consumedAt = new Date('2026-04-20T09:00:00.000Z');
    const resetAt = new Date('2026-04-20T10:30:00.000Z');
    const token = 'consumed-token-456';
    const tokenHash = createChallengeHashForTest(token);
    const originalDateNow = Date.now;
    Date.now = (): number => resetAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          const where = (args[0] as { readonly where: Record<string, unknown> }).where;
          // Call 1: getLatestActivePasswordResetTokenChallenge → null (no active)
          if ('tokenHash' in where && !('id' in where) && authChallengeFindFirstCallsCount === 1) {
            return null;
          }
          // Call 2: getLatestPasswordResetTokenChallenge → consumed challenge found
          if ('tokenHash' in where && !('id' in where) && authChallengeFindFirstCallsCount === 2) {
            return {
              id: 'reset-challenge-consumed',
              webAccountId: 'web-account-1',
              purpose: 'password_reset',
              channel: 'email',
              destination: 'user@example.com',
              codeHash: null,
              tokenHash,
              expiresAt: new Date('2026-04-20T10:45:00.000Z'),
              consumedAt,
              attemptsLeft: 0,
              meta: null,
              createdAt: new Date('2026-04-20T10:00:00.000Z'),
            };
          }
          // Unreachable in this test, but satisfy the type
          return null;
        },
        create: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> => null,
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => null,
      },
      $queryRaw: async (): Promise<unknown> => null,
    };
    const prismaService: MockPrismaService = {
      $transaction: async <T>(
        callback: (transactionClient: MockTransactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
      authChallenge: {
        findFirst: async (): Promise<unknown> => null,
        create: async (): Promise<unknown> => ({} as unknown),
        update: async (): Promise<unknown> => ({} as unknown),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      plan: { findMany: (): Promise<readonly unknown[]> => Promise.resolve([]) },
      webAccount: {
        findUnique: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => ({} as unknown),
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

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByLink({
            token,
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'This password reset link has already been used',
        },
      );
      assert.equal(authChallengeFindFirstCallsCount, 2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('resets the linked web-account password from a valid Telegram recovery code', async () => {
    let transactionCallsCount = 0;
    let authChallengeFindFirstCallsCount = 0;
    let webAccountFindUniqueCallsCount = 0;
    let userFindUniqueCallsCount = 0;
    let lockCallsCount = 0;
    let hashPasswordCallsCount = 0;
    let actualActiveChallengeLookupArgs: unknown;
    let actualWebAccountUpdateArgs: unknown;
    let actualChallengeConsumeArgs: unknown;
    let actualHashInput: unknown;
    const resetAt = new Date('2026-04-20T10:30:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => resetAt.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          actualActiveChallengeLookupArgs = args[0];
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: createChallengeHashForTest('123456'),
            tokenHash: createChallengeHashForTest('token-1'),
            expiresAt: new Date('2026-04-20T10:45:00.000Z'),
            consumedAt: null,
            attemptsLeft: 1,
            meta: null,
            createdAt: new Date('2026-04-20T10:20:00.000Z'),
          };
        },
        create: async (): Promise<unknown> => null,
        update: async (): Promise<unknown> => null,
        updateMany: async (...args: readonly unknown[]): Promise<unknown> => {
          actualChallengeConsumeArgs = args[0];
          return { count: 2 };
        },
      },
      user: {
        findUnique: async (): Promise<unknown> => {
          userFindUniqueCallsCount += 1;
          return createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          });
        },
      },
      webAccount: {
        findUnique: async (): Promise<unknown> => {
          webAccountFindUniqueCallsCount += 1;
          return createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
            requiresPasswordChange: true,
            temporaryPasswordExpiresAt: new Date('2026-04-21T10:00:00.000Z'),
            tokenVersion: 7,
          });
        },
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountUpdateArgs = args[0];
          return null;
        },
      },
      $queryRaw: async (): Promise<unknown> => {
        lockCallsCount += 1;
        return [{ id: 'web-account-1' }];
      },
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> => {
        transactionCallsCount += 1;
        return callback(transactionClient);
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
            requiresPasswordChange: true,
            temporaryPasswordExpiresAt: new Date('2026-04-21T10:00:00.000Z'),
            tokenVersion: 7,
          }),
        update: async (): Promise<unknown> => null,
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    const passwordHashService: MockPasswordHashService = {
      hashPassword: async (...args: readonly unknown[]): Promise<string> => {
        hashPasswordCallsCount += 1;
        actualHashInput = args[0];
        return 'next-password-hash';
      },
    };
    try {
      const service = new InternalUserService(
        prismaService as never,
        passwordHashService as PasswordHashService,
        createEmailServiceMock(),
      );

      const actualResponse = await service.resetWebAccountPasswordByTelegramCode({
        email: 'user@example.com',
        code: '123456',
        password: 'new-password-123',
      });

      assert.equal(transactionCallsCount, 1);
      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(webAccountFindUniqueCallsCount, 1);
      assert.equal(userFindUniqueCallsCount, 1);
      assert.equal(lockCallsCount, 1);
      assert.equal(hashPasswordCallsCount, 1);
      assert.deepStrictEqual(actualHashInput, {
        plainTextPassword: 'new-password-123',
      });
      assert.deepStrictEqual(actualActiveChallengeLookupArgs, {
        where: {
          webAccountId: 'web-account-1',
          destination: '123456789',
          purpose: 'password_reset',
          channel: 'telegram',
          consumedAt: null,
          expiresAt: {
            gt: resetAt,
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
      assert.deepStrictEqual(actualWebAccountUpdateArgs, {
        where: {
          id: 'web-account-1',
        },
        data: {
          passwordHash: 'next-password-hash',
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
          tokenVersion: {
            increment: 1,
          },
        },
      });
      assert.deepStrictEqual(actualChallengeConsumeArgs, {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'password_reset',
          channel: {
            in: ['email', 'telegram'],
          },
          consumedAt: null,
        },
        data: {
          consumedAt: resetAt,
        },
      });
      assert.deepStrictEqual(actualResponse, {
        message: 'Password has been reset successfully.',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('decrements Telegram reset challenge attempts on wrong code', async () => {
    let authChallengeFindFirstCallsCount = 0;
    let authChallengeUpdateCallsCount = 0;
    let actualActiveChallengeLookupArgs: unknown;
    let actualChallengeUpdateArgs: unknown;
    const failureTime = new Date('2026-04-20T10:30:00.000Z');
    const originalDateNow = Date.now;
    Date.now = (): number => failureTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          actualActiveChallengeLookupArgs = args[0];
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: createChallengeHashForTest('654321'),
            tokenHash: createChallengeHashForTest('token-1'),
            expiresAt: new Date('2026-04-20T10:45:00.000Z'),
            consumedAt: null,
            attemptsLeft: 2,
            meta: null,
            createdAt: new Date('2026-04-20T10:20:00.000Z'),
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
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByTelegramCode({
            email: 'user@example.com',
            code: '123456',
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'invalid password reset code',
        },
      );

      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(authChallengeUpdateCallsCount, 1);
      assert.deepStrictEqual(actualActiveChallengeLookupArgs, {
        where: {
          webAccountId: 'web-account-1',
          destination: '123456789',
          purpose: 'password_reset',
          channel: 'telegram',
          consumedAt: null,
          expiresAt: {
            gt: failureTime,
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
          id: 'reset-challenge-1',
        },
        data: {
          attemptsLeft: 1,
          consumedAt: null,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('surfaces terminal Telegram reset attempt exhaustion after the last wrong code', async () => {
    let authChallengeFindFirstCallsCount = 0;
    let authChallengeUpdateCallsCount = 0;
    let actualChallengeUpdateArgs: unknown;
    const failureTime = new Date('2026-04-20T10:30:00.000Z');
    let challengeAttemptsLeft = 1;
    let challengeConsumedAt: Date | null = null;
    const originalDateNow = Date.now;
    Date.now = (): number => failureTime.getTime();
    const transactionClient: MockTransactionClient = {
      authChallenge: {
        findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeFindFirstCallsCount += 1;
          const where = (args[0] as { readonly where: Record<string, unknown> }).where;
          if ('attemptsLeft' in where) {
            if (challengeAttemptsLeft <= 0 || challengeConsumedAt !== null) {
              return null;
            }
            return {
              id: 'reset-challenge-1',
              webAccountId: 'web-account-1',
              purpose: 'password_reset',
              channel: 'telegram',
              destination: '123456789',
              codeHash: createChallengeHashForTest('654321'),
              tokenHash: createChallengeHashForTest('token-1'),
              expiresAt: new Date('2026-04-20T10:45:00.000Z'),
              consumedAt: challengeConsumedAt,
              attemptsLeft: challengeAttemptsLeft,
              meta: null,
              createdAt: new Date('2026-04-20T10:20:00.000Z'),
            };
          }
          return {
            id: 'reset-challenge-1',
            webAccountId: 'web-account-1',
            purpose: 'password_reset',
            channel: 'telegram',
            destination: '123456789',
            codeHash: createChallengeHashForTest('654321'),
            tokenHash: createChallengeHashForTest('token-1'),
            expiresAt: new Date('2026-04-20T10:45:00.000Z'),
            consumedAt: challengeConsumedAt,
            attemptsLeft: challengeAttemptsLeft,
            meta: null,
            createdAt: new Date('2026-04-20T10:20:00.000Z'),
          };
        },
        create: async (): Promise<unknown> => null,
        update: async (...args: readonly unknown[]): Promise<unknown> => {
          authChallengeUpdateCallsCount += 1;
          actualChallengeUpdateArgs = args[0];
          const updateData = (args[0] as { readonly data: { readonly attemptsLeft: number; readonly consumedAt: Date | null } }).data;
          challengeAttemptsLeft = updateData.attemptsLeft;
          challengeConsumedAt = updateData.consumedAt;
          return null;
        },
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
      },
      $queryRaw: async (): Promise<unknown> => [{ id: 'web-account-1' }],
    };
    const prismaService: MockPrismaService = createBasePrismaService({
      $transaction: async <T>(callback: (input: MockTransactionClient) => Promise<T>): Promise<T> =>
        callback(transactionClient),
      user: {
        findUnique: async (): Promise<unknown> =>
          createUserRecord({
            telegramId: BigInt('123456789'),
            isBotBlocked: false,
          }),
        findFirst: async (): Promise<unknown> => null,
        findMany: async (): Promise<readonly unknown[]> => [],
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
      webAccount: {
        findUnique: async (): Promise<unknown> =>
          createWebAccountRecord({
            emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
            passwordHash: 'old-password-hash',
            login: 'user-login',
            loginNormalized: 'user-login',
          }),
        updateMany: async (): Promise<unknown> => ({ count: 0 }),
      },
    });
    try {
      const service = new InternalUserService(
        prismaService as never,
        createPasswordHashServiceMock(),
        createEmailServiceMock(),
      );

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByTelegramCode({
            email: 'user@example.com',
            code: '123456',
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'invalid password reset code',
        },
      );

      assert.equal(authChallengeFindFirstCallsCount, 1);
      assert.equal(authChallengeUpdateCallsCount, 1);
      assert.deepStrictEqual(actualChallengeUpdateArgs, {
        where: {
          id: 'reset-challenge-1',
        },
        data: {
          attemptsLeft: 0,
          consumedAt: failureTime,
        },
      });

      await assert.rejects(
        async (): Promise<void> => {
          await service.resetWebAccountPasswordByTelegramCode({
            email: 'user@example.com',
            code: '123456',
            password: 'new-password-123',
          });
        },
        {
          name: 'BadRequestException',
          message: 'too many password reset code attempts',
        },
      );

      assert.equal(authChallengeFindFirstCallsCount, 3);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

function createBasePrismaService(overrides: Partial<MockPrismaService> = {}): MockPrismaService {
  return {
    authChallenge: {
      findFirst: async (): Promise<unknown> => null,
      create: async (): Promise<unknown> => null,
      update: async (): Promise<unknown> => null,
      updateMany: async (): Promise<unknown> => ({ count: 0 }),
      ...overrides.authChallenge,
    },
    plan: {
      findMany: async (): Promise<readonly unknown[]> => [],
      ...overrides.plan,
    },
    webAccount: {
      findUnique: async (): Promise<unknown> => null,
      update: async (): Promise<unknown> => null,
      updateMany: async (): Promise<unknown> => ({ count: 0 }),
      ...overrides.webAccount,
    },
    user: {
      findUnique: async (): Promise<unknown> => null,
      findFirst: async (): Promise<unknown> => null,
      findMany: async (): Promise<readonly unknown[]> => [],
      updateMany: async (): Promise<unknown> => ({ count: 0 }),
      ...overrides.user,
    },
    subscription: {
      findMany: async (): Promise<readonly unknown[]> => [],
      ...overrides.subscription,
    },
    ...overrides,
  };
}

function createPasswordHashServiceMock(): PasswordHashService {
  const passwordHashService: MockPasswordHashService = {
    hashPassword: async (): Promise<string> => 'unused-password-hash',
  };
  return passwordHashService as PasswordHashService;
}

function createEmailServiceMock(overrides: Partial<MockEmailService> = {}): EmailService {
  const emailService: MockEmailService = {
    sendLinkedAccountVerificationCode: async (): Promise<void> => undefined,
    sendLinkedAccountPasswordResetLink: async (): Promise<void> => undefined,
    ...overrides,
  };
  return emailService as EmailService;
}

function createTelegramPasswordRecoveryDeliveryServiceMock(
  overrides: Partial<MockTelegramPasswordRecoveryDeliveryService> = {},
): TelegramPasswordRecoveryDeliveryService {
  const telegramDeliveryService: MockTelegramPasswordRecoveryDeliveryService = {
    sendLinkedAccountPasswordResetLink: async (): Promise<void> => undefined,
    ...overrides,
  };
  return telegramDeliveryService as TelegramPasswordRecoveryDeliveryService;
}

function createChallengeHashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createUserRecord(input: {
  readonly telegramId?: bigint | null;
  readonly isBotBlocked?: boolean;
}): Record<string, unknown> {
  return {
    id: 'user-1',
    telegramId: input.telegramId === undefined ? null : input.telegramId,
    username: 'user_name',
    name: 'User Name',
    email: 'user@example.com',
    role: 'USER',
    language: 'en',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 0,
    maxSubscriptions: 1,
    isBlocked: false,
    isBotBlocked: input.isBotBlocked ?? false,
    isRulesAccepted: true,
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: new Date('2026-04-18T10:00:00.000Z'),
  };
}

function createWebAccountRecord(input: {
  readonly email?: string | null;
  readonly emailNormalized?: string | null;
  readonly emailVerifiedAt?: Date | null;
  readonly passwordHash?: string | null;
  readonly login?: string | null;
  readonly loginNormalized?: string | null;
  readonly requiresPasswordChange?: boolean;
  readonly temporaryPasswordExpiresAt?: Date | null;
  readonly tokenVersion?: number;
  readonly updatedAt?: Date;
}): Record<string, unknown> {
  return {
    id: 'web-account-1',
    userId: 'user-1',
    login: input.login === undefined ? 'user-login' : input.login,
    loginNormalized: input.loginNormalized === undefined ? 'user-login' : input.loginNormalized,
    email: input.email === undefined ? 'user@example.com' : input.email,
    emailNormalized: input.emailNormalized === undefined ? 'user@example.com' : input.emailNormalized,
    emailVerifiedAt:
      input.emailVerifiedAt === undefined
        ? new Date('2026-04-18T10:00:00.000Z')
        : input.emailVerifiedAt,
    passwordHash: input.passwordHash === undefined ? 'stored-password-hash' : input.passwordHash,
    requiresPasswordChange: input.requiresPasswordChange ?? false,
    temporaryPasswordExpiresAt:
      input.temporaryPasswordExpiresAt === undefined ? null : input.temporaryPasswordExpiresAt,
    tokenVersion: input.tokenVersion ?? 0,
    linkPromptSnoozeUntil: null,
    credentialsBootstrappedAt: new Date('2026-04-18T09:00:00.000Z'),
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: input.updatedAt ?? new Date('2026-04-18T10:00:00.000Z'),
  };
}
