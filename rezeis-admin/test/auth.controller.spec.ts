import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpStatus, RequestMethod, UnauthorizedException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Request } from 'express';
import { UserRole } from '@prisma/client';

import { AdminAuthController } from '../src/modules/auth/controllers/admin-auth.controller';
import { ChangeAdminPasswordDto } from '../src/modules/auth/dto/change-password.dto';
import { PublicLoginAdminDto } from '../src/modules/auth/dto/public-login-admin.dto';
import { RegisterAdminDto } from '../src/modules/auth/dto/register-admin.dto';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

interface LoginAdminCall {
  readonly login: string;
  readonly password: string;
  readonly totpCode?: string | null;
  readonly requestMetadata: {
    readonly requestId: string | null;
    readonly remoteAddress: string | null;
    readonly userAgent: string | null;
  };
}

interface BootstrapFirstAdminCall {
  readonly login: string;
  readonly email?: string;
  readonly password: string;
  readonly name?: string;
  readonly requestMetadata: {
    readonly requestId: string | null;
    readonly remoteAddress: string | null;
    readonly userAgent: string | null;
  };
}

interface ChangePasswordCall {
  readonly adminId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
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
    rbacRoleId: null,
    mustChangePassword: false,
  };
}

function buildRequest(): Request {
  return {
    headers: {
      'x-request-id': 'request-1',
      'x-forwarded-for': '198.51.100.25, 203.0.113.10',
      'user-agent': 'controller-spec',
    },
    ip: '127.0.0.1',
    socket: {
      remoteAddress: '127.0.0.2',
    },
  } as unknown as Request;
}

