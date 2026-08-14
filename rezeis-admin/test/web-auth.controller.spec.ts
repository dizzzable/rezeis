import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalWebAuthController } from '../src/modules/web-auth/controllers/internal-web-auth.controller';
import { BotSigninConsumeDto } from '../src/modules/web-auth/dto/bot-signin-consume.dto';
import { BotSigninIssueDto } from '../src/modules/web-auth/dto/bot-signin-issue.dto';
import { WebAuthChangePasswordDto } from '../src/modules/web-auth/dto/web-auth-change-password.dto';
import { WebAuthCheckLoginDto } from '../src/modules/web-auth/dto/web-auth-check-login.dto';
import { WebAuthLoginDto } from '../src/modules/web-auth/dto/web-auth-login.dto';
import { WebAuthRecoverDto } from '../src/modules/web-auth/dto/web-auth-recover.dto';
import { WebAuthRegisterDto } from '../src/modules/web-auth/dto/web-auth-register.dto';
import { BotSigninTokenService } from '../src/modules/web-auth/services/bot-signin-token.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';
import {
  assertRoute,
  assertRouteHandlers,
  assertRouteUngated,
  routeLabel,
  type RouteHandler,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'internal/web-auth';

describe('InternalWebAuthController', () => {
  it('exposes the current internal web-auth route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalWebAuthController), BASE_PATH);
    // The set of routes is read off the class rather than remembered here. The
    // hand-written list this replaces named 7 of the 9 that exist — `claim` and
    // `telegram-claim`, both of which hand out credentials, had been added
    // since and were described by nothing. These routes carry no
    // `@RequirePermission` by design: they are what a signed-out visitor calls
    // through the edge, so the enumeration is the only thing standing between
    // this file and a tenth credential endpoint nobody wrote down. That the
    // permission is absent is asserted per route in the loop below.
    assertRouteHandlers(InternalWebAuthController, [
      'register',
      'claim',
      'telegramClaim',
      'checkLogin',
      'login',
      'recover',
      'changePassword',
      'issueBotSigninToken',
      'consumeBotSigninToken',
    ]);

    for (const route of WEB_AUTH_ROUTES) {
      const label = routeLabel(BASE_PATH, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      // Carrying no permission is the CONTRACT here, not an omission, and
      // saying so is not decoration: `RbacGuard` is not among this
      // controller's guards, so a `@RequirePermission` hung on one of these
      // routes tomorrow would be read by nothing. On endpoints that mint and
      // reset credentials, a decorator that restricts no one while reading as
      // a restriction is the worst of both.
      assertRouteUngated(InternalWebAuthController, route.handler, label);
    }
  });

  it('requires internal admin API-token auth at controller level', () => {
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, InternalWebAuthController) as
      | readonly unknown[]
      | undefined;

    assert.deepStrictEqual(actualGuards, [InternalAdminAuthGuard]);
  });

  it('delegates credential lifecycle calls to WebAuthService without legacy request IP plumbing', async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const webAuthService = createWebAuthServiceMock(calls);
    const controller = new InternalWebAuthController(
      webAuthService,
      createBotSigninTokenServiceMock(),
    );
    const registerDto: WebAuthRegisterDto = {
      login: 'new-user',
      password: 'valid-password',
      email: 'user@example.com',
    };
    const checkLoginDto: WebAuthCheckLoginDto = { login: 'new-user' };
    const loginDto: WebAuthLoginDto = { login: 'new-user', password: 'valid-password' };
    const recoverDto: WebAuthRecoverDto = { login: 'new-user' };
    const changePasswordDto: WebAuthChangePasswordDto = {
      userId: 'user-1',
      currentPassword: 'old-password',
      newPassword: 'new-password',
    };

    assert.deepStrictEqual(await controller.register(registerDto), {
      userId: 'user-1',
      webAccountId: 'web-account-1',
    });
    assert.deepStrictEqual(await controller.checkLogin(checkLoginDto), { available: true });
    assert.deepStrictEqual(await controller.login(loginDto), {
      userId: 'user-1',
      requiresPasswordChange: false,
      telegramLinked: true,
      emailVerified: true,
    });
    assert.deepStrictEqual(await controller.recover(recoverDto), { method: 'telegram' });
    assert.deepStrictEqual(await controller.changePassword(changePasswordDto), { success: true });
    assert.deepStrictEqual(calls, [
      { method: 'register', payload: registerDto },
      { method: 'checkLoginAvailable', payload: 'new-user' },
      { method: 'login', payload: loginDto },
      { method: 'recover', payload: recoverDto },
      { method: 'changePassword', payload: changePasswordDto },
    ]);
  });

  it('keeps bot-signin issue responses wire-stable when no token can be minted', async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const controller = new InternalWebAuthController(
      createWebAuthServiceMock([]),
      createBotSigninTokenServiceMock(calls, { issueResult: null }),
    );
    const dto: BotSigninIssueDto = { telegramId: '123456789' };

    assert.deepStrictEqual(await controller.issueBotSigninToken(dto), {
      token: null,
      expiresAt: null,
    });
    assert.deepStrictEqual(calls, [{ method: 'issue', payload: dto.telegramId }]);
  });

  it('delegates bot-signin issue and consume to BotSigninTokenService', async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const issueResult = { token: 'a'.repeat(64), expiresAt: '2026-06-02T12:00:00.000Z' };
    const controller = new InternalWebAuthController(
      createWebAuthServiceMock([]),
      createBotSigninTokenServiceMock(calls, {
        issueResult,
        consumeResult: { userId: 'user-1' },
      }),
    );
    const issueDto: BotSigninIssueDto = { telegramId: '123456789' };
    const consumeDto: BotSigninConsumeDto = { token: 'a'.repeat(64) };

    assert.deepStrictEqual(await controller.issueBotSigninToken(issueDto), issueResult);
    assert.deepStrictEqual(await controller.consumeBotSigninToken(consumeDto), { userId: 'user-1' });
    assert.deepStrictEqual(calls, [
      { method: 'issue', payload: issueDto.telegramId },
      { method: 'consume', payload: consumeDto.token },
    ]);
  });

  it('returns a null userId when bot-signin consume misses', async () => {
    const controller = new InternalWebAuthController(
      createWebAuthServiceMock([]),
      createBotSigninTokenServiceMock([], { consumeResult: null }),
    );

    assert.deepStrictEqual(
      await controller.consumeBotSigninToken({ token: 'b'.repeat(64) }),
      { userId: null },
    );
  });
});

