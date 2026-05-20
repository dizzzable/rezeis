import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { RegisterSchema } from '../src/modules/web-auth/dto/register.dto';

/**
 * Property 1: Registration Input Validation
 *
 * For any string, the username validator SHALL accept it if and only if it matches
 * the pattern ^[a-zA-Z0-9_-]{3,32}$, and the password hash validator SHALL accept
 * it if and only if it is exactly 64 lowercase hex characters.
 *
 * **Validates: Requirements 1.3, 1.4**
 */
describe('Property 1: Registration Input Validation', () => {
  const VALID_PASSWORD_HASH = 'a'.repeat(64);
  const VALID_USERNAME = 'valid-user';
  const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;
  const PASSWORD_HASH_REGEX = /^[a-f0-9]{64}$/;

  describe('Username validation', () => {
    it('accepts any string matching ^[a-zA-Z0-9_-]{3,32}$', () => {
      const validUsernameArb = fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
        { minLength: 3, maxLength: 32 },
      );

      fc.assert(
        fc.property(validUsernameArb, (username) => {
          const result = RegisterSchema.safeParse({ username, passwordHash: VALID_PASSWORD_HASH });
          assert.ok(
            result.success,
            `Expected username "${username}" to pass validation but got: ${JSON.stringify(result.error?.issues)}`,
          );
        }),
        { numRuns: 500 },
      );
    });

    it('rejects any string shorter than 3 characters', () => {
      const shortUsernameArb = fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
        { minLength: 0, maxLength: 2 },
      );

      fc.assert(
        fc.property(shortUsernameArb, (username) => {
          const result = RegisterSchema.safeParse({ username, passwordHash: VALID_PASSWORD_HASH });
          assert.equal(result.success, false, `Expected short username "${username}" (len=${username.length}) to fail`);
        }),
        { numRuns: 200 },
      );
    });

    it('rejects any string longer than 32 characters', () => {
      const longUsernameArb = fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
        { minLength: 33, maxLength: 100 },
      );

      fc.assert(
        fc.property(longUsernameArb, (username) => {
          const result = RegisterSchema.safeParse({ username, passwordHash: VALID_PASSWORD_HASH });
          assert.equal(result.success, false, `Expected long username (len=${username.length}) to fail`);
        }),
        { numRuns: 200 },
      );
    });

    it('rejects any string containing invalid characters (regardless of length)', () => {
      // Generate strings that contain at least one character NOT in [a-zA-Z0-9_-]
      const invalidCharArb = fc.unicode().filter((c) => !/^[a-zA-Z0-9_-]$/.test(c));
      const validCharArb = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split(''));

      // Build a username of valid length (3-32) but inject at least one invalid char
      const invalidUsernameArb = fc
        .tuple(
          fc.array(validCharArb, { minLength: 2, maxLength: 30 }),
          invalidCharArb,
          fc.array(validCharArb, { minLength: 0, maxLength: 10 }),
        )
        .map(([prefix, badChar, suffix]) => [...prefix, badChar, ...suffix].join(''))
        .filter((s) => s.length >= 3 && s.length <= 32);

      fc.assert(
        fc.property(invalidUsernameArb, (username) => {
          const result = RegisterSchema.safeParse({ username, passwordHash: VALID_PASSWORD_HASH });
          assert.equal(
            result.success,
            false,
            `Expected username with invalid chars "${username}" to fail validation`,
          );
        }),
        { numRuns: 500 },
      );
    });

    it('validation result matches the regex for arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 50 }), (username) => {
          const result = RegisterSchema.safeParse({ username, passwordHash: VALID_PASSWORD_HASH });
          const shouldPass = USERNAME_REGEX.test(username);
          assert.equal(
            result.success,
            shouldPass,
            `Username "${username}": expected ${shouldPass ? 'pass' : 'fail'} but got ${result.success ? 'pass' : 'fail'}`,
          );
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe('Password hash validation', () => {
    it('accepts any 64-character lowercase hex string', () => {
      const validHashArb = fc.stringOf(
        fc.constantFrom(...'0123456789abcdef'.split('')),
        { minLength: 64, maxLength: 64 },
      );

      fc.assert(
        fc.property(validHashArb, (passwordHash) => {
          const result = RegisterSchema.safeParse({ username: VALID_USERNAME, passwordHash });
          assert.ok(
            result.success,
            `Expected valid hash "${passwordHash.substring(0, 10)}..." to pass validation`,
          );
        }),
        { numRuns: 500 },
      );
    });

    it('rejects hex strings shorter than 64 characters', () => {
      const shortHashArb = fc.stringOf(
        fc.constantFrom(...'0123456789abcdef'.split('')),
        { minLength: 0, maxLength: 63 },
      );

      fc.assert(
        fc.property(shortHashArb, (passwordHash) => {
          const result = RegisterSchema.safeParse({ username: VALID_USERNAME, passwordHash });
          assert.equal(result.success, false, `Expected short hash (len=${passwordHash.length}) to fail`);
        }),
        { numRuns: 200 },
      );
    });

    it('rejects hex strings longer than 64 characters', () => {
      const longHashArb = fc.stringOf(
        fc.constantFrom(...'0123456789abcdef'.split('')),
        { minLength: 65, maxLength: 200 },
      );

      fc.assert(
        fc.property(longHashArb, (passwordHash) => {
          const result = RegisterSchema.safeParse({ username: VALID_USERNAME, passwordHash });
          assert.equal(result.success, false, `Expected long hash (len=${passwordHash.length}) to fail`);
        }),
        { numRuns: 200 },
      );
    });

    it('rejects 64-character strings with non-hex characters', () => {
      // Generate a 64-char string that contains at least one non-hex char
      const nonHexCharArb = fc.char().filter((c) => !/^[a-f0-9]$/.test(c));
      const hexCharArb = fc.constantFrom(...'0123456789abcdef'.split(''));

      const invalidHashArb = fc
        .tuple(
          fc.array(hexCharArb, { minLength: 0, maxLength: 62 }),
          nonHexCharArb,
          fc.array(hexCharArb, { minLength: 0, maxLength: 62 }),
        )
        .map(([prefix, badChar, suffix]) => {
          const combined = [...prefix, badChar, ...suffix];
          // Ensure exactly 64 chars by padding or trimming
          while (combined.length < 64) combined.push('a');
          return combined.slice(0, 64).join('');
        })
        .filter((s) => s.length === 64 && !PASSWORD_HASH_REGEX.test(s));

      fc.assert(
        fc.property(invalidHashArb, (passwordHash) => {
          const result = RegisterSchema.safeParse({ username: VALID_USERNAME, passwordHash });
          assert.equal(
            result.success,
            false,
            `Expected hash with non-hex chars to fail: "${passwordHash.substring(0, 10)}..."`,
          );
        }),
        { numRuns: 500 },
      );
    });

    it('validation result matches the regex for arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 100 }), (passwordHash) => {
          const result = RegisterSchema.safeParse({ username: VALID_USERNAME, passwordHash });
          const shouldPass = PASSWORD_HASH_REGEX.test(passwordHash);
          assert.equal(
            result.success,
            shouldPass,
            `Hash "${passwordHash.substring(0, 16)}..." (len=${passwordHash.length}): expected ${shouldPass ? 'pass' : 'fail'} but got ${result.success ? 'pass' : 'fail'}`,
          );
        }),
        { numRuns: 1000 },
      );
    });
  });
});
