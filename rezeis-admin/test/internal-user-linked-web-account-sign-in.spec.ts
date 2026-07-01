import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { UserRole } from '@prisma/client';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailService } from '../src/modules/email/services/email.service';
import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { LinkedWebAccountSignInDto } from '../src/modules/internal-user/dto/linked-web-account-sign-in.dto';
import { InternalUserSessionInterface } from '../src/modules/internal-user/interfaces/internal-user-session.interface';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

describe('linked web-account internal sign-in', () => {
  it('exposes the internal route contract through InternalUserController', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.signInLinkedWebAccount,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.signInLinkedWebAccount,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'signInLinkedWebAccount',
    ) as readonly unknown[] | undefined;
    const actualRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'signInLinkedWebAccount',
    ) as
      | Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }>
      | undefined) ?? {};

    assert.equal(actualPath, 'web-account/sign-in');
    assert.equal(actualMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualParameterTypes, [LinkedWebAccountSignInDto]);
    assert.deepStrictEqual(actualRouteArgs[`${RouteParamtypes.BODY}:0`], {
      index: 0,
      data: undefined,
      pipes: [],
    });
  });

  it('verifies linked credentials and returns the canonical session payload', async () => {
    let actualWebAccountWhere: unknown;
    let actualPasswordInput: unknown;
    let actualUserWhere: unknown;
    const prismaService = {
      webAccount: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualWebAccountWhere = (args[0] as { readonly where: unknown }).where;
          return createWebAccountRecord();
        },
      },
      user: {
        findUnique: async (...args: readonly unknown[]): Promise<unknown> => {
          actualUserWhere = (args[0] as { readonly where: unknown }).where;
          return createInternalUserRecord();
        },
      },
    };
    const passwordHashService = {
      verifyPassword: async (...args: readonly unknown[]): Promise<boolean> => {
        actualPasswordInput = args[0];
        return true;
      },
    };
    const service = new InternalUserService(
      prismaService as never,
      passwordHashService as PasswordHashService,
      createEmailServiceMock(),
    );

    const actualSession = await service.signInLinkedWebAccount({
      login: '  User_Login  ',
      password: 'correct-password',
    });

    assert.deepStrictEqual(actualWebAccountWhere, { loginNormalized: 'user_login' });
    assert.deepStrictEqual(actualPasswordInput, {
      plainTextPassword: 'correct-password',
      passwordHash: 'stored-password-hash',
    });
    assert.deepStrictEqual(actualUserWhere, {
      id: 'user-1',
    });
    assert.deepStrictEqual(actualSession, createExpectedSession());
  });

  it('does not reveal whether missing account or bad password caused the failure', async () => {
    const missingAccountService = new InternalUserService(
      {
        webAccount: {
          findUnique: async (): Promise<unknown> => null,
        },
      } as never,
      createPasswordHashServiceMock({ isPasswordValid: true }),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await missingAccountService.signInLinkedWebAccount({
          login: 'missing-user',
          password: 'correct-password',
        });
      },
      {
        name: 'UnauthorizedException',
        message: 'Invalid login or password',
      },
    );

    const badPasswordService = new InternalUserService(
      {
        webAccount: {
          findUnique: async (): Promise<unknown> => createWebAccountRecord(),
        },
      } as never,
      createPasswordHashServiceMock({ isPasswordValid: false }),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await badPasswordService.signInLinkedWebAccount({
          login: 'user-login',
          password: 'wrong-password',
        });
      },
      {
        name: 'UnauthorizedException',
        message: 'Invalid login or password',
      },
    );
  });

  it('rejects linked accounts that are not ready for standalone sign-in', async () => {
    await assert.rejects(
      async (): Promise<void> => {
        await createSignInServiceForWebAccount({
          passwordHash: null,
        }).signInLinkedWebAccount({ login: 'user-login', password: 'correct-password' });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount password is not configured',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await createSignInServiceForWebAccount({
          requiresPasswordChange: true,
        }).signInLinkedWebAccount({ login: 'user-login', password: 'correct-password' });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount password change is required',
      },
    );
    await assert.rejects(
      async (): Promise<void> => {
        await createSignInServiceForWebAccount({
          emailVerifiedAt: null,
        }).signInLinkedWebAccount({ login: 'user-login', password: 'correct-password' });
      },
      {
        name: 'BadRequestException',
        message: 'webAccount email is not verified',
      },
    );
  });

  it('rejects a blocked linked-account user after credential verification', async () => {
    const service = new InternalUserService(
      {
        webAccount: {
          findUnique: async (): Promise<unknown> => createWebAccountRecord(),
        },
        user: {
          findUnique: async (): Promise<unknown> => createInternalUserRecord({ isBlocked: true }),
        },
      } as never,
      createPasswordHashServiceMock({ isPasswordValid: true }),
      createEmailServiceMock(),
    );
    await assert.rejects(
      async (): Promise<void> => {
        await service.signInLinkedWebAccount({
          login: 'user-login',
          password: 'correct-password',
        });
      },
      {
        name: 'BadRequestException',
        message: 'User is blocked',
      },
    );
  });
});

