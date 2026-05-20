import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Locale, PlanType, SubscriptionStatus, UserRole } from '@prisma/client';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../src/modules/internal-user/interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserSessionInterface } from '../src/modules/internal-user/interfaces/internal-user-session.interface';
import { AdminUserSubscriptionDevicesInterface } from '../src/modules/users/interfaces/admin-user-subscription-devices.interface';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUserIdentifierQueryDto } from '../src/modules/users/dto/admin-user-identifier-query.dto';
import { AdminUserSelectedSubscriptionWorkbenchQueryDto } from '../src/modules/users/dto/admin-user-selected-subscription-workbench-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { ListAdminUsersQueryDto } from '../src/modules/users/dto/list-admin-users-query.dto';
import { AdminUsersListInterface } from '../src/modules/users/interfaces/admin-users-list.interface';
import { AdminUserAccessDiagnosticsInterface } from '../src/modules/users/interfaces/admin-user-access-diagnostics.interface';
import { AdminUserSelectedSubscriptionWorkbenchInterface } from '../src/modules/users/interfaces/admin-user-selected-subscription-workbench.interface';
import { AdminUserSubscriptionsWorkbenchInterface } from '../src/modules/users/interfaces/admin-user-subscriptions-workbench.interface';
import {
  AdminUserDeviceProvisioningChallengeInterface,
  AdminUserDeviceProvisioningChallengesInterface,
} from '../src/modules/users/interfaces/admin-user-device-provisioning-challenge.interface';
import { AdminUserSearchResultInterface } from '../src/modules/users/interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

interface SearchCallRecord {
  readonly query: AdminUserSearchQueryDto;
}

interface ListCallRecord {
  readonly query: ListAdminUsersQueryDto;
}

interface GetSubscriptionDevicesCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface RevokeSubscriptionDeviceCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
  readonly deviceRef: string;
}

interface AcceptRulesCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface SnoozeWebAccountLinkPromptCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface IssueWebAccountEmailVerificationChallengeCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface AccessDiagnosticsCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface SubscriptionsWorkbenchCallRecord {
  readonly query: AdminUserIdentifierQueryDto;
}

interface SelectedSubscriptionWorkbenchCallRecord {
  readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
}

interface SelectedSubscriptionDevicesCallRecord {
  readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
}

interface RevokeSelectedSubscriptionDeviceCallRecord {
  readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
  readonly deviceRef: string;
}

interface DeviceProvisioningChallengesCallRecord {
  readonly query: {
    readonly userId: string;
    readonly subscriptionId: string;
  };
}

interface IssueDeviceProvisioningChallengeCallRecord {
  readonly query: {
    readonly userId: string;
    readonly subscriptionId: string;
  };
  readonly reason: string | null | undefined;
}

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
      points: 42,
      maxSubscriptions: 3,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
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
        updatedAt: '2026-04-16T00:00:00.000Z',
      },
    },
    subscription: null,
    identityDiagnostics: {
      lookup: {
        requestedIdentifier: {
          type: 'email',
          value: 'user@example.com',
        },
        resolvedBy: 'email',
        resolvedViaLinkedWebAccount: true,
      },
      linkedWebAccount: {
        status: 'ready',
        hasLinkedWebAccount: true,
        emailVerified: true,
        credentialsBootstrapped: true,
        requiresPasswordChange: false,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: false,
        },
        guidance: ['linked_identity_ready'],
      },
    },
  };
}

