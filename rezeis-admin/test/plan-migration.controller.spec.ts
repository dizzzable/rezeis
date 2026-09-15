import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ConflictException,
  ExecutionContext,
  HttpStatus,
  INestApplication,
  NotFoundException,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { match as compilePathMatcher } from 'path-to-regexp';
import request from 'supertest';

import { AdminSafeExceptionFilter, SAFE_PRODUCT_CODES } from '../src/common/filters/admin-safe-exception.filter';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPlanMigrationsController } from '../src/modules/plans/migrations/controllers/admin-plan-migrations.controller';
import {
  migrationRefusal,
  validateMigrationAssignment,
} from '../src/modules/plans/migrations/plan-migration-assignment.util';
import { PLAN_MIGRATION_REFUSAL_CODES } from '../src/modules/plans/migrations/plan-migration.codes';
import { PlanMigrationQueryService } from '../src/modules/plans/migrations/plan-migration-query.service';
import { PlanMigrationRunnerService } from '../src/modules/plans/migrations/plan-migration-runner.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { AdminPlansController } from '../src/modules/plans/controllers/admin-plans.controller';
import { AdminPlansStatsController } from '../src/modules/plans/controllers/admin-plans-stats.controller';
import {
  assertEffectiveRoutePermission,
  declaredRoutesInOrder,
  routeHandlerNames,
} from './helpers/controller-routes';

/**
 * The HTTP surface of the plan migration: routes, the permission each one
 * resolves to THROUGH the real `RbacGuard`, the DTO refusals, and the machine
 * codes surviving the real `AdminSafeExceptionFilter` — which strips any code it
 * does not list, so a code thrown correctly and forgotten there reaches the
 * dialog as an untyped 400.
 */

const proto = AdminPlanMigrationsController.prototype;

