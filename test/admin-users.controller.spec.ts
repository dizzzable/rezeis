import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  Locale,
  PaymentGatewayType,
  PlanType,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
  UserRole,
} from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../src/modules/internal-user/interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserSessionInterface } from '../src/modules/internal-user/interfaces/internal-user-session.interface';
import { RevokeAdminUserSubscriptionDeviceDto } from '../src/modules/users/dto/revoke-admin-user-subscription-device.dto';
import { AdminUserSubscriptionDevicesInterface } from '../src/modules/users/interfaces/admin-user-subscription-devices.interface';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUserActivityNotificationsQueryDto } from '../src/modules/users/dto/admin-user-activity-notifications-query.dto';
import { AdminUserActivityTransactionsQueryDto } from '../src/modules/users/dto/admin-user-activity-transactions-query.dto';
import { AdminUserIdentifierQueryDto } from '../src/modules/users/dto/admin-user-identifier-query.dto';
import { AdminUserDeviceProvisioningChallengeQueryDto } from '../src/modules/users/dto/admin-user-device-provisioning-challenge-query.dto';
import { AdminUserSelectedSubscriptionWorkbenchQueryDto } from '../src/modules/users/dto/admin-user-selected-subscription-workbench-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { IssueAdminUserDeviceProvisioningChallengeDto } from '../src/modules/users/dto/issue-admin-user-device-provisioning-challenge.dto';
import { ListAdminUsersQueryDto } from '../src/modules/users/dto/list-admin-users-query.dto';
import { AdminUsersListInterface } from '../src/modules/users/interfaces/admin-users-list.interface';
import { AdminUserAccessDiagnosticsInterface } from '../src/modules/users/interfaces/admin-user-access-diagnostics.interface';
import { AdminUserModerationInterface } from '../src/modules/users/interfaces/admin-user-moderation.interface';
import { AdminUserSubscriptionsWorkbenchInterface } from '../src/modules/users/interfaces/admin-user-subscriptions-workbench.interface';
import { AdminUserSelectedSubscriptionWorkbenchInterface } from '../src/modules/users/interfaces/admin-user-selected-subscription-workbench.interface';
import {
  AdminUserDeviceProvisioningChallengeInterface,
  AdminUserDeviceProvisioningChallengesInterface,
} from '../src/modules/users/interfaces/admin-user-device-provisioning-challenge.interface';
import { AdminUserSearchResultInterface } from '../src/modules/users/interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';
import { PaginatedUserActivityNotificationsInterface } from '../src/modules/user-activity/interfaces/user-activity-notification.interface';
import { PaginatedUserActivityTransactionsInterface } from '../src/modules/user-activity/interfaces/user-activity-transaction.interface';

