import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalQuestPartnerController } from '../src/modules/quests/controllers/internal-quest-partner.controller';

describe('InternalQuestPartnerController', () => {
  it('exposes admin-guarded manual-code + timed-visit routes for the BFF', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestPartnerController),
      'internal/quests/partner',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalQuestPartnerController),
      [InternalAdminAuthGuard],
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestPartnerController.prototype.verifyCode),
      'code',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalQuestPartnerController.prototype.verifyCode),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestPartnerController.prototype.completeVisit),
      'visit/complete',
    );
  });

  it('forwards manual code verification with server-trusted identity', async () => {
    const calls: unknown[] = [];
    const controller = new InternalQuestPartnerController({
      verifyManualCode: async (input: unknown) => {
        calls.push(input);
        return { state: 'COMPLETED' };
      },
      completeTimedVisit: async () => ({ state: 'COMPLETED' }),
    } as never);

    const result = await controller.verifyCode({
      userRef: '42',
      questId: 'cmphfcr6i007v01jg0lcu653h',
      code: 'PROMO2026',
    });

    assert.deepStrictEqual(calls, [
      { userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', code: 'PROMO2026' },
    ]);
    assert.deepStrictEqual(result, { state: 'COMPLETED' });
  });
});
