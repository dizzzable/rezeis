/**
 * Property 15: Email Uniqueness Constraint
 *
 * *For any* email address already linked to User A, attempting to link it
 * to User B SHALL be rejected.
 *
 * **Validates: Requirements 5.6**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// --- Generators ---

/**
 * Generates valid email-like strings with random local parts and domains.
 */
const emailArb = fc
  .tuple(
    fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz0123456789._%+-'.split(''),
      ),
      { minLength: 1, maxLength: 20 },
    ),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      { minLength: 1, maxLength: 15 },
    ),
    fc.constantFrom('com', 'org', 'net', 'io', 'dev', 'ru'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/**
 * Generates UUID-like strings for web account identifiers.
 */
const uuidArb = fc.uuid();

// --- Mock builders ---

/**
 * Builds a mock PrismaService where webAccount.findFirst returns an existing
 * record (simulating the email is already linked to another user).
 */
function buildMockPrismaWithLinkedEmail(
  normalizedEmail: string,
  requestingUserUuid: string,
  existingAccountUuid: string,
) {
  return {
    webAccount: {
      findUnique: async (args: any) => {
        // When queried by uuid — return the requesting user's account (User B)
        if (args?.where?.uuid === requestingUserUuid) {
          return {
            uuid: requestingUserUuid,
            userId: BigInt(2002),
            username: 'user_b',
            email: null,
            emailVerified: false,
          };
        }
        return null;
      },
      findFirst: async (args: any) => {
        // Simulate email already linked to another account (User A)
        // The service queries: { email: normalizedEmail, uuid: { not: dto.userId } }
        if (
          args?.where?.email === normalizedEmail &&
          args?.where?.uuid?.not === requestingUserUuid
        ) {
          return {
            uuid: existingAccountUuid,
            userId: BigInt(1001),
            username: 'user_a',
            email: normalizedEmail,
            emailVerified: true,
          };
        }
        return null;
      },
    },
    authChallenge: {
      create: async () => {
        throw new Error('authChallenge.create should not be called when email is already linked');
      },
    },
  };
}

describe('Property 15: Email Uniqueness Constraint', () => {
  it('for any email already linked to User A, initiateEmailLinking() for User B throws ConflictException', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        uuidArb,
        uuidArb,
        async (email, requestingUserUuid, existingAccountUuid) => {
          // Ensure the two accounts are different (User A ≠ User B)
          fc.pre(requestingUserUuid !== existingAccountUuid);

          const service = new EmailVerificationService(null as any, null as any, null as any);
          const normalizedEmail = service.normalizeEmail(email);

          const mockPrisma = buildMockPrismaWithLinkedEmail(
            normalizedEmail,
            requestingUserUuid,
            existingAccountUuid,
          );

          // Reconstruct service with mocked prisma
          const testService = new EmailVerificationService(
            mockPrisma as any,
            null as any,
            null as any,
          );

          await assert.rejects(
            () => testService.initiateEmailLinking({ userId: requestingUserUuid, email }),
            (err: any) => {
              assert.ok(
                err instanceof ConflictException,
                `Expected ConflictException, got ${err?.constructor?.name}: ${err?.message}`,
              );
              return true;
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no verification code is generated or email sent when email is already linked', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        uuidArb,
        uuidArb,
        async (email, requestingUserUuid, existingAccountUuid) => {
          fc.pre(requestingUserUuid !== existingAccountUuid);

          const service = new EmailVerificationService(null as any, null as any, null as any);
          const normalizedEmail = service.normalizeEmail(email);

          let challengeCreated = false;
          let emailSent = false;

          const mockPrisma = {
            webAccount: {
              findUnique: async (args: any) => {
                if (args?.where?.uuid === requestingUserUuid) {
                  return {
                    uuid: requestingUserUuid,
                    userId: BigInt(2002),
                  };
                }
                return null;
              },
              findFirst: async (args: any) => {
                if (
                  args?.where?.email === normalizedEmail &&
                  args?.where?.uuid?.not === requestingUserUuid
                ) {
                  return { uuid: existingAccountUuid };
                }
                return null;
              },
            },
            authChallenge: {
              create: async () => {
                challengeCreated = true;
                return {};
              },
            },
          };

          const mockEmailService = {
            sendLinkedAccountVerificationCode: async () => {
              emailSent = true;
            },
          };

          const testService = new EmailVerificationService(
            mockPrisma as any,
            null as any,
            mockEmailService as any,
          );

          try {
            await testService.initiateEmailLinking({ userId: requestingUserUuid, email });
          } catch {
            // Expected to throw ConflictException
          }

          assert.equal(
            challengeCreated,
            false,
            'AuthChallenge must NOT be created when email is already linked to another user',
          );

          assert.equal(
            emailSent,
            false,
            'Verification email must NOT be sent when email is already linked to another user',
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejection occurs regardless of email casing or whitespace (normalization applied before check)', async () => {
    // Generate emails with mixed case and whitespace to verify normalization happens before uniqueness check
    const emailWithVariationsArb = fc
      .tuple(
        fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }),
        fc.stringOf(
          fc.constantFrom(
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'.split(''),
          ),
          { minLength: 1, maxLength: 15 },
        ),
        fc.stringOf(
          fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
          { minLength: 1, maxLength: 10 },
        ),
        fc.constantFrom('com', 'org', 'net'),
        fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }),
      )
      .map(([leadWs, local, domain, tld, trailWs]) => `${leadWs}${local}@${domain}.${tld}${trailWs}`);

    await fc.assert(
      fc.asyncProperty(
        emailWithVariationsArb,
        uuidArb,
        uuidArb,
        async (email, requestingUserUuid, existingAccountUuid) => {
          fc.pre(requestingUserUuid !== existingAccountUuid);

          const service = new EmailVerificationService(null as any, null as any, null as any);
          const normalizedEmail = service.normalizeEmail(email);

          const mockPrisma = buildMockPrismaWithLinkedEmail(
            normalizedEmail,
            requestingUserUuid,
            existingAccountUuid,
          );

          const testService = new EmailVerificationService(
            mockPrisma as any,
            null as any,
            null as any,
          );

          await assert.rejects(
            () => testService.initiateEmailLinking({ userId: requestingUserUuid, email }),
            (err: any) => {
              assert.ok(
                err instanceof ConflictException,
                `Expected ConflictException for email "${email}" (normalized: "${normalizedEmail}"), got ${err?.constructor?.name}`,
              );
              return true;
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
