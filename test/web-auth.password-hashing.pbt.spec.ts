import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as bcrypt from 'bcryptjs';
import fc from 'fast-check';

/**
 * Property 2: Password Hashing Round-Trip
 *
 * For any password string, computing SHA-256(password) then bcrypt(sha256Hash)
 * SHALL produce a stored hash such that bcrypt.compare(SHA-256(password), storedHash)
 * returns true.
 *
 * **Validates: Requirements 1.6**
 */

const BCRYPT_ROUNDS = 12;

/**
 * Arbitrary that generates valid SHA-256 hex strings (64 lowercase hex chars).
 * This matches the format the client sends to the server.
 */
const arbitrarySha256Hex = fc.hexaString({ minLength: 64, maxLength: 64 });

describe('Feature: web-auth-pwa, Property 2: Password Hashing Round-Trip', () => {
  it('bcrypt(sha256Hash) produces a hash that verifies with bcrypt.compare for the same input', async () => {
    await fc.assert(
      fc.asyncProperty(arbitrarySha256Hex, async (sha256Hash) => {
        // Hash the SHA-256 hex string with bcrypt (same as the service does)
        const storedHash = await bcrypt.hash(sha256Hash, BCRYPT_ROUNDS);

        // Verify that bcrypt.compare returns true for the original hash
        const isMatch = await bcrypt.compare(sha256Hash, storedHash);
        assert.equal(isMatch, true, `bcrypt.compare should return true for the original SHA-256 hash`);
      }),
      { numRuns: 100 },
    );
  });

  it('bcrypt(sha256Hash) produces a hash that does NOT verify with a different SHA-256 hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySha256Hex,
        arbitrarySha256Hex,
        async (sha256Hash, differentHash) => {
          // Skip when both hashes happen to be the same
          fc.pre(sha256Hash !== differentHash);

          // Hash the first SHA-256 hex string with bcrypt
          const storedHash = await bcrypt.hash(sha256Hash, BCRYPT_ROUNDS);

          // Verify that bcrypt.compare returns false for a different hash
          const isMatch = await bcrypt.compare(differentHash, storedHash);
          assert.equal(isMatch, false, `bcrypt.compare should return false for a different SHA-256 hash`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
