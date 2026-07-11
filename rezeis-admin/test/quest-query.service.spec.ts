import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestType } from '@prisma/client';

import { QuestProgressService } from '../src/modules/quests/services/quest-progress.service';
import { QuestQueryService } from '../src/modules/quests/services/quest-query.service';

function makeService(cfg: {
  user: Record<string, unknown> | null;
  quests: Array<Record<string, unknown>>;
  completions: Array<Record<string, unknown>>;
  eligible?: boolean;
}): QuestQueryService {
  const prisma = {
    user: {
      findUnique: async () => cfg.user,
      count: async () => (cfg.eligible === false ? 0 : 1),
    },
    quest: { findMany: async () => cfg.quests },
    questCompletion: { findMany: async () => cfg.completions },
  };
  const progress = new QuestProgressService(prisma as never);
  return new QuestQueryService(prisma as never, progress);
}

function quest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q1', type: QuestType.LINK_TELEGRAM, enabled: true,
    title: { ru: 'т', en: 't' }, description: { ru: '', en: '' },
    iconKind: 'PRESET', iconRef: 'telegram', rewardType: 'POINTS', rewardAmount: 3,
    audienceFilter: null, params: null, startAt: null, endAt: null,
    maxCompletionsGlobal: null, issuedCount: 0, order: 0, createdAt: new Date(),
    ...overrides,
  };
}

const user = { points: 42, telegramId: null, webAccount: { emailVerifiedAt: null } };

describe('QuestQueryService.listForUser', () => {
  it('returns the points balance and an actionable quest with no completion', async () => {
    const svc = makeService({ user, quests: [quest()], completions: [] });
    const res = await svc.listForUser('u1');
    assert.equal(res.pointsBalance, 42);
    assert.equal(res.quests.length, 1);
    assert.equal(res.quests[0].claimable, false);
    assert.equal(res.quests[0].status, 'IN_PROGRESS');
  });

  it('auto-hides LINK_TELEGRAM when the user already linked Telegram and has no pending completion', async () => {
    const svc = makeService({
      user: { ...user, telegramId: 12345n },
      quests: [quest()],
      completions: [],
    });
    const res = await svc.listForUser('u1');
    assert.equal(res.quests.length, 0);
  });

  it('shows a COMPLETED completion as claimable even when the action is done', async () => {
    const svc = makeService({
      user: { ...user, telegramId: 12345n },
      quests: [quest()],
      completions: [{ questId: 'q1', status: 'COMPLETED', progress: 0 }],
    });
    const res = await svc.listForUser('u1');
    assert.equal(res.quests.length, 1);
    assert.equal(res.quests[0].claimable, true);
    assert.equal(res.quests[0].status, 'COMPLETED');
  });

  it('hides a CLAIMED quest', async () => {
    const svc = makeService({
      user,
      quests: [quest()],
      completions: [{ questId: 'q1', status: 'CLAIMED', progress: 0 }],
    });
    const res = await svc.listForUser('u1');
    assert.equal(res.quests.length, 0);
  });

  it('hides a quest whose global budget is exhausted', async () => {
    const svc = makeService({
      user,
      quests: [quest({ maxCompletionsGlobal: 10, issuedCount: 10 })],
      completions: [],
    });
    const res = await svc.listForUser('u1');
    assert.equal(res.quests.length, 0);
  });

  it('hides an audience-filtered quest from a non-matching user (no completion)', async () => {
    const svc = makeService({
      user,
      quests: [quest({ audienceFilter: { subscription: ['EXPIRED'] } })],
      completions: [],
      eligible: false,
    });
    const res = await svc.listForUser('u1');
    assert.equal(res.quests.length, 0);
  });

  it('exposes requiredFriends + progress for INVITE_FRIENDS', async () => {
    const svc = makeService({
      user,
      quests: [quest({ type: QuestType.INVITE_FRIENDS, params: { requiredFriends: 3 } })],
      completions: [{ questId: 'q1', status: 'IN_PROGRESS', progress: 1 }],
    })
    const res = await svc.listForUser('u1')
    assert.equal(res.quests[0].requiredFriends, 3)
    assert.equal(res.quests[0].progress, 1)
  })

  it('exposes only safe partner metadata for PARTNER_TASK (no secret / slug / code)', async () => {
    const svc = makeService({
      user,
      quests: [
        quest({
          type: QuestType.PARTNER_TASK,
          params: {
            partner: {
              method: 'timed_visit',
              partnerSlug: 'acme',
              code: 'SECRET-CODE',
              landingUrl: 'https://acme.example/land',
              minDwellSeconds: 30,
            },
          },
        }),
      ],
      completions: [],
    });
    const res = await svc.listForUser('u1');
    const item = res.quests[0] as unknown as Record<string, unknown>;
    assert.equal(item.partnerMethod, 'timed_visit');
    assert.equal(item.partnerUrl, 'https://acme.example/land');
    assert.equal(item.partnerVisitSeconds, 30);
    // Secrets / internal refs must never reach the cabinet.
    assert.equal(item.partnerSlug, undefined);
    assert.equal(item.code, undefined);
    assert.equal(item.partner, undefined);
    assert.equal(JSON.stringify(item).includes('SECRET-CODE'), false);
  });
});
