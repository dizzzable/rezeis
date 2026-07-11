import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { QuestPartnerCallbackController } from '../src/modules/quests/controllers/quest-partner-callback.controller';
import { QuestPartnerCallbackGuard } from '../src/modules/quests/guards/quest-partner-callback.guard';

describe('QuestPartnerCallbackController', () => {
  it('exposes a single public signed callback route guarded by the partner guard', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, QuestPartnerCallbackController),
      'internal/quests/partner',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, QuestPartnerCallbackController.prototype.callback),
      'callback',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, QuestPartnerCallbackController.prototype.callback),
      RequestMethod.POST,
    );
    const guards = Reflect.getMetadata(GUARDS_METADATA, QuestPartnerCallbackController) ?? [];
    assert.ok(
      guards.includes(QuestPartnerCallbackGuard),
      'callback must be protected by QuestPartnerCallbackGuard, not the global admin guard',
    );
  });

  it('forwards the resolved identity + quest id to applyPostback', async () => {
    const calls: unknown[] = [];
    const controller = new QuestPartnerCallbackController({
      applyPostback: async (input: unknown) => {
        calls.push(input);
        return { state: 'COMPLETED' };
      },
    } as never);

    const result = await controller.callback({
      partnerSlug: 'acme',
      questId: 'cmphfcr6i007v01jg0lcu653h',
      telegramId: '42',
      nonce: 'n-1',
    });

    assert.deepStrictEqual(calls, [
      { userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h' },
    ]);
    assert.deepStrictEqual(result, { state: 'COMPLETED' });
  });
});
