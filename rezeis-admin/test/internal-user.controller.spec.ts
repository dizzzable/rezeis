import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Currency, Locale, PaymentGatewayType, PlanType, PurchaseChannel, PurchaseType, SubscriptionStatus, TransactionStatus, UserRole } from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AcceptInternalUserRulesDto } from '../src/modules/internal-user/dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../src/modules/internal-user/dto/complete-web-account-email-verification.dto';
import { InternalBootstrapUserDto } from '../src/modules/internal-user/dto/internal-bootstrap-user.dto';
import { InternalByTelegramQueryDto } from '../src/modules/internal-user/dto/internal-by-telegram-query.dto';
import { InternalUpdateLanguageDto } from '../src/modules/internal-user/dto/internal-update-language.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../src/modules/internal-user/dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../src/modules/internal-user/dto/internal-user-session-query.dto';
import { LinkedWebAccountSignInDto } from '../src/modules/internal-user/dto/linked-web-account-sign-in.dto';
import { SetWebAccountPasswordDto } from '../src/modules/internal-user/dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../src/modules/internal-user/dto/snooze-web-account-link-prompt.dto';
import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../src/modules/internal-user/interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalPartnerStatusInterface } from '../src/modules/internal-user/interfaces/internal-partner-status.interface';
import { InternalUserNotificationInterface, InternalUserTransactionInterface } from '../src/modules/internal-user/interfaces/internal-user-notification.interface';
import { InternalUserPlanInterface } from '../src/modules/internal-user/interfaces/internal-user-plan.interface';
import { InternalUserSessionInterface } from '../src/modules/internal-user/interfaces/internal-user-session.interface';
import { InternalUserSubscriptionInterface } from '../src/modules/internal-user/interfaces/internal-user-subscription.interface';

