import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  LinkEmailInitiateDto,
  LinkEmailVerifyDto,
  LinkTelegramConsumeDto,
  LinkTelegramGenerateDto,
} from '../src/modules/linking/dto/linking.dto';
import { LinkingService } from '../src/modules/linking/services/linking.service';

interface ChallengeRecord {
  id: string;
  webAccountId: string;
  purpose: string;
  channel: string;
  destination: string;
  codeHash: string | null;
  tokenHash: string | null;
  attemptsLeft: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface MockPrismaOptions {
  readonly webAccount?: {
    readonly id?: string;
    readonly userId?: string;
    readonly emailVerifiedAt?: Date | null;
    readonly telegramId?: bigint | null;
  } | null;
  readonly existingEmailOwner?: boolean;
  readonly challenge?: ChallengeRecord;
  readonly conflictingTelegramUserId?: string | null;
}

interface MockAuthChallengeUpdateManyCall {
  readonly where: unknown;
  readonly data: { readonly consumedAt: Date };
}

interface MockUpdateCall {
  readonly where: unknown;
  readonly data: Record<string, unknown>;
}

interface SentEmail {
  readonly emailAddress: string;
  readonly code: string;
  readonly expiresAt: Date;
}

function hashForTest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createChallenge(input: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    id: 'challenge-1',
    webAccountId: 'web-account-1',
    purpose: 'telegram_link',
    channel: 'telegram',
    destination: 'user-1',
    codeHash: hashForTest('123456'),
    tokenHash: null,
    attemptsLeft: 5,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
    createdAt: new Date('2026-06-03T10:00:00.000Z'),
    ...input,
  };
}

