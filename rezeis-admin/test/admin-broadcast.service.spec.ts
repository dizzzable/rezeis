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
              scheduledAt: null,
              startedAt: new Date('2026-04-24T12:05:00.000Z'),
            }),
          ];
        },
      },
      // The list COUNTS the states the stored counters cannot describe. It used
      // to derive "still delivering" as `total - success - failed`, which
      // assumes every recipient is one of those three — cancelling and
      // recalling both make a fourth, so a recalled broadcast claimed for ever
      // that it was still delivering to people whose message had been withdrawn.
      broadcastMessage: {
        // TWO questions, and the fake answers each on its own terms. The second
        // is not a status tally: a recall can only touch a message that exists
        // in Telegram, and a broadcast also reaches web-only users through the
        // cabinet feed — SENT rows with no message id. Deriving the recallable
        // count from the others offered to recall messages that never existed.
        groupBy: async (args: {
          by: string[];
          where: {
            broadcastId: { in: string[] };
            status?: unknown;
            telegramMessageId?: unknown;
            errorMessage?: unknown;
          };
        }) => {
          assert.deepStrictEqual(args.where.broadcastId.in, ['broadcast-1']);
          if (args.by.includes('status')) {
            return [
              { broadcastId: 'broadcast-1', status: 'PENDING', _count: { _all: 2 } },
              { broadcastId: 'broadcast-1', status: 'CANCELED', _count: { _all: 3 } },
              // SENT is counted live so a running send is not reported as zero
              // delivered while it works through four hundred people.
              { broadcastId: 'broadcast-1', status: 'SENT', _count: { _all: 7 } },
            ];
          }
          // Recipients who blocked the bot: counted apart from `failedCount`
          // because no retry can change them, and folded together they were the
          // bulk of "N ошибок" beside a button that never moved the number. The
          // reason string is the whole predicate — it must be the one the
          // delivery path writes and the one `getFailedMessageIds` excludes.
          if (args.where.status === 'FAILED') {
            assert.equal(args.where.errorMessage, 'telegram_blocked_by_user');
            return [{ broadcastId: 'broadcast-1', _count: { _all: 2 } }];
          }
          // THE OTHER HALF of the predicate, and the half that makes the two
          // message counts mean anything: a broadcast also reaches web-only
          // users through the cabinet feed, and those rows are SENT with NO
          // Telegram message id. Without this filter the panel would offer to
          // recall messages that do not exist — the defect this count replaced.
          assert.deepStrictEqual(args.where.telegramMessageId, { not: null });
          // Two groupBys share that shape and differ only by status: what a
          // recall could still remove (SENT), and what one already did
          // (CANCELED, which still counts as REACHED — the send happened).
          if (args.where.status === 'CANCELED') {
            return [{ broadcastId: 'broadcast-1', _count: { _all: 1 } }];
          }
          return [{ broadcastId: 'broadcast-1', _count: { _all: 4 } }];
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
        // COUNTED, not `5 - 2 - 1`. The subtraction would say 2 here by
        // coincidence; it says the wrong thing the moment anything is
        // cancelled or recalled.
        pendingCount: 2,
        canceledCount: 3,
        // COUNTED with the recall's own predicate, not `success - canceled`.
        recallableCount: 4,
        blockedCount: 2,
        // Counted live, so mid-flight the panel shows real progress instead of
        // the finaliser's zero.
        // 7 SENT plus the 1 since recalled: "reached" counted the same way
        // `checkAndFinalize` counts it, so the row cannot say 0 delivered while
        // its own stored `successCount` says 400.
        deliveredCount: 8,
        channelPost: 'none',
        createdBy: 'admin-1',
        scheduledAt: null,
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
      // A pending SCHEDULED send is editable too — that wait is exactly when an
      // operator notices a typo, and the job re-reads content when it fires.
      { name: 'NotFoundException', message: 'Only draft or scheduled broadcasts can be updated' },
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

  it('rewrites cabinet-feed events in ONE bulk statement, not a per-row loop (MEDIUM #18)', async () => {
    let executeRawCalls = 0;
    let perRowUpdateCalls = 0;
    const service = new BroadcastService({
      broadcast: {
        findUnique: async () => ({ id: 'broadcast-1', payload: { text: 'old' } }),
        update: async () => undefined,
      },
      userNotificationEvent: {
        // These must NOT be used anymore — the old loop called findMany + update-per-row.
        findMany: async () => {
          throw new Error('must not read all feed rows into memory');
        },
        update: async () => {
          perRowUpdateCalls += 1;
        },
      },
      $executeRaw: async () => {
        executeRawCalls += 1;
        return 0;
      },
    } as never);

    await service.updateBroadcastContent({
      broadcastId: 'broadcast-1',
      text: 'corrected text',
      parseMode: 'HTML',
    });

    assert.equal(executeRawCalls, 1, 'must issue exactly one bulk feed-rewrite statement');
    assert.equal(perRowUpdateCalls, 0, 'must not update feed rows one-by-one');
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
    // The address of the one public copy on the operator channel. Present in
    // the fixture because their ABSENCE is what the mapper answers about — an
    // `undefined` that read as "there is a post" would put a recall button on
    // every broadcast.
    channelChatId: null,
    channelMessageId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
    updatedAt: new Date('2026-04-24T12:10:00.000Z'),
    ...overrides,
  };
}
