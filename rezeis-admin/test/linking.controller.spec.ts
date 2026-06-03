import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalLinkingController } from '../src/modules/linking/controllers/internal-linking.controller';
import { LinkingService } from '../src/modules/linking/services/linking.service';

describe('InternalLinkingController', () => {
  it('exposes the current internal linking route contract', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, InternalLinkingController) as
      | string
      | undefined;
    const guards = Reflect.getMetadata(GUARDS_METADATA, InternalLinkingController) as
      | readonly unknown[]
      | undefined;

    assert.equal(controllerPath, 'internal/link');
    assert.deepStrictEqual(guards, [InternalAdminAuthGuard]);
    assert.deepStrictEqual(route('telegramGenerate'), {
      path: 'telegram/generate',
      method: RequestMethod.POST,
    });
    assert.deepStrictEqual(route('telegramConsume'), {
      path: 'telegram/consume',
      method: RequestMethod.POST,
    });
    assert.deepStrictEqual(route('emailInitiate'), {
      path: 'email/initiate',
      method: RequestMethod.POST,
    });
    assert.deepStrictEqual(route('emailVerify'), {
      path: 'email/verify',
      method: RequestMethod.POST,
    });
  });

  it('delegates all current link endpoints to LinkingService unchanged', async () => {
    const calls: Array<{ readonly method: string; readonly body: unknown }> = [];
    const service = {
      telegramGenerate: async (body: unknown): Promise<unknown> => {
        calls.push({ method: 'telegramGenerate', body });
        return { code: '123456', expiresAt: '2026-06-03T10:10:00.000Z' };
      },
      telegramConsume: async (body: unknown): Promise<unknown> => {
        calls.push({ method: 'telegramConsume', body });
        return { success: true, userId: 'user-1' };
      },
      emailInitiate: async (body: unknown): Promise<unknown> => {
        calls.push({ method: 'emailInitiate', body });
        return { success: true, message: 'Verification code sent' };
      },
      emailVerify: async (body: unknown): Promise<unknown> => {
        calls.push({ method: 'emailVerify', body });
        return { success: true, verified: true };
      },
    } as LinkingService;
    const controller = new InternalLinkingController(service);

    const telegramGenerateBody = { userId: 'user-1' };
    const telegramConsumeBody = { code: '123456', telegramId: '777000' };
    const emailInitiateBody = { userId: 'user-1', email: 'user@example.com' };
    const emailVerifyBody = { userId: 'user-1', code: '123456' };

    assert.deepStrictEqual(await controller.telegramGenerate(telegramGenerateBody), {
      code: '123456',
      expiresAt: '2026-06-03T10:10:00.000Z',
    });
    assert.deepStrictEqual(await controller.telegramConsume(telegramConsumeBody), {
      success: true,
      userId: 'user-1',
    });
    assert.deepStrictEqual(await controller.emailInitiate(emailInitiateBody), {
      success: true,
      message: 'Verification code sent',
    });
    assert.deepStrictEqual(await controller.emailVerify(emailVerifyBody), {
      success: true,
      verified: true,
    });
    assert.deepStrictEqual(calls, [
      { method: 'telegramGenerate', body: telegramGenerateBody },
      { method: 'telegramConsume', body: telegramConsumeBody },
      { method: 'emailInitiate', body: emailInitiateBody },
      { method: 'emailVerify', body: emailVerifyBody },
    ]);
  });
});

function route(methodName: keyof InternalLinkingController): {
  readonly path: string | undefined;
  readonly method: RequestMethod | undefined;
} {
  const handler = InternalLinkingController.prototype[methodName] as unknown;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as string | undefined,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined,
  };
}
