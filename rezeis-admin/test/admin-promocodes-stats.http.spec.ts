import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { PromocodesModule } from '../src/modules/promocodes/promocodes.module';
import { PromocodeLifecycleService } from '../src/modules/promocodes/services/promocode-lifecycle.service';
import { PromocodePortalService } from '../src/modules/promocodes/services/promocode-portal.service';
import {
  PromocodesStatsQueryInput,
  PromocodesStatsResultInterface,
  PromocodesStatsService,
} from '../src/modules/promocodes/services/promocodes-stats.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

/**
 * `GET /api/admin/promocodes/stats` reaches the stats controller and not
 * `:promocodeId`.
 *
 * The twin of `admin-plans-stats.http.spec.ts`: `PromocodesModule` registers a
 * CRUD controller on `admin/promocodes` declaring `@Get(':promocodeId')` and a
 * stats controller on `admin/promocodes/stats` declaring `@Get()`. Express
 * answers from the first route registered for a method, Nest registers
 * controllers in the module array's order, so array position alone decides
 * whether the statistics tab works or 404s. It shipped shadowed, exactly like
 * the plans one — the two modules were written from the same template and
 * inherited the same defect.
 *
 * Boots the real routing rather than reading metadata, because metadata cannot
 * see this: both controllers declare precisely the paths they intend.
 */
describe('GET admin/promocodes/stats routing', () => {
  let application: INestApplication;
  const statsCalls: PromocodesStatsQueryInput[] = [];
  const getByIdCalls: string[] = [];

  before(async () => {
    // The REAL registration order, read off the module rather than restated —
    // restating it would let this spec pass against an order the application no
    // longer uses, which is the exact failure it exists to catch.
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PromocodesModule) as Array<
      new (...args: never[]) => object
    >;
    assert.ok(
      controllers !== undefined && controllers.length > 0,
      'PromocodesModule declares no controllers — this spec would then assert nothing',
    );

    const testingModule: TestingModule = await Test.createTestingModule({
      controllers,
      providers: [
        {
          provide: PromocodeLifecycleService,
          useValue: {
            getById: async (promocodeId: string) => {
              getByIdCalls.push(promocodeId);
              // What the real service does for an unknown id, so a shadowed
              // request reproduces the production symptom rather than a
              // test-only one.
              throw new NotFoundException('Promocode not found');
            },
          },
        },
        {
          provide: PromocodesStatsService,
          useValue: {
            getStats: async (input: PromocodesStatsQueryInput) => {
              statsCalls.push(input);
              return buildStatsResult();
            },
          },
        },
        { provide: PromocodePortalService, useValue: {} },
        { provide: PrismaService, useValue: {} },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: (): boolean => true })
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    application = testingModule.createNestApplication();
    // `main.ts:57` mounts everything under `/api`; the SPA calls the prefixed
    // path, so the spec has to as well or it is testing a URL nobody requests.
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('answers from the stats controller, not from the :promocodeId lookup', async () => {
    statsCalls.length = 0;
    getByIdCalls.length = 0;

    // Deliberately NOT `.expect(200)`: the status is a symptom, and asserting
    // it first would report "expected 200, got 404" while the interesting fact
    // — WHICH handler ran — went unsaid.
    const response = await request(application.getHttpServer()).get('/api/admin/promocodes/stats');

    assert.deepStrictEqual(
      getByIdCalls,
      [],
      'GET admin/promocodes/stats was routed to AdminPromocodesController.getById with ' +
        'promocodeId="stats" — the parameterised route is registered ahead of the literal one, ' +
        'so the promocode statistics tab 404s for every operator',
    );
    assert.equal(statsCalls.length, 1, 'AdminPromocodesStatsController.getStats did not run');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body, buildStatsResult());
  });

  it('passes the stats query window through untouched', async () => {
    statsCalls.length = 0;
    getByIdCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/promocodes/stats')
      .query({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        promocodeId: 'promo-1',
      });

    assert.deepStrictEqual(getByIdCalls, []);
    assert.equal(statsCalls.length, 1);
    assert.equal(response.status, 200);
    assert.equal(statsCalls[0]?.from?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(statsCalls[0]?.to?.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(statsCalls[0]?.promocodeId, 'promo-1');
  });

  it('still routes a real promocode id to the :promocodeId lookup', async () => {
    // The other half of the contract. A fix that wins the literal by breaking
    // the parameterised route would pass the assertions above and take the
    // promocode detail view down instead.
    statsCalls.length = 0;
    getByIdCalls.length = 0;

    await request(application.getHttpServer()).get('/api/admin/promocodes/promo-1').expect(404);

    assert.deepStrictEqual(getByIdCalls, ['promo-1']);
    assert.equal(statsCalls.length, 0);
  });
});

function buildStatsResult(): PromocodesStatsResultInterface {
  return {
    totals: { activations: 3, uniqueUsers: 2 },
    byCode: [],
    byReward: [],
    topUsers: [],
    timeline: [],
  };
}