describe('AdminAuthController', () => {
  it('exposes the current public auth route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, AdminAuthController) as string | undefined;
    const actualStatusPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminAuthController.prototype.getStatus,
    ) as string | undefined;
    const actualStatusMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminAuthController.prototype.getStatus,
    ) as RequestMethod | undefined;
    const actualRegisterPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminAuthController.prototype.register,
    ) as string | undefined;
    const actualRegisterMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminAuthController.prototype.register,
    ) as RequestMethod | undefined;
    const actualRegisterHttpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AdminAuthController.prototype.register,
    ) as number | undefined;
    const actualLoginPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminAuthController.prototype.login,
    ) as string | undefined;
    const actualLoginMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminAuthController.prototype.login,
    ) as RequestMethod | undefined;
    const actualLoginHttpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AdminAuthController.prototype.login,
    ) as number | undefined;
    const actualGetMePath = Reflect.getMetadata(
      PATH_METADATA,
      AdminAuthController.prototype.getMe,
    ) as string | undefined;
    const actualGetMeMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminAuthController.prototype.getMe,
    ) as RequestMethod | undefined;
    const actualGetMeGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminAuthController.prototype.getMe,
    ) as readonly unknown[] | undefined;
    const actualPasswordPath = Reflect.getMetadata(
      PATH_METADATA,
      AdminAuthController.prototype.changePassword,
    ) as string | undefined;
    const actualPasswordMethod = Reflect.getMetadata(
      METHOD_METADATA,
      AdminAuthController.prototype.changePassword,
    ) as RequestMethod | undefined;
    const actualPasswordHttpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AdminAuthController.prototype.changePassword,
    ) as number | undefined;
    const actualPasswordGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminAuthController.prototype.changePassword,
    ) as readonly unknown[] | undefined;
    assert.equal(actualControllerPath, 'admin/auth');
    assert.equal(actualStatusPath, 'status');
    assert.equal(actualStatusMethod, RequestMethod.GET);
    assert.equal(actualRegisterPath, 'register');
    assert.equal(actualRegisterMethod, RequestMethod.POST);
    assert.equal(actualRegisterHttpCode, HttpStatus.OK);
    assert.equal(actualLoginPath, 'login');
    assert.equal(actualLoginMethod, RequestMethod.POST);
    assert.equal(actualLoginHttpCode, HttpStatus.OK);
    assert.equal(actualGetMePath, 'me');
    assert.equal(actualGetMeMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualGetMeGuards, [AdminJwtAuthGuard]);
    assert.equal(actualPasswordPath, 'password');
    assert.equal(actualPasswordMethod, RequestMethod.POST);
    assert.equal(actualPasswordHttpCode, HttpStatus.OK);
    assert.deepStrictEqual(actualPasswordGuards, [AdminJwtAuthGuard]);
  });

  it('reports bootstrap status and configured locales', async () => {
    const prismaService = {
      adminUser: {
        count: async (): Promise<number> => 1,
      },
    } as PrismaService;
    const controller = new AdminAuthController(
      {} as AdminAuthService,
      prismaService,
      { locales: ['ru', 'en'], defaultLocale: 'ru' } as never,
    );
    assert.deepStrictEqual(await controller.getStatus(), {
      hasAdmins: true,
      locales: ['ru', 'en'],
      defaultLocale: 'ru',
    });
  });

  it('bootstraps the first admin, then logs in with the same public registration credentials', async () => {
    const bootstrapCalls: BootstrapFirstAdminCall[] = [];
    const loginCalls: LoginAdminCall[] = [];
    const expectedResponse = {
      accessToken: 'signed-token',
      tokenType: 'Bearer' as const,
      expiresIn: '12h',
      admin: buildCurrentAdmin(),
    };
    const adminAuthService = {
      bootstrapFirstAdmin: async (input: BootstrapFirstAdminCall): Promise<CurrentAdminInterface> => {
        bootstrapCalls.push(input);
        return buildCurrentAdmin();
      },
      loginAdmin: async (input: LoginAdminCall): Promise<typeof expectedResponse> => {
        loginCalls.push(input);
        return expectedResponse;
      },
    } as AdminAuthService;
    const controller = new AdminAuthController(
      adminAuthService,
      {} as PrismaService,
      { locales: ['ru'], defaultLocale: 'ru' } as never,
    );
    const dto: RegisterAdminDto = {
      username: 'dev-admin',
      email: 'dev@example.com',
      password: 'strong-password',
      name: 'DEV Admin',
    };
    const actualResponse = await controller.register(dto, buildRequest());
    const expectedRequestMetadata = {
      requestId: 'request-1',
      remoteAddress: '198.51.100.25',
      userAgent: 'controller-spec',
    };
    assert.deepStrictEqual(bootstrapCalls, [
      {
        login: 'dev-admin',
        email: 'dev@example.com',
        password: 'strong-password',
        name: 'DEV Admin',
        requestMetadata: expectedRequestMetadata,
      },
    ]);
    assert.deepStrictEqual(loginCalls, [
      {
        login: 'dev-admin',
        password: 'strong-password',
        requestMetadata: expectedRequestMetadata,
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
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
    const controller = new AdminAuthController(
      adminAuthService,
      {} as PrismaService,
      { locales: ['ru'], defaultLocale: 'ru' } as never,
    );
    const request = buildRequest();
    const dto: PublicLoginAdminDto = {
      username: 'admin',
      password: 'correct-password',
      totpCode: '123456',
    };
    const actualResponse = await controller.login(
      dto,
      request,
    );
    assert.deepStrictEqual(loginCalls, [
      {
        login: 'admin',
        password: 'correct-password',
        totpCode: '123456',
        requestMetadata: {
          requestId: 'request-1',
          remoteAddress: '198.51.100.25',
          userAgent: 'controller-spec',
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('maps the service totp_required signal to the public two-factor response contract', async () => {
    const adminAuthService = {
      loginAdmin: async (): Promise<never> => {
        throw new UnauthorizedException('totp_required');
      },
    } as unknown as AdminAuthService;
    const controller = new AdminAuthController(
      adminAuthService,
      {} as PrismaService,
      { locales: ['ru'], defaultLocale: 'ru' } as never,
    );
    await assert.rejects(
      async (): Promise<void> => {
        await controller.login(
          { username: 'admin', password: 'correct-password' },
          buildRequest(),
        );
      },
      (error: unknown): boolean => {
        assert.equal(error instanceof UnauthorizedException, true);
        assert.deepStrictEqual((error as UnauthorizedException).getResponse(), {
          statusCode: 401,
          code: 'totp_required',
          message: 'Two-factor authentication required',
        });
        return true;
      },
    );
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
    const controller = new AdminAuthController(
      adminAuthService,
      {} as PrismaService,
      { locales: ['ru'], defaultLocale: 'ru' } as never,
    );
    const actualResponse = controller.getMe(expectedAdmin);
    assert.deepStrictEqual(getMeCalls, [{ currentAdmin: expectedAdmin }]);
    assert.deepStrictEqual(actualResponse, { admin: expectedAdmin });
  });

  it('forwards password changes with the authenticated admin id and request metadata', async () => {
    const changePasswordCalls: ChangePasswordCall[] = [];
    const expectedAdmin = buildCurrentAdmin();
    const expectedResponse = {
      accessToken: 'rotated-token',
      tokenType: 'Bearer' as const,
      expiresIn: '12h',
      admin: expectedAdmin,
    };
    const adminAuthService = {
      changePassword: async (input: ChangePasswordCall): Promise<typeof expectedResponse> => {
        changePasswordCalls.push(input);
        return expectedResponse;
      },
    } as AdminAuthService;
    const controller = new AdminAuthController(
      adminAuthService,
      {} as PrismaService,
      { locales: ['ru'], defaultLocale: 'ru' } as never,
    );
    const dto: ChangeAdminPasswordDto = {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    };
    const actualResponse = await controller.changePassword(expectedAdmin, dto, buildRequest());
    assert.deepStrictEqual(changePasswordCalls, [
      {
        adminId: 'admin-1',
        currentPassword: 'old-password',
        newPassword: 'new-password',
        requestMetadata: {
          requestId: 'request-1',
          remoteAddress: '198.51.100.25',
          userAgent: 'controller-spec',
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });
});