describe('InternalUserController', () => {
  it('exposes the current guarded internal user route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalUserController), 'internal/user');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalUserController), [InternalAdminAuthGuard]);
    assertRoute(RequestMethod.GET, 'session', InternalUserController.prototype.getSession);
    assertRoute(RequestMethod.POST, 'web-account/sign-in', InternalUserController.prototype.signInLinkedWebAccount);
    assertRoute(RequestMethod.PATCH, 'session/rules-acceptance', InternalUserController.prototype.acceptRules);
    assertRoute(RequestMethod.PATCH, 'session/onboarding', InternalUserController.prototype.setOnboarding);
    assertRoute(RequestMethod.PATCH, 'session/web-account-link-prompt-snooze', InternalUserController.prototype.snoozeWebAccountLinkPrompt);
    assertRoute(RequestMethod.PATCH, 'session/web-account-password', InternalUserController.prototype.setWebAccountPassword);
    assertRoute(RequestMethod.PATCH, 'session/web-account-email-verification-challenge', InternalUserController.prototype.issueWebAccountEmailVerificationChallenge);
    assertRoute(RequestMethod.PATCH, 'session/web-account-email-verification-completion', InternalUserController.prototype.completeWebAccountEmailVerification);
    assertRoute(RequestMethod.GET, 'plans', InternalUserController.prototype.getPlans);
    assertRoute(RequestMethod.GET, 'subscription', InternalUserController.prototype.getSubscription);
    assertRoute(RequestMethod.GET, 'subscriptions', InternalUserController.prototype.getAllSubscriptions);
    assertRoute(RequestMethod.GET, 'partner-status', InternalUserController.prototype.getPartnerStatus);
    assertRoute(RequestMethod.POST, 'bootstrap', InternalUserController.prototype.bootstrap);
    assertRoute(RequestMethod.PATCH, 'language', InternalUserController.prototype.updateLanguage);
    assertRoute(RequestMethod.GET, 'notifications', InternalUserController.prototype.listNotifications);
    assertRoute(RequestMethod.GET, 'notifications/unread-count', InternalUserController.prototype.unreadCount);
    assertRoute(RequestMethod.POST, 'notifications/read-all', InternalUserController.prototype.readAll);
    assertRoute(RequestMethod.POST, 'notifications/:notificationId/read', InternalUserController.prototype.readOne);
    assertRoute(RequestMethod.GET, 'transactions', InternalUserController.prototype.listTransactions);
    assertRoute(RequestMethod.GET, 'trial/eligibility', InternalUserController.prototype.trialEligibility);
    assertRoute(RequestMethod.POST, 'trial', InternalUserController.prototype.trialActivate);
    assertRoute(RequestMethod.POST, 'bot-blocked', InternalUserController.prototype.markBotBlocked);
  });

  it('delegates session and linked web-account operations to InternalUserService', async () => {
    const calls: unknown[] = [];
    const session = createSession();
    const challenge: InternalWebAccountEmailVerificationChallengeInterface = {
      webAccountId: 'web-account-1',
      email: 'user@example.com',
      challengeExpiresAt: '2026-04-17T05:15:00.000Z',
    };
    const controller = createController({
      internalUserService: {
        getSession: async (input: InternalUserSessionQueryDto) => {
          calls.push(['getSession', input]);
          return session;
        },
        signInLinkedWebAccount: async (input: LinkedWebAccountSignInDto) => {
          calls.push(['signInLinkedWebAccount', input]);
          return session;
        },
        acceptRules: async (input: AcceptInternalUserRulesDto) => {
          calls.push(['acceptRules', input]);
          return session;
        },
        setOnboardingCompleted: async (userId: string | undefined, completed: boolean) => {
          calls.push(['setOnboardingCompleted', { userId, completed }]);
          return session;
        },
        snoozeWebAccountLinkPrompt: async (input: SnoozeWebAccountLinkPromptDto) => {
          calls.push(['snoozeWebAccountLinkPrompt', input]);
          return session;
        },
        setWebAccountPassword: async (input: SetWebAccountPasswordDto) => {
          calls.push(['setWebAccountPassword', input]);
          return session;
        },
        issueWebAccountEmailVerificationChallenge: async (input: IssueWebAccountEmailVerificationChallengeDto) => {
          calls.push(['issueWebAccountEmailVerificationChallenge', input]);
          return challenge;
        },
        completeWebAccountEmailVerification: async (input: CompleteWebAccountEmailVerificationDto) => {
          calls.push(['completeWebAccountEmailVerification', input]);
          return session;
        },
      },
    });

    await controller.getSession({ userId: 'cmphfcr6i007v01jg0lcu653h' });
    await controller.signInLinkedWebAccount({ login: 'login', password: 'secret-password' } as LinkedWebAccountSignInDto);
    await controller.acceptRules({ userId: 'cmphfcr6i007v01jg0lcu653h' } as AcceptInternalUserRulesDto);
    await controller.setOnboarding({ userId: 'cmphfcr6i007v01jg0lcu653h' }, { completed: false });
    await controller.snoozeWebAccountLinkPrompt({ userId: 'cmphfcr6i007v01jg0lcu653h' } as SnoozeWebAccountLinkPromptDto);
    await controller.setWebAccountPassword({ userId: 'cmphfcr6i007v01jg0lcu653h', login: 'login', password: 'secret-password' } as SetWebAccountPasswordDto);
    assert.deepStrictEqual(
      await controller.issueWebAccountEmailVerificationChallenge({ userId: 'cmphfcr6i007v01jg0lcu653h' } as IssueWebAccountEmailVerificationChallengeDto),
      challenge,
    );
    await controller.completeWebAccountEmailVerification({ userId: 'cmphfcr6i007v01jg0lcu653h', code: '123456' } as CompleteWebAccountEmailVerificationDto);

    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'getSession',
      'signInLinkedWebAccount',
      'acceptRules',
      'setOnboardingCompleted',
      'snoozeWebAccountLinkPrompt',
      'setWebAccountPassword',
      'issueWebAccountEmailVerificationChallenge',
      'completeWebAccountEmailVerification',
    ]);
    assert.deepStrictEqual(calls[3], [
      'setOnboardingCompleted',
      { userId: 'cmphfcr6i007v01jg0lcu653h', completed: false },
    ]);
  });

  it('delegates plans, subscription, and partner status reads to InternalUserService', async () => {
    const calls: unknown[] = [];
    const plans: readonly InternalUserPlanInterface[] = [createPlan()];
    const subscription = createSubscription();
    const partnerStatus: InternalPartnerStatusInterface = {
      isActive: true,
    };
    const controller = createController({
      internalUserService: {
        getPlans: async () => {
          calls.push(['getPlans']);
          return plans;
        },
        getSubscription: async (input: InternalUserSessionQueryDto) => {
          calls.push(['getSubscription', input]);
          return subscription;
        },
        getAllSubscriptions: async (input: InternalUserSessionQueryDto) => {
          calls.push(['getAllSubscriptions', input]);
          return { subscriptions: [subscription] };
        },
        getPartnerStatus: async (input: InternalUserSessionQueryDto) => {
          calls.push(['getPartnerStatus', input]);
          return partnerStatus;
        },
      },
    });

    assert.deepStrictEqual(await controller.getPlans(), plans);
    assert.deepStrictEqual(await controller.getSubscription({ telegramId: '123456789' }), subscription);
    assert.deepStrictEqual(await controller.getAllSubscriptions({ telegramId: '123456789' }), { subscriptions: [subscription] });
    assert.deepStrictEqual(await controller.getPartnerStatus({ telegramId: '123456789' }), partnerStatus);
    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'getPlans',
      'getSubscription',
      'getAllSubscriptions',
      'getPartnerStatus',
    ]);
  });

  it('delegates edge bootstrap, locale, activity, trial, and bot-blocked flows', async () => {
    const calls: unknown[] = [];
    const notification: InternalUserNotificationInterface = {
      id: 'notification-1',
      type: 'PAYMENT_COMPLETED',
      payload: { paymentId: 'payment-1' },
      readAt: null,
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    const transaction: InternalUserTransactionInterface = {
      id: 'tx-1',
      paymentId: 'payment-1',
      status: TransactionStatus.COMPLETED,
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      amount: '8.00',
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    };
    const controller = createController({
      internalUserEdgeService: {
        bootstrapByTelegram: async (input: InternalBootstrapUserDto) => {
          calls.push(['bootstrapByTelegram', input]);
          return createSession();
        },
        updateLanguage: async (telegramId: string, language: string) => {
          calls.push(['updateLanguage', { telegramId, language }]);
          return createSession();
        },
        listNotifications: async (reference: string) => {
          calls.push(['listNotifications', reference]);
          return { notifications: [notification] };
        },
        getUnreadCount: async (reference: string) => {
          calls.push(['getUnreadCount', reference]);
          return { unread: 2 };
        },
        markAllRead: async (reference: string) => {
          calls.push(['markAllRead', reference]);
          return { updated: 2 };
        },
        markOneRead: async (reference: string, notificationId: string) => {
          calls.push(['markOneRead', { reference, notificationId }]);
          return { ok: true };
        },
        listTransactions: async (reference: string) => {
          calls.push(['listTransactions', reference]);
          return { transactions: [transaction] };
        },
        getTrialEligibility: async (reference: string) => {
          calls.push(['getTrialEligibility', reference]);
          return { eligible: true, reason: null };
        },
        activateTrial: async (reference: string, grantTrial: (input: { userId: string; planId: string; durationDays: number }) => Promise<{ subscriptionId: string }>) => {
          calls.push(['activateTrial', reference]);
          const granted = await grantTrial({ userId: 'user-1', planId: 'plan-1', durationDays: 7 });
          calls.push(['grantTrialResult', granted]);
          return { activated: true, subscriptionId: granted.subscriptionId };
        },
        markBotBlocked: async (telegramId: string) => {
          calls.push(['markBotBlocked', telegramId]);
        },
      },
      subscriptionMutationsService: {
        grantTrial: async (input: { userId: string; planId: string; durationDays: number }) => {
          calls.push(['grantTrial', input]);
          return { subscriptionId: 'subscription-trial' };
        },
      },
    });

    await controller.bootstrap({ telegramId: '123456789', username: 'user', name: 'User', language: 'EN' } as InternalBootstrapUserDto);
    await controller.updateLanguage({ telegramId: '123456789', language: 'RU' } as InternalUpdateLanguageDto);
    assert.deepStrictEqual(await controller.listNotifications({ userId: 'cmphfcr6i007v01jg0lcu653h' } as InternalByTelegramQueryDto), { notifications: [notification] });
    assert.deepStrictEqual(await controller.unreadCount({ telegramId: '123456789' } as InternalByTelegramQueryDto), { unread: 2 });
    assert.deepStrictEqual(await controller.readAll({ userId: 'cmphfcr6i007v01jg0lcu653h' } as InternalByTelegramQueryDto), { updated: 2 });
    assert.deepStrictEqual(await controller.readOne('notification-1', { telegramId: '123456789' } as InternalByTelegramQueryDto), { ok: true });
    assert.deepStrictEqual(await controller.listTransactions({ telegramId: '123456789' } as InternalByTelegramQueryDto), { transactions: [transaction] });
    assert.deepStrictEqual(await controller.trialEligibility({ telegramId: '123456789' } as InternalByTelegramQueryDto), { eligible: true, reason: null });
    assert.deepStrictEqual(await controller.trialActivate({ telegramId: '123456789' } as InternalByTelegramQueryDto), { activated: true, subscriptionId: 'subscription-trial' });
    assert.deepStrictEqual(await controller.markBotBlocked({ telegramId: '123456789' } as InternalByTelegramQueryDto), { ok: true });

    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'bootstrapByTelegram',
      'updateLanguage',
      'listNotifications',
      'getUnreadCount',
      'markAllRead',
      'markOneRead',
      'listTransactions',
      'getTrialEligibility',
      'activateTrial',
      'grantTrial',
      'grantTrialResult',
      'markBotBlocked',
    ]);
  });
});

