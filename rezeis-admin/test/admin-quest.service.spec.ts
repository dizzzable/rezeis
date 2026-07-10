import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestType, UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { QuestService } from '../src/modules/quests/services/quest.service';

describe('QuestService', () => {
  it('maps quest records into the localized service shape', async () => {
    const service = new QuestService({
      quest: {
        findMany: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
            take: 200,
          });
          return [questRecord()];
        },
      },
    } as never);

    const [quest] = await service.list();
    assert.equal(quest.type, QuestType.LINK_TELEGRAM);
    assert.deepStrictEqual(quest.title, { ru: 'Привяжи Telegram', en: 'Link Telegram' });
    assert.equal(quest.rewardAmount, 3);
    assert.equal(quest.audienceFilter, null);
    assert.equal(quest.startAt, null);
  });

  it('creates a quest with the next display order and admin id', async () => {
    const createCalls: unknown[] = [];
    const service = new QuestService({
      quest: {
        aggregate: async () => ({ _max: { order: 4 } }),
        create: async (args: unknown) => {
          createCalls.push(args);
          return questRecord();
        },
      },
    } as never);

    await service.create({
      dto: {
        type: QuestType.LINK_TELEGRAM,
        title: { ru: 'Привяжи Telegram', en: 'Link Telegram' },
        rewardType: 'POINTS',
        rewardAmount: 3,
      },
      currentAdmin: currentAdmin(),
    });

    const data = (createCalls[0] as { data: Record<string, unknown> }).data;
    assert.equal(data.order, 5);
    assert.equal(data.createdBy, 'admin-1');
    assert.equal(data.daysFallback, 'MINT_PROMOCODE');
    assert.deepStrictEqual(data.title, { ru: 'Привяжи Telegram', en: 'Link Telegram' });
  });

  it('rejects a campaign window whose endAt is not after startAt', async () => {
    const service = new QuestService({ quest: {} } as never);
    await assert.rejects(
      () =>
        service.create({
          dto: {
            type: QuestType.INVITE_FRIENDS,
            title: { ru: 'a', en: 'a' },
            rewardType: 'POINTS',
            startAt: '2026-07-10T12:00:00.000Z',
            endAt: '2026-07-10T11:00:00.000Z',
          },
          currentAdmin: currentAdmin(),
        }),
      { name: 'BadRequestException', message: 'endAt must be after startAt' },
    );
  });

  it('rejects a DAYS→GRANT_TRIAL quest created without a reward plan', async () => {
    const service = new QuestService({ quest: {} } as never);
    await assert.rejects(
      () =>
        service.create({
          dto: {
            type: QuestType.LINK_TELEGRAM,
            title: { ru: 'a', en: 'a' },
            rewardType: 'DAYS',
            rewardAmount: 3,
            daysFallback: 'GRANT_TRIAL',
          },
          currentAdmin: currentAdmin(),
        }),
      { name: 'BadRequestException', message: 'A DAYS reward with GRANT_TRIAL fallback requires a reward plan' },
    );
  });

  it('rejects oversized quest params', async () => {
    const service = new QuestService({ quest: {} } as never);
    const huge = { blob: 'x'.repeat(5000) };
    await assert.rejects(
      () =>
        service.create({
          dto: {
            type: QuestType.LINK_TELEGRAM,
            title: { ru: 'a', en: 'a' },
            rewardType: 'POINTS',
            rewardAmount: 1,
            params: huge,
          },
          currentAdmin: currentAdmin(),
        }),
      { name: 'BadRequestException', message: 'Quest params are too large (max 4 KB)' },
    );
  });

  it('rejects creating a quest type with no completion path (Phase A gate)', async () => {
    const service = new QuestService({ quest: {} } as never);
    for (const type of [QuestType.SUBSCRIBE_CHANNEL, QuestType.PARTNER_TASK, QuestType.CUSTOM]) {
      await assert.rejects(
        () =>
          service.create({
            dto: {
              type,
              title: { ru: 'a', en: 'a' },
              rewardType: 'POINTS',
              rewardAmount: 1,
            },
            currentAdmin: currentAdmin(),
          }),
        { name: 'BadRequestException', message: 'This quest type is not available yet' },
      );
    }
  });

  it('patches only provided fields and retains history on disable', async () => {
    const updateCalls: unknown[] = [];
    const service = new QuestService({
      quest: {
        findUnique: async () => ({
          id: 'q1',
          type: QuestType.LINK_TELEGRAM,
          startAt: null,
          endAt: null,
          rewardType: 'POINTS',
          daysFallback: 'MINT_PROMOCODE',
          rewardPlanId: null,
        }),
        update: async (args: unknown) => {
          updateCalls.push(args);
          return questRecord({ enabled: false });
        },
      },
    } as never);

    const result = await service.update('q1', { enabled: false });
    const data = (updateCalls[0] as { data: Record<string, unknown> }).data;
    // Only `enabled` is patched — no destructive reset of other fields.
    assert.deepStrictEqual(Object.keys(data), ['enabled']);
    assert.equal(data.enabled, false);
    // Disabling keeps the row (history retained), just flips the flag.
    assert.equal(result.enabled, false);
  });

  it('throws NotFound when updating a missing quest', async () => {
    const service = new QuestService({
      quest: { findUnique: async () => null },
    } as never);
    await assert.rejects(() => service.update('missing', { enabled: true }), {
      name: 'NotFoundException',
    });
  });

  it('reorders quests by index', async () => {
    const updates: Array<{ id: string; order: number }> = [];
    const service = new QuestService({
      $transaction: async (ops: unknown[]) => Promise.all(ops),
      quest: {
        update: (args: { where: { id: string }; data: { order: number } }) => {
          updates.push({ id: args.where.id, order: args.data.order });
          return Promise.resolve(questRecord());
        },
        findMany: async () => [],
      },
    } as never);

    await service.reorder(['b', 'a', 'c']);
    assert.deepStrictEqual(updates, [
      { id: 'b', order: 0 },
      { id: 'a', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });
});

function currentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'root',
    email: null,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
}

function questRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q1',
    type: QuestType.LINK_TELEGRAM,
    title: { ru: 'Привяжи Telegram', en: 'Link Telegram' },
    description: { ru: '', en: '' },
    iconKind: 'PRESET',
    iconRef: 'telegram',
    rewardType: 'POINTS',
    rewardAmount: 3,
    rewardPlanId: null,
    daysFallback: 'MINT_PROMOCODE',
    audienceFilter: null,
    repeat: 'ONCE',
    cooldownHours: null,
    startAt: null,
    endAt: null,
    maxCompletionsGlobal: null,
    issuedCount: 0,
    params: null,
    order: 0,
    enabled: true,
    createdBy: 'admin-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}
