import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalApiGuard } from '../src/common/guards/internal-api.guard';
import { WebAuthController } from '../src/modules/web-auth/web-auth.controller';
import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

describe('WebAuthController', () => {
  it('is mounted at internal/web-auth path', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, WebAuthController) as string | undefined;
    assert.equal(controllerPath, 'internal/web-auth');
  });

  it('register endpoint is POST at "register" path', () => {
    const registerPath = Reflect.getMetadata(
      PATH_METADATA,
      WebAuthController.prototype.register,
    ) as string | undefined;
    const registerMethod = Reflect.getMetadata(
      METHOD_METADATA,
      WebAuthController.prototype.register,
    ) as RequestMethod | undefined;
    assert.equal(registerPath, 'register');
    assert.equal(registerMethod, RequestMethod.POST);
  });

  it('login endpoint is POST at "login" path', () => {
    const loginPath = Reflect.getMetadata(
      PATH_METADATA,
      WebAuthController.prototype.login,
    ) as string | undefined;
    const loginMethod = Reflect.getMetadata(
      METHOD_METADATA,
      WebAuthController.prototype.login,
    ) as RequestMethod | undefined;
    assert.equal(loginPath, 'login');
    assert.equal(loginMethod, RequestMethod.POST);
  });

  it('uses InternalApiGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WebAuthController) as readonly unknown[] | undefined;
    assert.ok(guards, 'Expected guards metadata to be defined');
    assert.ok(guards.includes(InternalApiGuard), 'Expected InternalApiGuard to be applied');
  });

  it('delegates registration to WebAuthService and returns the result', async () => {
    const registerCalls: Array<{ username: string; passwordHash: string }> = [];
    const expectedResult = { userId: 'uuid-1', webAccountId: 'uuid-2' };

    const mockService = {
      register: async (dto: { username: string; passwordHash: string }) => {
        registerCalls.push(dto);
        return expectedResult;
      },
    } as unknown as WebAuthService;

    const controller = new WebAuthController(mockService);
    const dto = {
      username: 'test-user',
      passwordHash: 'a'.repeat(64),
    };

    const result = await controller.register(dto);

    assert.deepStrictEqual(registerCalls, [dto]);
    assert.deepStrictEqual(result, expectedResult);
  });

  it('delegates login to WebAuthService with client IP from x-forwarded-for', async () => {
    const loginCalls: Array<{ dto: any; ip: string }> = [];
    const expectedResult = {
      userId: 'uuid-1',
      requiresPasswordChange: false,
      telegramLinked: true,
      emailVerified: false,
    };

    const mockService = {
      login: async (dto: any, ip: string) => {
        loginCalls.push({ dto, ip });
        return expectedResult;
      },
    } as unknown as WebAuthService;

    const controller = new WebAuthController(mockService);
    const dto = { username: 'test-user', passwordHash: 'a'.repeat(64) };
    const mockReq = {
      headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' },
      ip: '127.0.0.1',
    } as any;

    const result = await controller.login(dto, mockReq);

    assert.deepStrictEqual(loginCalls, [{ dto, ip: '203.0.113.50' }]);
    assert.deepStrictEqual(result, expectedResult);
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    const loginCalls: Array<{ dto: any; ip: string }> = [];

    const mockService = {
      login: async (dto: any, ip: string) => {
        loginCalls.push({ dto, ip });
        return { userId: 'uuid-1', requiresPasswordChange: false, telegramLinked: false, emailVerified: false };
      },
    } as unknown as WebAuthService;

    const controller = new WebAuthController(mockService);
    const dto = { username: 'test-user', passwordHash: 'b'.repeat(64) };
    const mockReq = {
      headers: { 'x-real-ip': '10.20.30.40' },
      ip: '192.168.1.100',
    } as any;

    await controller.login(dto, mockReq);

    assert.equal(loginCalls[0].ip, '10.20.30.40');
  });

  it('falls back to req.ip when both x-forwarded-for and x-real-ip are absent', async () => {
    const loginCalls: Array<{ dto: any; ip: string }> = [];

    const mockService = {
      login: async (dto: any, ip: string) => {
        loginCalls.push({ dto, ip });
        return { userId: 'uuid-1', requiresPasswordChange: false, telegramLinked: false, emailVerified: false };
      },
    } as unknown as WebAuthService;

    const controller = new WebAuthController(mockService);
    const dto = { username: 'test-user', passwordHash: 'b'.repeat(64) };
    const mockReq = {
      headers: {},
      ip: '192.168.1.100',
    } as any;

    await controller.login(dto, mockReq);

    assert.equal(loginCalls[0].ip, '192.168.1.100');
  });
});