function createController(input: {
  readonly internalUserService?: Record<string, unknown>;
  readonly internalUserEdgeService?: Record<string, unknown>;
  readonly subscriptionMutationsService?: Record<string, unknown>;
} = {}): InternalUserController {
  return new InternalUserController(
    (input.internalUserService ?? {}) as never,
    (input.internalUserEdgeService ?? {}) as never,
    (input.subscriptionMutationsService ?? {}) as never,
  );
}

function assertRoute(requestMethod: RequestMethod, path: string, target: unknown): void {
  assert.equal(Reflect.getMetadata(METHOD_METADATA, target), requestMethod);
  assert.equal(Reflect.getMetadata(PATH_METADATA, target), path);
}

function createSession(): InternalUserSessionInterface {
  return {
    id: 'cmphfcr6i007v01jg0lcu653h',
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
    onboardingCompleted: true,
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
}

function createPlan(): InternalUserPlanInterface {
  return {
    id: 'plan-1',
    orderIndex: 1,
    name: 'Starter',
    description: 'Starter plan',
    tag: 'popular',
    icon: null,
    type: PlanType.TRAFFIC,
    trafficLimit: 10737418240,
    deviceLimit: 1,
    durations: [
      {
        id: 'duration-1',
        days: 30,
        prices: [{ currency: Currency.USD, price: '9.99' }],
      },
    ],
  };
}

function createSubscription(): InternalUserSubscriptionInterface {
  return {
    id: 'subscription-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    plan: {
      id: 'plan-1',
      name: 'Starter',
      type: PlanType.TRAFFIC,
    },
    trafficLimit: 10737418240,
    trafficUsed: 1.5,
    deviceLimit: 1,
    userRemnaId: 'rem-user-1',
    profileName: 'rz_user_subscription',
    url: 'https://example.com/config',
    configUrl: 'https://example.com/config',
    startedAt: '2026-04-01T00:00:00.000Z',
    expiresAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  };
}
