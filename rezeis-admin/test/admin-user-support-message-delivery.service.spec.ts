import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

describe('AdminUserManagementController support notifications', () => {
  it('keeps the current admin support-message route on the management controller', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminUserManagementController.prototype.sendNotification),
      ':telegramId/notify',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminUserManagementController.prototype.sendNotification),
      RequestMethod.POST,
    );
  });

  it('persists admin support messages through UserNotificationsService', async () => {
    const notificationCalls: unknown[] = [];
    const controller = new AdminUserManagementController(
      {
        user: {
          findFirst: async (args: unknown) => {
            assert.deepStrictEqual(args, { where: { telegramId: 12345n } });
            return { id: 'user-1', telegramId: 12345n };
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        create: async (input: unknown) => {
          notificationCalls.push(input);
        },
      } as never,
    );

    assert.deepStrictEqual(await controller.sendNotification('12345', { message: 'Support answer' }), {
      sent: true,
    });
    assert.deepStrictEqual(notificationCalls, [
      {
        userId: 'user-1',
        type: 'ADMIN_MESSAGE',
        payload: { text: 'Support answer' },
        preRenderedText: 'Support answer',
      },
    ]);
  });
});