describe('AdminPlanMigrationsController routes', () => {
  it('declares the dialog’s six routes on the admin/plans surface, behind both guards', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPlanMigrationsController), 'admin/plans');
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminPlanMigrationsController), [AdminJwtAuthGuard, RbacGuard]);
    assert.deepEqual(routeHandlerNames(AdminPlanMigrationsController), [
      'getCurrentRun',
      'getRun',
      'listSubscriptions',
      'preview',
      'retry',
      'startMigration',
    ]);
    const expected: Array<[string, RequestMethod, string, number | undefined]> = [
      ['listSubscriptions', RequestMethod.GET, ':planId/subscriptions', undefined],
      ['preview', RequestMethod.POST, ':planId/migrations/preview', HttpStatus.OK],
      ['startMigration', RequestMethod.POST, ':planId/migrations', HttpStatus.ACCEPTED],
      ['getCurrentRun', RequestMethod.GET, ':planId/migrations/current', undefined],
      ['getRun', RequestMethod.GET, ':planId/migrations/:runId', undefined],
      ['retry', RequestMethod.POST, ':planId/migrations/:runId/retry', HttpStatus.ACCEPTED],
    ];
    for (const [name, method, path, code] of expected) {
      const handler = (proto as unknown as Record<string, object>)[name] as object;
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), method, name);
      assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path, name);
      assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, handler), code, name);
    }
  });

  it('gates reads on plans:delete + subscriptions:view and writes on plans:delete + subscriptions:edit', () => {
    const read = [
      { resource: 'plans', action: 'delete' },
      { resource: 'subscriptions', action: 'view' },
    ];
    const write = [
      { resource: 'plans', action: 'delete' },
      { resource: 'subscriptions', action: 'edit' },
    ];
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.listSubscriptions, read, 'GET :planId/subscriptions');
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.preview, read, 'POST :planId/migrations/preview');
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.getRun, read, 'GET :planId/migrations/:runId');
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.getCurrentRun, read, 'GET :planId/migrations/current');
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.startMigration, write, 'POST :planId/migrations');
    assertEffectiveRoutePermission(AdminPlanMigrationsController, proto.retry, write, 'POST :planId/migrations/:runId/retry');
  });

  it('leaves no route on the admin/plans surface unreachable behind an earlier parameterised one', () => {
    // `test/route-shadowing.spec.ts` compares LITERAL paths with parameterised
    // ones. Every route here carries `:planId`, so it never compares them — and
    // `:planId/migrations/:runId` declared above `:planId/migrations/current`
    // would swallow it (runId = "current") with that spec still green. So this
    // asks the stronger question, with Express's own matcher (built the way
    // `route-shadowing.spec.ts` builds it): does a route declared EARLIER match
    // a later route's path with each of its parameters filled in?
    const covers = (pattern: string, path: string): boolean =>
      compilePathMatcher(`/${pattern}`, { sensitive: false, end: true, trailing: true, decode: decodeURIComponent })(
        `/${path.replace(/:[A-Za-z0-9_]+/g, '__param__')}`,
      ) !== false;
    const full = (base: unknown, path: string | undefined): string =>
      [String(base), path ?? ''].map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
    const routesOf = (controller: new (...args: never[]) => object) =>
      declaredRoutesInOrder(controller).map((route) => ({
        ...route,
        controller: controller.name,
        full: full(Reflect.getMetadata(PATH_METADATA, controller), route.path),
      }));

    const own = routesOf(AdminPlanMigrationsController);
    const shadowed: string[] = [];
    own.forEach((later, laterIndex) => {
      for (const earlier of own.slice(0, laterIndex)) {
        if (earlier.method === later.method && covers(earlier.full, later.full)) {
          shadowed.push(`${later.handler} (${later.full}) is swallowed by ${earlier.handler} (${earlier.full})`);
        }
      }
    });
    assert.deepEqual(shadowed, []);
    const current = own.findIndex((route) => route.handler === 'getCurrentRun');
    const byRunId = own.findIndex((route) => route.handler === 'getRun');
    assert.ok(current >= 0 && current < byRunId, 'GET :planId/migrations/current must be declared before :runId');

    // Against the other controllers on `admin/plans`, order is decided by
    // module registration, which no file shows — so the paths must be disjoint.
    const neighbours = [...routesOf(AdminPlansController), ...routesOf(AdminPlansStatsController)];
    const crossing: string[] = [];
    for (const mine of own) {
      for (const theirs of neighbours) {
        if (mine.method !== theirs.method) continue;
        if (covers(mine.full, theirs.full) || covers(theirs.full, mine.full)) {
          crossing.push(`${mine.handler} (${mine.full}) ↔ ${theirs.controller}.${theirs.handler} (${theirs.full})`);
        }
      }
    }
    assert.deepEqual(crossing, []);
  });

  it('lists every refusal code in the safe filter’s allowlist, by value', () => {
    const missing = Object.values(PLAN_MIGRATION_REFUSAL_CODES).filter((code) => !SAFE_PRODUCT_CODES.has(code));
    assert.deepEqual(missing, [], 'these codes would be stripped from the wire');
  });
});

