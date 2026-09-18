import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminRemnawaveController } from '../src/modules/remnawave/controllers/admin-remnawave.controller';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  RemnawaveMetricsCollectorService,
  type OnlineRange,
} from '../src/modules/remnawave/services/remnawave-metrics-collector.service';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * The online card's query, through the real router and the real pipe.
 *
 * The routes used to read one key by hand (`@Query('range')`), so the global
 * `ValidationPipe` never saw the query at all: `?hours=168` — the removed
 * route's parameter — answered 200 with the default window, as if honoured, and
 * a handler-level test could not even express a repeated `?range=`, which
 * Express hands over as an array. Here the requests go over HTTP, the pipe is
 * configured as `main.ts` configures it, and the collector double records what
 * reached it: a refusal must be a 400 that never touched the collector.
 */
describe('GET admin/remnawave/metrics/online-* — the query', () => {
  let application: INestApplication;
  const asked: Array<{ readonly route: 'overview' | 'distribution'; readonly range: OnlineRange }> = [];

  before(async () => {
    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [AdminRemnawaveController],
      providers: [
        {
          provide: RemnawaveMetricsCollectorService,
          useValue: {
            getOnlineOverview: async (range: OnlineRange) => {
              asked.push({ route: 'overview', range });
              return { range };
            },
            getOnlineDistribution: async (range: OnlineRange) => {
              asked.push({ route: 'distribution', range });
              return { range };
            },
          },
        },
        // None of the requests below may reach these; a route change that sent
        // one there would fail loudly rather than answer plausibly.
        { provide: RemnawaveApiService, useValue: {} },
        { provide: RemnawaveWebhookService, useValue: {} },
        { provide: RemnawaveVersionService, useValue: {} },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    application = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    // Exactly `main.ts`'s global pipe.
    application.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  beforeEach(() => {
    asked.length = 0;
  });

  const get = (path: string) => request(application.getHttpServer()).get(`/api/admin/remnawave/metrics/${path}`);

  it('serves each window it knows, and 24 hours when none is named', async () => {
    assert.equal((await get('online-overview')).status, 200);
    assert.equal((await get('online-overview?range=7d')).status, 200);
    assert.equal((await get('online-overview?range=24h')).status, 200);
    assert.equal((await get('online-distribution?range=7d')).status, 200);
    assert.equal((await get('online-distribution')).status, 200);

    assert.deepStrictEqual(asked, [
      { route: 'overview', range: '24h' },
      { route: 'overview', range: '7d' },
      { route: 'overview', range: '24h' },
      { route: 'distribution', range: '7d' },
      { route: 'distribution', range: '24h' },
    ]);
  });

  for (const route of ['online-overview', 'online-distribution']) {
    it(`${route}: refuses any other window, a repeated window, and any other parameter — before the collector`, async () => {
      const refused = [
        '?range=14d',
        '?range=168',
        '?range=7D',
        '?range=',
        // Express hands a repeated key over as an array.
        '?range=7d&range=24h',
        // The removed route's parameter, still in bookmarks and scripts.
        '?hours=168',
        '?range=7d&hours=24',
      ];
      for (const query of refused) {
        const response = await get(`${route}${query}`);
        assert.equal(response.status, 400, `${route}${query} was not refused`);
      }
      assert.deepStrictEqual(asked, [], 'a refused query reached the collector');
    });
  }
});
