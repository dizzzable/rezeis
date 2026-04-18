import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { HealthController } from '../src/modules/health/health.controller';
import { HealthService } from '../src/modules/health/health.service';

interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly timestamp: string;
  readonly database: {
    readonly status: string;
  };
}

describe('HealthController', () => {
  it('exposes the shipped health route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, HealthController) as string | undefined;
    const actualGetHealthPath = Reflect.getMetadata(
      PATH_METADATA,
      HealthController.prototype.getHealth,
    ) as string | undefined;
    const actualGetHealthMethod = Reflect.getMetadata(
      METHOD_METADATA,
      HealthController.prototype.getHealth,
    ) as RequestMethod | undefined;
    assert.equal(actualControllerPath, 'health');
    assert.equal(actualGetHealthPath, '/');
    assert.equal(actualGetHealthMethod, RequestMethod.GET);
  });

  it('delegates getHealth and returns the response shape unchanged', async () => {
    let getHealthCallsCount: number = 0;
    const expectedResponse: HealthResponse = {
      status: 'ok',
      service: 'rezeis-admin',
      timestamp: '2026-04-16T10:00:00.000Z',
      database: {
        status: 'up',
      },
    };
    const healthService = {
      getHealth: async (): Promise<HealthResponse> => {
        getHealthCallsCount += 1;
        return expectedResponse;
      },
    } as HealthService;
    const controller = new HealthController(healthService);
    const actualResponse = await controller.getHealth();
    assert.equal(getHealthCallsCount, 1);
    assert.deepStrictEqual(actualResponse, expectedResponse);
    assert.deepStrictEqual(Object.keys(actualResponse).sort(), [
      'database',
      'service',
      'status',
      'timestamp',
    ]);
    assert.deepStrictEqual(Object.keys(actualResponse.database), ['status']);
  });
});
