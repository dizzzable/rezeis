import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Locale, PlanType, SubscriptionStatus, UserRole } from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AcceptInternalUserRulesDto } from '../src/modules/internal-user/dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../src/modules/internal-user/dto/complete-web-account-email-verification.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../src/modules/internal-user/dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../src/modules/internal-user/dto/internal-user-session-query.dto';
import { RevokeInternalUserSubscriptionDeviceDto } from '../src/modules/internal-user/dto/revoke-internal-user-subscription-device.dto';
import { SetWebAccountPasswordDto } from '../src/modules/internal-user/dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../src/modules/internal-user/dto/snooze-web-account-link-prompt.dto';
import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../src/modules/internal-user/interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserPlanInterface } from '../src/modules/internal-user/interfaces/internal-user-plan.interface';
import { InternalUserSessionInterface } from '../src/modules/internal-user/interfaces/internal-user-session.interface';
import { InternalUserSubscriptionDevicesInterface } from '../src/modules/internal-user/interfaces/internal-user-subscription-devices.interface';
import { InternalUserSubscriptionInterface } from '../src/modules/internal-user/interfaces/internal-user-subscription.interface';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

describe('InternalUserController', () => {
  it('exposes the shipped internal user route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, InternalUserController) as
      | string
      | undefined;
    const actualSessionPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.getSession,
    ) as string | undefined;
    const actualSessionMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.getSession,
    ) as RequestMethod | undefined;
    const actualAcceptRulesPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.acceptRules,
    ) as string | undefined;
    const actualAcceptRulesMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.acceptRules,
    ) as RequestMethod | undefined;
    const actualAcceptRulesParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'acceptRules',
    ) as readonly unknown[] | undefined;
    const actualSnoozeLinkPromptPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.snoozeWebAccountLinkPrompt,
    ) as string | undefined;
    const actualSnoozeLinkPromptMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.snoozeWebAccountLinkPrompt,
    ) as RequestMethod | undefined;
    const actualSnoozeLinkPromptParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'snoozeWebAccountLinkPrompt',
    ) as readonly unknown[] | undefined;
    const actualSetWebAccountPasswordPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.setWebAccountPassword,
    ) as string | undefined;
    const actualSetWebAccountPasswordMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.setWebAccountPassword,
    ) as RequestMethod | undefined;
    const actualSetWebAccountPasswordParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'setWebAccountPassword',
    ) as readonly unknown[] | undefined;
    const actualSetWebAccountPasswordRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'setWebAccountPassword',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};
    const actualSetWebAccountPasswordBodyArg =
      actualSetWebAccountPasswordRouteArgs[`${RouteParamtypes.BODY}:0`];
    const actualIssueChallengePath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.issueWebAccountEmailVerificationChallenge,
    ) as string | undefined;
    const actualIssueChallengeMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.issueWebAccountEmailVerificationChallenge,
    ) as RequestMethod | undefined;
    const actualIssueChallengeParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'issueWebAccountEmailVerificationChallenge',
    ) as readonly unknown[] | undefined;
    const actualIssueChallengeRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'issueWebAccountEmailVerificationChallenge',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};
    const actualIssueChallengeBodyArg = actualIssueChallengeRouteArgs[`${RouteParamtypes.BODY}:0`];
    const actualCompleteVerificationPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.completeWebAccountEmailVerification,
    ) as string | undefined;
    const actualCompleteVerificationMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.completeWebAccountEmailVerification,
    ) as RequestMethod | undefined;
    const actualCompleteVerificationParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'completeWebAccountEmailVerification',
    ) as readonly unknown[] | undefined;
    const actualCompleteVerificationRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'completeWebAccountEmailVerification',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};
    const actualCompleteVerificationBodyArg = actualCompleteVerificationRouteArgs[`${RouteParamtypes.BODY}:0`];
    const actualPlansPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.getPlans,
    ) as string | undefined;
    const actualPlansMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.getPlans,
    ) as RequestMethod | undefined;
    const actualSubscriptionPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.getSubscription,
    ) as string | undefined;
    const actualSubscriptionMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.getSubscription,
    ) as RequestMethod | undefined;
    const actualSubscriptionDevicesPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.getSubscriptionDevices,
    ) as string | undefined;
    const actualSubscriptionDevicesMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.getSubscriptionDevices,
    ) as RequestMethod | undefined;
    const actualRevokeSubscriptionDevicePath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.revokeSubscriptionDevice,
    ) as string | undefined;
    const actualRevokeSubscriptionDeviceMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.revokeSubscriptionDevice,
    ) as RequestMethod | undefined;
    const actualRevokeSubscriptionDeviceParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'revokeSubscriptionDevice',
    ) as readonly unknown[] | undefined;
    const actualRevokeSubscriptionDeviceRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'revokeSubscriptionDevice',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};
    const actualRevokeSubscriptionDeviceQueryArg =
      actualRevokeSubscriptionDeviceRouteArgs[`${RouteParamtypes.QUERY}:0`];
    const actualRevokeSubscriptionDeviceParamArg =
      actualRevokeSubscriptionDeviceRouteArgs[`${RouteParamtypes.PARAM}:1`];
    const actualControllerGuards = Reflect.getMetadata(GUARDS_METADATA, InternalUserController) as
      | readonly unknown[]
      | undefined;
    assert.equal(actualControllerPath, 'internal/user');
    assert.equal(actualSessionPath, 'session');
    assert.equal(actualSessionMethod, RequestMethod.GET);
    assert.equal(actualAcceptRulesPath, 'session/rules-acceptance');
    assert.equal(actualAcceptRulesMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualAcceptRulesParameterTypes, [AcceptInternalUserRulesDto]);
    assert.equal(actualSnoozeLinkPromptPath, 'session/web-account-link-prompt-snooze');
    assert.equal(actualSnoozeLinkPromptMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualSnoozeLinkPromptParameterTypes, [SnoozeWebAccountLinkPromptDto]);
    assert.equal(actualSetWebAccountPasswordPath, 'session/web-account-password');
    assert.equal(actualSetWebAccountPasswordMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualSetWebAccountPasswordParameterTypes, [SetWebAccountPasswordDto]);
    assert.deepStrictEqual(actualSetWebAccountPasswordBodyArg, {
      index: 0,
      data: undefined,
      pipes: [],
    });
    assert.equal(actualIssueChallengePath, 'session/web-account-email-verification-challenge');
    assert.equal(actualIssueChallengeMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualIssueChallengeParameterTypes, [IssueWebAccountEmailVerificationChallengeDto]);
    assert.deepStrictEqual(actualIssueChallengeBodyArg, {
      index: 0,
      data: undefined,
      pipes: [],
    });
    assert.equal(actualCompleteVerificationPath, 'session/web-account-email-verification-completion');
    assert.equal(actualCompleteVerificationMethod, RequestMethod.PATCH);
    assert.deepStrictEqual(actualCompleteVerificationParameterTypes, [CompleteWebAccountEmailVerificationDto]);
    assert.deepStrictEqual(actualCompleteVerificationBodyArg, {
      index: 0,
      data: undefined,
      pipes: [],
    });
    assert.equal(actualPlansPath, 'plans');
    assert.equal(actualPlansMethod, RequestMethod.GET);
    assert.equal(actualSubscriptionPath, 'subscription');
    assert.equal(actualSubscriptionMethod, RequestMethod.GET);
    assert.equal(actualSubscriptionDevicesPath, 'subscription/devices');
    assert.equal(actualSubscriptionDevicesMethod, RequestMethod.GET);
    assert.equal(actualRevokeSubscriptionDevicePath, 'subscription/devices/:hwid');
    assert.equal(actualRevokeSubscriptionDeviceMethod, RequestMethod.DELETE);
    assert.deepStrictEqual(actualRevokeSubscriptionDeviceParameterTypes, [
      InternalUserSessionQueryDto,
      RevokeInternalUserSubscriptionDeviceDto,
    ]);
    assert.deepStrictEqual(actualRevokeSubscriptionDeviceQueryArg, {
      index: 0,
      data: undefined,
      pipes: [],
    });
    assert.deepStrictEqual(actualRevokeSubscriptionDeviceParamArg, {
      index: 1,
      data: undefined,
      pipes: [],
    });
    assert.deepStrictEqual(actualControllerGuards, [InternalAdminAuthGuard]);
  });

  it('delegates session lookup and returns the resolved session unchanged', async () => {
    const getSessionCalls: InternalUserSessionQueryDto[] = [];
    const query = { email: 'user@example.com' } as InternalUserSessionQueryDto;
    const expectedSession: InternalUserSessionInterface = {
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
    };
    const internalUserService = {
      getSession: async (input: InternalUserSessionQueryDto): Promise<InternalUserSessionInterface> => {
        getSessionCalls.push(input);
        return expectedSession;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSession = await controller.getSession(query);
    assert.deepStrictEqual(getSessionCalls, [query]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates rules acceptance and returns the refreshed session unchanged', async () => {
    const acceptRulesCalls: AcceptInternalUserRulesDto[] = [];
    const query = { userId: '11111111-1111-1111-1111-111111111111' } as AcceptInternalUserRulesDto;
    const expectedSession: InternalUserSessionInterface = {
      id: 'user-1',
      telegramId: null,
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 0,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-17T05:00:00.000Z',
      webAccount: null,
    };
    const internalUserService = {
      acceptRules: async (input: AcceptInternalUserRulesDto): Promise<InternalUserSessionInterface> => {
        acceptRulesCalls.push(input);
        return expectedSession;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSession = await controller.acceptRules(query);
    assert.deepStrictEqual(acceptRulesCalls, [query]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates web-account link prompt snooze and returns the refreshed session unchanged', async () => {
    const snoozeCalls: SnoozeWebAccountLinkPromptDto[] = [];
    const query = { userId: '11111111-1111-1111-1111-111111111111' } as SnoozeWebAccountLinkPromptDto;
    const expectedSession: InternalUserSessionInterface = {
      id: 'user-1',
      telegramId: null,
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 0,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-17T05:00:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-01T01:00:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: '2026-04-24T05:00:00.000Z',
        credentialsBootstrappedAt: '2026-04-01T01:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-17T05:00:00.000Z',
      },
    };
    const internalUserService = {
      snoozeWebAccountLinkPrompt: async (
        input: SnoozeWebAccountLinkPromptDto,
      ): Promise<InternalUserSessionInterface> => {
        snoozeCalls.push(input);
        return expectedSession;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSession = await controller.snoozeWebAccountLinkPrompt(query);
    assert.deepStrictEqual(snoozeCalls, [query]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates web-account password handoff and returns the refreshed session unchanged', async () => {
    const setPasswordCalls: SetWebAccountPasswordDto[] = [];
    const input = {
      userId: '11111111-1111-1111-1111-111111111111',
      login: 'user-login',
      password: 'new-password-123',
    } as SetWebAccountPasswordDto;
    const expectedSession: InternalUserSessionInterface = {
      id: 'user-1',
      telegramId: null,
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 0,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-17T05:00:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-01T01:00:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: '2026-04-17T05:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-17T05:00:00.000Z',
      },
    };
    const internalUserService = {
      setWebAccountPassword: async (
        value: SetWebAccountPasswordDto,
      ): Promise<InternalUserSessionInterface> => {
        setPasswordCalls.push(value);
        return expectedSession;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSession = await controller.setWebAccountPassword(input);
    assert.deepStrictEqual(setPasswordCalls, [input]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('delegates email verification challenge issuance and returns the narrow challenge state unchanged', async () => {
    const issueChallengeCalls: IssueWebAccountEmailVerificationChallengeDto[] = [];
    const input = {
      userId: '11111111-1111-1111-1111-111111111111',
    } as IssueWebAccountEmailVerificationChallengeDto;
    const expectedResponse: InternalWebAccountEmailVerificationChallengeInterface = {
      webAccountId: 'web-account-1',
      email: 'user@example.com',
      challengeExpiresAt: '2026-04-17T05:15:00.000Z',
    };
    const internalUserService = {
      issueWebAccountEmailVerificationChallenge: async (
        value: IssueWebAccountEmailVerificationChallengeDto,
      ): Promise<InternalWebAccountEmailVerificationChallengeInterface> => {
        issueChallengeCalls.push(value);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualResponse = await controller.issueWebAccountEmailVerificationChallenge(input);
    assert.deepStrictEqual(issueChallengeCalls, [input]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates email verification completion and returns the refreshed session unchanged', async () => {
    const completeVerificationCalls: CompleteWebAccountEmailVerificationDto[] = [];
    const input = {
      userId: '11111111-1111-1111-1111-111111111111',
      code: '123456',
    } as CompleteWebAccountEmailVerificationDto;
    const expectedSession: InternalUserSessionInterface = {
      id: 'user-1',
      telegramId: null,
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 0,
      points: 120,
      maxSubscriptions: 2,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-18T08:30:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-18T08:30:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: '2026-04-17T05:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-18T08:30:00.000Z',
      },
    };
    const internalUserService = {
      completeWebAccountEmailVerification: async (
        value: CompleteWebAccountEmailVerificationDto,
      ): Promise<InternalUserSessionInterface> => {
        completeVerificationCalls.push(value);
        return expectedSession;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSession = await controller.completeWebAccountEmailVerification(input);
    assert.deepStrictEqual(completeVerificationCalls, [input]);
    assert.deepStrictEqual(actualSession, expectedSession);
  });

  it('returns active plans for the user-facing edge', async () => {
    let getPlansCallsCount: number = 0;
    const expectedPlans: readonly InternalUserPlanInterface[] = [
      {
        id: 'plan-1',
        orderIndex: 1,
        name: 'Starter',
        description: 'Starter plan',
        tag: 'popular',
        type: 'TRAFFIC',
        trafficLimit: 10737418240,
        deviceLimit: 1,
        durations: [
          {
            id: 'duration-1',
            days: 30,
            prices: [{ currency: 'USD', price: '9.99' }],
          },
        ],
      },
    ];
    const internalUserService = {
      getPlans: async (): Promise<readonly InternalUserPlanInterface[]> => {
        getPlansCallsCount += 1;
        return expectedPlans;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualPlans = await controller.getPlans();
    assert.equal(getPlansCallsCount, 1);
    assert.deepStrictEqual(actualPlans, expectedPlans);
  });

  it('delegates subscription lookup and returns the latest subscription unchanged', async () => {
    const getSubscriptionCalls: InternalUserSessionQueryDto[] = [];
    const query = { telegramId: '123456789' } as InternalUserSessionQueryDto;
    const expectedSubscription: InternalUserSubscriptionInterface = {
      id: 'subscription-1',
      status: SubscriptionStatus.ACTIVE,
      isTrial: false,
      plan: {
        name: 'Starter',
        type: PlanType.TRAFFIC,
      },
      trafficLimit: 10737418240,
      deviceLimit: 1,
      configUrl: 'https://example.com/config',
      startedAt: '2026-04-01T00:00:00.000Z',
      expiresAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
    };
    const internalUserService = {
      getSubscription: async (
        input: InternalUserSessionQueryDto,
      ): Promise<InternalUserSubscriptionInterface | null> => {
        getSubscriptionCalls.push(input);
        return expectedSubscription;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualSubscription = await controller.getSubscription(query);
    assert.deepStrictEqual(getSubscriptionCalls, [query]);
    assert.deepStrictEqual(actualSubscription, expectedSubscription);
  });

  it('delegates current-subscription device lookup and returns payload unchanged', async () => {
    const getSubscriptionDevicesCalls: InternalUserSessionQueryDto[] = [];
    const query = { telegramId: '123456789' } as InternalUserSessionQueryDto;
    const expectedResponse: InternalUserSubscriptionDevicesInterface = {
      devices: [
        {
          hwid: 'hwid-1',
          deviceName: 'iPhone 15 Pro',
          platform: 'ios',
          osVersion: '17.4',
          appVersion: null,
          userAgent: 'Rezeis/1.0',
          ipAddress: '203.0.113.10',
          lastSeenAt: '2026-04-20T11:30:00.000Z',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
      deviceCount: 1,
      deviceLimit: 2,
      isLimitReached: false,
      blockedMessage: null,
      maxDevicesMessage: null,
    };
    const internalUserService = {
      getSubscriptionDevices: async (
        input: InternalUserSessionQueryDto,
      ): Promise<InternalUserSubscriptionDevicesInterface> => {
        getSubscriptionDevicesCalls.push(input);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualResponse = await controller.getSubscriptionDevices(query);
    assert.deepStrictEqual(getSubscriptionDevicesCalls, [query]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates one-device revoke by hwid and returns updated payload unchanged', async () => {
    const revokeCalls: Array<{ readonly query: InternalUserSessionQueryDto; readonly hwid: string }> = [];
    const query = { telegramId: '123456789' } as InternalUserSessionQueryDto;
    const params = { hwid: 'hwid-1' } as RevokeInternalUserSubscriptionDeviceDto;
    const expectedResponse: InternalUserSubscriptionDevicesInterface = {
      devices: [],
      deviceCount: 0,
      deviceLimit: 2,
      isLimitReached: false,
      blockedMessage: null,
      maxDevicesMessage: null,
    };
    const internalUserService = {
      revokeSubscriptionDevice: async (input: {
        readonly query: InternalUserSessionQueryDto;
        readonly hwid: string;
      }): Promise<InternalUserSubscriptionDevicesInterface> => {
        revokeCalls.push(input);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);
    const actualResponse = await controller.revokeSubscriptionDevice(query, params);
    assert.deepStrictEqual(revokeCalls, [{ query, hwid: 'hwid-1' }]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });
});
