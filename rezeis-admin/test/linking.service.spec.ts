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

interface MockWebAccountOptions {
  readonly id?: string;
  readonly userId?: string;
  readonly emailVerifiedAt?: Date | null;
  readonly telegramId?: bigint | null;
  /** Default: an account with credentials. null + null is a shell. */
  readonly login?: string | null;
  readonly passwordHash?: string | null;
  readonly email?: string | null;
  readonly emailNormalized?: string | null;
}

interface MockPrismaOptions {
  readonly webAccount?: MockWebAccountOptions | null;
  /** The User exists (default) - matters only when there is no web account. */
  readonly userExists?: boolean;
  /** The first webAccount.create fails with this (a lost race on the unique userId). */
  readonly createWebAccountError?: unknown;
  /** The row that won that race, and is there on the re-read. */
  readonly racedWebAccount?: MockWebAccountOptions;
  /** Another web account holds this normalized address by the time the code is confirmed. */
  readonly addressTakenAtVerify?: string;
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
  // Mutable: update and create write to it, as the database would.
  let webAccount: Required<MockWebAccountOptions> | null =
    options.webAccount === null
      ? null
      : {
          id: 'web-account-1',
          userId: 'user-1',
          emailVerifiedAt: null,
          telegramId: null,
          login: 'alice',
          passwordHash: 'hash',
          email: null,
          emailNormalized: null,
          ...options.webAccount,
        };
  const createdWebAccounts: Array<Record<string, unknown>> = [];
  let createFailureSpent = false;
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
          login: webAccount.login,
          passwordHash: webAccount.passwordHash,
          emailNormalized: webAccount.emailNormalized,
        };
      },
      findFirst: async (...args: readonly unknown[]): Promise<unknown> => {
        // The check emailVerify makes before it writes an address that is not
        // yet on the row.
        const where = (args[0] as { readonly where: Record<string, unknown> }).where;
        return options.addressTakenAtVerify !== undefined &&
          where.emailNormalized === options.addressTakenAtVerify
          ? { id: 'other-web-account' }
          : null;
      },
      update: async (...args: readonly unknown[]): Promise<unknown> => {
        const input = args[0] as MockUpdateCall;
        webAccountUpdates.push(input);
        if (webAccount !== null) webAccount = { ...webAccount, ...(input.data as object) };
        return { id: webAccount?.id ?? 'web-account-1', ...(input.data as object) };
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
    user: {
      findUnique: async (): Promise<unknown> =>
        options.userExists === false ? null : { id: webAccount?.userId ?? 'user-1' },
    },
    webAccount: {
      findUnique: tx.webAccount.findUnique,
      create: async (...args: readonly unknown[]): Promise<unknown> => {
        const input = args[0] as { readonly data: { readonly userId: string } };
        createdWebAccounts.push(input.data);
        if (options.createWebAccountError !== undefined && !createFailureSpent) {
          createFailureSpent = true;
          // The winner's row is there for the re-read.
          webAccount = {
            id: 'web-account-raced',
            userId: input.data.userId,
            emailVerifiedAt: null,
            telegramId: null,
            login: null,
            passwordHash: null,
            email: null,
            emailNormalized: null,
            ...options.racedWebAccount,
          };
          throw options.createWebAccountError;
        }
        webAccount = {
          id: 'web-account-new',
          userId: input.data.userId,
          emailVerifiedAt: null,
          telegramId: null,
          login: null,
          passwordHash: null,
          email: null,
          emailNormalized: null,
        };
        return {
          id: webAccount.id,
          emailVerifiedAt: null,
          login: null,
          passwordHash: null,
        };
      },
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
    _createdWebAccounts: createdWebAccounts,
    _userUpdates: userUpdates,
    _currentWebAccount: () => webAccount,
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

  describe('a customer who came through the bot and has no web account', () => {
    it('makes the shell, hangs the challenge off it and sends the code instead of answering 404', async () => {
      const prisma = createMockPrisma({ webAccount: null });
      const emailService = createEmailServiceMock();
      const service = new LinkingService(prisma as never, emailService as never);

      const actual = await service.emailInitiate({ userId: 'user-1', email: 'User@Example.COM' });

      assert.deepStrictEqual(actual, { success: true, message: 'Verification code sent' });
      // The shell is the userId and nothing else: no login, password or address.
      assert.deepStrictEqual(prisma._createdWebAccounts, [{ userId: 'user-1' }]);
      assert.equal(prisma._createdChallenges.length, 1);
      assert.equal(prisma._createdChallenges[0].webAccountId, 'web-account-new');
      assert.equal(prisma._createdChallenges[0].destination, 'user@example.com');
      assert.equal(emailService.sentEmails.length, 1);
      assert.equal(emailService.sentEmails[0]?.emailAddress, 'User@Example.COM');
    });

    it('keeps the unconfirmed address off the shell until the code is entered', async () => {
      const prisma = createMockPrisma({ webAccount: null });
      const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

      await service.emailInitiate({ userId: 'user-1', email: 'user@example.com' });

      // An address nobody has proved is theirs would otherwise be refused to its
      // real owner and receive the operator's broadcasts.
      assert.deepStrictEqual(prisma._webAccountUpdates, []);
      assert.equal(prisma._currentWebAccount()?.emailNormalized, null);
    });

    it('does not make a shell for a user that does not exist', async () => {
      const prisma = createMockPrisma({ webAccount: null, userExists: false });
      const emailService = createEmailServiceMock();
      const service = new LinkingService(prisma as never, emailService as never);

      await assert.rejects(
        () => service.emailInitiate({ userId: 'ghost', email: 'user@example.com' }),
        (error: unknown) => error instanceof NotFoundException,
      );
      assert.deepStrictEqual(prisma._createdWebAccounts, []);
      assert.equal(prisma._createdChallenges.length, 0);
      assert.deepStrictEqual(emailService.sentEmails, []);
    });

    it('reads the winner instead of failing when two first attempts race on the unique userId', async () => {
      const prisma = createMockPrisma({
        webAccount: null,
        createWebAccountError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      });
      const emailService = createEmailServiceMock();
      const service = new LinkingService(prisma as never, emailService as never);

      const actual = await service.emailInitiate({ userId: 'user-1', email: 'user@example.com' });

      assert.deepStrictEqual(actual, { success: true, message: 'Verification code sent' });
      assert.equal(prisma._createdChallenges.length, 1);
      assert.equal(prisma._createdChallenges[0].webAccountId, 'web-account-raced');
      assert.equal(emailService.sentEmails.length, 1);
    });

    it('lets any other failure to make the shell through', async () => {
      const prisma = createMockPrisma({
        webAccount: null,
        createWebAccountError: Object.assign(new Error('connection lost'), { code: 'P1001' }),
      });
      const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

      await assert.rejects(
        () => service.emailInitiate({ userId: 'user-1', email: 'user@example.com' }),
        /connection lost/,
      );
    });

    it('writes the address, its normalized form and the verification together once the code is right', async () => {
      const prisma = createMockPrisma({ webAccount: null });
      const emailService = createEmailServiceMock();
      const service = new LinkingService(prisma as never, emailService as never);
      await service.emailInitiate({ userId: 'user-1', email: 'User@Example.COM' });
      const code = emailService.sentEmails[0]?.code ?? '';

      const actual = await service.emailVerify({ userId: 'user-1', code });

      assert.deepStrictEqual(actual, { success: true, verified: true });
      assert.equal(prisma._webAccountUpdates.length, 1);
      const data = prisma._webAccountUpdates[0]?.data ?? {};
      assert.equal(data.email, 'user@example.com');
      assert.equal(data.emailNormalized, 'user@example.com');
      assert.ok(data.emailVerifiedAt instanceof Date);
      // Still a shell: confirming an address chooses no login.
      assert.equal(prisma._currentWebAccount()?.login, null);
      assert.equal(prisma._currentWebAccount()?.passwordHash, null);
    });

    it('spends the code and says so when somebody took the address in the meantime', async () => {
      const prisma = createMockPrisma({ webAccount: null, addressTakenAtVerify: 'user@example.com' });
      const emailService = createEmailServiceMock();
      const service = new LinkingService(prisma as never, emailService as never);
      await service.emailInitiate({ userId: 'user-1', email: 'user@example.com' });
      const code = emailService.sentEmails[0]?.code ?? '';

      await assert.rejects(
        () => service.emailVerify({ userId: 'user-1', code }),
        (error: unknown) => error instanceof ConflictException,
      );

      assert.deepStrictEqual(prisma._webAccountUpdates, []);
      assert.ok(prisma._authChallengeUpdates.some((update) => update.data.consumedAt instanceof Date));
    });

    it('answers a verify with no shell and no challenge as an ordinary failure', async () => {
      const prisma = createMockPrisma({ webAccount: null });
      const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

      const actual = await service.emailVerify({ userId: 'user-1', code: '123456' });

      assert.deepStrictEqual(actual, { success: false, verified: false });
      assert.deepStrictEqual(prisma._createdWebAccounts, []);
    });

    it('leaves an account that has a login and a password to the stash-then-verify flow it always had', async () => {
      const prisma = createMockPrisma({ webAccount: { login: 'alice', passwordHash: 'hash' } });
      const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

      await service.emailInitiate({ userId: 'user-1', email: 'User@Example.COM' });

      assert.deepStrictEqual(prisma._createdWebAccounts, []);
      assert.deepStrictEqual(prisma._webAccountUpdates, [
        {
          where: { id: 'web-account-1' },
          data: { email: 'User@Example.COM', emailNormalized: 'user@example.com', emailVerifiedAt: null },
        },
      ]);
    });

    it('does not touch a shell that already holds a verified address until the new one is proven', async () => {
      const prisma = createMockPrisma({
        webAccount: {
          login: null,
          passwordHash: null,
          email: 'old@example.com',
          emailNormalized: 'old@example.com',
          emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      });
      const service = new LinkingService(prisma as never, createEmailServiceMock() as never);

      await service.emailInitiate({ userId: 'user-1', email: 'new@example.com' });

      assert.deepStrictEqual(prisma._webAccountUpdates, []);
      assert.equal(prisma._currentWebAccount()?.emailNormalized, 'old@example.com');
      assert.ok(prisma._currentWebAccount()?.emailVerifiedAt instanceof Date);
    });
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

interface CapturedEvent {
  readonly type: string;
  readonly category: string;
  readonly metadata?: Record<string, unknown>;
}

function createEventsMock(): {
  readonly mock: { info: (t: string, c: string, m: string, meta?: Record<string, unknown>) => void };
  readonly events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  return {
    mock: {
      info: (type, category, _message, metadata) => {
        events.push({ type, category, metadata });
      },
    },
    events,
  };
}

describe('LinkingService — dev event emission', () => {
  it('emits user.telegram_linked once when a new Telegram id is attached', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({ purpose: 'telegram_link', codeHash: hashForTest('123456') }),
      conflictingTelegramUserId: null,
    });
    const { mock, events } = createEventsMock();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never, mock as never);

    await service.telegramConsume({ code: '123456', telegramId: '777000' });

    const linked = events.filter((e) => e.type === 'user.telegram_linked');
    assert.equal(linked.length, 1);
    assert.equal(linked[0].category, 'USER');
    assert.equal(linked[0].metadata?.userId, 'user-1');
    assert.equal(linked[0].metadata?.telegramId, '777000');
  });

  it('does NOT emit on an idempotent re-link of the same Telegram id', async () => {
    const prisma = createMockPrisma({
      webAccount: { id: 'web-account-1', userId: 'user-1', emailVerifiedAt: null, telegramId: BigInt('777000') },
      challenge: createChallenge({ purpose: 'telegram_link', codeHash: hashForTest('123456') }),
      conflictingTelegramUserId: null,
    });
    const { mock, events } = createEventsMock();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never, mock as never);

    await service.telegramConsume({ code: '123456', telegramId: '777000' });

    assert.equal(events.filter((e) => e.type === 'user.telegram_linked').length, 0);
  });

  it('emits user.email_linked when an email is verified', async () => {
    const prisma = createMockPrisma({
      challenge: createChallenge({
        purpose: 'email_link',
        channel: 'email',
        destination: 'user@example.com',
        codeHash: hashForTest('123456'),
      }),
    });
    const { mock, events } = createEventsMock();
    const service = new LinkingService(prisma as never, createEmailServiceMock() as never, mock as never);

    await service.emailVerify({ userId: 'user-1', code: '123456' });

    const linked = events.filter((e) => e.type === 'user.email_linked');
    assert.equal(linked.length, 1);
    assert.equal(linked[0].category, 'USER');
    assert.equal(linked[0].metadata?.userId, 'user-1');
    assert.equal(linked[0].metadata?.email, 'user@example.com');
  });
});
