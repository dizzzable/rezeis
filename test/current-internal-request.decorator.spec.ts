import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionContext } from '@nestjs/common';
import { CUSTOM_ROUTE_ARGS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Request } from 'express';

import { CurrentInternalRequest } from '../src/modules/auth/decorators/current-internal-request.decorator';
import { InternalAdminRequest } from '../src/modules/auth/interfaces/internal-admin-request.interface';

interface CustomRouteArgMetadata {
  readonly factory: (data: unknown, context: ExecutionContext) => unknown;
}

class CurrentInternalRequestDecoratorTestController {
  public execute(@CurrentInternalRequest() _request: InternalAdminRequest): void {}
}

function readCustomRouteArgMetadata(): CustomRouteArgMetadata {
  const routeArgsMetadata = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    CurrentInternalRequestDecoratorTestController,
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

describe('CurrentInternalRequest', () => {
  it('returns normalized request metadata from the HTTP request', () => {
    const customRouteArgMetadata = readCustomRouteArgMetadata();
    const request = {
      headers: {
        'x-request-id': ['internal-request-3', 'internal-request-ignored'],
        'x-forwarded-for': '198.51.100.82, 203.0.113.12',
        'user-agent': ['internal-bootstrap-spec', 'ignored-user-agent'],
      },
      ip: '127.0.0.3',
      socket: {
        remoteAddress: '127.0.0.4',
      },
    } as unknown as Request;
    const executionContext = buildHttpExecutionContext(request);
    const actualInternalRequest = customRouteArgMetadata.factory(undefined, executionContext);
    assert.deepStrictEqual(actualInternalRequest, {
      requestId: 'internal-request-3',
      remoteAddress: '198.51.100.82',
      userAgent: 'internal-bootstrap-spec',
    });
  });
});
