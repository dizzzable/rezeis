import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockCache(overrides: Record<string, any> = {}) {
  const store: Record<string, { value: any; ttl?: number }> = {};
  return {
    get: async <T>(key: string): Promise<T | null> => {
      const entry = store[key];
      return entry ? (entry.value as T) : null;
    },
    set: async (key: string, value: unknown, ttlSeconds?: number): Promise<void> => {
      store[key] = { value, ttl: ttlSeconds };
    },
    del: async (key: string): Promise<void> => {
      delete store[key];
    },
    exists: async (key: string): Promise<boolean> => key in store,
    _store: store,
    ...overrides,
  } as any;
}

function createMockEmailService(overrides: Record<string, any> = {}) {
  const sentEmails: Array<{ emailAddress: string; code: string; expiresAt: Date }> = [];
  return {
    sendLinkedAccountVerificationCode: async (input: {
      emailAddress: string;
      code: string;
      expiresAt: Date;
    }) => {
      sentEmails.push(input);
    },
    _sentEmails: sentEmails,
    ...overrides,
  } as any;
}

function createMockPrisma(options: {
  webAccountExists?: boolean;
  webAccountUuid?: string;
  webAccountUserId?: bigint;
  emailAlreadyLinked?: boolean;
  challenges?: Array<{
    uuid: string;
    type: string;
    userId: bigint;
    code: string;
    attempts: number;
    consumed: boolean;
    expiresAt: Date;
    createdAt: Date;
  }>;
} = {}) {
  const {
    webAccountExists = true,
    webAccountUuid = 'test-uuid-1234',
    webAccountUserId = BigInt(12345),
    emailAlreadyLinked = false,
    challenges = [],
  } = options;

  const createdChallenges: any[] = [];
  const updatedChallenges: any[] = [];
  const updatedWebAccounts: any[] = [];

  return {
    webAccount: {
      findUnique: async (args: any) => {
        if (!webAccountExists) return null;
        if (args.where?.uuid) {
          return { uuid: webAccountUuid, userId: webAccountUserId };
        }
        return null;
      },
      findFirst: async (args: any) => {
        if (emailAlreadyLinked && args.where?.email) {
          return { uuid: 'other-user-uuid' };
        }
        return null;
      },
      update: async (args: any) => {
        updatedWebAccounts.push(args);
        return { uuid: webAccountUuid, ...args.data };
      },
    },
    authChallenge: {
      create: async (args: any) => {
        const challenge = {
          uuid: `challenge-${createdChallenges.length + 1}`,
          ...args.data,
          attempts: 0,
          consumed: false,
          createdAt: new Date(),
        };
        createdChallenges.push(challenge);
        return challenge;
      },
      findFirst: async (args: any) => {
        const matching = challenges
          .filter(
            (c) =>
              c.userId === args.where.userId &&
              c.type === args.where.type &&
              c.consumed === args.where.consumed,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matching[0] ?? null;
      },
      update: async (args: any) => {
        const challenge = challenges.find((c) => c.uuid === args.where.uuid);
        if (challenge) {
          if (args.data.attempts?.increment) {
            challenge.attempts += args.data.attempts.increment;
          }
          if (args.data.consumed !== undefined) {
            challenge.consumed = args.data.consumed;
          }
          updatedChallenges.push({ ...args, result: challenge });
          return challenge;
        }
        return null;
      },
    },
    _createdChallenges: createdChallenges,
    _updatedChallenges: updatedChallenges,
    _updatedWebAccounts: updatedWebAccounts,
  } as any;
}

function createService(
  prisma: any,
  cache?: any,
  emailService?: any,
): EmailVerificationService {
  return new EmailVerificationService(
    prisma,
    cache ?? createMockCache(),
    emailService ?? createMockEmailService(),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EmailVerificationService', () => {
  describe('normalizeEmail', () => {
    it('converts email to lowercase', () => {
      const service = createService(createMockPrisma());
      assert.equal(service.normalizeEmail('User@Example.COM'), 'user@example.com');
    });

    it('trims whitespace', () => {
      const service = createService(createMockPrisma());
      assert.equal(service.normalizeEmail('  user@example.com  '), 'user@example.com');
    });

    it('is idempotent', () => {
      const service = createService(createMockPrisma());
      const email = '  User@Example.COM  ';
      const first = service.normalizeEmail(email);
      const second = service.normalizeEmail(first);
      assert.equal(first, second);
    });

    it('handles already normalized email', () => {
      const service = createService(createMockPrisma());
      assert.equal(service.normalizeEmail('user@example.com'), 'user@example.com');
    });
  });

  describe('initiateEmailLinking', () => {
    it('throws NotFoundException when user account does not exist', async () => {
      const prisma = createMockPrisma({ webAccountExists: false });
      const service = createService(prisma);

      await assert.rejects(
        () => service.initiateEmailLinking({ userId: 'nonexistent-uuid', email: 'test@example.com' }),
        (err: any) => err instanceof NotFoundException,
      );
    });

    it('throws ConflictException when email is already linked to another account', async () => {
      const prisma = createMockPrisma({ emailAlreadyLinked: true });
      const emailService = createMockEmailService();
      const service = createService(prisma, createMockCache(), emailService);

      await assert.rejects(
        () => service.initiateEmailLinking({ userId: 'test-uuid-1234', email: 'taken@example.com' }),
        (err: any) => err instanceof ConflictException,
      );

      // Verify NO email was sent (reject immediately without sending)
      assert.equal(emailService._sentEmails.length, 0);
    });

    it('sends verification email on success', async () => {
      const prisma = createMockPrisma();
      const emailService = createMockEmailService();
      const cache = createMockCache();
      const service = createService(prisma, cache, emailService);

      const result = await service.initiateEmailLinking({
        userId: 'test-uuid-1234',
        email: 'User@Example.COM',
      });

      assert.equal(result.success, true);
      assert.equal(emailService._sentEmails.length, 1);
      // Email should be normalized
      assert.equal(emailService._sentEmails[0].emailAddress, 'user@example.com');
      // Code should be 6 digits
      assert.match(emailService._sentEmails[0].code, /^\d{6}$/);
    });

    it('normalizes email before uniqueness check', async () => {
      const prisma = createMockPrisma();
      const emailService = createMockEmailService();
      const service = createService(prisma, createMockCache(), emailService);

      const result = await service.initiateEmailLinking({
        userId: 'test-uuid-1234',
        email: '  USER@EXAMPLE.COM  ',
      });

      assert.equal(result.success, true);
      assert.equal(emailService._sentEmails[0].emailAddress, 'user@example.com');
    });

    it('creates AuthChallenge with type email_verify', async () => {
      const prisma = createMockPrisma();
      const service = createService(prisma);

      await service.initiateEmailLinking({
        userId: 'test-uuid-1234',
        email: 'test@example.com',
      });

      assert.equal(prisma._createdChallenges.length, 1);
      assert.equal(prisma._createdChallenges[0].type, 'email_verify');
    });
  });

  describe('verifyEmailCode', () => {
    it('throws NotFoundException when user account does not exist', async () => {
      const prisma = createMockPrisma({ webAccountExists: false });
      const service = createService(prisma);

      await assert.rejects(
        () => service.verifyEmailCode({ userId: 'nonexistent-uuid', code: '123456' }),
        (err: any) => err instanceof NotFoundException,
      );
    });

    it('returns failure when no active challenge exists', async () => {
      const prisma = createMockPrisma({ challenges: [] });
      const service = createService(prisma);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '123456' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
    });

    it('returns failure when challenge has expired', async () => {
      const expiredChallenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 0,
        consumed: false,
        expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      };
      const prisma = createMockPrisma({ challenges: [expiredChallenge] });
      const service = createService(prisma);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '123456' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.ok(result.message?.includes('expired'));
    });

    it('returns failure when challenge has 5 or more attempts', async () => {
      const lockedChallenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 5,
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [lockedChallenge] });
      const service = createService(prisma);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '123456' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.ok(result.message?.includes('Too many incorrect attempts'));
    });

    it('increments attempts on incorrect code', async () => {
      const challenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 0,
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [challenge] });
      const service = createService(prisma);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '000000' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.equal(challenge.attempts, 1);
    });

    it('invalidates challenge at exactly 5 incorrect attempts', async () => {
      const challenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 4, // 4 previous attempts, this will be the 5th
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [challenge] });
      const service = createService(prisma);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '000000' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.equal(challenge.attempts, 5);
      assert.equal(challenge.consumed, true); // invalidated
      assert.ok(result.message?.includes('invalidated'));
    });

    it('marks email verified on correct code', async () => {
      const challenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 0,
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [challenge] });
      const cache = createMockCache();
      // Pre-populate cache with pending email data
      await cache.set('email_verify_pending:test-uuid-1234', {
        email: 'user@example.com',
        code: '123456',
      });
      const service = createService(prisma, cache);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '123456' });

      assert.equal(result.success, true);
      assert.equal(result.verified, true);
      // Verify WebAccount was updated
      assert.equal(prisma._updatedWebAccounts.length, 1);
      assert.equal(prisma._updatedWebAccounts[0].data.email, 'user@example.com');
      assert.equal(prisma._updatedWebAccounts[0].data.emailVerified, true);
    });

    it('marks challenge as consumed on correct code', async () => {
      const challenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '654321',
        attempts: 2,
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [challenge] });
      const cache = createMockCache();
      await cache.set('email_verify_pending:test-uuid-1234', {
        email: 'test@example.com',
        code: '654321',
      });
      const service = createService(prisma, cache);

      await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '654321' });

      assert.equal(challenge.consumed, true);
    });

    it('returns failure when cache data expired but challenge is valid', async () => {
      const challenge = {
        uuid: 'challenge-1',
        type: 'email_verify',
        userId: BigInt(12345),
        code: '123456',
        attempts: 0,
        consumed: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      };
      const prisma = createMockPrisma({ challenges: [challenge] });
      // Empty cache — no pending email data
      const cache = createMockCache();
      const service = createService(prisma, cache);

      const result = await service.verifyEmailCode({ userId: 'test-uuid-1234', code: '123456' });

      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.ok(result.message?.includes('session expired'));
    });
  });
});
