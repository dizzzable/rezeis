import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';

describe('InternalUserController activity endpoints', () => {
  it('keeps the current activity feed on the internal user controller', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController), 'internal/user');
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController.prototype.listNotifications), 'notifications');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserController.prototype.listNotifications), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController.prototype.unreadCount), 'notifications/unread-count');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserController.prototype.unreadCount), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController.prototype.readOne), 'notifications/:notificationId/read');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserController.prototype.readOne), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController.prototype.readAll), 'notifications/read-all');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserController.prototype.readAll), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController.prototype.listTransactions), 'transactions');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserController.prototype.listTransactions), RequestMethod.GET);
  });

  it('delegates activity calls with the resolved user reference', async () => {
    const calls: unknown[] = [];
    const controller = new InternalUserController(
      {} as never,
      {
        listNotifications: async (reference: string) => {
          calls.push(['notifications', reference]);
          return { notifications: [] };
        },
        getUnreadCount: async (reference: string) => {
          calls.push(['unread', reference]);
          return { unread: 0 };
        },
        markOneRead: async (reference: string, notificationId: string) => {
          calls.push(['read-one', { reference, notificationId }]);
          return { ok: true };
        },
        markAllRead: async (reference: string) => {
          calls.push(['read-all', reference]);
          return { updated: 1 };
        },
        listTransactions: async (reference: string) => {
          calls.push(['transactions', reference]);
          return { transactions: [] };
        },
      } as never,
      {} as never,
    );

    await controller.listNotifications({ userId: 'cmphfcr6i007v01jg0lcu653h' });
    await controller.unreadCount({ telegramId: '123456789' });
    await controller.readOne('notification-1', { telegramId: '123456789' });
    await controller.readAll({ userId: 'cmphfcr6i007v01jg0lcu653h' });
    await controller.listTransactions({ telegramId: '123456789' });

    assert.deepStrictEqual(calls, [
      ['notifications', 'cmphfcr6i007v01jg0lcu653h'],
      ['unread', '123456789'],
      ['read-one', { reference: '123456789', notificationId: 'notification-1' }],
      ['read-all', 'cmphfcr6i007v01jg0lcu653h'],
      ['transactions', '123456789'],
    ]);
  });
});
