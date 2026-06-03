import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InternalByTelegramQueryDto } from '../src/modules/internal-user/dto/internal-by-telegram-query.dto';
import { requireUserReference } from '../src/modules/internal-user/utils/user-reference.util';

describe('internal user edge identity DTO', () => {
  it('accepts canonical reiwa_id references', async () => {
    const dto = plainToInstance(InternalByTelegramQueryDto, {
      userId: 'cmphfcr6i007v01jg0lcu653h',
    });

    const errors = await validate(dto);

    assert.deepStrictEqual(errors, []);
    assert.equal(requireUserReference(dto), 'cmphfcr6i007v01jg0lcu653h');
  });

  it('accepts positive Telegram id references', async () => {
    const dto = plainToInstance(InternalByTelegramQueryDto, {
      telegramId: '123456789',
    });

    const errors = await validate(dto);

    assert.deepStrictEqual(errors, []);
    assert.equal(requireUserReference(dto), '123456789');
  });

  it('rejects malformed Telegram ids before controller resolution', async () => {
    const dto = plainToInstance(InternalByTelegramQueryDto, {
      telegramId: '12-not-a-telegram-id',
    });

    const errors = await validate(dto);

    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.constraints?.matches,
      'telegramId must be a positive numeric string up to 19 digits',
    );
  });

  it('fails controller resolution when both identities are omitted', () => {
    assert.throws(
      () => requireUserReference({}),
      /A userId or telegramId is required/,
    );
  });
});
