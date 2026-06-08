import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalSubscriptionsController } from '../src/modules/subscriptions/controllers/internal-subscriptions.controller';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

describe('InternalSubscriptionsController', () => {
  it('exposes action-policy and quote internal routes', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalSubscriptionsController),
      'internal/subscriptions',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalSubscriptionsController.prototype.getActionPolicy),
      'action-policy',
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        InternalSubscriptionsController.prototype.getActionPolicy,
      ),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalSubscriptionsController.prototype.getQuote),
      'quote',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalSubscriptionsController.prototype.getQuote),
      RequestMethod.POST,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalSubscriptionsController),
      [InternalAdminAuthGuard],
    );
  });

  it('delegates action-policy and quote calls unchanged', async () => {
    const calls: unknown[] = [];
    const controller = new InternalSubscriptionsController({
      getActionPolicy: async (input: unknown) => {
        calls.push(['policy', input]);
        return { actions: { NEW: true } };
      },
      getQuote: async (input: unknown) => {
        calls.push(['quote', input]);
        return { isEligible: true };
      },
    } as never as SubscriptionQuoteService, {} as never);

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