function createSignInServiceForWebAccount(
  webAccount: Partial<ReturnType<typeof createWebAccountRecord>>,
): InternalUserService {
  return new InternalUserService(
    {
      webAccount: {
        findUnique: async (): Promise<unknown> => createWebAccountRecord(webAccount),
      },
      user: {
        findUnique: async (): Promise<unknown> => createInternalUserRecord(),
      },
    } as never,
    createPasswordHashServiceMock({ isPasswordValid: true }),
    createEmailServiceMock(),
  );
}

function createPasswordHashServiceMock(input: { readonly isPasswordValid: boolean }): PasswordHashService {
  return {
    verifyPassword: async (): Promise<boolean> => input.isPasswordValid,
  } as unknown as PasswordHashService;
}

function createEmailServiceMock(): EmailService {
  return {
    sendLinkedAccountVerificationCode: async (): Promise<void> => undefined,
  } as unknown as EmailService;
}

function createWebAccountRecord(
  overrides: Partial<{
    readonly passwordHash: string | null;
    readonly requiresPasswordChange: boolean;
    readonly emailVerifiedAt: Date | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: 'web-account-1',
    userId: 'user-1',
    login: 'User_Login',
    loginNormalized: 'user_login',
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
    passwordHash: 'stored-password-hash',
    requiresPasswordChange: false,
    temporaryPasswordExpiresAt: null,
    tokenVersion: 0,
    linkPromptSnoozeUntil: null,
    credentialsBootstrappedAt: new Date('2026-04-18T09:00:00.000Z'),
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: new Date('2026-04-18T10:00:00.000Z'),
    ...overrides,
  };
}

function createInternalUserRecord(
  overrides: Partial<{
    readonly isBlocked: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    id: 'user-1',
    telegramId: BigInt('777000'),
    username: 'tester',
    name: 'Rezeis User',
    email: 'user@example.com',
    role: UserRole.USER,
    language: 'EN',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 0,
    maxSubscriptions: 1,
    isBlocked: false,
    isBotBlocked: false,
    isRulesAccepted: true,
    onboardingCompletedAt: null,
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: new Date('2026-04-18T10:00:00.000Z'),
    webAccount: createWebAccountRecord(),
    ...overrides,
  };
}

function createExpectedSession(): InternalUserSessionInterface {
  return {
    id: 'user-1',
    telegramId: '777000',
    username: 'tester',
    name: 'Rezeis User',
    email: 'user@example.com',
    role: UserRole.USER,
    language: 'EN',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 0,
    maxSubscriptions: 1,
    isBlocked: false,
    isBotBlocked: false,
    isRulesAccepted: true,
    onboardingCompleted: false,
    createdAt: '2026-04-18T08:00:00.000Z',
    updatedAt: '2026-04-18T10:00:00.000Z',
    lastSeenAt: null,
    webAccount: {
      id: 'web-account-1',
      login: 'User_Login',
      loginNormalized: 'user_login',
      email: 'user@example.com',
      emailNormalized: 'user@example.com',
      emailVerifiedAt: '2026-04-18T10:00:00.000Z',
      requiresPasswordChange: false,
      linkPromptSnoozeUntil: null,
      credentialsBootstrappedAt: '2026-04-18T09:00:00.000Z',
      createdAt: '2026-04-18T08:00:00.000Z',
      updatedAt: '2026-04-18T10:00:00.000Z',
    },
  };
}
