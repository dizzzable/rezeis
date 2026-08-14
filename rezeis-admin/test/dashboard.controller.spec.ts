import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminDashboardController } from '../src/modules/dashboard/controllers/admin-dashboard.controller';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
  type RouteHandler,
  type RoutePermission,
} from './helpers/controller-routes';

/** Every dashboard read sits behind the same gate. */
const DASHBOARD_VIEW: RoutePermission = { resource: 'dashboard', action: 'view' };

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/dashboard';

describe('AdminDashboardController', () => {
  it('exposes the current guarded admin dashboard routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminDashboardController), BASE_PATH);
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminDashboardController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
    // Read off the class instead of hand-listed, so a route added to the
    // controller fails here rather than slipping past an outdated list — which
    // is exactly how `system-health/reiwa` escaped this suite.
    assertRouteHandlers(AdminDashboardController, [
      'getReiwaSystemHealth',
      'getSummary',
      'getSystemHealth',
    ]);

    const routes: readonly DashboardRoute[] = [
      { handler: AdminDashboardController.prototype.getSummary, path: 'summary' },
      { handler: AdminDashboardController.prototype.getSystemHealth, path: 'system-health' },
      {
        handler: AdminDashboardController.prototype.getReiwaSystemHealth,
        path: 'system-health/reiwa',
      },
    ];
    for (const route of routes) {
      const label = routeLabel(BASE_PATH, RequestMethod.GET, route.path);
      assertRoute(route.handler, { method: RequestMethod.GET, path: route.path }, label);
      assertRoutePermission(route.handler, DASHBOARD_VIEW, label);
    }
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The two are not the same check: the
    // enumeration forces a new route to be noticed, but it is satisfied by
    // adding a name to it — and a route that never gets a row here is one
    // `RbacGuard` waves through (`rbac.guard.ts:41`), open to any signed-in
    // admin rather than refused. No dashboard route is exempt, hence no list.
    assertEveryRouteGuarded(AdminDashboardController);
  });

  it('delegates summary and system-health reads without response wrapping', async () => {
    const calls: string[] = [];
    const summary = {
      checkedAt: '2026-04-24T12:00:00.000Z',
      users: { total: 1, blocked: 0, recentRegistered7d: 1 },
      subscriptions: { active: 1, limited: 0, expired: 0, expiring7d: 1 },
      transactions: { completed: 1, pending: 0, failed: 0, grossVolume: '10.00' },
      operations: { broadcastDrafts: 1, importDryRunAvailable: true },
      financeOps: {
        refundRequests: 0,
        executedRefunds: 0,
        correctionNotes: 0,
        correctionRequests: 0,
        disputeRecords: 0,
        reconciliationExceptions: 0,
      },
      operationsTimeline: [],
      financeOpsTimeline: [],
      attentionItems: [],
      metrics: [],
    };
    const health = { checkedAt: '2026-04-24T12:00:00.000Z', status: 'ok' };
    const controller = new AdminDashboardController(
      {
        getSummary: async () => {
          calls.push('summary');
          return summary;
        },
      } as never,
      {
        getSystemHealth: async () => {
          calls.push('system-health');
          return health;
        },
      } as never,
    );

    assert.deepStrictEqual(await controller.getSummary(), summary);
    assert.deepStrictEqual(await controller.getSystemHealth(), health);
    assert.deepStrictEqual(calls, ['summary', 'system-health']);
  });
});

/** A dashboard route as this spec states it; every one of them is a `GET`. */
interface DashboardRoute {
  readonly handler: RouteHandler;
  readonly path: string;
}