function createMockPrisma(options: MockPrismaOptions = {}) {
  const webAccount = options.webAccount === undefined
    ? {
        id: 'web-account-1',
        userId: 'user-1',
        emailVerifiedAt: null,
        telegramId: null,
      }
    : options.webAccount;
  const challenges: ChallengeRecord[] = options.challenge === undefined ? [] : [options.challenge];
  const authChallengeUpdateManyCalls: MockAuthChallengeUpdateManyCall[] = [];
  const authChallengeUpdates: MockUpdateCall[] = [];
  const createdChallenges: ChallengeRecord[] = [];
  const webAccountUpdates: MockUpdateCall[] = [];
  const userUpdates: MockUpdateCall[] = [];

  const tx = {
    authChallenge: {
      updateMany: async (...args: readonly unknown[]): Promise<{ readonly count: number }> => {
        authChallengeUpdateManyCalls.push(args[0] as MockAuthChallengeUpdateManyCall);
        return { count: 1 };
      },
      create: async (...args: readonly unknown[]): Promise<ChallengeRecord> => {
        const data = (args[0] as { readonly data: Omit<ChallengeRecord, 'id' | 'createdAt' | 'consumedAt'> & { readonly consumedAt?: Date | null } }).data;
        const challenge: ChallengeRecord = {
          id: `challenge-${createdChallenges.length + 1}`,
          webAccountId: data.webAccountId,
          purpose: data.purpose,
          channel: data.channel,
          destination: data.destination,
          codeHash: data.codeHash,
          tokenHash: data.tokenHash ?? null,
          attemptsLeft: data.attemptsLeft,
          expiresAt: data.expiresAt,
          consumedAt: data.consumedAt ?? null,
          createdAt: new Date('2026-06-03T10:00:00.000Z'),
        };
        createdChallenges.push(challenge);
        challenges.push(challenge);
        return challenge;
      },
      findFirst: async (...args: readonly unknown[]): Promise<ChallengeRecord | null> => {
        const where = (args[0] as { readonly where: Record<string, unknown> }).where;
        const now = new Date();
        return challenges.find((challenge) => {
          if (where.purpose !== undefined && challenge.purpose !== where.purpose) return false;
          if (where.webAccountId !== undefined && challenge.webAccountId !== where.webAccountId) return false;
          if (where.destination !== undefined && challenge.destination !== where.destination) return false;
          if (where.codeHash !== undefined && challenge.codeHash !== where.codeHash) return false;
          if (where.consumedAt === null && challenge.consumedAt !== null) return false;
          if (where.expiresAt !== undefined && challenge.expiresAt.getTime() <= now.getTime()) return false;
          const attemptsLeft = where.attemptsLeft as { readonly gt?: number } | undefined;
          if (attemptsLeft?.gt !== undefined && challenge.attemptsLeft <= attemptsLeft.gt) return false;
          return true;
        }) ?? null;
      },
      update: async (...args: readonly unknown[]): Promise<ChallengeRecord> => {
        const input = args[0] as { readonly where: { readonly id: string }; readonly data: Record<string, unknown> };
        authChallengeUpdates.push(input);
        const challenge = challenges.find((item) => item.id === input.where.id) ?? challenges[0];
        if (input.data.attemptsLeft !== undefined) {
          const attemptsLeft = input.data.attemptsLeft;
          challenge.attemptsLeft = typeof attemptsLeft === 'number'
            ? attemptsLeft
            : challenge.attemptsLeft - ((attemptsLeft as { readonly decrement?: number }).decrement ?? 0);
        }
        if (Object.prototype.hasOwnProperty.call(input.data, 'consumedAt')) {
          challenge.consumedAt = input.data.consumedAt as Date | null;
        }
        return challenge;
      },
    },
    webAccount: {
      findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
        if (webAccount === null) return null;
        const where = (args[0] as { readonly where: Record<string, unknown> }).where;
        if (where.id !== undefined && where.id !== webAccount.id) return null;
        if (where.userId !== undefined && where.userId !== webAccount.userId) return null;
        if (where.id !== undefined) {
          return {
            id: webAccount.id,
            userId: webAccount.userId,
            user: { telegramId: webAccount.telegramId },
          };
        }
        return {
          id: webAccount.id,
          userId: webAccount.userId,
          emailVerifiedAt: webAccount.emailVerifiedAt,
        };
      },
      update: async (...args: readonly unknown[]): Promise<unknown> => {
        webAccountUpdates.push(args[0] as MockUpdateCall);
        return { id: webAccount?.id ?? 'web-account-1', ...(args[0] as { readonly data: object }).data };
      },
    },
    user: {
      findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
        const where = (args[0] as { readonly where: Record<string, unknown> }).where;
        if (where.telegramId !== undefined && options.conflictingTelegramUserId !== undefined) {
          return options.conflictingTelegramUserId === null
            ? null
            : { id: options.conflictingTelegramUserId };
        }
        return null;
      },
      update: async (...args: readonly unknown[]): Promise<unknown> => {
        userUpdates.push(args[0] as MockUpdateCall);
        return args[0];
      },
    },
  };

  const prisma = {
    webAccount: {
      findUnique: tx.webAccount.findUnique,
      findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
        if (!options.existingEmailOwner) return null;
        const where = (args[0] as { readonly where: Record<string, unknown> }).where;
        const userId = where.userId as { readonly not?: string } | undefined;
        return where.emailNormalized === 'taken@example.com' && userId?.not === webAccount?.userId
          ? { id: 'other-web-account' }
          : null;
      },
    },
    $transaction: async <T>(callback: (transactionClient: typeof tx) => Promise<T>): Promise<T> => callback(tx),
    _authChallengeUpdateManyCalls: authChallengeUpdateManyCalls,
    _authChallengeUpdates: authChallengeUpdates,
    _createdChallenges: createdChallenges,
    _webAccountUpdates: webAccountUpdates,
    _userUpdates: userUpdates,
  };
  return prisma;
}

function createEmailServiceMock(input: { readonly fail?: boolean } = {}) {
  const sentEmails: SentEmail[] = [];
  return {
    sentEmails,
    sendLinkedAccountVerificationCode: async (...args: readonly unknown[]): Promise<void> => {
      if (input.fail) {
        throw new Error('smtp unavailable');
      }
      sentEmails.push(args[0] as SentEmail);
    },
  };
}