function buildSearchResult(): AdminUserSearchResultInterface {
  return {
    session: {
      id: 'user-1',
      telegramId: '123456789',
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 5,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-01T01:00:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: '2026-04-01T01:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    },
    subscription: {
      id: 'subscription-1',
      status: SubscriptionStatus.ACTIVE,
      isTrial: false,
      plan: {
        name: 'Premium',
        type: PlanType.TRAFFIC,
      },
      trafficLimit: 2048,
      deviceLimit: 3,
      configUrl: 'https://example.com/config',
      startedAt: '2026-04-01T00:00:00.000Z',
      expiresAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
    },
  };
}

function buildUsersList(): AdminUsersListInterface {
  return {
    queue: 'recentRegistered',
    limit: 2,
    hasMore: false,
    nextCursor: null,
    items: [
      {
        id: 'user-1',
        telegramId: '123456789',
        username: 'rezeis-user',
        name: 'Rezeis User',
        email: 'user@example.com',
        role: UserRole.USER,
        isBlocked: false,
        createdAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
      {
        id: 'user-2',
        telegramId: null,
        username: 'beta-user',
        name: null,
        email: null,
        role: UserRole.USER,
        isBlocked: true,
        createdAt: '2026-04-15T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    ],
  };
}

function buildSubscriptionDevicesResult(): AdminUserSubscriptionDevicesInterface {
  return {
    devices: [
      {
        deviceRef: 'device-ref-1',
        deviceName: 'Pixel',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
        userAgent: 'rezeis-admin-tests',
        ipAddress: '127.0.0.1',
        lastSeenAt: '2026-04-16T10:00:00.000Z',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    ],
    deviceCount: 1,
    deviceLimit: 3,
    isLimitReached: false,
    blockedMessage: null,
    maxDevicesMessage: null,
  };
}

function buildSessionResult(): InternalUserSessionInterface {
  return buildSearchResult().session;
}

function buildEmailVerificationChallengeResult(): InternalWebAccountEmailVerificationChallengeInterface {
  return {
    webAccountId: 'web-account-1',
    email: 'user@example.com',
    challengeExpiresAt: '2026-04-16T10:15:00.000Z',
  };
}

function buildTransactionsResult(): PaginatedUserActivityTransactionsInterface {
  return {
    items: [
      {
        id: 'transaction-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        subscriptionId: 'subscription-1',
        status: TransactionStatus.COMPLETED,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.TELEGRAM,
        gatewayType: PaymentGatewayType.CRYPTOMUS,
        currency: 'USDT',
        amount: '9.99',
        paymentAsset: 'USDT',
        gatewayId: 'gateway-1',
        planSnapshot: null,
        createdAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
  };
}

function buildNotificationsResult(): PaginatedUserActivityNotificationsInterface {
  return {
    items: [
      {
        id: 'notification-1',
        userId: 'user-1',
        type: 'subscription.expiring',
        title: null,
        message: 'Your subscription is expiring soon',
        isRead: false,
        readAt: null,
        readSource: null,
        createdAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
  };
}

describe('AdminUsersController', () => {
  it('exposes the shipped admin users search route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, AdminUsersController) as
      | string
      | undefined;
    const actualSearchPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.searchUser,
    ) as string | undefined;
    const actualSearchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.searchUser,
    ) as RequestMethod | undefined;
    const actualSearchParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'searchUser',
    ) as readonly unknown[] | undefined;
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, AdminUsersController) as
      | readonly unknown[]
      | undefined;
    assert.equal(actualControllerPath, 'admin/users');
    assert.equal(actualSearchPath, 'search');
    assert.equal(actualSearchMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualSearchParameterTypes, [AdminUserSearchQueryDto]);
    assert.deepStrictEqual(actualGuards, [AdminJwtAuthGuard]);
  });

  it('exposes the bounded admin users list route contract', () => {
    const actualListPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.listUsers,
    ) as string | undefined;
    const actualListMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.listUsers,
    ) as RequestMethod | undefined;
    const actualListParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'listUsers',
    ) as readonly unknown[] | undefined;
    assert.equal(actualListPath, '/');
    assert.equal(actualListMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualListParameterTypes, [ListAdminUsersQueryDto]);
  });

  it('exposes the current-subscription devices read route contract', () => {
    const actualDevicesPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.getSubscriptionDevices,
    ) as string | undefined;
    const actualDevicesMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.getSubscriptionDevices,
    ) as RequestMethod | undefined;
    const actualDevicesParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'getSubscriptionDevices',
    ) as readonly unknown[] | undefined;
    assert.equal(actualDevicesPath, 'subscription/devices');
    assert.equal(actualDevicesMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualDevicesParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('exposes the single-device revocation route contract', () => {
    const actualRevokePath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.revokeSubscriptionDevice,
    ) as string | undefined;
    const actualRevokeMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.revokeSubscriptionDevice,
    ) as RequestMethod | undefined;
    const actualRevokeParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'revokeSubscriptionDevice',
    ) as readonly unknown[] | undefined;
    assert.equal(actualRevokePath, 'subscription/devices/:deviceRef');
    assert.equal(actualRevokeMethod, RequestMethod.DELETE);
    assert.deepStrictEqual(actualRevokeParameterTypes, [
      AdminUserIdentifierQueryDto,
      RevokeAdminUserSubscriptionDeviceDto,
    ]);
  });

  it('exposes the rules-acceptance route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.acceptRules,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.acceptRules,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'acceptRules',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'session/rules-acceptance');
    assert.equal(actualMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('exposes the web-account-link-prompt-snooze route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.snoozeWebAccountLinkPrompt,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.snoozeWebAccountLinkPrompt,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'snoozeWebAccountLinkPrompt',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'session/web-account-link-prompt-snooze');
    assert.equal(actualMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('exposes the web-account-email-verification-challenge route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.issueWebAccountEmailVerificationChallenge,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.issueWebAccountEmailVerificationChallenge,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'issueWebAccountEmailVerificationChallenge',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'session/web-account-email-verification-challenge');
    assert.equal(actualMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('exposes the activity transactions read route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.listActivityTransactions,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.listActivityTransactions,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'listActivityTransactions',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'activity/transactions');
    assert.equal(actualMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserActivityTransactionsQueryDto]);
  });

  it('exposes the activity notifications read route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.listActivityNotifications,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.listActivityNotifications,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'listActivityNotifications',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'activity/notifications');
    assert.equal(actualMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserActivityNotificationsQueryDto]);
  });

  it('delegates search to the admin users service and returns the aggregated result unchanged', async () => {
    const searchCalls: AdminUserSearchQueryDto[] = [];
    const query = { telegramId: '123456789' } as AdminUserSearchQueryDto;
    const expectedResult = buildSearchResult();
    const adminUsersService = {
      searchUser: async (input: AdminUserSearchQueryDto): Promise<AdminUserSearchResultInterface> => {
        searchCalls.push(input);
        return expectedResult;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualResult = await controller.searchUser(query);
    assert.deepStrictEqual(searchCalls, [query]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });

  it('exposes the access diagnostics read route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.getAccessDiagnostics,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.getAccessDiagnostics,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'getAccessDiagnostics',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'access-diagnostics');
    assert.equal(actualMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('delegates access diagnostics reads to the admin users service', async () => {
    const diagnosticsCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { userId: 'user-1' } as AdminUserIdentifierQueryDto;
    const expectedDiagnostics: AdminUserAccessDiagnosticsInterface = {
      checkedAt: '2026-04-24T12:00:00.000Z',
      accessState: 'REVIEW',
      primaryReasonCode: 'DEVICE_LIMIT_REACHED',
      reasons: [
        {
          code: 'DEVICE_LIMIT_REACHED',
          severity: 'WARNING',
          message: 'Device limit reached for the current subscription.',
        },
      ],
      facts: [
        {
          code: 'DEVICE_COUNT',
          label: 'Device count',
          value: '2 / 2',
        },
      ],
      nextActions: [
        {
          code: 'REVIEW_SUBSCRIPTION_DEVICES',
          label: 'Review current-subscription devices before changing access.',
          target: 'SUBSCRIPTION_DEVICES',
        },
      ],
    };
    const adminUsersService = {
      getAccessDiagnostics: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<AdminUserAccessDiagnosticsInterface> => {
        diagnosticsCalls.push(input);
        return expectedDiagnostics;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualDiagnostics = await controller.getAccessDiagnostics(query);
    assert.deepStrictEqual(diagnosticsCalls, [query]);
    assert.deepStrictEqual(actualDiagnostics, expectedDiagnostics);
  });

  it('exposes the subscriptions workbench read route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.getSubscriptionsWorkbench,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.getSubscriptionsWorkbench,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'getSubscriptionsWorkbench',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'subscriptions');
    assert.equal(actualMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserIdentifierQueryDto]);
  });

  it('delegates subscriptions workbench reads to the admin users service', async () => {
    const subscriptionsCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { userId: '11111111-1111-4111-8111-111111111111' } as AdminUserIdentifierQueryDto;
    const expectedWorkbench: AdminUserSubscriptionsWorkbenchInterface = {
      checkedAt: '2026-04-24T12:00:00.000Z',
      totalCount: 1,
      currentSubscriptionId: 'subscription-1',
      items: [
        {
          id: 'subscription-1',
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          plan: {
            name: 'Premium',
            type: PlanType.TRAFFIC,
          },
          trafficLimit: 2048,
          deviceLimit: 3,
          startedAt: '2026-04-01T00:00:00.000Z',
          expiresAt: '2026-05-01T00:00:00.000Z',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-16T10:00:00.000Z',
          isCurrentCandidate: true,
          riskLevel: 'OK',
          markers: [
            {
              code: 'SUBSCRIPTION_STABLE',
              severity: 'INFO',
              message: 'No immediate subscription risk marker is raised.',
            },
          ],
        },
      ],
    };
    const adminUsersService = {
      getSubscriptionsWorkbench: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<AdminUserSubscriptionsWorkbenchInterface> => {
        subscriptionsCalls.push(input);
        return expectedWorkbench;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualWorkbench = await controller.getSubscriptionsWorkbench(query);
    assert.deepStrictEqual(subscriptionsCalls, [query]);
    assert.deepStrictEqual(actualWorkbench, expectedWorkbench);
  });

  it('exposes the selected-subscription workbench read route contract', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.getSelectedSubscriptionWorkbench,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.getSelectedSubscriptionWorkbench,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'getSelectedSubscriptionWorkbench',
    ) as readonly unknown[] | undefined;
    assert.equal(actualPath, 'subscriptions/selected');
    assert.equal(actualMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualParameterTypes, [AdminUserSelectedSubscriptionWorkbenchQueryDto]);
  });

  it('delegates selected-subscription workbench reads to the admin users service', async () => {
    const selectedCalls: AdminUserSelectedSubscriptionWorkbenchQueryDto[] = [];
    const query = {
      userId: '11111111-1111-4111-8111-111111111111',
      subscriptionId: '22222222-2222-4222-8222-222222222222',
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto;
    const expectedWorkbench: AdminUserSelectedSubscriptionWorkbenchInterface = {
      checkedAt: '2026-04-24T12:00:00.000Z',
      subscription: {
        id: '22222222-2222-4222-8222-222222222222',
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        plan: {
          name: 'Premium',
          type: PlanType.TRAFFIC,
        },
        trafficLimit: 2048,
        deviceLimit: 3,
        startedAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2026-05-01T00:00:00.000Z',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
        isCurrentCandidate: true,
        riskLevel: 'OK',
        markers: [
          {
            code: 'SUBSCRIPTION_STABLE',
            severity: 'INFO',
            message: 'No immediate subscription risk marker is raised.',
          },
        ],
      },
      ownership: {
        belongsToUser: true,
        status: SubscriptionStatus.ACTIVE,
      },
      entitlement: {
        isActiveCandidate: true,
        isExpired: false,
        isUpcoming: false,
        riskLevel: 'OK',
        markers: [
          {
            code: 'SUBSCRIPTION_STABLE',
            severity: 'INFO',
            message: 'No immediate subscription risk marker is raised.',
          },
        ],
      },
      capacity: {
        trafficLimit: 2048,
        deviceLimit: 3,
      },
      nextActions: [
        {
          code: 'NO_IMMEDIATE_ACTION',
          label: 'No immediate selected-subscription action is suggested by this read-only workbench.',
          target: 'USERS_SEARCH',
        },
      ],
    };
    const adminUsersService = {
      getSelectedSubscriptionWorkbench: async (
        input: AdminUserSelectedSubscriptionWorkbenchQueryDto,
      ): Promise<AdminUserSelectedSubscriptionWorkbenchInterface> => {
        selectedCalls.push(input);
        return expectedWorkbench;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualWorkbench = await controller.getSelectedSubscriptionWorkbench(query);
    assert.deepStrictEqual(selectedCalls, [query]);
    assert.deepStrictEqual(actualWorkbench, expectedWorkbench);
  });

  it('exposes selected-subscription devices read and revoke route contracts', () => {
    const actualReadPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.getSelectedSubscriptionDevices,
    ) as string | undefined;
    const actualReadMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.getSelectedSubscriptionDevices,
    ) as RequestMethod | undefined;
    const actualReadParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'getSelectedSubscriptionDevices',
    ) as readonly unknown[] | undefined;
    const actualRevokePath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.revokeSelectedSubscriptionDevice,
    ) as string | undefined;
    const actualRevokeMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.revokeSelectedSubscriptionDevice,
    ) as RequestMethod | undefined;
    const actualRevokeParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'revokeSelectedSubscriptionDevice',
    ) as readonly unknown[] | undefined;
    assert.equal(actualReadPath, 'subscriptions/selected/devices');
    assert.equal(actualReadMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualReadParameterTypes, [AdminUserSelectedSubscriptionWorkbenchQueryDto]);
    assert.equal(actualRevokePath, 'subscriptions/selected/devices/:deviceRef');
    assert.equal(actualRevokeMethod, RequestMethod.DELETE);
    assert.deepStrictEqual(actualRevokeParameterTypes, [
      AdminUserSelectedSubscriptionWorkbenchQueryDto,
      RevokeAdminUserSubscriptionDeviceDto,
    ]);
  });

  it('delegates selected-subscription devices reads and revokes to the admin users service', async () => {
    const devicesCalls: AdminUserSelectedSubscriptionWorkbenchQueryDto[] = [];
    const revokeCalls: Array<{
      readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
      readonly deviceRef: string;
    }> = [];
    const query = {
      userId: '11111111-1111-4111-8111-111111111111',
      subscriptionId: '22222222-2222-4222-8222-222222222222',
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto;
    const deviceRef = { deviceRef: 'device-ref-1' } as RevokeAdminUserSubscriptionDeviceDto;
    const expectedDevices: AdminUserSubscriptionDevicesInterface = {
      devices: [],
      deviceCount: 0,
      deviceLimit: 3,
      isLimitReached: false,
      blockedMessage: null,
      maxDevicesMessage: null,
    };
    const adminUsersService = {
      getSelectedSubscriptionDevices: async (
        input: AdminUserSelectedSubscriptionWorkbenchQueryDto,
      ): Promise<AdminUserSubscriptionDevicesInterface> => {
        devicesCalls.push(input);
        return expectedDevices;
      },
      revokeSelectedSubscriptionDevice: async (input: {
        readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
        readonly deviceRef: string;
      }): Promise<AdminUserSubscriptionDevicesInterface> => {
        revokeCalls.push(input);
        return expectedDevices;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    assert.deepStrictEqual(await controller.getSelectedSubscriptionDevices(query), expectedDevices);
    assert.deepStrictEqual(await controller.revokeSelectedSubscriptionDevice(query, deviceRef), expectedDevices);
    assert.deepStrictEqual(devicesCalls, [query]);
    assert.deepStrictEqual(revokeCalls, [{ query, deviceRef: 'device-ref-1' }]);
  });

  it('delegates block and unblock moderation actions to service', async () => {
    const calls: unknown[] = [];
    const blockResult: AdminUserModerationInterface = {
      userId: 'user-1',
      isBlocked: true,
      changed: true,
      action: 'BLOCK_USER',
      checkedAt: '2026-04-24T12:00:00.000Z',
    };
    const unblockResult: AdminUserModerationInterface = {
      ...blockResult,
      isBlocked: false,
      action: 'UNBLOCK_USER',
    };
    const adminUsersService = {
      setUserBlockedState: async (input: unknown): Promise<AdminUserModerationInterface> => {
        calls.push(input);
        return calls.length === 1 ? blockResult : unblockResult;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminUsersController['blockUser']>[0];

    assert.deepStrictEqual(await controller.blockUser(currentAdmin, 'user-1', { reason: 'support case' }), blockResult);
    assert.deepStrictEqual(await controller.unblockUser(currentAdmin, 'user-1', {}), unblockResult);
    assert.deepStrictEqual(calls, [
      { adminUserId: 'admin-1', userId: 'user-1', reason: 'support case', isBlocked: true },
      { adminUserId: 'admin-1', userId: 'user-1', reason: undefined, isBlocked: false },
    ]);
  });

  it('exposes the device provisioning challenge read and issue route contracts', () => {
    const actualListPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.listDeviceProvisioningChallenges,
    ) as string | undefined;
    const actualListMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.listDeviceProvisioningChallenges,
    ) as RequestMethod | undefined;
    const actualListParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'listDeviceProvisioningChallenges',
    ) as readonly unknown[] | undefined;
    const actualIssuePath = Reflect.getMetadata(
      PATH_METADATA,
      AdminUsersController.prototype.issueDeviceProvisioningChallenge,
    ) as string | undefined;
    const actualIssueMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminUsersController.prototype.issueDeviceProvisioningChallenge,
    ) as RequestMethod | undefined;
    const actualIssueParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminUsersController.prototype,
      'issueDeviceProvisioningChallenge',
    ) as readonly unknown[] | undefined;

    assert.equal(actualListPath, 'device-provisioning-challenges');
    assert.equal(actualListMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualListParameterTypes, [AdminUserDeviceProvisioningChallengeQueryDto]);
    assert.equal(actualIssuePath, 'device-provisioning-challenges');
    assert.equal(actualIssueMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualIssueParameterTypes, [Object, AdminUserDeviceProvisioningChallengeQueryDto, IssueAdminUserDeviceProvisioningChallengeDto]);
  });

  it('delegates device provisioning challenge reads and issues to the admin users service', async () => {
    const listCalls: AdminUserDeviceProvisioningChallengeQueryDto[] = [];
    const issueCalls: Array<{
      readonly query: AdminUserDeviceProvisioningChallengeQueryDto;
      readonly dto: IssueAdminUserDeviceProvisioningChallengeDto;
      readonly adminUserId: string;
    }> = [];
    const revokeCalls: Array<{
      readonly query: AdminUserDeviceProvisioningChallengeQueryDto;
      readonly challengeId: string;
      readonly adminUserId: string;
    }> = [];
    const query = {
      userId: '11111111-1111-4111-8111-111111111111',
      subscriptionId: '22222222-2222-4222-8222-222222222222',
    } as AdminUserDeviceProvisioningChallengeQueryDto;
    const dto = { reason: 'support-confirmed-stale-device' } as IssueAdminUserDeviceProvisioningChallengeDto;
    const challenge: AdminUserDeviceProvisioningChallengeInterface = {
      id: 'challenge-1',
      status: 'PENDING',
      reason: 'support-confirmed-stale-device',
      expiresAt: '2026-04-24T12:15:00.000Z',
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 5,
      createdAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    };
    const challengeList: AdminUserDeviceProvisioningChallengesInterface = {
      userId: query.userId,
      subscriptionId: query.subscriptionId,
      activeChallenge: challenge,
      items: [challenge],
    };
    const adminUsersService = {
      listDeviceProvisioningChallenges: async (
        input: AdminUserDeviceProvisioningChallengeQueryDto,
      ): Promise<AdminUserDeviceProvisioningChallengesInterface> => {
        listCalls.push(input);
        return challengeList;
      },
      issueDeviceProvisioningChallenge: async (input: {
        readonly query: AdminUserDeviceProvisioningChallengeQueryDto;
        readonly dto: IssueAdminUserDeviceProvisioningChallengeDto;
        readonly adminUserId: string;
      }): Promise<AdminUserDeviceProvisioningChallengeInterface> => {
        issueCalls.push(input);
        return challenge;
      },
      revokeDeviceProvisioningChallenge: async (input: {
        readonly query: AdminUserDeviceProvisioningChallengeQueryDto;
        readonly challengeId: string;
        readonly adminUserId: string;
      }): Promise<AdminUserDeviceProvisioningChallengeInterface> => {
        revokeCalls.push(input);
        return {
          ...challenge,
          status: 'REVOKED',
          revokedAt: '2026-04-24T12:05:00.000Z',
        };
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);

    const actualList = await controller.listDeviceProvisioningChallenges(query);
    const actualIssue = await controller.issueDeviceProvisioningChallenge({ id: 'admin-1' } as never, query, dto);
    const actualRevoke = await controller.revokeDeviceProvisioningChallenge({ id: 'admin-1' } as never, 'challenge-1', query);

    assert.deepStrictEqual(listCalls, [query]);
    assert.deepStrictEqual(issueCalls, [{ query, dto, adminUserId: 'admin-1' }]);
    assert.deepStrictEqual(revokeCalls, [{ query, challengeId: 'challenge-1', adminUserId: 'admin-1' }]);
    assert.deepStrictEqual(actualList, challengeList);
    assert.deepStrictEqual(actualIssue, challenge);
    assert.equal(actualRevoke.status, 'REVOKED');
    assert.equal(JSON.stringify(actualIssue).includes('challengeHash'), false);
    assert.equal(JSON.stringify(actualIssue).includes('idempotencyKey'), false);
    assert.equal(JSON.stringify(actualIssue).includes('hwid'), false);
  });

  it('delegates list reads to the admin users service and returns queue payload unchanged', async () => {
    const listCalls: ListAdminUsersQueryDto[] = [];
    const query: ListAdminUsersQueryDto = {
      queue: 'blacklist',
      limit: 10,
    };
    const expectedListResult = buildUsersList();
    const adminUsersService = {
      searchUser: async (): Promise<AdminUserSearchResultInterface> => buildSearchResult(),
      listUsers: async (input: ListAdminUsersQueryDto): Promise<AdminUsersListInterface> => {
        listCalls.push(input);
        return expectedListResult;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualListResult = await controller.listUsers(query);
    assert.deepStrictEqual(listCalls, [query]);
    assert.deepStrictEqual(actualListResult, expectedListResult);
  });

  it('delegates current-subscription devices reads to the admin users service', async () => {
    const devicesCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { userId: 'user-1' } as AdminUserIdentifierQueryDto;
    const expectedDevices = buildSubscriptionDevicesResult();
    const adminUsersService = {
      getSubscriptionDevices: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<AdminUserSubscriptionDevicesInterface> => {
        devicesCalls.push(input);
        return expectedDevices;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualDevices = await controller.getSubscriptionDevices(query);
    assert.deepStrictEqual(devicesCalls, [query]);
    assert.deepStrictEqual(actualDevices, expectedDevices);
  });

  it('delegates single-device revocation to the admin users service with query + hwid', async () => {
    const revokeCalls: Array<{ query: AdminUserIdentifierQueryDto; deviceRef: string }> = [];
    const query = { telegramId: '123456789' } as AdminUserIdentifierQueryDto;
    const input = { deviceRef: 'device-ref-1' } as RevokeAdminUserSubscriptionDeviceDto;
    const expectedDevices = buildSubscriptionDevicesResult();
    const adminUsersService = {
      revokeSubscriptionDevice: async (payload: {
        query: AdminUserIdentifierQueryDto;
        deviceRef: string;
      }): Promise<AdminUserSubscriptionDevicesInterface> => {
        revokeCalls.push(payload);
        return expectedDevices;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualDevices = await controller.revokeSubscriptionDevice(query, input);
    assert.deepStrictEqual(revokeCalls, [{ query, deviceRef: 'device-ref-1' }]);
    assert.deepStrictEqual(actualDevices, expectedDevices);
  });

  it('delegates rules acceptance to the admin users service', async () => {
    const acceptRulesCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { email: 'user@example.com' } as AdminUserIdentifierQueryDto;
    const expectedSession = buildSessionResult();
    const adminUsersService = {
      acceptRules: async (input: AdminUserIdentifierQueryDto): Promise<InternalUserSessionInterface> => {
        acceptRulesCalls.push(input);
        return expectedSession;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualSession = await controller.acceptRules(query);
    assert.deepStrictEqual(acceptRulesCalls, [query]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates web-account link prompt snooze to the admin users service', async () => {
    const snoozeCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { login: 'user-login' } as AdminUserIdentifierQueryDto;
    const expectedSession = buildSessionResult();
    const adminUsersService = {
      snoozeWebAccountLinkPrompt: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<InternalUserSessionInterface> => {
        snoozeCalls.push(input);
        return expectedSession;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualSession = await controller.snoozeWebAccountLinkPrompt(query);
    assert.deepStrictEqual(snoozeCalls, [query]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates email verification challenge issuance to the admin users service', async () => {
    const issueCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { userId: 'user-1' } as AdminUserIdentifierQueryDto;
    const expectedChallenge = buildEmailVerificationChallengeResult();
    const adminUsersService = {
      issueWebAccountEmailVerificationChallenge: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<InternalWebAccountEmailVerificationChallengeInterface> => {
        issueCalls.push(input);
        return expectedChallenge;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualChallenge = await controller.issueWebAccountEmailVerificationChallenge(query);
    assert.deepStrictEqual(issueCalls, [query]);
    assert.deepStrictEqual(actualChallenge, expectedChallenge);
  });

  it('delegates activity transactions read to the admin users service', async () => {
    const transactionsCalls: AdminUserActivityTransactionsQueryDto[] = [];
    const query = {
      userId: 'user-1',
      status: TransactionStatus.COMPLETED,
      page: 1,
      limit: 20,
    } as AdminUserActivityTransactionsQueryDto;
    const expectedResult = buildTransactionsResult();
    const adminUsersService = {
      listActivityTransactions: async (
        input: AdminUserActivityTransactionsQueryDto,
      ): Promise<PaginatedUserActivityTransactionsInterface> => {
        transactionsCalls.push(input);
        return expectedResult;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualResult = await controller.listActivityTransactions(query);
    assert.deepStrictEqual(transactionsCalls, [query]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });

  it('delegates activity notifications read to the admin users service', async () => {
    const notificationsCalls: AdminUserActivityNotificationsQueryDto[] = [];
    const query = {
      telegramId: '123456789',
      isRead: false,
      type: 'subscription.expiring',
      page: 1,
      limit: 20,
    } as AdminUserActivityNotificationsQueryDto;
    const expectedResult = buildNotificationsResult();
    const adminUsersService = {
      listActivityNotifications: async (
        input: AdminUserActivityNotificationsQueryDto,
      ): Promise<PaginatedUserActivityNotificationsInterface> => {
        notificationsCalls.push(input);
        return expectedResult;
      },
    } as unknown as AdminUsersService;
    const controller = new AdminUsersController(adminUsersService);
    const actualResult = await controller.listActivityNotifications(query);
    assert.deepStrictEqual(notificationsCalls, [query]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });
});
