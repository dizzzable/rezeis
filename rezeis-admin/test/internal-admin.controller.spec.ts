import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { InternalAdminController } from '../src/modules/auth/controllers/internal-admin.controller';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { InternalAdminRequest } from '../src/modules/auth/interfaces/internal-admin-request.interface';
import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { InternalAdminService } from '../src/modules/auth/services/internal-admin.service';
import { BootstrapAdminDto } from '../src/modules/auth/dto/bootstrap-admin.dto';

interface BootstrapFirstAdminCall {
  readonly login: string;
  readonly email?: string;
  readonly password: string;
  readonly name?: string;
  readonly requestMetadata: InternalAdminRequest;
}

interface InternalAdminTestResponse {
  readonly status: string;
  readonly service: string;
  readonly auth: {
    readonly type: string;
    readonly isAuthorized: boolean;
  };
  readonly request: InternalAdminRequest;
  readonly timestamp: string;
}

function buildCurrentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'dev-admin',
    email: 'dev@example.com',
    name: 'DEV Admin',
    role: UserRole.DEV,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
  };
}

function buildInternalRequest(): InternalAdminRequest {
  return {
    requestId: 'internal-request-1',
    remoteAddress: '198.51.100.80',
    userAgent: 'internal-admin-controller-spec',
  };
}

describe('InternalAdminController', () => {
  it('exposes the shipped internal admin route contract', () => {
    const actualControllerPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalAdminController,
    ) as string | undefined;
    const actualGetTestPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalAdminController.prototype.getTest,
    ) as string | undefined;
    const actualGetTestMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalAdminController.prototype.getTest,
    ) as RequestMethod | undefined;
    const actualBootstrapAdminPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalAdminController.prototype.bootstrapAdmin,
    ) as string | undefined;
    const actualBootstrapAdminMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalAdminController.prototype.bootstrapAdmin,
    ) as RequestMethod | undefined;
    assert.equal(actualControllerPath, 'internal');
    assert.equal(actualGetTestPath, 'test');
    assert.equal(actualGetTestMethod, RequestMethod.GET);
    assert.equal(actualBootstrapAdminPath, 'bootstrap-admin');
    assert.equal(actualBootstrapAdminMethod, RequestMethod.POST);
  });

  it('delegates getTest with the internal request object and returns the service response unchanged', () => {
    const getTestCalls: InternalAdminRequest[] = [];
    const request: InternalAdminRequest = buildInternalRequest();
    const expectedResponse: InternalAdminTestResponse = {
      status: 'ok',
      service: 'rezeis-admin',
      auth: {
        type: 'internal-api-key',
        isAuthorized: true,
      },
      request,
      timestamp: '2026-04-16T10:00:00.000Z',
    };
    const internalAdminService = {
      getTestResponse: (input: InternalAdminRequest): InternalAdminTestResponse => {
        getTestCalls.push(input);
        return expectedResponse;
      },
    } as InternalAdminService;
    const controller = new InternalAdminController({} as AdminAuthService, internalAdminService);
    const actualResponse = controller.getTest(request);
    assert.deepStrictEqual(getTestCalls, [request]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('forwards bootstrap input and internal request metadata, then returns the admin payload wrapper', async () => {
    const bootstrapFirstAdminCalls: BootstrapFirstAdminCall[] = [];
    const expectedAdmin: CurrentAdminInterface = buildCurrentAdmin();
    const adminAuthService = {
      bootstrapFirstAdmin: async (
        input: BootstrapFirstAdminCall,
      ): Promise<CurrentAdminInterface> => {
        bootstrapFirstAdminCalls.push(input);
        return expectedAdmin;
      },
    } as AdminAuthService;
    const controller = new InternalAdminController(adminAuthService, {} as InternalAdminService);
    const bootstrapAdminDto: BootstrapAdminDto = {
      login: 'dev-admin',
      email: 'dev@example.com',
      password: 'strong-password',
      name: 'DEV Admin',
    };
    const request: InternalAdminRequest = buildInternalRequest();
    const actualResponse = await controller.bootstrapAdmin(bootstrapAdminDto, request);
    assert.deepStrictEqual(bootstrapFirstAdminCalls, [
      {
        login: 'dev-admin',
        email: 'dev@example.com',
        password: 'strong-password',
        name: 'DEV Admin',
        requestMetadata: request,
      },
    ]);
    assert.deepStrictEqual(actualResponse, { admin: expectedAdmin });
  });

  it('requires the internal admin guard on the protected methods', () => {
    const actualGetTestGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      InternalAdminController.prototype.getTest,
    ) as readonly unknown[] | undefined;
    const actualBootstrapAdminGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      InternalAdminController.prototype.bootstrapAdmin,
    ) as readonly unknown[] | undefined;
    assert.deepStrictEqual(actualGetTestGuards, [InternalAdminAuthGuard]);
    assert.deepStrictEqual(actualBootstrapAdminGuards, [InternalAdminAuthGuard]);
  });
});
