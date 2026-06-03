import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';

describe('AdminUserSearchQueryDto', () => {
  it('accepts exactly one current user identifier', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      login: 'user_login',
    });

    assert.deepStrictEqual(await validate(dto), []);
  });

  it('rejects payloads without an identifier', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {});
    const errors = await validate(dto);

    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.ExactlyOneUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  });

  it('rejects payloads with multiple identifiers', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      userId: 'user-1',
      telegramId: '123456',
    });
    const errors = await validate(dto);

    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.ExactlyOneUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  });

  it('trims whitespace around email and login lookups', async () => {
    const emailDto = plainToInstance(AdminUserSearchQueryDto, {
      email: '  user@example.com  ',
    });
    const loginDto = plainToInstance(AdminUserSearchQueryDto, {
      login: '  User_Login  ',
    });

    assert.deepStrictEqual(await validate(emailDto), []);
    assert.deepStrictEqual(await validate(loginDto), []);
    assert.equal(emailDto.email, 'user@example.com');
    assert.equal(loginDto.login, 'User_Login');
  });

  it('does not count removed referralCode lookups on the single-user route', async () => {
    const dto = plainToInstance(AdminUserSearchQueryDto, {
      referralCode: 'ref-code-123',
    });
    const errors = await validate(dto);

    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.ExactlyOneUserIdentifier,
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  });
});

describe('AdminUserListQueryDto', () => {
  it('keeps referral-code matching on the paginated list search field', async () => {
    const dto = plainToInstance(AdminUserListQueryDto, {
      search: ' ref-code-123 ',
      limit: '25',
      offset: '5',
    });

    assert.deepStrictEqual(await validate(dto), []);
    assert.equal(dto.search, ' ref-code-123 ');
    assert.equal(dto.limit, 25);
    assert.equal(dto.offset, 5);
  });

  it('bounds list pagination parameters', async () => {
    const dto = plainToInstance(AdminUserListQueryDto, {
      search: 'user',
      limit: '250',
      offset: '-1',
    });
    const errors = await validate(dto);

    assert.equal(errors.some((error) => error.property === 'limit'), true);
    assert.equal(errors.some((error) => error.property === 'offset'), true);
  });
});
