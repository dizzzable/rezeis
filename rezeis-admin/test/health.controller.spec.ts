import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { HealthController } from '../src/modules/health/health.controller';
import { HealthService } from '../src/modules/health/health.service';

interface ComponentHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs?: number;
  readonly details?: string;
}

interface HealthResponse {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly service: string;
  readonly version: string;
  readonly gitSha: string | null;
  readonly timestamp: string;
  readonly uptime: number;
  readonly components: {
    readonly database: ComponentHealth;
    readonly redis: ComponentHealth;
    readonly queues: ComponentHealth;
    readonly disk: ComponentHealth;
  };
}

interface CapturedResponse {
  readonly statusCode: number | null;
  readonly body: unknown;
}

const healthySnapshot: HealthResponse = {
  status: 'ok',
  service: 'rezeis-admin',
  version: '0.7.3',
  gitSha: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-06-03T10:00:00.000Z',
  uptime: 12,
  components: {
    database: { status: 'up', latencyMs: 1 },
    redis: { status: 'up', latencyMs: 1 },
    queues: { status: 'up', details: 'waiting=0 active=0 failed=0' },
    disk: { status: 'up' },
  },
};

describe('HealthController', () => {
  it('exposes the current unauthenticated health, liveness, and readiness routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, HealthController), 'health');
    assert.equal(Reflect.getMetadata(PATH_METADATA, HealthController.prototype.getHealth), '/');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, HealthController.prototype.getHealth), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, HealthController.prototype.liveness), 'live');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, HealthController.prototype.liveness), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, HealthController.prototype.liveness), HttpStatus.OK);
    assert.equal(Reflect.getMetadata(PATH_METADATA, HealthController.prototype.readiness), 'ready');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, HealthController.prototype.readiness), RequestMethod.GET);
  });

  it('writes the full health snapshot with a service-unavailable status on critical failure', async () => {
    const expectedSnapshot: HealthResponse = {
      ...healthySnapshot,
      status: 'error',
      components: {
        ...healthySnapshot.components,
        database: { status: 'down', latencyMs: 2, details: 'database_unavailable' },
      },
    };
    const controller = new HealthController(createHealthService(expectedSnapshot));
    const captured = createResponseCapture();

    await controller.getHealth(captured.response as never);

    assert.equal(captured.result.statusCode, HttpStatus.SERVICE_UNAVAILABLE);
    assert.deepStrictEqual(captured.result.body, expectedSnapshot);
  });

  it('returns ok liveness without touching dependencies', () => {
    const controller = new HealthController(createHealthService(healthySnapshot));

    assert.deepStrictEqual(controller.liveness(), { status: 'ok' });
  });

  it('writes a compact ready response when database and Redis are up', async () => {
    const controller = new HealthController(createHealthService(healthySnapshot));
    const captured = createResponseCapture();

    await controller.readiness(captured.response as never);

    assert.equal(captured.result.statusCode, HttpStatus.OK);
    assert.deepStrictEqual(captured.result.body, {
      status: 'ready',
      database: 'up',
      redis: 'up',
    });
  });

  it('writes not_ready when a critical dependency is down', async () => {
    const controller = new HealthController(
      createHealthService({
        ...healthySnapshot,
        status: 'error',
        components: {
          ...healthySnapshot.components,
          redis: { status: 'down', latencyMs: 2, details: 'redis_unavailable' },
        },
      }),
    );
    const captured = createResponseCapture();

    await controller.readiness(captured.response as never);

    assert.equal(captured.result.statusCode, HttpStatus.SERVICE_UNAVAILABLE);
    assert.deepStrictEqual(captured.result.body, {
      status: 'not_ready',
      database: 'up',
      redis: 'down',
    });
  });
});

function createHealthService(snapshot: HealthResponse): HealthService {
  return {
    getHealth: async (): Promise<HealthResponse> => snapshot,
  } as HealthService;
}

function createResponseCapture(): {
  readonly response: { status: (statusCode: number) => { json: (body: unknown) => void } };
  readonly result: CapturedResponse;
} {
  const result: { statusCode: number | null; body: unknown } = { statusCode: null, body: undefined };
  const response = {
    status(statusCode: number) {
      result.statusCode = statusCode;
      return {
        json(body: unknown) {
          result.body = body;
        },
      };
    },
  };

  return { response, result };
}
