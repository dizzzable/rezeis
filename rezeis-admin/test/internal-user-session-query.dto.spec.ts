import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InternalUserSessionQueryDto } from '../src/modules/internal-user/dto/internal-user-session-query.dto';

describe('InternalUserSessionQueryDto', () => {
  it('accepts exactly one identifier', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      login: 'user_login',
    });
    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
  });

  it('rejects payloads without an identifier', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {});
    const errors = await validate(dto);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.ExactlyOneUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  });

  it('rejects payloads with multiple identifiers', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      telegramId: '123456',
    });
    const errors = await validate(dto);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.ExactlyOneUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  });

  it('trims whitespace around email lookups', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      email: '  user@example.com  ',
    });
    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
    assert.equal(dto.email, 'user@example.com');
  });

  it('trims whitespace around login lookups', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      login: '  User_Login  ',
    });
    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
    assert.equal(dto.login, 'User_Login');
  });

  it('rejects invalid login lookups with the shared message', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      login: 'not valid',
    });
    const errors = await validate(dto);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.constraints?.matches, 'login must be a valid web-account login');
  });

  it('rejects invalid email lookups with the shared message', async () => {
    const dto = plainToInstance(InternalUserSessionQueryDto, {
      email: 'not-an-email',
    });
    const errors = await validate(dto);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.constraints?.matches, 'email must be a valid email address');
  });
});