describe('validateMigrationAssignment', () => {
  const plans = [
    { id: 'plan-p', deletedAt: null, availability: 'ALL' },
    { id: 'plan-q', deletedAt: null, availability: 'ALL' },
    { id: 'plan-archived', deletedAt: null, availability: 'ALL' },
    { id: 'plan-trial', deletedAt: null, availability: 'TRIAL' },
    { id: 'plan-gone', deletedAt: new Date(), availability: 'ALL' },
  ];
  const client = {
    plan: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        plans.filter((plan) => args.where.id.in.includes(plan.id)),
    },
  } as never;

  async function codeOf(input: unknown): Promise<string | undefined> {
    try {
      await validateMigrationAssignment(client, 'plan-p', input as never);
      return undefined;
    } catch (error: unknown) {
      return ((error as { getResponse: () => { code?: string } }).getResponse()).code;
    }
  }

  it('refuses in a fixed order with the contract’s codes', async () => {
    assert.equal(await codeOf({}), 'EMPTY_ASSIGNMENT');
    assert.equal(await codeOf({ groups: [{ targetPlanId: 'plan-q', subscriptionIds: [] }] }), 'EMPTY_ASSIGNMENT');
    assert.equal(
      await codeOf({ groups: [{ targetPlanId: 'plan-q', subscriptionIds: Array.from({ length: 5001 }, (_, i) => `s${i}`) }] }),
      'TOO_MANY_IDS',
    );
    assert.equal(
      await codeOf({
        groups: [
          { targetPlanId: 'plan-q', subscriptionIds: Array.from({ length: 2500 }, (_, i) => `a${i}`) },
          { targetPlanId: 'plan-archived', subscriptionIds: Array.from({ length: 2500 }, (_, i) => `b${i}`) },
        ],
      }),
      undefined,
      'exactly 5000 across groups is allowed',
    );
    assert.equal(
      await codeOf({
        groups: [
          { targetPlanId: 'plan-q', subscriptionIds: ['s1'] },
          { targetPlanId: 'plan-archived', subscriptionIds: ['s1'] },
        ],
      }),
      'DUPLICATE_SUBSCRIPTION',
    );
    assert.equal(await codeOf({ groups: [{ targetPlanId: 'plan-p', subscriptionIds: ['s1'] }] }), 'TARGET_IS_SOURCE');
    assert.equal(await codeOf({ restTargetPlanId: 'plan-p' }), 'TARGET_IS_SOURCE');
    assert.equal(await codeOf({ restTargetPlanId: 'plan-gone' }), 'TARGET_NOT_FOUND');
    assert.equal(await codeOf({ restTargetPlanId: 'plan-missing' }), 'TARGET_NOT_FOUND');
    assert.equal(await codeOf({ restTargetPlanId: 'plan-trial' }), 'TARGET_IS_TRIAL');
    assert.equal(await codeOf({ restTargetPlanId: 'plan-archived', groups: [{ targetPlanId: 'plan-q', subscriptionIds: ['s1'] }] }), undefined);
    assert.equal(await codeOf({ restTargetPlanId: null, groups: [{ targetPlanId: 'plan-q', subscriptionIds: ['s1'] }] }), undefined);
  });
});

