import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalUserActivityController } from '../src/modules/user-activity/controllers/internal-user-activity.controller';
import {
  PaginatedUserActivityNotificationsInterface,
  UserActivityNotificationInterface,
} from '../src/modules/user-activity/interfaces/user-activity-notification.interface';
import {
  PaginatedUserActivityTransactionsInterface,
  UserActivityTransactionInterface,
} from '../src/modules/user-activity/interfaces/user-activity-transaction.interface';
import { UserNotificationsService } from '../src/modules/user-activity/services/user-notifications.service';
import { UserTransactionsHistoryService } from '../src/modules/user-activity/services/user-transactions-history.service';

type ListTransactionsQuery = Parameters<InternalUserActivityController['listTransactions']>[0];
type ListNotificationsQuery = Parameters<InternalUserActivityController['listNotifications']>[0];
type GetUnreadCountQuery = Parameters<InternalUserActivityController['getUnreadCount']>[0];
type MarkNotificationReadInput = Parameters<InternalUserActivityController['markNotificationRead']>[1];
type MarkAllNotificationsReadInput = Parameters<InternalUserActivityController['markAllNotificationsRead']>[0];

describe('InternalUserActivityController', () => {
  it('exposes internal user-activity routes behind InternalAdminAuthGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController), 'internal/user/activity');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalUserActivityController), [InternalAdminAuthGuard]);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController.prototype.listTransactions), 'transactions');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserActivityController.prototype.listTransactions), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController.prototype.listNotifications), 'notifications');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserActivityController.prototype.listNotifications), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController.prototype.getUnreadCount), 'notifications/unread-count');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserActivityController.prototype.getUnreadCount), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController.prototype.markNotificationRead), 'notifications/:notificationId/read');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserActivityController.prototype.markNotificationRead), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserActivityController.prototype.markAllNotificationsRead), 'notifications/read-all');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalUserActivityController.prototype.markAllNotificationsRead), RequestMethod.POST);
  });

  it('delegates user-activity calls unchanged', async () => {
    const calls: unknown[] = [];

    const transactionItem: UserActivityTransactionInterface = {
      id: 'tx-1',
      paymentId: 'payment-1',
      userId: 'user-1',
      subscriptionId: null,
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      amount: '10.00',
      paymentAsset: null,
      gatewayId: null,
      planSnapshot: { planId: 'plan-1' },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const transactionsResult: PaginatedUserActivityTransactionsInterface = {
      items: [transactionItem],
      total: 1,
      page: 1,
      limit: 20,
    };

    const notificationItem: UserActivityNotificationInterface = {
      id: 'notification-1',
      userId: 'user-1',
      type: 'SYSTEM',
      title: 'System update',
      message: 'Your settings were updated',
      isRead: false,
      readAt: null,
      readSource: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const notificationsResult: PaginatedUserActivityNotificationsInterface = {
      items: [notificationItem],
      total: 1,
      page: 1,
      limit: 20,
    };

    const transactionsServiceDouble = {
      listTransactions: async (query: ListTransactionsQuery) => {
        calls.push(['transactions', query]);
        return transactionsResult;
      },
    } satisfies Pick<UserTransactionsHistoryService, 'listTransactions'>;
    const notificationsServiceDouble = {
      listNotifications: async (query: ListNotificationsQuery) => {
        calls.push(['notifications', query]);
        return notificationsResult;
      },
      getUnreadCount: async (query: GetUnreadCountQuery) => {
        calls.push(['unread-count', query]);
        return { unread: 4 };
      },
      markNotificationRead: async (input: {
        readonly notificationId: string;
        readonly userId: string;
        readonly readSource?: string;
      }) => {
        calls.push(['mark-read', input]);
        return { updated: 1 };
      },
      markAllNotificationsRead: async (input: MarkAllNotificationsReadInput) => {
        calls.push(['mark-all-read', input]);
        return { updated: 3 };
      },
    } satisfies Pick<
      UserNotificationsService,
      'listNotifications' | 'getUnreadCount' | 'markNotificationRead' | 'markAllNotificationsRead'
    >;

    const controller = new InternalUserActivityController(
      transactionsServiceDouble as unknown as UserTransactionsHistoryService,
      notificationsServiceDouble as unknown as UserNotificationsService,
    );

    const transactionsQuery: ListTransactionsQuery = { userId: 'user-1' };
    const notificationsQuery: ListNotificationsQuery = { userId: 'user-1', isRead: false };
    const unreadCountQuery: GetUnreadCountQuery = { userId: 'user-1' };
    const markReadInput: MarkNotificationReadInput = { userId: 'user-1', readSource: 'MANUAL' };
    const markAllReadInput: MarkAllNotificationsReadInput = { userId: 'user-1', readSource: 'BULK' };

    assert.deepStrictEqual(
      await controller.listTransactions(transactionsQuery),
      transactionsResult,
    );
    assert.deepStrictEqual(
      await controller.listNotifications(notificationsQuery),
      notificationsResult,
    );
    assert.deepStrictEqual(await controller.getUnreadCount(unreadCountQuery), { unread: 4 });
    assert.deepStrictEqual(
      await controller.markNotificationRead('notification-1', markReadInput),
      { updated: 1 },
    );
    assert.deepStrictEqual(
      await controller.markAllNotificationsRead(markAllReadInput),
      { updated: 3 },
    );

    assert.deepStrictEqual(calls, [
      ['transactions', { userId: 'user-1' }],
      ['notifications', { userId: 'user-1', isRead: false }],
      ['unread-count', { userId: 'user-1' }],
      ['mark-read', { notificationId: 'notification-1', userId: 'user-1', readSource: 'MANUAL' }],
      ['mark-all-read', { userId: 'user-1', readSource: 'BULK' }],
    ]);
  });
});
