import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestType } from '@prisma/client';

import { QuestProgressService } from '../src/modules/quests/services/quest-progress.service';

function makeService(cfg: {
  quests: Array<Record<string, unknown>>;
  completion?: Record<string, unknown> | null;
  eligibleCount?: number;
  qualifiedCount?: number;
}): {
  service: QuestProgressService;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = { create: [], update: [] };
  const prisma = {
    quest: { findMany: async () => cfg.quests },
    referral: { count: async () => cfg.qualifiedCount ?? 0 },
    user: { count: async () => cfg.eligibleCount ?? 1 },
    questCompletion: {
      findUnique: async () => cfg.completion ?? null,
      create: async (a: unknown) => {
        calls.create.push(a);
        return {};
      },
      update: async (a: unknown) => {
        calls.update.push(a);
        return {};
      },
    },
  };
  return { service: new QuestProgressService(prisma as never), calls };
}

function quest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q1', type: QuestType.LINK_TELEGRAM, enabled: true, audienceFilter: null,
    params: null, startAt: null, endAt: null, ...overrides,
  };
}

describe('QuestProgressService', () => {
  it('creates a COMPLETED completion on first detection', async () => {
    const { service, calls } = makeService({ quests: [quest()], completion: null });
    await service.markCompleted(QuestType.LINK_TELEGRAM, 'u1');
    assert.equal(calls.create.length, 1);
    const data = (calls.create[0] as { data: { status: string; completedAt: unknown } }).data;
    assert.equal(data.status, 'COMPLETED');
    assert.ok(data.completedAt);
  });

  it('is idempotent — does not touch an already COMPLETED completion', async () => {
    const { service, calls } = makeService({
      quests: [quest()],
      completion: { id: 'c1', status: 'COMPLETED' },
    });
    await service.markCompleted(QuestType.LINK_TELEGRAM, 'u1');
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
  });

  it('never re-opens a CLAIMED completion', async () => {
    const { service, calls } = makeService({
      quests: [quest()],
      completion: { id: 'c1', status: 'CLAIMED' },
    });
    await service.markCompleted(QuestType.LINK_TELEGRAM, 'u1');
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
  });

  it('skips users who do not match the audience filter', async () => {
    const { service, calls } = makeService({
      quests: [quest({ audienceFilter: { subscription: ['EXPIRED'] } })],
      completion: null,
      eligibleCount: 0, // user.count returns 0 → not eligible
    });
    await service.markCompleted(QuestType.LINK_TELEGRAM, 'u1');
    assert.equal(calls.create.length, 0);
  });

  it('keeps INVITE_FRIENDS IN_PROGRESS below the friend threshold', async () => {
    const { service, calls } = makeService({
      quests: [quest({ type: QuestType.INVITE_FRIENDS, params: { requiredFriends: 3 } })],
      completion: null,
      qualifiedCount: 2,
    });
    await service.advanceInvite('u1');
    const data = (calls.create[0] as { data: { status: string; progress: number } }).data;
    assert.equal(data.status, 'IN_PROGRESS');
    assert.equal(data.progress, 2);
  });

  it('completes INVITE_FRIENDS once the friend threshold is reached', async () => {
    const { service, calls } = makeService({
      quests: [quest({ type: QuestType.INVITE_FRIENDS, params: { requiredFriends: 3 } })],
      completion: null,
      qualifiedCount: 3,
    });
    await service.advanceInvite('u1');
    const data = (calls.create[0] as { data: { status: string; progress: number } }).data;
    assert.equal(data.status, 'COMPLETED');
    assert.equal(data.progress, 3);
  });
});
