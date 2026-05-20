import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

const EXACTLY_ONE_IDENTIFIER_ERROR = 'users.searchPage.form.errors.exactlyOneIdentifier';

function normalizeValue(value: string): string | undefined {
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : undefined;
}

function createContractSearchSchema() {
  return z
    .object({
      userId: z.string(),
      telegramId: z.string(),
      email: z.string(),
      login: z.string(),
    })
    .superRefine((values, ctx): void => {
      const identifierCount = [values.userId, values.telegramId, values.email, values.login].filter(
        (value) => value.trim().length > 0,
      ).length;
      if (identifierCount === 1) {
        return;
      }
      for (const path of ['userId', 'telegramId', 'email', 'login'] as const) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: EXACTLY_ONE_IDENTIFIER_ERROR,
        });
      }
    });
}

describe('admin users web search contract', () => {
  it('accepts a single web login identifier in the frontend search schema', () => {
    const schema = createContractSearchSchema();
    const actualValues = schema.parse({
      userId: '',
      telegramId: '',
      email: '',
      login: '  User_Login  ',
    });
    assert.equal(actualValues.login, '  User_Login  ');
  });

  it('rejects frontend payloads that combine login with another identifier', () => {
    const schema = createContractSearchSchema();
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
    assert.ok(actualMessages.includes(EXACTLY_ONE_IDENTIFIER_ERROR));
  });

  it('builds the admin users search request with the explicit login query parameter', () => {
    const actualParams = {
      userId: normalizeValue(''),
      telegramId: normalizeValue(''),
      email: normalizeValue(''),
      login: normalizeValue('  User_Login  '),
    };
    assert.deepStrictEqual(actualParams, {
      userId: undefined,
      telegramId: undefined,
      email: undefined,
      login: 'User_Login',
    });
  });
});
