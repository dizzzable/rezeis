import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { CUSTOM_ROUTE_ARGS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdmin } from '../src/modules/auth/decorators/current-admin.decorator';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';

interface CustomRouteArgMetadata {
  readonly factory: (data: unknown, context: ExecutionContext) => unknown;
}

class CurrentAdminDecoratorTestController {
  public execute(@CurrentAdmin() _currentAdmin: CurrentAdminInterface): void {}
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

function readCustomRouteArgMetadata(): CustomRouteArgMetadata {
  const routeArgsMetadata = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    CurrentAdminDecoratorTestController,
    'execute',
  ) as Record<string, unknown> | undefined) ?? {};
  const customRouteArgEntry = Object.entries(routeArgsMetadata).find(
    ([key]: readonly [string, unknown]): boolean => key.includes(CUSTOM_ROUTE_ARGS_METADATA),
  );
  assert.ok(customRouteArgEntry);
  return customRouteArgEntry[1] as CustomRouteArgMetadata;
}

function buildHttpExecutionContext(request: Request): ExecutionContext {
  return {
    switchToHttp: (): { getRequest: <T>() => T } => ({
      getRequest: <T>(): T => request as T,
    }),
  } as ExecutionContext;
}

describe('CurrentAdmin', () => {
  it('returns the authenticated admin from request.user', () => {
    const currentAdmin = buildCurrentAdmin();
    const customRouteArgMetadata = readCustomRouteArgMetadata();
    const request = {
      user: currentAdmin,
    } as Request;
    const executionContext = buildHttpExecutionContext(request);
    const actualCurrentAdmin = customRouteArgMetadata.factory(undefined, executionContext);
    assert.deepStrictEqual(actualCurrentAdmin, currentAdmin);
  });

  it('throws UnauthorizedException when request.user is missing', () => {
    const customRouteArgMetadata = readCustomRouteArgMetadata();
    const request = {} as Request;
    const executionContext = buildHttpExecutionContext(request);
    assert.throws(
      (): unknown => customRouteArgMetadata.factory(undefined, executionContext),
      (err: unknown): boolean => {
        assert.ok(err instanceof UnauthorizedException);
        assert.equal(err.message, 'Admin user is not authenticated');
        return true;
      },
    );
  });
});
