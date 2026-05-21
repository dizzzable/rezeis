import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';

describe('AdminUserSearchQueryDto', () => {
  it('accepts exactly one identifier', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      login: 'user_login',
    });
    const actualErrors = await validate(dto);
    assert.deepStrictEqual(actualErrors, []);
  });

  it('rejects payloads without an identifier', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {});
    const actualErrors = await validate(dto);
    assert.equal(actualErrors.length, 1);
    assert.equal(
      actualErrors[0]?.constraints?.ExactlyOneAdminUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, login, or referralCode',
    );
  });

  it('rejects payloads with multiple identifiers', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      telegramId: '123456',
    });
    const actualErrors = await validate(dto);
    assert.equal(actualErrors.length, 1);
    assert.equal(
      actualErrors[0]?.constraints?.ExactlyOneAdminUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, login, or referralCode',
    );
  });

  it('accepts trimmed referral code lookups', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      referralCode: '  ref-code-123  ',
    });
    const actualErrors = await validate(dto);
    assert.deepStrictEqual(actualErrors, []);
    assert.equal(dto.referralCode, 'ref-code-123');
  });

  it('trims whitespace around email lookups', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      email: '  user@example.com  ',
    });
    const actualErrors = await validate(dto);
    assert.deepStrictEqual(actualErrors, []);
    assert.equal(dto.email, 'user@example.com');
  });

  it('trims whitespace around login lookups', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      login: '  User_Login  ',
    });
    const actualErrors = await validate(dto);
    assert.deepStrictEqual(actualErrors, []);
    assert.equal(dto.login, 'User_Login');
  });
});
