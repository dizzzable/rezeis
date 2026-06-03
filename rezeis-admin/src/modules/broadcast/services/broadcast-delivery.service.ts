import { Injectable, Logger } from '@nestjs/common';
import { BroadcastMessageStatus, BroadcastStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { TELEGRAM_RATE_LIMIT_MS } from '../broadcast.constants';

/**
 * Broadcast delivery service — handles staging, sending, editing, deleting,
 * and retrying messages via Telegram Bot API.
 *
 * All methods are designed to be called from BullMQ processor jobs.
 * Each method is idempotent and safe to retry.
 */
@Injectable()
export class BroadcastDeliveryService {
  private readonly logger = new Logger(BroadcastDeliveryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemEventsService: SystemEventsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  STAGE RECIPIENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve audience, create message rows, transition to PROCESSING.
   * @returns Array of created BroadcastMessage IDs (for batching)
   */
  public async stageRecipients(broadcastId: string): Promise<string[]> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true, audience: true },
    });
    if (broadcast === null) {
      this.logger.warn(`Broadcast ${broadcastId} not found`);
      return [];
    }
    if (broadcast.status !== BroadcastStatus.DRAFT) {
      this.logger.warn(`Broadcast ${broadcastId} not DRAFT (current: ${broadcast.status})`);
      return [];
    }

    const recipientUserIds = await this.resolveRecipients(broadcast.audience);
    if (recipientUserIds.length === 0) {
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.COMPLETED, totalCount: 0, startedAt: new Date(), completedAt: new Date() },
      });
      return [];
    }

    await this.prismaService.broadcastMessage.createMany({
      data: recipientUserIds.map((userId) => ({
        broadcastId,
        userId,
        status: BroadcastMessageStatus.PENDING,
      })),
    });

    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { broadcastId, status: BroadcastMessageStatus.PENDING },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: { status: BroadcastStatus.PROCESSING, totalCount: recipientUserIds.length, startedAt: new Date() },
    });

    this.systemEventsService.info(
      EVENT_TYPES.SYSTEM_BROADCAST_SENT,
      'SYSTEM',
      `Broadcast staging: ${messages.length} recipients`,
      { broadcastId, recipientCount: messages.length },
    );

    return messages.map((m) => m.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DELIVER BATCH (text + media)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a batch of messages. Supports text-only, photo, and video broadcasts.
   */
  public async deliverBatch(
    broadcastId: string,
    messageIds: string[],
  ): Promise<{ sent: number; failed: number }> {
    const botToken = this.getBotToken();
    if (!botToken) {
      await this.failBatch(messageIds, 'BOT_TOKEN not configured');
      await this.checkAndFinalize(broadcastId);
      return { sent: 0, failed: messageIds.length };
    }

    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true, payload: true },
    });
    if (!broadcast) return { sent: 0, failed: 0 };

    // If broadcast was canceled mid-flight, skip remaining
    if (broadcast.status === BroadcastStatus.CANCELED) {
      await this.prismaService.broadcastMessage.updateMany({
        where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
        data: { status: BroadcastMessageStatus.CANCELED },
      });
      return { sent: 0, failed: 0 };
    }

    const payload = broadcast.payload as Record<string, unknown> | null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const mediaType = payload?.mediaType as string | undefined;
    const mediaFileId = typeof payload?.mediaFileId === 'string' ? payload.mediaFileId : null;
    const parseMode = (payload?.parseMode as string) ?? undefined;

    if (!text && !mediaFileId) {
      await this.failBatch(messageIds, 'Empty broadcast: no text and no media');
      await this.checkAndFinalize(broadcastId);
      return { sent: 0, failed: messageIds.length };
    }

    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
      select: { id: true, userId: true },
    });

    let sent = 0;
    let failed = 0;

    for (const message of messages) {
      const user = await this.prismaService.user.findUnique({
        where: { id: message.userId },
        select: { telegramId: true },
      });

      if (!user?.telegramId) {
        await this.markFailed(message.id, 'No telegramId');
        failed++;
        continue;
      }

      const chatId = user.telegramId.toString();
      const result = await this.sendTelegramMessage(botToken, {
        chatId,
        text,
        mediaType: mediaType ?? 'none',
        mediaFileId,
        parseMode,
      });

      if (result.ok) {
        await this.prismaService.broadcastMessage.update({
          where: { id: message.id },
          data: {
            status: BroadcastMessageStatus.SENT,
            telegramMessageId: result.messageId ? BigInt(result.messageId) : null,
            sentAt: new Date(),
          },
        });
        sent++;
      } else {
        await this.markFailed(message.id, result.error ?? 'Unknown error');
        failed++;
      }

      await sleep(TELEGRAM_RATE_LIMIT_MS);
    }

    await this.checkAndFinalize(broadcastId);
    return { sent, failed };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EDIT BATCH (editMessageText / editMessageCaption)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Edit already-sent messages. Uses editMessageText for text-only broadcasts,
   * editMessageCaption for photo/video broadcasts.
   */
  public async editBatch(
    broadcastId: string,
    messageIds: string[],
    newText: string,
    parseMode: string | null,
  ): Promise<{ edited: number; failed: number }> {
    const botToken = this.getBotToken();
    if (!botToken) return { edited: 0, failed: messageIds.length };

    // Determine if this is a media broadcast (use editMessageCaption)
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { payload: true },
    });
    const payload = broadcast?.payload as Record<string, unknown> | null;
    const isMedia = payload?.mediaType === 'photo' || payload?.mediaType === 'video';

    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { id: { in: messageIds }, broadcastId, status: 'SENT', telegramMessageId: { not: null } },
      select: { id: true, userId: true, telegramMessageId: true },
    });

    let edited = 0;
    let failed = 0;

    for (const message of messages) {
      const user = await this.prismaService.user.findUnique({
        where: { id: message.userId },
        select: { telegramId: true },
      });

      if (!user?.telegramId || !message.telegramMessageId) {
        failed++;
        continue;
      }

      const endpoint = isMedia ? 'editMessageCaption' : 'editMessageText';
      const body: Record<string, unknown> = {
        chat_id: user.telegramId.toString(),
        message_id: Number(message.telegramMessageId),
      };
      if (isMedia) {
        body.caption = newText;
        if (parseMode) body.parse_mode = parseMode;
      } else {
        body.text = newText;
        if (parseMode) body.parse_mode = parseMode;
      }

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/${endpoint}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        if (response.ok) {
          edited++;
        } else {
          const err = await response.text();
          this.logger.warn(
            `Edit ${message.id} failed: ${sanitizeTelegramDiagnostic(
              err,
              botToken,
              user.telegramId.toString(),
              200,
            )}`,
          );
          failed++;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Edit ${message.id} threw: ${sanitizeTelegramDiagnostic(
            err,
            botToken,
            user.telegramId.toString(),
            200,
          )}`,
        );
        failed++;
      }

      await sleep(TELEGRAM_RATE_LIMIT_MS);
    }

    // Update broadcast payload
    if (edited > 0) {
      const existing = (broadcast?.payload as Record<string, unknown>) ?? {};
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { payload: { ...existing, text: newText, parseMode: parseMode ?? null } },
      });
    }

    return { edited, failed };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DELETE BATCH (deleteMessage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Delete already-sent messages from Telegram chats.
   * Telegram allows deletion within 48 hours of sending.
   */
  public async deleteBatch(
    broadcastId: string,
    messageIds: string[],
  ): Promise<{ deleted: number; failed: number }> {
    const botToken = this.getBotToken();
    if (!botToken) return { deleted: 0, failed: messageIds.length };

    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { id: { in: messageIds }, broadcastId, status: 'SENT', telegramMessageId: { not: null } },
      select: { id: true, userId: true, telegramMessageId: true },
    });

    let deleted = 0;
    let failed = 0;

    for (const message of messages) {
      const user = await this.prismaService.user.findUnique({
        where: { id: message.userId },
        select: { telegramId: true },
      });

      if (!user?.telegramId || !message.telegramMessageId) {
        failed++;
        continue;
      }

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/deleteMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: user.telegramId.toString(),
              message_id: Number(message.telegramMessageId),
            }),
          },
        );

        if (response.ok) {
          await this.prismaService.broadcastMessage.update({
            where: { id: message.id },
            data: { status: BroadcastMessageStatus.CANCELED, telegramMessageId: null },
          });
          deleted++;
        } else {
          const err = await response.text();
          this.logger.warn(
            `Delete ${message.id} failed: ${sanitizeTelegramDiagnostic(
              err,
              botToken,
              user.telegramId.toString(),
              200,
            )}`,
          );
          failed++;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Delete ${message.id} threw: ${sanitizeTelegramDiagnostic(
            err,
            botToken,
            user.telegramId.toString(),
            200,
          )}`,
        );
        failed++;
      }

      await sleep(TELEGRAM_RATE_LIMIT_MS);
    }

    // Update broadcast counters
    if (deleted > 0) {
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { successCount: { decrement: deleted } },
      });
    }

    return { deleted, failed };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RETRY FAILED
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Retry previously failed messages. Resets them to PENDING and re-delivers.
   */
  public async retryBatch(
    broadcastId: string,
    messageIds: string[],
  ): Promise<{ sent: number; failed: number }> {
    // Reset failed messages back to PENDING
    await this.prismaService.broadcastMessage.updateMany({
      where: { id: { in: messageIds }, broadcastId, status: 'FAILED' },
      data: { status: BroadcastMessageStatus.PENDING, errorMessage: null },
    });

    // Re-deliver using the standard batch logic
    return this.deliverBatch(broadcastId, messageIds);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FINALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Check if all messages processed; if so, mark broadcast COMPLETED. */
  public async checkAndFinalize(broadcastId: string): Promise<void> {
    const pendingCount = await this.prismaService.broadcastMessage.count({
      where: { broadcastId, status: BroadcastMessageStatus.PENDING },
    });
    if (pendingCount > 0) return;

    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    // Don't overwrite CANCELED status
    if (broadcast?.status === BroadcastStatus.CANCELED) return;

    const [sentCount, failedCount] = await Promise.all([
      this.prismaService.broadcastMessage.count({ where: { broadcastId, status: BroadcastMessageStatus.SENT } }),
      this.prismaService.broadcastMessage.count({ where: { broadcastId, status: BroadcastMessageStatus.FAILED } }),
    ]);

    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: { status: BroadcastStatus.COMPLETED, successCount: sentCount, failedCount, completedAt: new Date() },
    });

    this.logger.log(`Broadcast ${broadcastId} completed: ${sentCount} sent, ${failedCount} failed`);
    this.systemEventsService.info(
      EVENT_TYPES.SYSTEM_BROADCAST_SENT,
      'SYSTEM',
      `Broadcast completed: ${sentCount} sent, ${failedCount} failed`,
      { broadcastId, sentCount, failedCount },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private getBotToken(): string | null {
    const token = this.configService.get<string>('BOT_TOKEN');
    if (!token) {
      this.logger.error('BOT_TOKEN not configured');
      return null;
    }
    return token;
  }

  private async failBatch(messageIds: string[], reason: string): Promise<void> {
    await this.prismaService.broadcastMessage.updateMany({
      where: { id: { in: messageIds } },
      data: { status: BroadcastMessageStatus.FAILED, errorMessage: reason },
    });
  }

  private async markFailed(messageId: string, reason: string): Promise<void> {
    await this.prismaService.broadcastMessage.update({
      where: { id: messageId },
      data: { status: BroadcastMessageStatus.FAILED, errorMessage: reason.slice(0, 500) },
    });
  }

  /**
   * Send a message via Telegram Bot API. Supports text, photo, and video.
   */
  private async sendTelegramMessage(
    botToken: string,
    input: {
      chatId: string;
      text: string;
      mediaType: string;
      mediaFileId: string | null;
      parseMode: string | undefined;
    },
  ): Promise<{ ok: boolean; messageId?: number; error?: string }> {
    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (input.mediaType === 'photo' && input.mediaFileId) {
        endpoint = 'sendPhoto';
        body = {
          chat_id: input.chatId,
          photo: input.mediaFileId,
          caption: input.text || undefined,
          parse_mode: input.parseMode,
        };
      } else if (input.mediaType === 'video' && input.mediaFileId) {
        endpoint = 'sendVideo';
        body = {
          chat_id: input.chatId,
          video: input.mediaFileId,
          caption: input.text || undefined,
          parse_mode: input.parseMode,
          supports_streaming: true,
        };
      } else {
        endpoint = 'sendMessage';
        body = {
          chat_id: input.chatId,
          text: input.text,
          parse_mode: input.parseMode,
        };
      }

      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/${endpoint}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );

      if (response.ok) {
        const data = (await response.json()) as { result?: { message_id?: number } };
        return { ok: true, messageId: data.result?.message_id };
      }
      const errorBody = await response.text();
      return {
        ok: false,
        error: sanitizeTelegramDiagnostic(errorBody, botToken, input.chatId),
      };
    } catch (err: unknown) {
      return {
        ok: false,
        error: sanitizeTelegramDiagnostic(
          err instanceof Error ? err.message : 'Network error',
          botToken,
          input.chatId,
        ),
      };
    }
  }

  private async resolveRecipients(audience: string): Promise<string[]> {
    const where: Record<string, unknown> = {
      isBlocked: false,
      isBotBlocked: false,
      telegramId: { not: null },
    };

    switch (audience) {
      case 'ACTIVE_SUBSCRIBERS':
        where.subscriptions = { some: { status: 'ACTIVE' } };
        break;
      case 'EXPIRED':
        where.subscriptions = { some: { status: 'EXPIRED' } };
        where.NOT = { subscriptions: { some: { status: 'ACTIVE' } } };
        break;
      case 'TRIAL':
        where.subscriptions = { some: { isTrial: true, status: 'ACTIVE' } };
        break;
      case 'UNSUBSCRIBED':
        where.subscriptions = { none: {} };
        break;
    }

    const users = await this.prismaService.user.findMany({
      where: where as Prisma.UserWhereInput,
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTelegramDiagnostic(
  value: unknown,
  botToken: string,
  chatId?: string | null,
  maxLength = 500,
): string {
  const raw = value instanceof Error ? value.message : String(value ?? 'Telegram request failed');
  let sanitized = raw
    .replace(/https?:\/\/api\.telegram\.org\/bot[^\s/]+(?:\/\S*)?/giu, '[telegram api url hidden]')
    .replace(/bot\d{4,}:[A-Za-z0-9_-]+/gu, 'bot[bot-token hidden]');

  if (botToken.length > 0) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(botToken), 'gu'), '[bot-token hidden]');
  }
  if (chatId && chatId.length > 0) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(chatId), 'gu'), '[chat-id hidden]');
  }

  return sanitized.slice(0, maxLength);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