describe('LinkingService', () => {
  it('issues a current telegram_link AuthChallenge for a web account user', async () => {
    const prisma = createMockPrisma();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.telegramGenerate({ userId: 'user-1' });

    assert.match(actual.code, /^\d{6}$/);
    assert.ok(!Number.isNaN(Date.parse(actual.expiresAt)));
    assert.deepStrictEqual(prisma._authChallengeUpdateManyCalls, [
      {
        where: {
          webAccountId: 'web-account-1',
          purpose: 'telegram_link',
          consumedAt: null,
        },
        data: { consumedAt: prisma._authChallengeUpdateManyCalls[0]?.data?.consumedAt },
      },
    ]);
    assert.ok(prisma._authChallengeUpdateManyCalls[0]?.data?.consumedAt instanceof Date);
    assert.equal(prisma._createdChallenges.length, 1);
    assert.deepStrictEqual(prisma._createdChallenges[0], {
      id: 'challenge-1',
      webAccountId: 'web-account-1',
      purpose: 'telegram_link',
      channel: 'telegram',
      destination: 'user-1',
      codeHash: hashForTest(actual.code),
      tokenHash: null,
      attemptsLeft: 5,
      expiresAt: prisma._createdChallenges[0].expiresAt,
      consumedAt: null,
      createdAt: new Date('2026-06-03T10:00:00.000Z'),
    });
  });

  it('rejects telegram code issuance when the current user has no web account', async () => {
    const prisma = createMockPrisma({ webAccount: null });
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    await assert.rejects(
      () => service.telegramGenerate({ userId: 'missing-user' }),
      (error: unknown) => error instanceof NotFoundException,
    );
    assert.equal(prisma._createdChallenges.length, 0);
  });

  it('rejects invalid or expired telegram codes without touching identity rows', async () => {
    const prisma = createMockPrisma();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.telegramConsume({ code: '000000', telegramId: '777000' });

    assert.deepStrictEqual(actual, { success: false, reason: 'INVALID_OR_EXPIRED_CODE' });
    assert.deepStrictEqual(prisma._userUpdates, []);
    assert.deepStrictEqual(prisma._authChallengeUpdates, []);
  });

  it('refuses to attach a Telegram id that belongs to a different canonical user', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({ purpose: 'telegram_link', codeHash: hashForTest('654321') }),
      conflictingTelegramUserId: 'other-user',
    });
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.telegramConsume({ code: '654321', telegramId: '777000' });

    assert.deepStrictEqual(actual, { success: false, reason: 'TELEGRAM_ALREADY_LINKED' });
    assert.deepStrictEqual(prisma._userUpdates, []);
    assert.deepStrictEqual(prisma._authChallengeUpdates, []);
  });

  it('attaches a Telegram id to the challenge owner and consumes the challenge', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({ purpose: 'telegram_link', codeHash: hashForTest('123456') }),
      conflictingTelegramUserId: null,
    });
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.telegramConsume({ code: '123456', telegramId: '777000' });

    assert.deepStrictEqual(actual, { success: true, userId: 'user-1' });
    assert.deepStrictEqual(prisma._userUpdates, [
      { where: { id: 'user-1' }, data: { telegramId: BigInt('777000') } },
    ]);
    assert.equal(prisma._authChallengeUpdates.length, 1);
    assert.deepStrictEqual(prisma._authChallengeUpdates[0]?.where, { id: 'challenge-1' });
    assert.ok(prisma._authChallengeUpdates[0]?.data?.consumedAt instanceof Date);
  });

  it('rejects duplicate linked emails before creating a challenge or sending mail', async () => {
    const prisma = createMockPrisma({ existingEmailOwner: true });
    const emailService = createEmailServiceMock();
    const service = new LinkingService(prisma as never, emailService as never);

    await assert.rejects(
      () => service.emailInitiate({ userId: 'user-1', email: '  Taken@Example.com  ' }),
      (error: unknown) => error instanceof ConflictException,
    );
    assert.equal(prisma._createdChallenges.length, 0);
    assert.deepStrictEqual(emailService.sentEmails, []);
  });

  it('initiates email verification by rotating the challenge and storing the normalized email candidate', async () => {
    const prisma = createMockPrisma();
    const emailService = createEmailServiceMock();
    const service = new LinkingService(prisma as never, emailService as never);

    const actual = await service.emailInitiate({ userId: 'user-1', email: 'User@Example.COM' });

    assert.deepStrictEqual(actual, { success: true, message: 'Verification code sent' });
    assert.equal(prisma._createdChallenges.length, 1);
    assert.equal(prisma._createdChallenges[0].purpose, 'email_link');
    assert.equal(prisma._createdChallenges[0].channel, 'email');
    assert.equal(prisma._createdChallenges[0].destination, 'user@example.com');
    assert.match(prisma._createdChallenges[0].codeHash ?? '', /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(prisma._webAccountUpdates, [
      {
        where: { id: 'web-account-1' },
        data: {
          email: 'User@Example.COM',
          emailNormalized: 'user@example.com',
          emailVerifiedAt: null,
        },
      },
    ]);
    assert.equal(emailService.sentEmails.length, 1);
    assert.equal(emailService.sentEmails[0]?.emailAddress, 'User@Example.COM');
    assert.match(emailService.sentEmails[0]?.code, /^\d{6}$/);
  });

  it('returns a stable failure when email delivery fails after challenge creation', async () => {
    const prisma = createMockPrisma();
    const service = new LinkingService(prisma as never, createEmailServiceMock({ fail: true }) as never);

    const actual = await service.emailInitiate({ userId: 'user-1', email: 'user@example.com' });

    assert.deepStrictEqual(actual, { success: false, message: 'Failed to send verification email' });
    assert.equal(prisma._createdChallenges.length, 1);
  });

  it('rejects missing email verification challenges', async () => {
    const prisma = createMockPrisma();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.emailVerify({ userId: 'user-1', code: '123456' });

    assert.deepStrictEqual(actual, { success: false, verified: false });
    assert.deepStrictEqual(prisma._webAccountUpdates, []);
  });

  it('decrements attempts and consumes the email challenge on the final wrong code', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({
        purpose: 'email_link',
        channel: 'email',
        destination: 'user@example.com',
        codeHash: hashForTest('123456'),
        attemptsLeft: 1,
      }),
    });
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.emailVerify({ userId: 'user-1', code: '000000' });

    assert.deepStrictEqual(actual, { success: false, verified: false });
    assert.equal(prisma._authChallengeUpdates.length, 1);
    assert.deepStrictEqual(prisma._authChallengeUpdates[0]?.where, { id: 'challenge-1' });
    assert.deepStrictEqual(prisma._authChallengeUpdates[0]?.data?.attemptsLeft, { decrement: 1 });
    assert.ok(prisma._authChallengeUpdates[0]?.data?.consumedAt instanceof Date);
    assert.deepStrictEqual(prisma._webAccountUpdates, []);
  });

  it('consumes the latest email challenge and stamps emailVerifiedAt on a correct code', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({
        purpose: 'email_link',
        channel: 'email',
        destination: 'user@example.com',
        codeHash: hashForTest('123456'),
      }),
    });
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

    const actual = await service.emailVerify({ userId: 'user-1', code: '123456' });

    assert.deepStrictEqual(actual, { success: true, verified: true });
    assert.equal(prisma._authChallengeUpdates.length, 1);
    assert.deepStrictEqual(prisma._authChallengeUpdates[0]?.where, { id: 'challenge-1' });
    assert.ok(prisma._authChallengeUpdates[0]?.data?.consumedAt instanceof Date);
    assert.equal(prisma._webAccountUpdates.length, 1);
    assert.deepStrictEqual(prisma._webAccountUpdates[0]?.where, { id: 'web-account-1' });
    assert.ok(prisma._webAccountUpdates[0]?.data?.emailVerifiedAt instanceof Date);
  });

  it('validates the current DTO class contracts', async () => {
    const validTelegramGenerate = await validate(plainToInstance(LinkTelegramGenerateDto, { userId: 'user-1' }));
    const invalidTelegramConsume = await validate(plainToInstance(LinkTelegramConsumeDto, { telegramId: -1, code: '123' }));
    const validEmailInitiate = await validate(plainToInstance(LinkEmailInitiateDto, { userId: 'user-1', email: 'user@example.com' }));
    const invalidEmailVerify = await validate(plainToInstance(LinkEmailVerifyDto, { userId: 'user-1', code: '' }));

    assert.deepStrictEqual(validTelegramGenerate, []);
    assert.ok(invalidTelegramConsume.length >= 1);
    assert.deepStrictEqual(validEmailInitiate, []);
    assert.ok(invalidEmailVerify.length >= 1);
  });
});
