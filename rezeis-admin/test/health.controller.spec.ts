import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { HealthController } from '../src/modules/health/health.controller';
import { HealthService } from '../src/modules/health/health.service';
import { QueueStatusService, QueueStatusSnapshot } from '../src/modules/health/queue-status.service';

interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly timestamp: string;
  readonly database: {
    readonly status: string;
  };
}

interface ReadinessResponse {
  readonly status: string;
  readonly info: Record<string, { readonly status: string }>;
  readonly error: Record<string, { readonly status: string }>;
  readonly details: Record<string, { readonly status: string }>;
}

const queueStatusService = {
  getSnapshot: async (): Promise<QueueStatusSnapshot> => ({
    generatedAt: '2026-04-16T10:01:00.000Z',
    queues: [],
  }),
} as QueueStatusService;

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
    const actualGetReadinessPath = Reflect.getMetadata(
      PATH_METADATA,
      HealthController.prototype.getReadiness,
    ) as string | undefined;
    const actualGetReadinessMethod = Reflect.getMetadata(
      METHOD_METADATA,
      HealthController.prototype.getReadiness,
    ) as RequestMethod | undefined;
    const actualGetQueueStatusPath = Reflect.getMetadata(
      PATH_METADATA,
      HealthController.prototype.getQueueStatus,
    ) as string | undefined;
    const actualGetQueueStatusMethod = Reflect.getMetadata(
      METHOD_METADATA,
      HealthController.prototype.getQueueStatus,
    ) as RequestMethod | undefined;
    const actualGetQueueStatusGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      HealthController.prototype.getQueueStatus,
    ) as readonly unknown[] | undefined;
    assert.equal(actualControllerPath, 'health');
    assert.equal(actualGetHealthPath, '/');
    assert.equal(actualGetHealthMethod, RequestMethod.GET);
    assert.equal(actualGetReadinessPath, 'readiness');
    assert.equal(actualGetReadinessMethod, RequestMethod.GET);
    assert.equal(actualGetQueueStatusPath, 'queues/status');
    assert.equal(actualGetQueueStatusMethod, RequestMethod.GET);
    assert.deepStrictEqual(actualGetQueueStatusGuards, [AdminJwtAuthGuard]);
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
      getReadiness: async (): Promise<ReadinessResponse> => ({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      }),
    } as HealthService;
    const controller = new HealthController(healthService, queueStatusService);
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

  it('delegates getReadiness and returns the Terminus-compatible response shape unchanged', async () => {
    let getReadinessCallsCount: number = 0;
    const expectedResponse: ReadinessResponse = {
      status: 'ok',
      info: {
        database: {
          status: 'up',
        },
      },
      error: {},
      details: {
        database: {
          status: 'up',
        },
      },
    };
    const healthService = {
      getHealth: async (): Promise<HealthResponse> => ({
        status: 'ok',
        service: 'rezeis-admin',
        timestamp: '2026-04-16T10:00:00.000Z',
        database: {
          status: 'up',
        },
      }),
      getReadiness: async (): Promise<ReadinessResponse> => {
        getReadinessCallsCount += 1;
        return expectedResponse;
      },
    } as HealthService;
    const controller = new HealthController(healthService, queueStatusService);
    const actualResponse = await controller.getReadiness();
    assert.equal(getReadinessCallsCount, 1);
    assert.deepStrictEqual(actualResponse, expectedResponse);
    assert.deepStrictEqual(Object.keys(actualResponse).sort(), ['details', 'error', 'info', 'status']);
    assert.deepStrictEqual(Object.keys(actualResponse.details), ['database']);
  });

  it('delegates getQueueStatus and returns only redacted queue snapshot shape', async () => {
    let getSnapshotCallsCount: number = 0;
    const expectedSnapshot: QueueStatusSnapshot = {
      generatedAt: '2026-04-16T10:02:00.000Z',
      queues: [
        {
          label: 'paymentReconciliationQueue',
          counts: {
            waiting: 2,
            active: 1,
            delayed: 0,
            completed: 5,
            failed: 1,
          },
        },
      ],
    };
    const healthService = {
      getHealth: async (): Promise<HealthResponse> => ({
        status: 'ok',
        service: 'rezeis-admin',
        timestamp: '2026-04-16T10:00:00.000Z',
        database: {
          status: 'up',
        },
      }),
      getReadiness: async (): Promise<ReadinessResponse> => ({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      }),
    } as HealthService;
    const localQueueStatusService = {
      getSnapshot: async (): Promise<QueueStatusSnapshot> => {
        getSnapshotCallsCount += 1;
        return expectedSnapshot;
      },
    } as QueueStatusService;
    const controller = new HealthController(healthService, localQueueStatusService);

    const actualResponse = await controller.getQueueStatus();

    assert.equal(getSnapshotCallsCount, 1);
    assert.deepStrictEqual(actualResponse, expectedSnapshot);
    assert.deepStrictEqual(Object.keys(actualResponse).sort(), ['generatedAt', 'queues']);
    assert.deepStrictEqual(Object.keys(actualResponse.queues[0]).sort(), ['counts', 'label']);
    assert.deepStrictEqual(Object.keys(actualResponse.queues[0].counts).sort(), [
      'active',
      'completed',
      'delayed',
      'failed',
      'waiting',
    ]);
  });
});
