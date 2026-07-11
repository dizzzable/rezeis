import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalQuestChannelController } from '../src/modules/quests/controllers/internal-quest-channel.controller';

describe('InternalQuestChannelController', () => {
  it('exposes only HMAC-guarded bot channel verification routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalQuestChannelController), 'internal/quests/channel');
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalQuestChannelController),
      [InternalAdminAuthGuard],
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestChannelController.prototype.getTarget),
      'target',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalQuestChannelController.prototype.getTarget),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestChannelController.prototype.verify),
      'verify',
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalQuestChannelController.prototype.recordRecheck),
      'recheck',
    );
  });

  it('forwards only telegram identity and quest id to the authoritative service', async () => {
    const calls: unknown[] = [];
    const controller = new InternalQuestChannelController({
      getVerificationTarget: async (input: unknown) => {
        calls.push(input);
        return { questId: 'quest-1', chatId: '-1001234567890', joinUrl: 'https://t.me/rezeis' };
      },
      verifyMembership: async () => ({ state: 'COMPLETED' }),
      recordRecheck: async () => ({ state: 'IN_PROGRESS' }),
      listRecheckCandidates: async () => [],
    } as never);

    const result = await controller.getTarget({ telegramId: '123456789', questId: 'quest-1' });

    assert.deepStrictEqual(calls, [{ telegramId: '123456789', questId: 'quest-1' }]);
    assert.deepStrictEqual(result, {
      questId: 'quest-1',
      chatId: '-1001234567890',
      joinUrl: 'https://t.me/rezeis',
    });
  });
});
