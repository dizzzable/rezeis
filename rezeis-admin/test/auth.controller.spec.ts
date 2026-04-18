import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Request } from 'express';
import { UserRole } from '@prisma/client';

import { AuthController } from '../src/modules/auth/auth.controller';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';

interface LoginAdminCall {
  readonly login: string;
  readonly password: string;
  readonly requestMetadata: {
    readonly requestId: string | null;
    readonly remoteAddress: string | null;
    readonly userAgent: string | null;
  };
}

interface GetMeCall {
  readonly currentAdmin: CurrentAdminInterface;
}

function buildCurrentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 3,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-04-15T12:00:00.000Z'),
    lastLoginIp: '203.0.113.10',
  };
}

describe('AuthController', () => {
  it('exposes the shipped public auth route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, AuthController) as string | undefined;
    const actualLoginPath = Reflect.getMetadata(
      PATH_METADATA,
      AuthController.prototype.login,
    ) as string | undefined;
    const actualLoginMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AuthController.prototype.login,
    ) as RequestMethod | undefined;
    const actualLoginHttpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AuthController.prototype.login,
    ) as number | undefined;
    const actualGetMePath = Reflect.getMetadata(
      PATH_METADATA,
      AuthController.prototype.getMe,
    ) as string | undefined;
    const actualGetMeMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AuthController.prototype.getMe,
    ) as RequestMethod | undefined;
    const actualGetMeGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      AuthController.prototype.getMe,
    ) as readonly unknown[] | undefined;
    assert.equal(actualControllerPath, 'auth');
    assert.equal(actualLoginPath, 'login');
    assert.equal(actualLoginMethod, RequestMethod.POST);
    assert.equal(actualLoginHttpCode, HttpStatus.OK);
    assert.equal(actualGetMePath, 'me');
    assert.equal(actualGetMeMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualGetMeGuards, [AdminJwtAuthGuard]);
  });

  it('forwards login input and extracted request metadata to the auth service', async () => {
    const loginCalls: LoginAdminCall[] = [];
    const expectedResponse = {
      accessToken: 'signed-token',
      tokenType: 'Bearer' as const,
      expiresIn: '12h',
        admin: buildCurrentAdmin(),
    };
    const adminAuthService = {
      loginAdmin: async (input: LoginAdminCall): Promise<typeof expectedResponse> => {
        loginCalls.push(input);
        return expectedResponse;
      },
      getMe: (currentAdmin: CurrentAdminInterface): CurrentAdminInterface => currentAdmin,
    } as AdminAuthService;
    const controller = new AuthController(adminAuthService);
    const request = {
      headers: {
        'x-request-id': 'request-1',
        'x-forwarded-for': '198.51.100.25, 203.0.113.10',
        'user-agent': 'controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as Request;
    const actualResponse = await controller.login(
      {
        login: 'admin',
        password: 'correct-password',
      },
      request,
    );
    assert.deepStrictEqual(loginCalls, [
      {
        login: 'admin',
        password: 'correct-password',
        requestMetadata: {
          requestId: 'request-1',
          remoteAddress: '198.51.100.25',
          userAgent: 'controller-spec',
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('delegates getMe to the auth service and returns the delegated profile unchanged', () => {
    const getMeCalls: GetMeCall[] = [];
    const expectedAdmin = buildCurrentAdmin();
    const adminAuthService = {
      getMe: (currentAdmin: CurrentAdminInterface): CurrentAdminInterface => {
        getMeCalls.push({ currentAdmin });
        return currentAdmin;
      },
    } as AdminAuthService;
    const controller = new AuthController(adminAuthService);
    const actualResponse = controller.getMe(expectedAdmin);
    assert.deepStrictEqual(getMeCalls, [{ currentAdmin: expectedAdmin }]);
    assert.deepStrictEqual(actualResponse, { admin: expectedAdmin });
  });
});
