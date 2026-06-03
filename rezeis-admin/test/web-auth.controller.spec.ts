import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

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

describe('InternalWebAuthController', () => {
  it('exposes the current internal web-auth route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalWebAuthController), 'internal/web-auth');
    assertPostRoute('register', InternalWebAuthController.prototype.register);
    assertPostRoute('check-login', InternalWebAuthController.prototype.checkLogin);
    assertPostRoute('login', InternalWebAuthController.prototype.login);
    assertPostRoute('recover', InternalWebAuthController.prototype.recover);
    assertPostRoute('change-password', InternalWebAuthController.prototype.changePassword);
    assertPostRoute('bot-signin/issue', InternalWebAuthController.prototype.issueBotSigninToken);
    assertPostRoute('bot-signin/consume', InternalWebAuthController.prototype.consumeBotSigninToken);
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

function assertPostRoute(expectedPath: string, handler: unknown): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), expectedPath);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
}

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
