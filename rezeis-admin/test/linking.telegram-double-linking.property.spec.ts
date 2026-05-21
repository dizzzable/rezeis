/**
 * Property 8: Telegram Double-Linking Prevention
 *
 * *For any* Telegram account already linked to User A, attempting to link it
 * to User B SHALL be rejected.
 *
 * **Validates: Requirements 3.3**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { LinkingService } from '../src/modules/linking/linking.service';

// --- Generators ---

/**
 * Generates valid Telegram IDs (positive integers).
 */
const telegramIdArb = fc.integer({ min: 1, max: 2_000_000_000 });

/**
 * Generates valid 8-character alphanumeric linking codes.
 */
const linkingCodeArb = fc.stringOf(
  fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ),
  { minLength: 8, maxLength: 8 },
);

/**
 * Generates UUID-like strings for web account identifiers.
 */
const uuidArb = fc.uuid();

// --- Mock builders ---

/**
 * Builds a mock PrismaService where webAccount.findUnique returns an existing
 * record for the given telegramId (simulating it's already linked to another user).
 */
function buildMockPrismaWithLinkedTelegram(
  telegramId: number,
  existingAccountUuid: string,
  targetAccountUuid: string,
) {
  return {
    webAccount: {
      findUnique: async (args: any) => {
        // When queried by telegramId — return existing linked account (User A)
        if (args?.where?.telegramId !== undefined) {
          const queryId = args.where.telegramId;
          // Compare as BigInt since the service uses BigInt(dto.telegramId)
          if (queryId === BigInt(telegramId)) {
            return {
              uuid: existingAccountUuid,
              userId: BigInt(1001),
              username: 'user_a',
              telegramId: BigInt(telegramId),
              telegramUsername: 'telegram_user_a',
            };
          }
          return null;
        }
        // When queried by uuid — return the target account (User B)
        if (args?.where?.uuid === targetAccountUuid) {
          return {
            uuid: targetAccountUuid,
            userId: BigInt(2002),
            username: 'user_b',
            telegramId: null,
            telegramUsername: null,
          };
        }
        return null;
      },
      update: async () => {
        throw new Error('Update should not be called when double-linking is prevented');
      },
    },
  };
}

/**
 * Builds a mock RawCacheService that returns linking data for the given code.
 */
function buildMockCache(code: string, targetAccountUuid: string) {
  return {
    get: async (key: string) => {
      if (key === `telegram_link:${code}`) {
        return {
          userId: 'user-b-id',
          webAccountUuid: targetAccountUuid,
        };
      }
      return null;
    },
    set: async () => {},
    del: async () => {},
    exists: async () => false,
  };
}

describe('Property 8: Telegram Double-Linking Prevention', () => {
  it('for any telegramId already linked to User A, verifyTelegramCode() for User B returns {success: false}', async () => {
    await fc.assert(
      fc.asyncProperty(
        telegramIdArb,
        linkingCodeArb,
        uuidArb,
        uuidArb,
        async (telegramId, code, existingAccountUuid, targetAccountUuid) => {
          // Ensure the two accounts are different (User A ≠ User B)
          fc.pre(existingAccountUuid !== targetAccountUuid);

          const mockPrisma = buildMockPrismaWithLinkedTelegram(
            telegramId,
            existingAccountUuid,
            targetAccountUuid,
          );
          const mockCache = buildMockCache(code, targetAccountUuid);

          const service = new LinkingService(mockPrisma as any, mockCache as any);

          const result = await service.verifyTelegramCode({
            code,
            telegramId,
            telegramUsername: 'some_user',
          });

          // The linking attempt must be rejected
          assert.equal(
            result.success,
            false,
            `Expected {success: false} when telegramId ${telegramId} is already linked to another user`,
          );

          // The message should indicate the Telegram account is already linked
          assert.ok(
            result.message.toLowerCase().includes('already linked'),
            `Expected message to mention "already linked", got: "${result.message}"`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the rejection message is consistent regardless of the telegramId value', async () => {
    await fc.assert(
      fc.asyncProperty(
        telegramIdArb,
        telegramIdArb,
        linkingCodeArb,
        uuidArb,
        uuidArb,
        async (telegramId1, telegramId2, code, existingUuid, targetUuid) => {
          fc.pre(existingUuid !== targetUuid);

          const mockPrisma1 = buildMockPrismaWithLinkedTelegram(telegramId1, existingUuid, targetUuid);
          const mockCache1 = buildMockCache(code, targetUuid);
          const service1 = new LinkingService(mockPrisma1 as any, mockCache1 as any);

          const mockPrisma2 = buildMockPrismaWithLinkedTelegram(telegramId2, existingUuid, targetUuid);
          const mockCache2 = buildMockCache(code, targetUuid);
          const service2 = new LinkingService(mockPrisma2 as any, mockCache2 as any);

          const result1 = await service1.verifyTelegramCode({
            code,
            telegramId: telegramId1,
            telegramUsername: 'user_x',
          });

          const result2 = await service2.verifyTelegramCode({
            code,
            telegramId: telegramId2,
            telegramUsername: 'user_y',
          });

          // Both must fail
          assert.equal(result1.success, false);
          assert.equal(result2.success, false);

          // Error messages must be identical (no information leakage about which telegramId)
          assert.equal(
            result1.message,
            result2.message,
            `Error messages must be identical regardless of telegramId. Got "${result1.message}" vs "${result2.message}"`,
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('no database update is attempted when double-linking is detected', async () => {
    await fc.assert(
      fc.asyncProperty(
        telegramIdArb,
        linkingCodeArb,
        uuidArb,
        uuidArb,
        async (telegramId, code, existingAccountUuid, targetAccountUuid) => {
          fc.pre(existingAccountUuid !== targetAccountUuid);

          let updateCalled = false;

          const mockPrisma = {
            webAccount: {
              findUnique: async (args: any) => {
                if (args?.where?.telegramId !== undefined) {
                  const queryId = args.where.telegramId;
                  if (queryId === BigInt(telegramId)) {
                    return {
                      uuid: existingAccountUuid,
                      userId: BigInt(1001),
                      telegramId: BigInt(telegramId),
                    };
                  }
                  return null;
                }
                if (args?.where?.uuid === targetAccountUuid) {
                  return {
                    uuid: targetAccountUuid,
                    userId: BigInt(2002),
                    telegramId: null,
                    telegramUsername: null,
                  };
                }
                return null;
              },
              update: async () => {
                updateCalled = true;
                return {};
              },
            },
          };

          const mockCache = buildMockCache(code, targetAccountUuid);
          const service = new LinkingService(mockPrisma as any, mockCache as any);

          await service.verifyTelegramCode({
            code,
            telegramId,
          });

          assert.equal(
            updateCalled,
            false,
            'Database update must NOT be called when Telegram account is already linked to another user',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