function buildSubscriptionDevicesResult(): AdminUserSubscriptionDevicesInterface {
  return {
    devices: [
      {
        deviceRef: 'device-ref-1',
        deviceName: 'Pixel 8',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
        userAgent: 'rezeis-admin-tests',
        ipAddress: '127.0.0.1',
        lastSeenAt: '2026-04-16T00:00:00.000Z',
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
    challengeExpiresAt: '2026-04-16T00:15:00.000Z',
  };
}

function buildAccessDiagnosticsResult(): AdminUserAccessDiagnosticsInterface {
  return {
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
}

function buildSubscriptionsWorkbenchResult(): AdminUserSubscriptionsWorkbenchInterface {
  return {
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
        updatedAt: '2026-04-16T00:00:00.000Z',
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
}

function buildSelectedSubscriptionWorkbenchResult(): AdminUserSelectedSubscriptionWorkbenchInterface {
  return {
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
      updatedAt: '2026-04-16T00:00:00.000Z',
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
          code: 'SELECTED_SUBSCRIPTION_READY',
          severity: 'INFO' as const,
          message: 'Selected subscription is ready for support review.',
        },
      ],
    },
    capacity: {
      trafficLimit: 2048,
      deviceLimit: 3,
    },
    nextActions: [
      {
        code: 'OPEN_ACCESS_DIAGNOSTICS',
        label: 'Review backend-owned access diagnostics before taking support action.',
        target: 'ACCESS_DIAGNOSTICS',
      },
    ],
  };
}

function buildDeviceProvisioningChallengeResult(): AdminUserDeviceProvisioningChallengeInterface {
  return {
    id: 'challenge-1',
    status: 'PENDING',
    reason: 'support-confirmed',
    expiresAt: '2026-04-24T12:15:00.000Z',
    consumedAt: null,
    revokedAt: null,
    attemptsLeft: 5,
    createdAt: '2026-04-24T12:00:00.000Z',
    updatedAt: '2026-04-24T12:00:00.000Z',
  };
}

function buildDeviceProvisioningChallengesResult(): AdminUserDeviceProvisioningChallengesInterface {
  const challenge = buildDeviceProvisioningChallengeResult();
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    subscriptionId: '22222222-2222-4222-8222-222222222222',
    activeChallenge: challenge,
    items: [challenge],
  };
}

