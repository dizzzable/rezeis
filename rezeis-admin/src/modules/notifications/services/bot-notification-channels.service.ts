import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BotNotificationChannel, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

import { BotNotifierClient } from './bot-notifier.client';

interface CreateChannelInput {
  readonly name: string;
  readonly chatId: string;
  readonly topicThreadId?: number | null;
  readonly kindFilter?: readonly string[];
  readonly isActive?: boolean;
}

interface UpdateChannelInput {
  readonly id: string;
  readonly name?: string;
  readonly chatId?: string;
  readonly topicThreadId?: number | null;
  readonly kindFilter?: readonly string[];
  readonly isActive?: boolean;
}

interface BroadcastInput {
  readonly eventId: string;
  readonly type: string;
  readonly text: string;
  readonly parseMode?: 'MarkdownV2' | 'HTML';
}

/**
 * BotNotificationChannelsService
 * ──────────────────────────────
 * CRUD + broadcast for `BotNotificationChannel` rows.
 *
 *  - **CRUD**: admin-controllered list / create / update / delete /
 *    toggle. Operator manages destinations through the admin SPA.
 *
 *  - **Broadcast**: when a SystemEvent or UserNotificationEvent fires,
 *    `broadcastToChannels()` resolves every active channel whose
 *    `kindFilter` matches (empty filter = "all") and forwards to bot's
 *    `/notify-broadcast`. Idempotency keyed on `eventId + channelId`
 *    so a single event delivers exactly once per channel even if the
 *    fanout is retried.
 *
 * The fanout is fire-and-forget — `broadcastToChannels()` doesn't
 * throw or await delivery confirmation per channel; the bot's LRU
 * dedup absorbs the rest.
 */
@Injectable()
export class BotNotificationChannelsService {
  private readonly logger = new Logger(BotNotificationChannelsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly botNotifier: BotNotifierClient,
  ) {}

  // ── CRUD ─────────────────────────────────────────────────────────────────

  public listAll(): Promise<BotNotificationChannel[]> {
    return this.prismaService.botNotificationChannel.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  public async create(input: CreateChannelInput): Promise<BotNotificationChannel> {
    return this.prismaService.botNotificationChannel.create({
      data: {
        name: input.name.trim(),
        chatId: input.chatId.trim(),
        topicThreadId: input.topicThreadId ?? null,
        kindFilter: normaliseFilter(input.kindFilter),
        isActive: input.isActive ?? true,
      },
    });
  }

  public async update(input: UpdateChannelInput): Promise<BotNotificationChannel> {
    const existing = await this.prismaService.botNotificationChannel.findUnique({
      where: { id: input.id },
    });
    if (existing === null) {
      throw new NotFoundException('Notification channel not found');
    }
    const data: Prisma.BotNotificationChannelUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.chatId !== undefined) data.chatId = input.chatId.trim();
    if (input.topicThreadId !== undefined) {
      data.topicThreadId = input.topicThreadId;
    }
    if (input.kindFilter !== undefined) {
      data.kindFilter = { set: normaliseFilter(input.kindFilter) };
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    return this.prismaService.botNotificationChannel.update({
      where: { id: input.id },
      data,
    });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botNotificationChannel.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Notification channel not found');
    }
    await this.prismaService.botNotificationChannel.delete({ where: { id } });
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  /**
   * Fan an event out to every active channel whose `kindFilter`
   * accepts `input.type`. Empty filter array on a row means "accept
   * all". Failures per channel are logged and swallowed — one
   * misconfigured destination doesn't block delivery to the others.
   */
  public async broadcastToChannels(input: BroadcastInput): Promise<void> {
    const channels = await this.prismaService.botNotificationChannel.findMany({
      where: { isActive: true },
    });
    if (channels.length === 0) return;
    await Promise.all(
      channels
        .filter((channel) => matchesFilter(channel.kindFilter, input.type))
        .map(async (channel) => {
          try {
            await this.botNotifier.notifyBroadcast({
              // Suffix the channel id so the bot's LRU dedup treats
              // the same UserNotificationEvent as distinct deliveries
              // per destination — otherwise the second channel would
              // see a stale eventId and skip.
              eventId: `${input.eventId}:${channel.id}`,
              chatId: channel.chatId,
              topicThreadId: channel.topicThreadId ?? undefined,
              text: input.text,
              parseMode: input.parseMode,
            });
          } catch (err: unknown) {
            this.logger.warn(
              `Broadcast to channel ${channel.id} (${channel.name}) failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }),
    );
  }
}

function normaliseFilter(filter: readonly string[] | undefined): string[] {
  if (filter === undefined) return [];
  // Trim, drop empties, dedupe — operator may paste extra whitespace
  // or duplicates; we treat the kindFilter as a small declarative
  // set of event-type slugs.
  const set = new Set<string>();
  for (const raw of filter) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return [...set];
}

/**
 * Returns true when the filter accepts the type. Empty filter = pass
 * through. Otherwise we do an exact match against any entry; future
 * versions could add wildcard / glob semantics here without changing
 * the call sites.
 */
function matchesFilter(filter: readonly string[], type: string): boolean {
  if (filter.length === 0) return true;
  return filter.includes(type);
}
