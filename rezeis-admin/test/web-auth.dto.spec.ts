import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RegisterSchema } from '../src/modules/web-auth/dto/register.dto';

describe('RegisterSchema (DTO validation)', () => {
  describe('username validation', () => {
    it('accepts valid usernames (alphanumeric, hyphens, underscores, 3-32 chars)', () => {
      const validUsernames = ['abc', 'user_name', 'my-user', 'User123', 'a'.repeat(32), 'A-B_c'];
      for (const username of validUsernames) {
        const result = RegisterSchema.safeParse({ username, passwordHash: 'a'.repeat(64) });
        assert.ok(result.success, `Expected "${username}" to be valid, got: ${JSON.stringify(result.error?.issues)}`);
      }
    });

    it('rejects usernames shorter than 3 characters', () => {
      const result = RegisterSchema.safeParse({ username: 'ab', passwordHash: 'a'.repeat(64) });
      assert.equal(result.success, false);
    });

    it('rejects usernames longer than 32 characters', () => {
      const result = RegisterSchema.safeParse({ username: 'a'.repeat(33), passwordHash: 'a'.repeat(64) });
      assert.equal(result.success, false);
    });

    it('rejects usernames with invalid characters', () => {
      const invalidUsernames = ['user name', 'user@name', 'user.name', 'user!', 'пользователь'];
      for (const username of invalidUsernames) {
        const result = RegisterSchema.safeParse({ username, passwordHash: 'a'.repeat(64) });
        assert.equal(result.success, false, `Expected "${username}" to be invalid`);
      }
    });
  });

  describe('passwordHash validation', () => {
    it('accepts valid SHA-256 hex strings (64 lowercase hex chars)', () => {
      const validHashes = [
        'a'.repeat(64),
        '0123456789abcdef'.repeat(4),
        'deadbeef'.repeat(8),
      ];
      for (const passwordHash of validHashes) {
        const result = RegisterSchema.safeParse({ username: 'valid-user', passwordHash });
        assert.ok(result.success, `Expected hash to be valid: ${passwordHash.substring(0, 10)}...`);
      }
    });

    it('rejects password hashes that are not 64 characters', () => {
      const result = RegisterSchema.safeParse({ username: 'valid-user', passwordHash: 'a'.repeat(63) });
      assert.equal(result.success, false);

      const result2 = RegisterSchema.safeParse({ username: 'valid-user', passwordHash: 'a'.repeat(65) });
      assert.equal(result2.success, false);
    });

    it('rejects password hashes with non-hex characters', () => {
      const result = RegisterSchema.safeParse({ username: 'valid-user', passwordHash: 'g'.repeat(64) });
      assert.equal(result.success, false);

      const result2 = RegisterSchema.safeParse({ username: 'valid-user', passwordHash: 'A'.repeat(64) });
      assert.equal(result2.success, false);
    });
  });
});
