import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BroadcastAudience,
  BroadcastStatus,
  SubscriptionStatus,
  UserRole,
} from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';

describe('BroadcastService', () => {
  it('lists current broadcast rows in service-mapped safe shape', async () => {
    const service = new BroadcastService({
      broadcast: {
        findMany: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 200,
          });
          return [
            broadcastRecord({
              id: 'broadcast-1',
              status: BroadcastStatus.PROCESSING,
              audience: BroadcastAudience.ACTIVE_SUBSCRIBERS,
              audiencePlanId: 'plan-1',
              payload: {
                text: 'Hello subscribers',
                mediaType: 'photo',
                mediaFileId: 'telegram-file-id',
                parseMode: 'HTML',
              },
              totalCount: 5,
              successCount: 2,
              failedCount: 1,
              startedAt: new Date('2026-04-24T12:05:00.000Z'),
            }),
          ];
        },
      },
    } as never);

    assert.deepStrictEqual(await service.listDrafts(), [
      {
        id: 'broadcast-1',
        status: BroadcastStatus.PROCESSING,
        audience: BroadcastAudience.ACTIVE_SUBSCRIBERS,
        audiencePlanId: 'plan-1',
        audienceFilter: null,
        promoCode: null,
        payload: {
          title: null,
          text: 'Hello subscribers',
          mediaType: 'photo',
          mediaFileId: 'telegram-file-id',
          parseMode: 'HTML',
          emailEnabled: false,
          telegramChannelChatId: null,
        },
        totalCount: 5,
        successCount: 2,
        failedCount: 1,
        createdBy: 'admin-1',
        startedAt: '2026-04-24T12:05:00.000Z',
        completedAt: null,
        createdAt: '2026-04-24T12:00:00.000Z',
        updatedAt: '2026-04-24T12:10:00.000Z',
      },
    ]);
  });

  it('creates draft rows with the current payload contract and admin id', async () => {
    const createCalls: unknown[] = [];
    const service = new BroadcastService({
      broadcast: {
        create: async (args: unknown) => {
          createCalls.push(args);
          return broadcastRecord({
            audience: BroadcastAudience.TRIAL,
            payload: {
              text: 'Trial notice',
              mediaType: 'video',
              mediaFileId: 'video-file-id',
              parseMode: 'MarkdownV2',
            },
          });
        },
      },
    } as never);

    const result = await service.createDraft({
      dto: {
        audience: BroadcastAudience.TRIAL,
        payload: {
          text: 'Trial notice',
          mediaType: 'video',
          mediaFileId: 'video-file-id',
          parseMode: 'MarkdownV2',
        },
      },
      currentAdmin: currentAdmin(),
    });

    assert.deepStrictEqual(createCalls, [
      {
        data: {
          status: BroadcastStatus.DRAFT,
          audience: BroadcastAudience.TRIAL,
          audiencePlanId: null,
          promoCode: null,
          payload: {
            title: null,
            text: 'Trial notice',
            mediaType: 'video',
            mediaFileId: 'video-file-id',
            parseMode: 'MarkdownV2',
            emailEnabled: false,
            telegramChannelChatId: null,
          },
          createdBy: 'admin-1',
        },
      },
    ]);
    assert.equal(result.audience, BroadcastAudience.TRIAL);
    assert.deepStrictEqual(result.payload, {
      title: null,
      text: 'Trial notice',
      mediaType: 'video',
      mediaFileId: 'video-file-id',
      parseMode: 'MarkdownV2',
      emailEnabled: false,
      telegramChannelChatId: null,
    });
  });

  it('updates only draft broadcasts and merges payload patches', async () => {
    const updateCalls: unknown[] = [];
    const service = new BroadcastService({
      broadcast: {
        findUnique: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            where: { id: 'broadcast-1' },
            select: { id: true, status: true, payload: true, audiencePlanId: true },
          });
          return {
            id: 'broadcast-1',
            status: BroadcastStatus.DRAFT,
            payload: {
              text: 'Old text',
              mediaType: 'photo',
              mediaFileId: 'old-file-id',
              parseMode: 'HTML',
            },
            audiencePlanId: null,
          };
        },
        update: async (args: unknown) => {
          updateCalls.push(args);
          return broadcastRecord({
            id: 'broadcast-1',
            payload: {
              text: 'New text',
              mediaType: 'photo',
              mediaFileId: 'old-file-id',
              parseMode: 'HTML',
            },
          });
        },
      },
    } as never);

    const result = await service.updateDraft({
      broadcastId: 'broadcast-1',
      dto: { payload: { text: 'New text' } },
    });

    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'broadcast-1' },
        data: {
          audience: undefined,
          audiencePlanId: undefined,
          payload: {
            text: 'New text',
            mediaType: 'photo',
            mediaFileId: 'old-file-id',
            parseMode: 'HTML',
          },
        },
      },
    ]);
    assert.equal(result.payload.text, 'New text');
    assert.equal(result.payload.mediaFileId, 'old-file-id');
  });

  it('rejects updates for broadcasts that are no longer drafts', async () => {
    const service = new BroadcastService({
      broadcast: {
        findUnique: async () => ({
          id: 'broadcast-1',
          status: BroadcastStatus.PROCESSING,
          payload: {},
          audiencePlanId: null,
        }),
      },
    } as never);

    await assert.rejects(
      () => service.updateDraft({ broadcastId: 'broadcast-1', dto: { payload: { text: 'New' } } }),
      { name: 'NotFoundException', message: 'Only draft broadcasts can be updated' },
    );
  });

  it('previews every current audience with the unified recipient filter (matches delivery)', async () => {
    const countCalls: unknown[] = [];
    const broadcasts = new Map<string, BroadcastAudience>([
      ['all', BroadcastAudience.ALL],
      ['active', BroadcastAudience.ACTIVE_SUBSCRIBERS],
      ['expired', BroadcastAudience.EXPIRED],
      ['trial', BroadcastAudience.TRIAL],
      ['unsubscribed', BroadcastAudience.UNSUBSCRIBED],
    ]);
    const service = new BroadcastService({
      broadcast: {
        findUnique: async (args: { readonly where: { readonly id: string } }) => ({
          id: args.where.id,
          audience: broadcasts.get(args.where.id),
          audiencePlanId: null,
        }),
      },
      user: {
        count: async (args: unknown) => {
          countCalls.push(args);
          return countCalls.length;
        },
      },
    } as never);

    const previews = await Promise.all([
      service.previewAudience('all'),
      service.previewAudience('active'),
      service.previewAudience('expired'),
      service.previewAudience('trial'),
      service.previewAudience('unsubscribed'),
    ]);

    assert.deepStrictEqual(previews.map((preview) => preview.totalRecipients), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(
      previews.map((preview) => preview.audience),
      [
        BroadcastAudience.ALL,
        BroadcastAudience.ACTIVE_SUBSCRIBERS,
        BroadcastAudience.EXPIRED,
        BroadcastAudience.TRIAL,
        BroadcastAudience.UNSUBSCRIBED,
      ],
    );
    assert.equal(previews.every((preview) => !Number.isNaN(Date.parse(preview.generatedAt))), true);
    assert.deepStrictEqual(countCalls, [
      { where: { isBlocked: false } },
      {
        where: {
          isBlocked: false,
          subscriptions: { some: { status: SubscriptionStatus.ACTIVE } },
        },
      },
      {
        where: {
          isBlocked: false,
          subscriptions: { some: { status: SubscriptionStatus.EXPIRED } },
          NOT: { subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } },
        },
      },
      {
        where: {
          isBlocked: false,
          subscriptions: { some: { isTrial: true, status: SubscriptionStatus.ACTIVE } },
        },
      },
      {
        where: {
          isBlocked: false,
          subscriptions: { none: {} },
        },
      },
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
    createdAt: new Date('2026-04-24T10:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
}

function broadcastRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'broadcast-1',
    status: BroadcastStatus.DRAFT,
    audience: BroadcastAudience.ALL,
    audiencePlanId: null,
    promoCode: null,
    payload: {},
    totalCount: 0,
    successCount: 0,
    failedCount: 0,
    createdBy: 'admin-1',
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
    updatedAt: new Date('2026-04-24T12:10:00.000Z'),
    ...overrides,
  };
}
