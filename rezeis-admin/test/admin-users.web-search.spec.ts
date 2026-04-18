import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUserSearchParams } from '../web/src/features/users/user-search-request';
import { createUserSearchSchema } from '../web/src/features/users/user-search-schema';

describe('admin users web search contract', () => {
  it('accepts a single web login identifier in the frontend search schema', () => {
    const schema = createUserSearchSchema();
    const actualValues = schema.parse({
      userId: '',
      telegramId: '',
      email: '',
      login: '  User_Login  ',
    });
    assert.equal(actualValues.login, '  User_Login  ');
  });

  it('rejects frontend payloads that combine login with another identifier', () => {
    const schema = createUserSearchSchema();
    const actualResult = schema.safeParse({
      userId: '',
      telegramId: '',
      email: 'user@example.com',
      login: 'user_login',
    });
    assert.equal(actualResult.success, false);
    if (actualResult.success) {
      return;
    }
    const actualMessages = actualResult.error.issues.map((issue) => issue.message);
    assert.ok(actualMessages.includes('users.searchPage.form.errors.exactlyOneIdentifier'));
  });

  it('builds the admin users search request with the explicit login query parameter', () => {
    const actualParams = buildUserSearchParams({
      userId: '',
      telegramId: '',
      email: '',
      login: '  User_Login  ',
    });
    assert.deepStrictEqual(actualParams, {
      userId: undefined,
      telegramId: undefined,
      email: undefined,
      login: 'User_Login',
    });
  });
});
