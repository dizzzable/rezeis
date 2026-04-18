import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CompleteWebAccountEmailVerificationDto } from '../src/modules/internal-user/dto/complete-web-account-email-verification.dto';

describe('CompleteWebAccountEmailVerificationDto', () => {
  it('accepts the canonical userId plus a 6-digit code', async () => {
    const dto = plainToInstance(CompleteWebAccountEmailVerificationDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      code: '123456',
    });
    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
  });

  it('rejects non-canonical payloads and non-6-digit codes', async () => {
    const invalidCodeDto = plainToInstance(CompleteWebAccountEmailVerificationDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      code: '12345a',
      email: 'user@example.com',
    });
    const invalidUserIdDto = plainToInstance(CompleteWebAccountEmailVerificationDto, {
      telegramId: '123456789',
      code: '123456',
    });
    const invalidCodeErrors = await validate(invalidCodeDto);
    const invalidUserIdErrors = await validate(invalidUserIdDto);
    assert.equal(invalidCodeErrors.length, 1);
    assert.equal(
      invalidCodeErrors[0]?.constraints?.matches,
      'code must be a 6-digit numeric string',
    );
    assert.equal(invalidUserIdErrors.length, 1);
    assert.equal(invalidUserIdErrors[0]?.constraints?.isUuid, 'userId must be a UUID');
  });
});
