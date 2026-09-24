import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ExecutionContext, INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminLifetimeRestoreController } from '../src/modules/subscriptions/controllers/admin-lifetime-restore.controller';
import {
  LIFETIME_RESTORE_MAX_IDS,
  LifetimeRestoreService,
  type LifetimeCensusResponse,
} from '../src/modules/subscriptions/services/lifetime-restore.service';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/**
 * «Вернуть бессрочность»'s two routes: who may reach them (the metadata
 * `RbacGuard` reads), and what the POST refuses before a single row is locked —
 * through the real router and the global `ValidationPipe` exactly as `main.ts`
 * installs it, so a body the pipe does not see as the DTO cannot pass as one.
 */

const BASE_PATH = 'admin/subscriptions/lifetime-restore';
const ADMIN = { id: 'admin-lifetime-spec', login: 'operator' };

describe('AdminLifetimeRestoreController', () => {
  it('both routes are admin routes gated on subscriptions:edit', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminLifetimeRestoreController), BASE_PATH);
    // Compared by identity, reported by name: a class in `expected` is what the
    // test reporter cannot print, and the failure then reads as no assertion.
    const guards = (Reflect.getMetadata(GUARDS_METADATA, AdminLifetimeRestoreController) ?? []) as unknown[];
    assert.deepStrictEqual(
      guards.map((guard) =>
        guard === AdminJwtAuthGuard ? 'AdminJwtAuthGuard' : guard === RbacGuard ? 'RbacGuard' : String(guard),
      ),
      ['AdminJwtAuthGuard', 'RbacGuard'],
      'who the admin is, then what they may do — without RbacGuard no @RequirePermission is read',
    );
    assertRouteHandlers(AdminLifetimeRestoreController, ['census', 'restore']);
    assertEveryRouteGuarded(AdminLifetimeRestoreController);

    const census = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (the census)`;
    assertRoute(AdminLifetimeRestoreController.prototype.census, { method: RequestMethod.GET, path: '/' }, census);
    assertRoutePermission(AdminLifetimeRestoreController.prototype.census, { resource: 'subscriptions', action: 'edit' }, census);

    const restore = `${routeLabel(BASE_PATH, RequestMethod.POST, '/')} (the restore)`;
    assertRoute(AdminLifetimeRestoreController.prototype.restore, { method: RequestMethod.POST, path: '/' }, restore);
    assertRoutePermission(AdminLifetimeRestoreController.prototype.restore, { resource: 'subscriptions', action: 'edit' }, restore);
  });

  describe('over HTTP', () => {
    let application: INestApplication;
    const calls: Array<{ readonly ids: readonly string[]; readonly admin: unknown; readonly request: unknown }> = [];
    const censusAnswer: LifetimeCensusResponse = { rows: [], total: 0, truncated: false };

    before(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AdminLifetimeRestoreController],
        providers: [
          {
            provide: LifetimeRestoreService,
            useValue: {
              census: async () => censusAnswer,
              restore: async (ids: readonly string[], admin: unknown, requestMetadata: unknown) => {
                calls.push({ ids, admin, request: requestMetadata });
                return { results: [] };
              },
            },
          },
        ],
      })
        .overrideGuard(AdminJwtAuthGuard)
        .useValue({
          canActivate: (context: ExecutionContext): boolean => {
            context.switchToHttp().getRequest<{ user?: unknown }>().user = ADMIN;
            return true;
          },
        })
        .overrideGuard(RbacGuard)
        .useValue({ canActivate: (): boolean => true })
        .compile();
      application = moduleRef.createNestApplication();
      // What `main.ts` installs, word for word.
      application.setGlobalPrefix('api');
      application.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
      await application.init();
    });

    beforeEach(() => {
      calls.length = 0;
    });

    after(async () => {
      await application.close();
    });

    const post = (body: unknown) =>
      request(application.getHttpServer())
        .post(`/api/${BASE_PATH}`)
        .set('User-Agent', 'lifetime-spec/1')
        .set('X-Request-Id', 'req-lifetime-1')
        .send(body as object);

    it('GET answers the census', async () => {
      const response = await request(application.getHttpServer()).get(`/api/${BASE_PATH}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, censusAnswer);
    });

    it('POST hands the ids, the admin and the request to the service, with 200', async () => {
      const response = await post({ subscriptionIds: ['sub-a', 'sub-b'] });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { results: [] });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.ids, ['sub-a', 'sub-b']);
      assert.deepEqual(calls[0]!.admin, ADMIN);
      const metadata = calls[0]!.request as { requestId: string; remoteAddress: string | null; userAgent: string };
      assert.equal(metadata.requestId, 'req-lifetime-1');
      assert.equal(metadata.userAgent, 'lifetime-spec/1');
      assert.match(metadata.remoteAddress ?? '', /^(127\.0\.0\.1|::1)$/);
    });

    it(`accepts exactly ${LIFETIME_RESTORE_MAX_IDS} distinct ids`, async () => {
      assert.equal(LIFETIME_RESTORE_MAX_IDS, 200);
      const ids = Array.from({ length: 200 }, (_, index) => `sub-${index}`);
      const response = await post({ subscriptionIds: ids });
      assert.equal(response.status, 200);
      assert.equal(calls[0]?.ids.length, 200);
    });

    for (const [name, body] of [
      ['no body at all', {}],
      ['not a list', { subscriptionIds: 'sub-a' }],
      ['an empty list', { subscriptionIds: [] }],
      ['201 ids', { subscriptionIds: Array.from({ length: 201 }, (_, index) => `sub-${index}`) }],
      ['the same id twice', { subscriptionIds: ['sub-a', 'sub-b', 'sub-a'] }],
      ['a number', { subscriptionIds: ['sub-a', 42] }],
      ['an empty id', { subscriptionIds: ['sub-a', ''] }],
      ['an id longer than 64 characters', { subscriptionIds: ['x'.repeat(65)] }],
      ['a field it does not know', { subscriptionIds: ['sub-a'], force: true }],
    ] as const) {
      it(`refuses ${name} with 400, and restores nothing`, async () => {
        const response = await post(body);
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(calls.length, 0);
      });
    }
  });
});