describe('GET /api/admin/users/search', () => {
  let testingModule: TestingModule;
  let application: INestApplication;
  let searchCalls: SearchCallRecord[];
  let listCalls: ListCallRecord[];
  let getSubscriptionDevicesCalls: GetSubscriptionDevicesCallRecord[];
  let revokeSubscriptionDeviceCalls: RevokeSubscriptionDeviceCallRecord[];
  let acceptRulesCalls: AcceptRulesCallRecord[];
  let snoozeWebAccountLinkPromptCalls: SnoozeWebAccountLinkPromptCallRecord[];
  let issueWebAccountEmailVerificationChallengeCalls: IssueWebAccountEmailVerificationChallengeCallRecord[];
  let accessDiagnosticsCalls: AccessDiagnosticsCallRecord[];
  let subscriptionsWorkbenchCalls: SubscriptionsWorkbenchCallRecord[];
  let selectedSubscriptionWorkbenchCalls: SelectedSubscriptionWorkbenchCallRecord[];
  let selectedSubscriptionDevicesCalls: SelectedSubscriptionDevicesCallRecord[];
  let revokeSelectedSubscriptionDeviceCalls: RevokeSelectedSubscriptionDeviceCallRecord[];
  let deviceProvisioningChallengesCalls: DeviceProvisioningChallengesCallRecord[];
  let issueDeviceProvisioningChallengeCalls: IssueDeviceProvisioningChallengeCallRecord[];
  let revokeDeviceProvisioningChallengeCalls: Array<{
    readonly query: { readonly userId: string; readonly subscriptionId: string };
    readonly challengeId: string;
    readonly adminUserId: string;
  }>;
  let moderationCalls: Array<{
    readonly adminUserId: string;
    readonly userId: string;
    readonly reason?: string;
    readonly isBlocked: boolean;
  }>;

  before(async () => {
    searchCalls = [];
    listCalls = [];
    getSubscriptionDevicesCalls = [];
    revokeSubscriptionDeviceCalls = [];
    acceptRulesCalls = [];
    snoozeWebAccountLinkPromptCalls = [];
    issueWebAccountEmailVerificationChallengeCalls = [];
    accessDiagnosticsCalls = [];
    subscriptionsWorkbenchCalls = [];
    selectedSubscriptionWorkbenchCalls = [];
    selectedSubscriptionDevicesCalls = [];
    revokeSelectedSubscriptionDeviceCalls = [];
    deviceProvisioningChallengesCalls = [];
    issueDeviceProvisioningChallengeCalls = [];
    revokeDeviceProvisioningChallengeCalls = [];
    moderationCalls = [];
    testingModule = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [
        {
          provide: AdminUsersService,
          useValue: {
            searchUser: async (query: AdminUserSearchQueryDto): Promise<AdminUserSearchResultInterface> => {
              searchCalls.push({ query });
              return buildSearchResult();
            },
            listUsers: async (query: ListAdminUsersQueryDto): Promise<AdminUsersListInterface> => {
              listCalls.push({ query });
              return {
                queue: query.queue,
                limit: query.limit ?? 50,
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
                    isBlocked: query.queue === 'blacklist',
                    createdAt: '2026-04-01T00:00:00.000Z',
                    updatedAt: '2026-04-16T00:00:00.000Z',
                    webAccountContext: {
                      hasWebAccount: true,
                      emailVerifiedAt: '2026-04-01T01:00:00.000Z',
                      credentialsBootstrappedAt: '2026-04-01T01:00:00.000Z',
                      requiresPasswordChange: false,
                    },
                      invitedContext:
                        query.queue === 'invited'
                          ? {
                             invitedAt: '2026-04-15T00:00:00.000Z',
                             qualifiedAt: '2026-04-16T00:00:00.000Z',
                             qualifiedPurchaseChannel: 'CRYPTO_BOT',
                             inviter: {
                               id: 'inviter-1',
                               username: 'referrer-alpha',
                              email: 'referrer-alpha@example.com',
                            },
                          }
                        : undefined,
                  },
                ],
              };
            },
            getSubscriptionDevices: async (
              query: AdminUserIdentifierQueryDto,
            ): Promise<AdminUserSubscriptionDevicesInterface> => {
              getSubscriptionDevicesCalls.push({ query });
              return buildSubscriptionDevicesResult();
            },
            revokeSubscriptionDevice: async (input: {
              query: AdminUserIdentifierQueryDto;
              deviceRef: string;
            }): Promise<AdminUserSubscriptionDevicesInterface> => {
              revokeSubscriptionDeviceCalls.push(input);
              return buildSubscriptionDevicesResult();
            },
            acceptRules: async (query: AdminUserIdentifierQueryDto): Promise<InternalUserSessionInterface> => {
              acceptRulesCalls.push({ query });
              return buildSessionResult();
            },
            snoozeWebAccountLinkPrompt: async (
              query: AdminUserIdentifierQueryDto,
            ): Promise<InternalUserSessionInterface> => {
              snoozeWebAccountLinkPromptCalls.push({ query });
              return buildSessionResult();
            },
            issueWebAccountEmailVerificationChallenge: async (
              query: AdminUserIdentifierQueryDto,
            ): Promise<InternalWebAccountEmailVerificationChallengeInterface> => {
              issueWebAccountEmailVerificationChallengeCalls.push({ query });
              return buildEmailVerificationChallengeResult();
            },
            getAccessDiagnostics: async (
              query: AdminUserIdentifierQueryDto,
            ): Promise<AdminUserAccessDiagnosticsInterface> => {
              accessDiagnosticsCalls.push({ query });
              return buildAccessDiagnosticsResult();
            },
            getSubscriptionsWorkbench: async (
              query: AdminUserIdentifierQueryDto,
            ): Promise<AdminUserSubscriptionsWorkbenchInterface> => {
              subscriptionsWorkbenchCalls.push({ query });
              return buildSubscriptionsWorkbenchResult();
            },
            getSelectedSubscriptionWorkbench: async (
              query: AdminUserSelectedSubscriptionWorkbenchQueryDto,
            ): Promise<AdminUserSelectedSubscriptionWorkbenchInterface> => {
              selectedSubscriptionWorkbenchCalls.push({ query });
              return buildSelectedSubscriptionWorkbenchResult();
            },
            getSelectedSubscriptionDevices: async (
              query: AdminUserSelectedSubscriptionWorkbenchQueryDto,
            ): Promise<AdminUserSubscriptionDevicesInterface> => {
              selectedSubscriptionDevicesCalls.push({ query });
              return buildSubscriptionDevicesResult();
            },
            revokeSelectedSubscriptionDevice: async (input: {
              readonly query: AdminUserSelectedSubscriptionWorkbenchQueryDto;
              readonly deviceRef: string;
            }): Promise<AdminUserSubscriptionDevicesInterface> => {
              revokeSelectedSubscriptionDeviceCalls.push(input);
              return buildSubscriptionDevicesResult();
            },
            listDeviceProvisioningChallenges: async (query: {
              readonly userId: string;
              readonly subscriptionId: string;
            }): Promise<AdminUserDeviceProvisioningChallengesInterface> => {
              deviceProvisioningChallengesCalls.push({ query });
              return buildDeviceProvisioningChallengesResult();
            },
            issueDeviceProvisioningChallenge: async (input: {
              readonly query: {
                readonly userId: string;
                readonly subscriptionId: string;
              };
              readonly dto: { readonly reason?: string | null };
              readonly adminUserId: string;
            }): Promise<AdminUserDeviceProvisioningChallengeInterface> => {
              issueDeviceProvisioningChallengeCalls.push({ query: input.query, reason: input.dto.reason });
              return buildDeviceProvisioningChallengeResult();
            },
            revokeDeviceProvisioningChallenge: async (input: {
              readonly query: {
                readonly userId: string;
                readonly subscriptionId: string;
              };
              readonly challengeId: string;
              readonly adminUserId: string;
            }): Promise<AdminUserDeviceProvisioningChallengeInterface> => {
              revokeDeviceProvisioningChallengeCalls.push(input);
              return {
                ...buildDeviceProvisioningChallengeResult(),
                status: 'REVOKED',
                revokedAt: '2026-04-24T12:05:00.000Z',
              };
            },
            setUserBlockedState: async (input: {
              readonly adminUserId: string;
              readonly userId: string;
              readonly reason?: string;
              readonly isBlocked: boolean;
            }) => {
              moderationCalls.push(input);
              return {
                userId: input.userId,
                isBlocked: input.isBlocked,
                changed: true,
                action: input.isBlocked ? 'BLOCK_USER' : 'UNBLOCK_USER',
                checkedAt: '2026-04-24T12:00:00.000Z',
              };
            },
          } satisfies Pick<
            AdminUsersService,
            | 'searchUser'
            | 'listUsers'
            | 'getSubscriptionDevices'
            | 'revokeSubscriptionDevice'
            | 'acceptRules'
            | 'snoozeWebAccountLinkPrompt'
            | 'issueWebAccountEmailVerificationChallenge'
            | 'getAccessDiagnostics'
            | 'getSubscriptionsWorkbench'
            | 'getSelectedSubscriptionWorkbench'
            | 'getSelectedSubscriptionDevices'
            | 'revokeSelectedSubscriptionDevice'
            | 'listDeviceProvisioningChallenges'
            | 'issueDeviceProvisioningChallenge'
            | 'revokeDeviceProvisioningChallenge'
            | 'setUserBlockedState'
          >,
        },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate: (context: {
          readonly switchToHttp: () => { readonly getRequest: () => { user?: unknown } };
        }): boolean => {
          context.switchToHttp().getRequest().user = {
            id: 'admin-1',
            login: 'admin',
            email: 'admin@example.com',
            name: 'Admin',
            role: 'ADMIN',
            isActive: true,
            tokenVersion: 1,
            createdAt: '2026-04-01T00:00:00.000Z',
          };
          return true;
        },
      })
      .compile();
    application = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('accepts trimmed email input and passes normalized DTO data to the route service', async () => {
    searchCalls.length = 0;
    const expectedResult = buildSearchResult();
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: '  user@example.com  ' })
      .expect(200);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.equal(searchCalls[0]?.query.email, 'user@example.com');
    assert.equal(searchCalls[0]?.query.login, undefined);
    assert.deepStrictEqual(response.body, expectedResult);
    assert.deepStrictEqual(response.body.identityDiagnostics, expectedResult.identityDiagnostics);
  });

  it('accepts trimmed login input and passes sanitized DTO data to the route service', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ login: '  User_Login  ' })
      .expect(200);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.equal(searchCalls[0]?.query.email, undefined);
    assert.equal(searchCalls[0]?.query.login, 'User_Login');
    assert.deepStrictEqual(response.body, buildSearchResult());
  });

  it('accepts referralCode input and passes it unchanged to the route service', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ referralCode: '  ref-code-123  ' })
      .expect(200);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.equal(searchCalls[0]?.query.referralCode, 'ref-code-123');
    assert.deepStrictEqual(response.body, buildSearchResult());
  });

  it('rejects multi-identifier queries at the validation layer', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: 'user@example.com', login: 'user_login' })
      .expect(400);
    assert.equal(searchCalls.length, 0);
    assert.deepStrictEqual(response.body.message, [
      'Exactly one identifier must be provided: userId, telegramId, email, login, or referralCode',
    ]);
  });

  it('returns backend-owned access diagnostics through a minimal read contract', async () => {
    accessDiagnosticsCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/access-diagnostics')
      .query({ userId: '11111111-1111-4111-8111-111111111111' })
      .expect(200);
    assert.equal(accessDiagnosticsCalls.length, 1);
    assert.equal(accessDiagnosticsCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(accessDiagnosticsCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.deepStrictEqual(response.body, buildAccessDiagnosticsResult());
    assert.equal('session' in response.body, false);
    assert.equal('subscription' in response.body, false);
    assert.equal('devices' in response.body, false);
    assert.equal(JSON.stringify(response.body).includes('configUrl'), false);
  });

  it('returns subscriptions workbench rows through a minimal read contract', async () => {
    subscriptionsWorkbenchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscriptions')
      .query({ userId: '11111111-1111-4111-8111-111111111111' })
      .expect(200);
    assert.equal(subscriptionsWorkbenchCalls.length, 1);
    assert.equal(subscriptionsWorkbenchCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(subscriptionsWorkbenchCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.deepStrictEqual(response.body, buildSubscriptionsWorkbenchResult());
    assert.equal('configUrl' in response.body.items[0], false);
    assert.equal('remnawaveData' in response.body.items[0], false);
    assert.equal('uuid' in response.body.items[0], false);
  });

  it('returns selected subscription workbench through a minimal read contract', async () => {
    selectedSubscriptionWorkbenchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscriptions/selected')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(200);
    assert.equal(selectedSubscriptionWorkbenchCalls.length, 1);
    assert.equal(selectedSubscriptionWorkbenchCalls[0]?.query instanceof AdminUserSelectedSubscriptionWorkbenchQueryDto, true);
    assert.equal(selectedSubscriptionWorkbenchCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(selectedSubscriptionWorkbenchCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.deepStrictEqual(response.body, buildSelectedSubscriptionWorkbenchResult());
    assert.equal(JSON.stringify(response.body).includes('configUrl'), false);
    assert.equal(JSON.stringify(response.body).includes('remnawaveData'), false);
    assert.equal(JSON.stringify(response.body).includes('uuid'), false);
    assert.equal(JSON.stringify(response.body).includes('hwid'), false);
  });

  it('returns selected-subscription devices through opaque device refs', async () => {
    selectedSubscriptionDevicesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscriptions/selected/devices')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(200);
    assert.equal(selectedSubscriptionDevicesCalls.length, 1);
    assert.equal(selectedSubscriptionDevicesCalls[0]?.query instanceof AdminUserSelectedSubscriptionWorkbenchQueryDto, true);
    assert.equal(selectedSubscriptionDevicesCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(selectedSubscriptionDevicesCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.equal('deviceRef' in response.body.devices[0], true);
    assert.equal(JSON.stringify(response.body).includes('hwid'), false);
  });

  it('revokes selected-subscription devices through opaque device refs', async () => {
    revokeSelectedSubscriptionDeviceCalls.length = 0;
    await request(application.getHttpServer())
      .delete('/api/admin/users/subscriptions/selected/devices/device-ref-1')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(200);
    assert.equal(revokeSelectedSubscriptionDeviceCalls.length, 1);
    assert.equal(revokeSelectedSubscriptionDeviceCalls[0]?.query instanceof AdminUserSelectedSubscriptionWorkbenchQueryDto, true);
    assert.equal(revokeSelectedSubscriptionDeviceCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(revokeSelectedSubscriptionDeviceCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(revokeSelectedSubscriptionDeviceCalls[0]?.deviceRef, 'device-ref-1');
  });

  it('returns bounded recent-registered queue payload and transforms numeric limit', async () => {
    listCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users')
      .query({ queue: 'recentRegistered', limit: '1' })
      .expect(200);
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0]?.query instanceof ListAdminUsersQueryDto, true);
    assert.equal(listCalls[0]?.query.queue, 'recentRegistered');
    assert.equal(listCalls[0]?.query.limit, 1);
    assert.equal(response.body.queue, 'recentRegistered');
    assert.equal(response.body.limit, 1);
    assert.equal(response.body.hasMore, false);
  });

  it('accepts invited queue values and preserves bounded queue payload shape', async () => {
    listCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users')
      .query({ queue: 'invited' })
      .expect(200);
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0]?.query instanceof ListAdminUsersQueryDto, true);
    assert.equal(listCalls[0]?.query.queue, 'invited');
    assert.equal(listCalls[0]?.query.limit, undefined);
    assert.equal(response.body.queue, 'invited');
    assert.equal(typeof response.body.limit, 'number');
    assert.equal(typeof response.body.hasMore, 'boolean');
    assert.equal(Array.isArray(response.body.items), true);
    assert.equal(typeof response.body.items[0]?.id, 'string');
    assert.equal('telegramId' in response.body.items[0], true);
    assert.equal('username' in response.body.items[0], true);
    assert.equal('name' in response.body.items[0], true);
    assert.equal('email' in response.body.items[0], true);
    assert.equal('role' in response.body.items[0], true);
    assert.equal('isBlocked' in response.body.items[0], true);
    assert.equal('createdAt' in response.body.items[0], true);
    assert.equal('updatedAt' in response.body.items[0], true);
    assert.equal('webAccountContext' in response.body.items[0], true);
    assert.equal('login' in (response.body.items[0].webAccountContext ?? {}), false);
    assert.equal('email' in (response.body.items[0].webAccountContext ?? {}), false);
    assert.equal('invitedContext' in response.body.items[0], true);
    assert.equal(response.body.items[0]?.invitedContext?.qualifiedAt, '2026-04-16T00:00:00.000Z');
    assert.equal(response.body.items[0]?.invitedContext?.qualifiedPurchaseChannel, 'CRYPTO_BOT');
  });

  it('returns current-subscription devices and delegates to service with transformed query DTO', async () => {
    getSubscriptionDevicesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscription/devices')
      .query({ email: '  user@example.com  ' })
      .expect(200);
    assert.equal(getSubscriptionDevicesCalls.length, 1);
    assert.equal(getSubscriptionDevicesCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(getSubscriptionDevicesCalls[0]?.query.email, 'user@example.com');
    assert.deepStrictEqual(response.body, buildSubscriptionDevicesResult());
  });

  it('rejects invalid identifier combinations for current-subscription devices route at validation layer', async () => {
    getSubscriptionDevicesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscription/devices')
      .query({ userId: 'd7f81dca-6b2a-4a71-844b-23d511f61893', email: 'user@example.com' })
      .expect(400);
    assert.equal(getSubscriptionDevicesCalls.length, 0);
    assert.deepStrictEqual(response.body.message, [
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    ]);
  });

  it('rejects referralCode on current-subscription devices route at validation time', async () => {
    getSubscriptionDevicesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/subscription/devices')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    assert.equal(getSubscriptionDevicesCalls.length, 0);
    assert.equal(response.body.message.includes('property referralCode should not exist'), true);
  });

  it('revokes one device and delegates query + opaque deviceRef unchanged to route service', async () => {
    revokeSubscriptionDeviceCalls.length = 0;
    const response = await request(application.getHttpServer())
      .delete('/api/admin/users/subscription/devices/device-1')
      .query({ login: '  User_Login  ' })
      .expect(200);
    assert.equal(revokeSubscriptionDeviceCalls.length, 1);
    assert.equal(revokeSubscriptionDeviceCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(revokeSubscriptionDeviceCalls[0]?.query.login, 'User_Login');
    assert.equal(revokeSubscriptionDeviceCalls[0]?.deviceRef, 'device-1');
    assert.deepStrictEqual(response.body, buildSubscriptionDevicesResult());
  });

  it('rejects referralCode on single-device revocation route at validation time', async () => {
    revokeSubscriptionDeviceCalls.length = 0;
    const response = await request(application.getHttpServer())
      .delete('/api/admin/users/subscription/devices/device-1')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    assert.equal(revokeSubscriptionDeviceCalls.length, 0);
    assert.equal(response.body.message.includes('property referralCode should not exist'), true);
  });

  it('rejects too-long device references for single-device revocation route', async () => {
    revokeSubscriptionDeviceCalls.length = 0;
    const longHwid = 'd'.repeat(257);
    const response = await request(application.getHttpServer())
      .delete(`/api/admin/users/subscription/devices/${longHwid}`)
      .query({ userId: 'user-1' })
      .expect(400);
    assert.equal(revokeSubscriptionDeviceCalls.length, 0);
    assert.equal(Array.isArray(response.body.message), true);
    assert.deepStrictEqual(response.body.message, ['deviceRef must be shorter than or equal to 128 characters']);
  });

  it('accepts query params and delegates device provisioning challenge list route', async () => {
    deviceProvisioningChallengesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/device-provisioning-challenges')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(200);

    assert.equal(deviceProvisioningChallengesCalls.length, 1);
    assert.equal(deviceProvisioningChallengesCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(deviceProvisioningChallengesCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.deepStrictEqual(response.body, buildDeviceProvisioningChallengesResult());
    assert.equal(JSON.stringify(response.body).includes('challengeHash'), false);
  });

  it('accepts query params and delegates device provisioning challenge issue route', async () => {
    issueDeviceProvisioningChallengeCalls.length = 0;
    const response = await request(application.getHttpServer())
      .post('/api/admin/users/device-provisioning-challenges')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .send({ reason: 'support-confirmed' })
      .expect(201);

    assert.equal(issueDeviceProvisioningChallengeCalls.length, 1);
    assert.equal(issueDeviceProvisioningChallengeCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(issueDeviceProvisioningChallengeCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(issueDeviceProvisioningChallengeCalls[0]?.reason, 'support-confirmed');
    assert.deepStrictEqual(response.body, buildDeviceProvisioningChallengeResult());
    assert.equal(JSON.stringify(response.body).includes('challengeHash'), false);
    assert.equal(JSON.stringify(response.body).includes('hwid'), false);
  });

  it('accepts query params and delegates device provisioning challenge revoke route', async () => {
    revokeDeviceProvisioningChallengeCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/device-provisioning-challenges/challenge-1/revoke')
      .query({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(200);

    assert.equal(revokeDeviceProvisioningChallengeCalls.length, 1);
    assert.equal(revokeDeviceProvisioningChallengeCalls[0]?.query.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(revokeDeviceProvisioningChallengeCalls[0]?.query.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(revokeDeviceProvisioningChallengeCalls[0]?.challengeId, 'challenge-1');
    assert.equal(revokeDeviceProvisioningChallengeCalls[0]?.adminUserId, 'admin-1');
    assert.equal(response.body.status, 'REVOKED');
    assert.equal(JSON.stringify(response.body).includes('challengeHash'), false);
    assert.equal(JSON.stringify(response.body).includes('hwid'), false);
  });

  it('blocks and unblocks users with admin moderation context', async () => {
    moderationCalls.length = 0;

    const blockResponse = await request(application.getHttpServer())
      .patch('/api/admin/users/user-1/block')
      .send({ reason: ' support case ' })
      .expect(200);
    assert.deepStrictEqual(blockResponse.body, {
      userId: 'user-1',
      isBlocked: true,
      changed: true,
      action: 'BLOCK_USER',
      checkedAt: '2026-04-24T12:00:00.000Z',
    });

    const unblockResponse = await request(application.getHttpServer())
      .patch('/api/admin/users/user-1/unblock')
      .send({})
      .expect(200);
    assert.equal(unblockResponse.body.isBlocked, false);
    assert.deepStrictEqual(moderationCalls, [
      { adminUserId: 'admin-1', userId: 'user-1', reason: ' support case ', isBlocked: true },
      { adminUserId: 'admin-1', userId: 'user-1', reason: undefined, isBlocked: false },
    ]);
  });

  it('accepts query identifier and delegates rules acceptance patch route', async () => {
    acceptRulesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/rules-acceptance')
      .query({ email: '  user@example.com  ' })
      .expect(200);
    assert.equal(acceptRulesCalls.length, 1);
    assert.equal(acceptRulesCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(acceptRulesCalls[0]?.query.email, 'user@example.com');
    assert.deepStrictEqual(response.body, buildSessionResult());
  });

  it('rejects referralCode on rules acceptance route at validation time', async () => {
    acceptRulesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/rules-acceptance')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    assert.equal(acceptRulesCalls.length, 0);
    assert.equal(response.body.message.includes('property referralCode should not exist'), true);
  });

  it('accepts query identifier and delegates web-account link prompt snooze patch route', async () => {
    snoozeWebAccountLinkPromptCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/web-account-link-prompt-snooze')
      .query({ login: '  User_Login  ' })
      .expect(200);
    assert.equal(snoozeWebAccountLinkPromptCalls.length, 1);
    assert.equal(snoozeWebAccountLinkPromptCalls[0]?.query instanceof AdminUserIdentifierQueryDto, true);
    assert.equal(snoozeWebAccountLinkPromptCalls[0]?.query.login, 'User_Login');
    assert.deepStrictEqual(response.body, buildSessionResult());
  });

  it('rejects referralCode on web-account link prompt snooze route at validation time', async () => {
    snoozeWebAccountLinkPromptCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/web-account-link-prompt-snooze')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    assert.equal(snoozeWebAccountLinkPromptCalls.length, 0);
    assert.equal(response.body.message.includes('property referralCode should not exist'), true);
  });

  it('accepts query identifier and delegates email verification challenge issuance patch route', async () => {
    issueWebAccountEmailVerificationChallengeCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/web-account-email-verification-challenge')
      .query({ userId: 'd7f81dca-6b2a-4a71-844b-23d511f61893' })
      .expect(200);
    assert.equal(issueWebAccountEmailVerificationChallengeCalls.length, 1);
    assert.equal(
      issueWebAccountEmailVerificationChallengeCalls[0]?.query instanceof AdminUserIdentifierQueryDto,
      true,
    );
    assert.equal(
      issueWebAccountEmailVerificationChallengeCalls[0]?.query.userId,
      'd7f81dca-6b2a-4a71-844b-23d511f61893',
    );
    assert.deepStrictEqual(response.body, buildEmailVerificationChallengeResult());
  });

  it('rejects referralCode on email verification challenge route at validation time', async () => {
    issueWebAccountEmailVerificationChallengeCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/web-account-email-verification-challenge')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    assert.equal(issueWebAccountEmailVerificationChallengeCalls.length, 0);
    assert.equal(response.body.message.includes('property referralCode should not exist'), true);
  });

  it('rejects multi-identifier query combinations on bounded action patch routes', async () => {
    acceptRulesCalls.length = 0;
    const response = await request(application.getHttpServer())
      .patch('/api/admin/users/session/rules-acceptance')
      .query({ userId: 'd7f81dca-6b2a-4a71-844b-23d511f61893', email: 'user@example.com' })
      .expect(400);
    assert.equal(acceptRulesCalls.length, 0);
    assert.deepStrictEqual(response.body.message, [
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    ]);
  });
});