describe('plan migration routes over HTTP', () => {
  let application: INestApplication;
  const granted = new Set<string>();
  const calls: Array<{ readonly method: string; readonly args: unknown[] }> = [];
  let failure: Error | null = null;
  let currentRunId: string | null = null;

  const queryService = {
    listSubscriptions: async (...args: unknown[]) => respond('listSubscriptions', args, { total: 0, matched: 0, items: [], nextCursor: null }),
    preview: async (...args: unknown[]) => respond('preview', args, { summary: [], rows: [], nextCursor: null }),
    getRun: async (...args: unknown[]) => respond('getRun', args, { runId: 'run-1', status: 'RUNNING' }),
    getCurrentRun: async (...args: unknown[]) => respond('getCurrentRun', args, { runId: currentRunId }),
  };
  const runnerService = {
    startRun: async (...args: unknown[]) => respond('startRun', args, { runId: 'run-1', totalItems: 3 }),
    retry: async (...args: unknown[]) => respond('retry', args, { runId: 'run-1' }),
  };

  function respond<T>(method: string, args: unknown[], value: T): T {
    calls.push({ method, args });
    if (failure !== null) throw failure;
    return value;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPlanMigrationsController],
      providers: [
        { provide: PlanMigrationQueryService, useValue: queryService },
        { provide: PlanMigrationRunnerService, useValue: runnerService },
        RbacGuard,
        {
          provide: RbacService,
          useValue: {
            hasPermission: async (_admin: unknown, resource: string, action: string) => granted.has(`${resource}:${action}`),
          },
        },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext): boolean => {
          context.switchToHttp().getRequest().user = { id: 'admin-1', role: 'ADMIN', rbacRoleId: 'role-1' };
          return true;
        },
      })
      .compile();
    application = moduleRef.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    application.useGlobalFilters(new AdminSafeExceptionFilter());
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  beforeEach(() => {
    granted.clear();
    granted.add('plans:delete');
    granted.add('subscriptions:view');
    granted.add('subscriptions:edit');
    calls.length = 0;
    failure = null;
    currentRunId = null;
  });

  it('answers the open run as current — reached by its own route, never by :runId', async () => {
    currentRunId = 'run-7';
    const open = await request(server()).get('/api/admin/plans/plan-p/migrations/current');
    assert.equal(open.status, 200);
    assert.deepEqual(open.body, { runId: 'run-7' });
    assert.deepEqual(
      calls.map((call) => [call.method, ...call.args]),
      [['getCurrentRun', 'plan-p']],
      'GET …/migrations/current was answered by another handler',
    );

    currentRunId = null;
    const idle = await request(server()).get('/api/admin/plans/plan-gone/migrations/current');
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body, { runId: null });

    // The sibling still answers a real run id.
    await request(server()).get('/api/admin/plans/plan-p/migrations/run-1').expect(200);
    assert.deepEqual(calls.map((call) => call.method), ['getCurrentRun', 'getCurrentRun', 'getRun']);
  });

  it('gates the current run on plans:delete + subscriptions:view', async () => {
    granted.delete('subscriptions:view');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/migrations/current')).status, 403, 'subscriptions:edit is not a read permission');
    granted.add('subscriptions:view');
    granted.delete('plans:delete');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/migrations/current')).status, 403);
    granted.add('plans:delete');
    granted.delete('subscriptions:edit');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/migrations/current')).status, 200);
    assert.deepEqual(calls.map((call) => call.method), ['getCurrentRun']);
  });

  const server = () => application.getHttpServer();

  it('answers 200 for the list, with the query typed and passed through', async () => {
    const response = await request(server()).get('/api/admin/plans/plan-p/subscriptions').query({ search: 'bob', limit: '20', cursor: 'abc' });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0]?.args[0], 'plan-p');
    const passed = calls[0]?.args[1] as { limit: unknown; search: unknown; cursor: unknown };
    assert.equal(passed.limit, 20, 'limit arrives as a number');
    assert.equal(passed.search, 'bob');
    assert.equal(passed.cursor, 'abc');
  });

  it('refuses unknown query params, and a limit outside 1..200, with 400 before the service runs', async () => {
    for (const query of [{ unexpected: '1' }, { limit: '0' }, { limit: '201' }, { limit: 'many' }]) {
      const response = await request(server()).get('/api/admin/plans/plan-p/subscriptions').query(query);
      assert.equal(response.status, 400, JSON.stringify(query));
    }
    assert.equal(calls.length, 0);
    const run = await request(server()).get('/api/admin/plans/plan-p/migrations/run-1').query({ page: '2' });
    assert.equal(run.status, 400);
  });

  it('answers 200 for the preview and 202 for a start and a retry', async () => {
    const body = { groups: [{ targetPlanId: 'plan-q', subscriptionIds: ['s1'] }], restTargetPlanId: 'plan-r' };
    const preview = await request(server()).post('/api/admin/plans/plan-p/migrations/preview').send({ ...body, limit: 10, cursor: 's0' });
    assert.equal(preview.status, 200);
    const previewArgs = calls[0]?.args[1] as { limit: unknown; groups: unknown };
    assert.equal(previewArgs.limit, 10);
    assert.deepEqual(JSON.parse(JSON.stringify(previewArgs.groups)), body.groups);

    const start = await request(server())
      .post('/api/admin/plans/plan-p/migrations')
      .set('x-request-id', 'req-42')
      .set('user-agent', 'dialog')
      .send(body);
    assert.equal(start.status, 202);
    assert.deepEqual(start.body, { runId: 'run-1', totalItems: 3 });
    const context = calls[1]?.args[2] as { currentAdmin: { id: string }; requestMetadata: { requestId: string; userAgent: string } };
    assert.equal(context.currentAdmin.id, 'admin-1');
    assert.equal(context.requestMetadata.requestId, 'req-42');
    assert.equal(context.requestMetadata.userAgent, 'dialog');

    const retry = await request(server()).post('/api/admin/plans/plan-p/migrations/run-1/retry').send({ scope: 'sync' });
    assert.equal(retry.status, 202);
    assert.deepEqual(calls[2]?.args.slice(0, 3), ['plan-p', 'run-1', 'sync']);
    const retryContext = calls[2]?.args[3] as { currentAdmin: { id: string }; requestMetadata: { userAgent: string } };
    assert.equal(retryContext.currentAdmin.id, 'admin-1', 'the retrying admin reaches the runner');
    assert.ok(retryContext.requestMetadata !== undefined);
  });

  it('refuses malformed bodies with 400: a cursor on the start, an unknown field, a bad scope, non-array ids', async () => {
    const cases: Array<[string, object]> = [
      ['/api/admin/plans/plan-p/migrations', { restTargetPlanId: 'plan-q', cursor: 'x' }],
      ['/api/admin/plans/plan-p/migrations', { restTargetPlanId: 'plan-q', dryRun: true }],
      ['/api/admin/plans/plan-p/migrations/preview', { groups: [{ targetPlanId: 'plan-q', subscriptionIds: 's1' }] }],
      ['/api/admin/plans/plan-p/migrations/preview', { groups: [{ subscriptionIds: ['s1'] }] }],
      ['/api/admin/plans/plan-p/migrations/preview', { restTargetPlanId: 'plan-q', limit: 500 }],
      ['/api/admin/plans/plan-p/migrations/run-1/retry', { scope: 'everything' }],
      ['/api/admin/plans/plan-p/migrations/run-1/retry', {}],
    ];
    for (const [path, body] of cases) {
      const response = await request(server()).post(path).send(body);
      assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal(calls.length, 0);
  });

  it('carries every refusal code through the safe filter', async () => {
    for (const code of Object.values(PLAN_MIGRATION_REFUSAL_CODES)) {
      failure = code === 'MIGRATION_ALREADY_RUNNING'
        ? new ConflictException({ code, message: 'A migration of this plan is already running.' })
        : migrationRefusal(code, 'refused');
      const response = await request(server()).post('/api/admin/plans/plan-p/migrations').send({ restTargetPlanId: 'plan-q' });
      assert.equal(response.status, code === 'MIGRATION_ALREADY_RUNNING' ? 409 : 400, code);
      assert.equal(response.body.code, code, `${code} was stripped by the filter`);
    }
  });

  it('answers 404 for an unknown plan or run', async () => {
    failure = new NotFoundException('Plan not found');
    assert.equal((await request(server()).get('/api/admin/plans/nope/subscriptions')).status, 404);
    failure = new NotFoundException('Plan migration run not found');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/migrations/nope')).status, 404);
  });

  it('refuses a read without subscriptions:view and a move without subscriptions:edit, even with plans:delete', async () => {
    granted.delete('subscriptions:view');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/subscriptions')).status, 403);
    assert.equal((await request(server()).post('/api/admin/plans/plan-p/migrations/preview').send({ restTargetPlanId: 'q' })).status, 403);
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/migrations/run-1')).status, 403);
    assert.equal((await request(server()).post('/api/admin/plans/plan-p/migrations').send({ restTargetPlanId: 'q' })).status, 202);

    granted.add('subscriptions:view');
    granted.delete('subscriptions:edit');
    assert.equal((await request(server()).post('/api/admin/plans/plan-p/migrations').send({ restTargetPlanId: 'q' })).status, 403);
    assert.equal((await request(server()).post('/api/admin/plans/plan-p/migrations/run-1/retry').send({ scope: 'failed' })).status, 403);
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/subscriptions')).status, 200);

    granted.add('subscriptions:edit');
    granted.delete('plans:delete');
    assert.equal((await request(server()).get('/api/admin/plans/plan-p/subscriptions')).status, 403);
    assert.equal((await request(server()).post('/api/admin/plans/plan-p/migrations').send({ restTargetPlanId: 'q' })).status, 403);
    assert.equal(calls.filter((call) => call.method !== 'startRun' && call.method !== 'listSubscriptions').length, 0);
  });
});
