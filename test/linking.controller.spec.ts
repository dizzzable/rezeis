import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalApiGuard } from '../src/common/guards/internal-api.guard';
import { LinkingController } from '../src/modules/linking/linking.controller';
import { LinkingService } from '../src/modules/linking/linking.service';

describe('LinkingController', () => {
  it('is mounted at internal/link path', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, LinkingController) as string | undefined;
    assert.equal(controllerPath, 'internal/link');
  });

  it('uses InternalApiGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LinkingController) as readonly unknown[] | undefined;
    assert.ok(guards, 'Expected guards metadata to be defined');
    assert.ok(guards.includes(InternalApiGuard), 'Expected InternalApiGuard to be applied');
  });

  it('generateCode endpoint is POST at "telegram/generate" path', () => {
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.generateCode,
    ) as string | undefined;
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.generateCode,
    ) as RequestMethod | undefined;
    assert.equal(path, 'telegram/generate');
    assert.equal(method, RequestMethod.POST);
  });

  it('verifyTelegram endpoint is POST at "telegram/verify" path', () => {
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.verifyTelegram,
    ) as string | undefined;
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.verifyTelegram,
    ) as RequestMethod | undefined;
    assert.equal(path, 'telegram/verify');
    assert.equal(method, RequestMethod.POST);
  });

  it('delegates generateCode to LinkingService and returns the result', async () => {
    const calls: Array<{ userId: string }> = [];
    const expectedResult = { code: 'AbCd1234', expiresAt: '2025-01-01T00:10:00.000Z' };

    const mockService = {
      generateLinkingCode: async (dto: { userId: string }) => {
        calls.push(dto);
        return expectedResult;
      },
    } as unknown as LinkingService;

    const controller = new LinkingController(mockService);
    const dto = { userId: '550e8400-e29b-41d4-a716-446655440000' };

    const result = await controller.generateCode(dto);

    assert.deepStrictEqual(calls, [dto]);
    assert.deepStrictEqual(result, expectedResult);
  });

  it('delegates verifyTelegram to LinkingService and returns the result', async () => {
    const calls: Array<{ code: string; telegramId: number; telegramUsername?: string }> = [];
    const expectedResult = {
      success: true,
      message: 'Telegram account linked successfully.',
      telegramId: 123456789,
      telegramUsername: 'testuser',
    };

    const mockService = {
      verifyTelegramCode: async (dto: { code: string; telegramId: number; telegramUsername?: string }) => {
        calls.push(dto);
        return expectedResult;
      },
    } as unknown as LinkingService;

    const controller = new LinkingController(mockService);
    const dto = { code: 'AbCd1234', telegramId: 123456789, telegramUsername: 'testuser' };

    const result = await controller.verifyTelegram(dto);

    assert.deepStrictEqual(calls, [dto]);
    assert.deepStrictEqual(result, expectedResult);
  });
});
