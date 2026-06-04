import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminSubscriptionsController } from '../src/modules/subscriptions/controllers/admin-subscriptions.controller';
import { AdminSubscriptionsListService } from '../src/modules/subscriptions/services/admin-subscriptions-list.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

describe('AdminSubscriptionsController', () => {
  it('exposes list, stats, action-policy and quote admin routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController), 'admin/subscriptions');
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminSubscriptionsController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController.prototype.list),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminSubscriptionsController.prototype.list),
      RequestMethod.GET,
    );
    assertSubscriptionsViewRoute(AdminSubscriptionsController.prototype.list);
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController.prototype.getStats),
      'stats',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminSubscriptionsController.prototype.getStats),
      RequestMethod.GET,
    );
    assertSubscriptionsViewRoute(AdminSubscriptionsController.prototype.getStats);
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController.prototype.getActionPolicy),
      'action-policy',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminSubscriptionsController.prototype.getActionPolicy),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController.prototype.getQuote),
      'quote',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminSubscriptionsController.prototype.getQuote),
      RequestMethod.POST,
    );
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

function assertSubscriptionsViewRoute(method: unknown): void {
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'subscriptions', action: 'view' },
  ]);
}
