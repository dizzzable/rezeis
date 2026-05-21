import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';

import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { RequestWebAccountPasswordRecoveryDto } from '../src/modules/internal-user/dto/request-web-account-password-recovery.dto';
import { ResetWebAccountPasswordByLinkDto } from '../src/modules/internal-user/dto/reset-web-account-password-by-link.dto';
import { ResetWebAccountPasswordByTelegramCodeDto } from '../src/modules/internal-user/dto/reset-web-account-password-by-telegram-code.dto';
import { InternalUserActionMessageInterface } from '../src/modules/internal-user/interfaces/internal-user-action-message.interface';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

describe('internal user password recovery controller contract', () => {
  it('exposes the password recovery route contract through InternalUserController', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.requestWebAccountPasswordRecovery,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.requestWebAccountPasswordRecovery,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'requestWebAccountPasswordRecovery',
    ) as readonly unknown[] | undefined;
    const actualRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'requestWebAccountPasswordRecovery',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};

    assert.equal(actualPath, 'web-account/password-recovery');
    assert.equal(actualMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualParameterTypes, [RequestWebAccountPasswordRecoveryDto]);
    assert.deepStrictEqual(actualRouteArgs[`${RouteParamtypes.BODY}:0`], {
      index: 0,
      data: undefined,
      pipes: [],
    });
  });

  it('exposes the Telegram password recovery route contract through InternalUserController', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.requestWebAccountPasswordRecoveryTelegram,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.requestWebAccountPasswordRecoveryTelegram,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'requestWebAccountPasswordRecoveryTelegram',
    ) as readonly unknown[] | undefined;
    const actualRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'requestWebAccountPasswordRecoveryTelegram',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};

    assert.equal(actualPath, 'web-account/password-recovery/telegram');
    assert.equal(actualMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualParameterTypes, [RequestWebAccountPasswordRecoveryDto]);
    assert.deepStrictEqual(actualRouteArgs[`${RouteParamtypes.BODY}:0`], {
      index: 0,
      data: undefined,
      pipes: [],
    });
  });

  it('exposes the password reset-by-link route contract through InternalUserController', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.resetWebAccountPasswordByLink,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.resetWebAccountPasswordByLink,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'resetWebAccountPasswordByLink',
    ) as readonly unknown[] | undefined;
    const actualRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'resetWebAccountPasswordByLink',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};

    assert.equal(actualPath, 'web-account/password-reset-by-link');
    assert.equal(actualMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualParameterTypes, [ResetWebAccountPasswordByLinkDto]);
    assert.deepStrictEqual(actualRouteArgs[`${RouteParamtypes.BODY}:0`], {
      index: 0,
      data: undefined,
      pipes: [],
    });
  });

  it('exposes the password reset-by-telegram-code route contract through InternalUserController', () => {
    const actualPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalUserController.prototype.resetWebAccountPasswordByTelegramCode,
    ) as string | undefined;
    const actualMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalUserController.prototype.resetWebAccountPasswordByTelegramCode,
    ) as RequestMethod | undefined;
    const actualParameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      InternalUserController.prototype,
      'resetWebAccountPasswordByTelegramCode',
    ) as readonly unknown[] | undefined;
    const actualRouteArgs = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      InternalUserController,
      'resetWebAccountPasswordByTelegramCode',
    ) as Record<string, { readonly index: number; readonly data: unknown; readonly pipes: readonly unknown[] }> | undefined) ?? {};

    assert.equal(actualPath, 'web-account/password-reset-by-telegram-code');
    assert.equal(actualMethod, RequestMethod.POST);
    assert.deepStrictEqual(actualParameterTypes, [ResetWebAccountPasswordByTelegramCodeDto]);
    assert.deepStrictEqual(actualRouteArgs[`${RouteParamtypes.BODY}:0`], {
      index: 0,
      data: undefined,
      pipes: [],
    });
  });

  it('delegates password recovery requests unchanged', async () => {
    const passwordRecoveryCalls: RequestWebAccountPasswordRecoveryDto[] = [];
    const input = { email: 'user@example.com' } as RequestWebAccountPasswordRecoveryDto;
    const expectedResponse: InternalUserActionMessageInterface = {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    };
    const internalUserService = {
      requestWebAccountPasswordRecovery: async (
        value: RequestWebAccountPasswordRecoveryDto,
      ): Promise<InternalUserActionMessageInterface> => {
        passwordRecoveryCalls.push(value);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);

    const actualResponse = await controller.requestWebAccountPasswordRecovery(input);

    assert.deepStrictEqual(passwordRecoveryCalls, [input]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates Telegram password recovery requests unchanged', async () => {
    const passwordRecoveryCalls: RequestWebAccountPasswordRecoveryDto[] = [];
    const input = { email: 'user@example.com' } as RequestWebAccountPasswordRecoveryDto;
    const expectedResponse: InternalUserActionMessageInterface = {
      message: 'If the account is eligible, a password reset link will be sent shortly.',
    };
    const internalUserService = {
      requestWebAccountPasswordRecoveryTelegram: async (
        value: RequestWebAccountPasswordRecoveryDto,
      ): Promise<InternalUserActionMessageInterface> => {
        passwordRecoveryCalls.push(value);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);

    const actualResponse = await controller.requestWebAccountPasswordRecoveryTelegram(input);

    assert.deepStrictEqual(passwordRecoveryCalls, [input]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates password reset-by-link requests unchanged', async () => {
    const passwordResetCalls: ResetWebAccountPasswordByLinkDto[] = [];
    const input = {
      token: 'token-123',
      password: 'new-password-123',
    } as ResetWebAccountPasswordByLinkDto;
    const expectedResponse: InternalUserActionMessageInterface = {
      message: 'Password has been reset successfully.',
    };
    const internalUserService = {
      resetWebAccountPasswordByLink: async (
        value: ResetWebAccountPasswordByLinkDto,
      ): Promise<InternalUserActionMessageInterface> => {
        passwordResetCalls.push(value);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);

    const actualResponse = await controller.resetWebAccountPasswordByLink(input);

    assert.deepStrictEqual(passwordResetCalls, [input]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates password reset-by-telegram-code requests unchanged', async () => {
    const passwordResetCalls: ResetWebAccountPasswordByTelegramCodeDto[] = [];
    const input = {
      email: 'user@example.com',
      code: '123456',
      password: 'new-password-123',
    } as ResetWebAccountPasswordByTelegramCodeDto;
    const expectedResponse: InternalUserActionMessageInterface = {
      message: 'Password has been reset successfully.',
    };
    const internalUserService = {
      resetWebAccountPasswordByTelegramCode: async (
        value: ResetWebAccountPasswordByTelegramCodeDto,
      ): Promise<InternalUserActionMessageInterface> => {
        passwordResetCalls.push(value);
        return expectedResponse;
      },
    } as InternalUserService;
    const controller = new InternalUserController(internalUserService);

    const actualResponse = await controller.resetWebAccountPasswordByTelegramCode(input);

    assert.deepStrictEqual(passwordResetCalls, [input]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });
});
