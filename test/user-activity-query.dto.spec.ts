import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListUserNotificationsQueryDto } from '../src/modules/user-activity/dto/list-user-notifications-query.dto';
import { ListUserTransactionsHistoryQueryDto } from '../src/modules/user-activity/dto/list-user-transactions-history-query.dto';

describe('user-activity query DTOs', () => {
  it('transforms and validates transactions query pagination', async () => {
    const dto = plainToInstance(ListUserTransactionsHistoryQueryDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      page: '2',
      limit: '15',
    });

    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
    assert.equal(dto.page, 2);
    assert.equal(dto.limit, 15);
  });

  it('rejects invalid notifications query boolean values', async () => {
    const dto = plainToInstance(ListUserNotificationsQueryDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      isRead: 'sometimes',
    });

    const errors = await validate(dto);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.constraints?.isBoolean, 'isRead must be a boolean value');
  });

  it('transforms notifications query pagination and booleans', async () => {
    const dto = plainToInstance(ListUserNotificationsQueryDto, {
      userId: '7078f4b8-1df0-4e02-bdd6-d7a15a1bfb2f',
      isRead: 'false',
      page: '3',
      limit: '25',
    });

    const errors = await validate(dto);
    assert.deepStrictEqual(errors, []);
    assert.equal(dto.isRead, false);
    assert.equal(dto.page, 3);
    assert.equal(dto.limit, 25);
  });
});
