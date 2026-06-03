import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { WebAuthLoginDto } from '../src/modules/web-auth/dto/web-auth-login.dto';
import { WebAuthRecoverDto } from '../src/modules/web-auth/dto/web-auth-recover.dto';
import { WebAuthRegisterDto } from '../src/modules/web-auth/dto/web-auth-register.dto';

describe('web-auth DTO validation', () => {
  describe('WebAuthRegisterDto', () => {
    it('accepts the current internal register payload contract', async () => {
      const errors = await validateDto(WebAuthRegisterDto, {
        login: 'User.Name-123',
        password: 'correct horse battery staple',
        email: 'user@example.com',
        telegramIdToLink: '123456789',
        referralCode: 'referrer-code',
      });

      assert.deepStrictEqual(errors, []);
    });

    it('rejects stale username/passwordHash register payloads', async () => {
      const errors = await validateDto(WebAuthRegisterDto, {
        username: 'valid-user',
        passwordHash: 'a'.repeat(64),
      });

      assert.deepStrictEqual(readErrorProperties(errors), ['login', 'password']);
    });

    it('enforces login syntax and length on register payloads', async () => {
      for (const login of ['ab', 'a'.repeat(65), 'user name', 'user@name', 'пользователь']) {
        const errors = await validateDto(WebAuthRegisterDto, {
          login,
          password: 'valid-password',
        });

        assert.ok(errors.some((error) => error.property === 'login'), `Expected ${login} to fail`);
      }
    });

    it('enforces plain password length instead of accepting pre-hashed passwords', async () => {
      const tooShortErrors = await validateDto(WebAuthRegisterDto, {
        login: 'valid-user',
        password: 'short',
      });
      const tooLongErrors = await validateDto(WebAuthRegisterDto, {
        login: 'valid-user',
        password: 'a'.repeat(257),
      });

      assert.ok(tooShortErrors.some((error) => error.property === 'password'));
      assert.ok(tooLongErrors.some((error) => error.property === 'password'));
    });

    it('validates optional email, telegram link, and referral fields when present', async () => {
      const errors = await validateDto(WebAuthRegisterDto, {
        login: 'valid-user',
        password: 'valid-password',
        email: 'not-an-email',
        telegramIdToLink: 'not-numeric',
        referralCode: '',
      });

      assert.deepStrictEqual(readErrorProperties(errors), [
        'email',
        'referralCode',
        'telegramIdToLink',
      ]);
    });
  });

  describe('WebAuthLoginDto', () => {
    it('accepts login plus plain password credentials', async () => {
      const errors = await validateDto(WebAuthLoginDto, {
        login: 'valid-user',
        password: 'valid-password',
      });

      assert.deepStrictEqual(errors, []);
    });
  });

  describe('WebAuthRecoverDto', () => {
    it('accepts only a bounded login lookup', async () => {
      const validErrors = await validateDto(WebAuthRecoverDto, { login: 'valid-user' });
      const invalidErrors = await validateDto(WebAuthRecoverDto, { login: 'ab' });

      assert.deepStrictEqual(validErrors, []);
      assert.deepStrictEqual(readErrorProperties(invalidErrors), ['login']);
    });
  });
});

function validateDto<T extends object>(
  dtoType: new () => T,
  payload: Record<string, unknown>,
): ReturnType<typeof validate> {
  return validate(plainToInstance(dtoType, payload));
}

function readErrorProperties(errors: Awaited<ReturnType<typeof validate>>): readonly string[] {
  return errors.map((error) => error.property).sort();
}
