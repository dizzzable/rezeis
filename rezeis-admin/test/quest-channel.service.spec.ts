import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Prisma,
  QuestCompletionStatus,
  QuestType,
} from '@prisma/client';

import { QuestChannelService } from '../src/modules/quests/services/quest-channel.service';

interface Setup {
  readonly quest?: Record<string, unknown> | null;
  readonly user?: { readonly id: string } | null;
  readonly completion?: Record<string, unknown> | null;
  readonly eligible?: boolean;
}

function makeService(setup: Setup = {}) {
  const calls: Record<string, unknown[]> = {
    completionCreate: [],
    completionUpdate: [],
  };
  const prisma = {
    quest: { findUnique: async () => setup.quest ?? channelQuest() },
    user: {
      findUnique: async () => setup.user ?? { id: 'user-1' },
      count: async () => (setup.eligible ?? true ? 1 : 0),
    },
    questCompletion: {
      findUnique: async () => setup.completion ?? null,
      create: async (args: unknown) => {
        calls.completionCreate.push(args);
        return { id: 'completion-1' };
      },
      update: async (args: unknown) => {
        calls.completionUpdate.push(args);
        return { id: 'completion-1' };
      },
    },
  };
  const progress = { isEligible: async () => setup.eligible ?? true };
  return {
    service: new QuestChannelService(prisma as never, progress as never),
    calls,
  };
}

function channelQuest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'quest-channel-1',
    type: QuestType.SUBSCRIBE_CHANNEL,
    enabled: true,
    startAt: null,
    endAt: null,
    audienceFilter: null,
    params: {
      channelId: '-1001234567890',
      channelLink: 'https://t.me/+RezeisPrivateInvite',
    },
    ...overrides,
  };
}

describe('QuestChannelService', () => {
  it('resolves Telegram identity server-side and creates a verified completed completion', async () => {
    const { service, calls } = makeService();

    const result = await service.verifyMembership({
      telegramId: '123456789',
      questId: 'quest-channel-1',
    });

    assert.deepStrictEqual(result, { state: 'COMPLETED' });
    const data = (calls.completionCreate[0] as { data: Record<string, unknown> }).data;
    assert.equal(data.questId, 'quest-channel-1');
    assert.equal(data.userId, 'user-1');
    assert.equal(data.status, QuestCompletionStatus.COMPLETED);
    assert.ok(data.completedAt instanceof Date);
    assert.ok(data.verifiedAt instanceof Date);
  });

  it('returns only server-derived channel metadata for the bot after identity resolution', async () => {
    const { service } = makeService();

    const target = await service.getVerificationTarget({
      telegramId: '123456789',
      questId: 'quest-channel-1',
    });

    assert.deepStrictEqual(target, {
      questId: 'quest-channel-1',
      chatId: '-1001234567890',
      joinUrl: 'https://t.me/+RezeisPrivateInvite',
    });
  });

  it('returns bounded server-derived candidates for bot-owned membership rechecks', async () => {
    const prisma = {
      questCompletion: {
        findMany: async () => [
          {
            questId: 'quest-channel-1',
            user: { telegramId: 123456789n },
            quest: channelQuest(),
          },
          {
            questId: 'bad-config',
            user: { telegramId: 987654321n },
            quest: channelQuest({ params: { channelLink: 'https://example.com/not-telegram' } }),
          },
        ],
      },
    };
    const service = new QuestChannelService(prisma as never, {} as never);

    const candidates = await service.listRecheckCandidates();

    assert.deepStrictEqual(candidates, [
      {
        questId: 'quest-channel-1',
        telegramId: '123456789',
        chatId: '-1001234567890',
        joinUrl: 'https://t.me/+RezeisPrivateInvite',
      },
    ]);
  });

  it('treats a concurrent completion create as an idempotent repeated callback', async () => {
    const calls: unknown[] = [];
    const prisma = {
      quest: { findUnique: async () => channelQuest() },
      user: {
        findUnique: async () => ({ id: 'user-1' }),
        count: async () => 1,
      },
      questCompletion: {
        findUnique: async () => {
          calls.push('find');
          return calls.filter((call) => call === 'find').length === 1
            ? null
            : { id: 'completion-1', status: QuestCompletionStatus.COMPLETED };
        },
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: '7.8.0',
          });
        },
        update: async () => undefined,
      },
    };
    const service = new QuestChannelService(prisma as never, { isEligible: async () => true } as never);

    const result = await service.verifyMembership({ telegramId: '123456789', questId: 'quest-channel-1' });

    assert.deepStrictEqual(result, { state: 'COMPLETED' });
  });

  it('does not create a completion when the resolved user is outside the quest audience', async () => {
    const { service, calls } = makeService({ eligible: false });

    await assert.rejects(
      () => service.verifyMembership({ telegramId: '123456789', questId: 'quest-channel-1' }),
      { name: 'BadRequestException', message: 'Quest is not available for this user' },
    );
    assert.deepStrictEqual(calls.completionCreate, []);
  });

  it('rejects a channel verify when the quest configuration is not verifiable', async () => {
    const { service, calls } = makeService({
      quest: channelQuest({ params: { channelLink: 'https://t.me/+inviteOnly' } }),
    });

    await assert.rejects(
      () => service.verifyMembership({ telegramId: '123456789', questId: 'quest-channel-1' }),
      { name: 'BadRequestException', message: 'Quest channel is not configured for verification' },
    );
    assert.deepStrictEqual(calls.completionCreate, []);
  });

  it('never re-opens a claimed completion on a repeated successful callback', async () => {
    const { service, calls } = makeService({
      completion: { id: 'completion-1', status: QuestCompletionStatus.CLAIMED },
    });

    const result = await service.verifyMembership({
      telegramId: '123456789',
      questId: 'quest-channel-1',
    });

    assert.deepStrictEqual(result, { state: 'CLAIMED' });
    assert.deepStrictEqual(calls.completionCreate, []);
    assert.deepStrictEqual(calls.completionUpdate, []);
  });

  it('reverts an unclaimed completion when a periodic membership recheck is negative', async () => {
    const { service, calls } = makeService({
      completion: {
        id: 'completion-1',
        status: QuestCompletionStatus.COMPLETED,
        verifiedAt: new Date('2026-07-11T10:00:00.000Z'),
      },
    });

    const result = await service.recordRecheck({
      telegramId: '123456789',
      questId: 'quest-channel-1',
      isMember: false,
    });

    assert.deepStrictEqual(result, { state: 'IN_PROGRESS' });
    assert.deepStrictEqual(calls.completionUpdate, [
      {
        where: { id: 'completion-1' },
        data: {
          status: QuestCompletionStatus.IN_PROGRESS,
          completedAt: null,
          verifiedAt: null,
        },
      },
    ]);
  });
});
