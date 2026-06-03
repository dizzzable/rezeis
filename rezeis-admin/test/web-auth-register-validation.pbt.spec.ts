import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import fc from 'fast-check';

import { WebAuthRegisterDto } from '../src/modules/web-auth/dto/web-auth-register.dto';

describe('WebAuthRegisterDto property validation', () => {
  const VALID_LOGIN = 'valid-user';
  const VALID_PASSWORD = 'valid-password';
  const LOGIN_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('');
  const LOGIN_REGEX = /^[A-Za-z0-9._-]{3,64}$/;

  it('accepts any login matching the current web-auth login DTO shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringOf(fc.constantFrom(...LOGIN_CHARACTERS), { minLength: 3, maxLength: 64 }),
        async (login) => {
          assert.equal(await isValidRegisterPayload({ login, password: VALID_PASSWORD }), true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects allowed-character logins outside the 3-64 character bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.stringOf(fc.constantFrom(...LOGIN_CHARACTERS), { minLength: 0, maxLength: 2 }),
          fc.stringOf(fc.constantFrom(...LOGIN_CHARACTERS), { minLength: 65, maxLength: 100 }),
        ),
        async (login) => {
          assert.equal(await isValidRegisterPayload({ login, password: VALID_PASSWORD }), false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects bounded logins containing characters outside the current login alphabet', async () => {
    const invalidLoginArbitrary = fc
      .tuple(
        fc.array(fc.constantFrom(...LOGIN_CHARACTERS), { minLength: 2, maxLength: 30 }),
        fc.constantFrom(' ', '@', '!', '/', '\\', ':', 'п', '中'),
        fc.array(fc.constantFrom(...LOGIN_CHARACTERS), { minLength: 0, maxLength: 30 }),
      )
      .map(([prefix, invalidCharacter, suffix]) => [...prefix, invalidCharacter, ...suffix].join(''))
      .filter((login) => login.length >= 3 && login.length <= 64);

    await fc.assert(
      fc.asyncProperty(invalidLoginArbitrary, async (login) => {
        assert.equal(await isValidRegisterPayload({ login, password: VALID_PASSWORD }), false);
      }),
      { numRuns: 500 },
    );
  });

  it('matches the login regex for generated bounded login candidates', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 80 }), async (login) => {
        assert.equal(
          await isValidRegisterPayload({ login, password: VALID_PASSWORD }),
          LOGIN_REGEX.test(login),
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('accepts arbitrary plain passwords within the 8-256 character bound', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8, maxLength: 256 }), async (password) => {
        assert.equal(await isValidRegisterPayload({ login: VALID_LOGIN, password }), true);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects plain passwords outside the 8-256 character bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string({ minLength: 0, maxLength: 7 }), fc.string({ minLength: 257, maxLength: 320 })),
        async (password) => {
          assert.equal(await isValidRegisterPayload({ login: VALID_LOGIN, password }), false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

async function isValidRegisterPayload(payload: Record<string, unknown>): Promise<boolean> {
  const dto = plainToInstance(WebAuthRegisterDto, payload);
  const errors = await validate(dto);
  return errors.length === 0;
}
