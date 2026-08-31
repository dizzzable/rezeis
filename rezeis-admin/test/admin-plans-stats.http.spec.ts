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
import { PlansModule } from '../src/modules/plans/plans.module';
import { UnknownSquadAuditService } from '../src/modules/plans/services/unknown-squad-audit.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import {
  PlansStatsQueryInput,
  PlansStatsResultInterface,
  PlansStatsService,
} from '../src/modules/plans/services/plans-stats.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

/**
 * `GET /api/admin/plans/stats` reaches the stats controller and not `:planId`.
 *
 * Two controllers in `PlansModule` claim overlapping ground: `AdminPlansController`
 * is mounted on `admin/plans` and declares `@Get(':planId')`, while
 * `AdminPlansStatsController` is mounted on `admin/plans/stats` and declares
 * `@Get()`. Express matches the FIRST route registered for a method, and Nest
 * registers controllers in the order of the module's `controllers` array — so
 * whether `/admin/plans/stats` is a plan lookup for a plan literally named
 * "stats" (404, every time, for every operator) or the statistics endpoint the
 * SPA's plan stats tab calls is decided entirely by array position in
 * `plans.module.ts`. Nothing in either controller file makes that dependency
 * visible, and no unit-level metadata assertion can see it: both controllers
 * declare exactly the paths they mean to.
 *
 * `admin-plans.controller.ts` already carries a comment hoisting `@Patch('reorder')`
 * above `:planId` for the same reason, so the hazard was understood — it was
 * simply never extended across a controller boundary.
 *
 * This spec therefore boots the real routing rather than reading metadata: it
 * takes the controllers array straight off `PlansModule` (so a reorder there is
 * reflected here rather than duplicated) and issues a real HTTP request through
 * the real router.
 */
describe('GET admin/plans/stats routing', () => {
  let application: INestApplication;
  const statsCalls: PlansStatsQueryInput[] = [];
  const getPlanCalls: string[] = [];
  const auditCalls: string[] = [];

  before(async () => {
    // The REAL registration order, read off the module rather than restated.
    // Restating it would let this spec keep passing against an order the
    // application no longer uses, which is the exact failure it exists to catch.
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PlansModule) as Array<
      new (...args: never[]) => object
    >;
    assert.ok(
      controllers !== undefined && controllers.length > 0,
      'PlansModule declares no controllers — this spec would then assert nothing',
    );

    const testingModule: TestingModule = await Test.createTestingModule({
      controllers,
      providers: [
        {
          provide: PlansAdminService,
          useValue: {
            getPlan: async (planId: string) => {
              getPlanCalls.push(planId);
              // Exactly what the real service does for an id that matches no
              // plan — so a shadowed request produces the production symptom
              // (404) rather than a test-only one.
              throw new NotFoundException('Plan not found');
            },
          },
        },
        {
          provide: PlansStatsService,
          useValue: {
            getStats: async (input: PlansStatsQueryInput) => {
              statsCalls.push(input);
              return buildStatsResult();
            },
          },
        },
        { provide: PlanCatalogService, useValue: { getCatalogPlans: async () => [] } },
        // Records its calls, because the routing assertion below needs to know
        // WHICH handler ran. A stub that only satisfied Nest's constructor
        // resolution would leave the second literal route on this controller
        // unguarded — and this file exists because exactly that shipped once.
        {
          provide: UnknownSquadAuditService,
          useValue: {
            audit: async () => {
              auditCalls.push('called');
              return { scanned: 0, affected: 0, truncated: false, rows: [], affectedPlans: [] };
            },
          },
        },
        { provide: PrismaService, useValue: { user: { findFirst: async () => null } } },
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

  it('answers unknown-squads from the audit, not from the :planId lookup', async () => {
    auditCalls.length = 0;
    getPlanCalls.length = 0;

    const response = await request(application.getHttpServer()).get(
      '/api/admin/plans/unknown-squads',
    );

    assert.deepStrictEqual(
      getPlanCalls,
      [],
      'GET admin/plans/unknown-squads was routed to AdminPlansController.getPlan with ' +
        'planId="unknown-squads" — the parameterised route is registered ahead of the ' +
        'literal one, so the screen 404s for every operator',
    );
    assert.equal(auditCalls.length, 1, 'the audit handler never ran');
    assert.equal(response.status, 200);
  });

  it('answers from the stats controller, not from the :planId lookup', async () => {
    statsCalls.length = 0;
    getPlanCalls.length = 0;

    // Deliberately NOT `.expect(200)` here: the status is a symptom, and
    // asserting it first would report "expected 200, got 404" while the
    // interesting fact — WHICH handler ran — went unsaid.
    const response = await request(application.getHttpServer()).get('/api/admin/plans/stats');

    assert.deepStrictEqual(
      getPlanCalls,
      [],
      'GET admin/plans/stats was routed to AdminPlansController.getPlan with planId="stats" — ' +
        'the parameterised route is registered ahead of the literal one, so the plan statistics ' +
        'tab 404s for every operator',
    );
    assert.equal(statsCalls.length, 1, 'AdminPlansStatsController.getStats did not run');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body, buildStatsResult());
  });

  it('passes the stats query window through untouched', async () => {
    statsCalls.length = 0;
    getPlanCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/plans/stats')
      .query({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', planId: 'plan-1' });

    assert.deepStrictEqual(getPlanCalls, []);
    assert.equal(statsCalls.length, 1);
    assert.equal(response.status, 200);
    assert.equal(statsCalls[0]?.from?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(statsCalls[0]?.to?.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(statsCalls[0]?.planId, 'plan-1');
  });

  it('still routes a real plan id to the :planId lookup', async () => {
    // The other half of the contract. A fix that wins the literal by breaking
    // the parameterised route would pass the assertions above and take the plan
    // detail view down instead, so the sibling route is asserted here.
    statsCalls.length = 0;
    getPlanCalls.length = 0;

    await request(application.getHttpServer()).get('/api/admin/plans/plan-1').expect(404);

    assert.deepStrictEqual(getPlanCalls, ['plan-1']);
    assert.equal(statsCalls.length, 0);
  });
});

function buildStatsResult(): PlansStatsResultInterface {
  return {
    totals: { purchases: 2, revenueByCurrency: { RUB: '400.00' }, uniqueBuyers: 1 },
    byPlan: [],
    timeline: [],
    topBuyers: [],
  };
}
