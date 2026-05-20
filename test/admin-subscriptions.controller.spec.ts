import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminSubscriptionsController } from '../src/modules/subscriptions/controllers/admin-subscriptions.controller';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

describe('AdminSubscriptionsController', () => {
  it('exposes action-policy and quote admin routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController), 'admin/subscriptions');
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
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminSubscriptionsController),
      [AdminJwtAuthGuard],
    );
  });

  it('delegates action-policy and quote calls unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new AdminSubscriptionsController({
      getActionPolicy: async (input: unknown) => {
        calls.push(['policy', input]);
        return { actions: { NEW: true } };
      },
      getQuote: async (input: unknown) => {
        calls.push(['quote', input]);
        return { isEligible: true };
      },
    } as never as SubscriptionQuoteService);

    assert.deepStrictEqual(await controller.getActionPolicy({ userId: 'user-1' } as never), {
      actions: { NEW: true },
    });
    assert.deepStrictEqual(await controller.getQuote({ userId: 'user-1' } as never), {
      isEligible: true,
    });
    assert.deepStrictEqual(calls, [
      ['policy', { userId: 'user-1' }],
      ['quote', { userId: 'user-1' }],
    ]);
  });
});