/** One web-auth endpoint as this spec states it. No RBAC gate exists to state. */
interface WebAuthRoute {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  readonly path: string;
}

/** The routes themselves, so a row names a handler the compiler has to find. */
const handlers = InternalWebAuthController.prototype;

const WEB_AUTH_ROUTES: readonly WebAuthRoute[] = [
  { handler: handlers.register, method: RequestMethod.POST, path: 'register' },
  { handler: handlers.claim, method: RequestMethod.POST, path: 'claim' },
  { handler: handlers.telegramClaim, method: RequestMethod.POST, path: 'telegram-claim' },
  { handler: handlers.checkLogin, method: RequestMethod.POST, path: 'check-login' },
  { handler: handlers.login, method: RequestMethod.POST, path: 'login' },
  { handler: handlers.recover, method: RequestMethod.POST, path: 'recover' },
  { handler: handlers.changePassword, method: RequestMethod.POST, path: 'change-password' },
  { handler: handlers.issueBotSigninToken, method: RequestMethod.POST, path: 'bot-signin/issue' },
  { handler: handlers.consumeBotSigninToken, method: RequestMethod.POST, path: 'bot-signin/consume' },
];

function createWebAuthServiceMock(
  calls: Array<{ method: string; payload: unknown }>,
): WebAuthService {
  return {
    register: async (payload: WebAuthRegisterDto) => {
      calls.push({ method: 'register', payload });
      return { userId: 'user-1', webAccountId: 'web-account-1' };
    },
    checkLoginAvailable: async (payload: string) => {
      calls.push({ method: 'checkLoginAvailable', payload });
      return { available: true };
    },
    login: async (payload: WebAuthLoginDto) => {
      calls.push({ method: 'login', payload });
      return {
        userId: 'user-1',
        requiresPasswordChange: false,
        telegramLinked: true,
        emailVerified: true,
      };
    },
    recover: async (payload: WebAuthRecoverDto) => {
      calls.push({ method: 'recover', payload });
      return { method: 'telegram' };
    },
    changePassword: async (payload: WebAuthChangePasswordDto) => {
      calls.push({ method: 'changePassword', payload });
      return { success: true };
    },
  } as WebAuthService;
}

function createBotSigninTokenServiceMock(
  calls: Array<{ method: string; payload: unknown }> = [],
  options: {
    readonly issueResult?: { readonly token: string; readonly expiresAt: string } | null;
    readonly consumeResult?: { readonly userId: string } | null;
  } = {},
): BotSigninTokenService {
  const { issueResult = { token: 'a'.repeat(64), expiresAt: '2026-06-02T12:00:00.000Z' }, consumeResult = null } = options;
  return {
    issue: async (payload: string) => {
      calls.push({ method: 'issue', payload });
      return issueResult;
    },
    consume: async (payload: string) => {
      calls.push({ method: 'consume', payload });
      return consumeResult;
    },
  } as BotSigninTokenService;
}
