import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma, QuestCompletionStatus, QuestType } from '@prisma/client';

import { QuestPartnerService } from '../src/modules/quests/services/quest-partner.service';

function partnerQuest(partner: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: 'cmphfcr6i007v01jg0lcu653h',
    type: QuestType.PARTNER_TASK,
    enabled: true,
    startAt: null,
    endAt: null,
    params: { partner },
    ...over,
  };
}

function makeService(cfg: {
  quest?: Record<string, unknown> | null;
  completion?: Record<string, unknown> | null;
  eligible?: boolean;
  secrets?: Record<string, string>;
  claimNonce?: boolean;
}) {
  const calls: Record<string, unknown[]> = { create: [], update: [], claimOnce: [] };
  const prisma = {
    user: { findUnique: async () => ({ id: 'user-1' }) },
    quest: { findUnique: async () => cfg.quest ?? partnerQuest({ method: 'manual_code', partnerSlug: 'acme', code: 'PROMO2026' }) },
    questCompletion: {
      findUnique: async () => cfg.completion ?? null,
      create: async (a: unknown) => {
        calls.create.push(a);
        return { id: 'c1' };
      },
      update: async (a: unknown) => {
        calls.update.push(a);
        return { id: 'c1' };
      },
    },
  };
  const progress = { isEligible: async () => cfg.eligible ?? true };
  const cache = {
    claimOnce: async (key: string) => {
      calls.claimOnce.push(key);
      return cfg.claimNonce ?? true;
    },
  };
  const registry = {
    getQuestPartnerSecretsRuntime: async () => cfg.secrets ?? { acme: 'partner-secret' },
  };
  const service = new QuestPartnerService(prisma as never, progress as never, cache as never, registry as never);
  return { service, calls };
}

describe('QuestPartnerService', () => {
  it('completes a manual_code quest when the code matches (timing-safe)', async () => {
    const { service, calls } = makeService({});
    const result = await service.verifyManualCode({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', code: 'PROMO2026' });
    assert.equal(result.state, 'COMPLETED');
    assert.equal(calls.create.length, 1);
  });

  it('rejects a manual_code quest when the code does not match — no completion', async () => {
    const { service, calls } = makeService({});
    await assert.rejects(
      () => service.verifyManualCode({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', code: 'WRONG' }),
      /code/i,
    );
    assert.equal(calls.create.length, 0);
  });

  it('never reopens a CLAIMED completion on a repeated manual code', async () => {
    const { service, calls } = makeService({
      completion: { id: 'c1', status: QuestCompletionStatus.CLAIMED },
    });
    const result = await service.verifyManualCode({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', code: 'PROMO2026' });
    assert.equal(result.state, 'CLAIMED');
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
  });

  it('applies a postback completion after signature+nonce were verified by the controller', async () => {
    const { service, calls } = makeService({
      quest: partnerQuest({ method: 'postback', partnerSlug: 'acme' }),
    });
    const result = await service.applyPostback({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h' });
    assert.equal(result.state, 'COMPLETED');
    assert.equal(calls.create.length, 1);
  });

  it('completes a timed_visit only after the minimum dwell has elapsed', async () => {
    const { service, calls } = makeService({
      quest: partnerQuest({ method: 'timed_visit', partnerSlug: 'acme', landingUrl: 'https://a.example', minDwellSeconds: 30 }),
    });
    // Started 40s ago → satisfied.
    const startedAt = Date.now() - 40_000;
    const ok = await service.completeTimedVisit({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', startedAtMs: startedAt });
    assert.equal(ok.state, 'COMPLETED');
    assert.equal(calls.create.length, 1);
  });

  it('rejects a timed_visit that returns too early', async () => {
    const { service, calls } = makeService({
      quest: partnerQuest({ method: 'timed_visit', partnerSlug: 'acme', landingUrl: 'https://a.example', minDwellSeconds: 30 }),
    });
    await assert.rejects(
      () => service.completeTimedVisit({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', startedAtMs: Date.now() - 5_000 }),
      /dwell|too early|not/i,
    );
    assert.equal(calls.create.length, 0);
  });

  it('resolves the per-partner secret for a postback callback', async () => {
    const { service } = makeService({ quest: partnerQuest({ method: 'postback', partnerSlug: 'acme' }) });
    const secret = await service.resolveCallbackSecret('cmphfcr6i007v01jg0lcu653h', 'acme');
    assert.equal(secret, 'partner-secret');
  });

  it('returns null secret when the slug does not match the quest config', async () => {
    const { service } = makeService({ quest: partnerQuest({ method: 'postback', partnerSlug: 'acme' }) });
    const secret = await service.resolveCallbackSecret('cmphfcr6i007v01jg0lcu653h', 'evilcorp');
    assert.equal(secret, null);
  });

  it('is idempotent on a concurrent completion create (P2002 → COMPLETED)', async () => {
    const prisma = {
      user: { findUnique: async () => ({ id: 'user-1' }) },
      quest: { findUnique: async () => partnerQuest({ method: 'manual_code', partnerSlug: 'acme', code: 'PROMO2026' }) },
      questCompletion: {
        findUnique: async () => null,
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7.8.0' });
        },
      },
    };
    const progress = { isEligible: async () => true };
    const cache = { claimOnce: async () => true };
    const registry = { getQuestPartnerSecretsRuntime: async () => ({ acme: 'partner-secret' }) };
    const service = new QuestPartnerService(prisma as never, progress as never, cache as never, registry as never);
    const result = await service.verifyManualCode({ userRef: '42', questId: 'cmphfcr6i007v01jg0lcu653h', code: 'PROMO2026' });
    assert.equal(result.state, 'COMPLETED');
  });
});
