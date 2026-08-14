import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminSubscriptionsController } from '../src/modules/subscriptions/controllers/admin-subscriptions.controller';
import { AdminSubscriptionsListService } from '../src/modules/subscriptions/services/admin-subscriptions-list.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/subscriptions';

describe('AdminSubscriptionsController', () => {
  it('exposes list, stats, action-policy and quote admin routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController), BASE_PATH);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminSubscriptionsController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    // Read off the class instead of remembered here. MEDIUM #16 below was
    // exactly this failure once already: two endpoints reached production with
    // no `@RequirePermission`, and the spec that lists the routes by hand had
    // nothing to say about them because they were never listed. A fifth route
    // added tomorrow lands in the same blind spot without this line.
    assertRouteHandlers(AdminSubscriptionsController, [
      'list',
      'getStats',
      'getActionPolicy',
      'getQuote',
    ]);

    const listRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (list subscriptions)`;
    assertRoute(
      AdminSubscriptionsController.prototype.list,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminSubscriptionsController.prototype.list,
      { resource: 'subscriptions', action: 'view' },
      listRoute,
    );

    const statsRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, 'stats')} (subscription stats)`;
    assertRoute(
      AdminSubscriptionsController.prototype.getStats,
      { method: RequestMethod.GET, path: 'stats' },
      statsRoute,
    );
    assertRoutePermission(
      AdminSubscriptionsController.prototype.getStats,
      { resource: 'subscriptions', action: 'view' },
      statsRoute,
    );

    // MEDIUM #16: action-policy + quote must require subscriptions:view — an
    // endpoint with no @RequirePermission is allowed for any authenticated
    // admin by the RbacGuard.
    const actionPolicyRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, 'action-policy')} (allowed actions)`;
    assertRoute(
      AdminSubscriptionsController.prototype.getActionPolicy,
      { method: RequestMethod.POST, path: 'action-policy' },
      actionPolicyRoute,
    );
    assertRoutePermission(
      AdminSubscriptionsController.prototype.getActionPolicy,
      { resource: 'subscriptions', action: 'view' },
      actionPolicyRoute,
    );

    const quoteRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, 'quote')} (price quote)`;
    assertRoute(
      AdminSubscriptionsController.prototype.getQuote,
      { method: RequestMethod.POST, path: 'quote' },
      quoteRoute,
    );
    assertRoutePermission(
      AdminSubscriptionsController.prototype.getQuote,
      { resource: 'subscriptions', action: 'view' },
      quoteRoute,
    );
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The two are not the same check, and this
    // controller is where the difference already cost something: MEDIUM #16 was
    // two routes carrying no `@RequirePermission`, which `RbacGuard` does not
    // refuse but waves through (`rbac.guard.ts:41`). An enumeration alone is
    // satisfied by adding the new name to the list; only this line insists the
    // route also be gated. No route here is exempt, hence no list.
    assertEveryRouteGuarded(AdminSubscriptionsController);
  });

  it('delegates list, stats, action-policy and quote calls unchanged', async () => {
    const calls: unknown[] = [];
    const quoteService = {
      getActionPolicy: async (input: unknown) => {
        calls.push(['policy', input]);
        return { actions: { NEW: true } };
      },
      getQuote: async (input: unknown) => {
        calls.push(['quote', input]);
        return { isEligible: true };
      },
    } as never as SubscriptionQuoteService;
    const listService = {
      list: async (input: unknown) => {
        calls.push(['list', input]);
        return { items: [], total: 0 };
      },
      getStats: async () => {
        calls.push(['stats']);
        return { total: 0, byStatus: {}, trialCount: 0, expiringIn7d: 0, generatedAt: 'now' };
      },
    } as never as AdminSubscriptionsListService;

    const controller = new AdminSubscriptionsController(quoteService, listService);

    assert.deepStrictEqual(await controller.list({ limit: 10 } as never), { items: [], total: 0 });
    assert.deepStrictEqual(await controller.getStats(), {
      total: 0,
      byStatus: {},
      trialCount: 0,
      expiringIn7d: 0,
      generatedAt: 'now',
    });
    assert.deepStrictEqual(await controller.getActionPolicy({ userId: 'user-1' } as never), {
      actions: { NEW: true },
    });
    assert.deepStrictEqual(await controller.getQuote({ userId: 'user-1' } as never), {
      isEligible: true,
    });
    assert.deepStrictEqual(calls, [
      ['list', { limit: 10 }],
      ['stats'],
      ['policy', { userId: 'user-1' }],
      ['quote', { userId: 'user-1' }],
    ]);
  });
});
