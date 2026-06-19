import { Injectable, Logger, Optional } from '@nestjs/common';
import { BroadcastMessageStatus, BroadcastStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { BotNotifierClient } from '../../notifications/services/bot-notifier.client';
import { SettingsService } from '../../settings/services/settings.service';
import { CustomEmojiService } from '../../custom-emoji/services/custom-emoji.service';
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
    private readonly userNotifications: UserNotificationsService,
    private readonly settingsService: SettingsService,
    private readonly botNotifier: BotNotifierClient,
    @Optional()
    private readonly customEmojiService?: CustomEmojiService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  TEST SEND (dev only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a one-off preview of a broadcast draft to the platform developer(s)
   * only — never to real recipients. Delivers on TWO surfaces so the dev sees
   * exactly what users will get:
   *   • Telegram DM to the bot's `BOT_DEV_ID` (via the reiwa relay), and
   *   • the in-cabinet feed + web-push of every user whose profile role is
   *     `DEV` (so the test shows up in the web cabinet too, not just the bot).
   *
   * Text-only on the Telegram leg (the dev-DM relay carries no media). Returns
   * `{ ok: false }` with a reason when nothing could be delivered (no relay and
   * no DEV user) or the draft has no content.
   */
  public async sendTestToDev(broadcastId: string): Promise<{ ok: boolean; reason?: string }> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { payload: true },
    });
    if (!broadcast) return { ok: false, reason: 'not-found' };

    const payload = broadcast.payload as Record<string, unknown> | null;
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!title && !text.trim()) {
      return { ok: false, reason: 'empty' };
    }

    // Render `:slug:` custom-emoji shortcodes into Telegram premium
    // `<tg-emoji>` HTML for BOTH the title and the body, identical to real
    // delivery (the dev DM is always HTML), so the preview is faithful.
    const composed = await this.composeTelegram(title || null, text, true);

    // 1) Telegram DM to the bot's BOT_DEV_ID (only when the relay is wired).
    let relayed = false;
    if (this.botNotifier.isEnabled) {
      await this.botNotifier.notifyDev({ text: composed || ' ', parseMode: 'HTML' });
      relayed = true;
    }

    // 2) Web cabinet (feed + web-push) for every DEV-role user. `skipTelegram`
    //    avoids a duplicate Telegram DM (the relay leg above already covers the
    //    dev's Telegram); the cabinet feed row + web-push are what was missing.
    const devUsers = await this.prismaService.user.findMany({
      where: { role: 'DEV', isBlocked: false },
      select: { id: true },
    });
    for (const dev of devUsers) {
      try {
        await this.userNotifications.create({
          userId: dev.id,
          type: 'broadcast',
          payload: { broadcastId, text, ...(title ? { title } : {}) },
          preRenderedText: composed || ' ',
          skipTelegram: true,
        });
      } catch (err: unknown) {
        this.logger.warn(
          `Test broadcast cabinet delivery failed for dev ${dev.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!relayed && devUsers.length === 0) {
      return { ok: false, reason: 'relay-disabled' };
    }
    this.logger.log(
      `Broadcast ${broadcastId} test preview: telegram=${relayed} devCabinet=${devUsers.length}`,
    );
    return { ok: true };
  }

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
    // BOT_TOKEN is only needed for DIRECT media delivery (sendPhoto/sendVideo).
    // Text broadcasts are delivered via the reiwa bot (notification path), so a
    // missing token must NOT fail the whole batch — web-push + cabinet feed +
    // text Telegram all still work. Prefer the panel-managed encrypted token,
    // falling back to the env var.
    const botToken = await this.getBotToken();

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
    const title = typeof payload?.title === 'string' ? payload.title : null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const mediaType = payload?.mediaType as string | undefined;
    const mediaFileId = typeof payload?.mediaFileId === 'string' ? payload.mediaFileId : null;
    const parseMode = (payload?.parseMode as string) ?? undefined;

    if (!text && !mediaFileId) {
      await this.failBatch(messageIds, 'Empty broadcast: no text and no media');
      await this.checkAndFinalize(broadcastId);
      return { sent: 0, failed: messageIds.length };
    }

    const hasMedia = mediaFileId !== null && (mediaType === 'photo' || mediaType === 'video');

    // Telegram-bound text. Custom-emoji `:slug:` shortcodes become Telegram
    // premium custom-emoji via `<tg-emoji>` HTML tags when sent with parse_mode
    // HTML (text broadcasts always are; media captions only when the operator
    // chose HTML) — Telegram shows the fallback glyph for bots without the
    // capability. Otherwise we fall back to the plain glyph. The cabinet feed
    // keeps the raw `:slug:` text (rendered as inline images). The operator
    // title (when set) leads the message as a bold headline — rendered through
    // the same custom-emoji substitution so premium emoji in the title show up
    // in Telegram too (not just the cabinet).
    const useHtmlEmoji = hasMedia ? parseMode === 'HTML' : true;
    const telegramText = await this.composeTelegram(title, text, useHtmlEmoji);

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
      if (!user) {
        await this.markFailed(message.id, 'User not found');
        failed++;
        continue;
      }

      // Deliver via the notification fanout: cabinet feed (always) + web-push
      // (always). The fanout's Telegram leg is skipped here — for TEXT we send
      // the Telegram message ourselves right below so we can capture the
      // returned message id (needed for later edit/delete within Telegram's
      // 48h window). For MEDIA we send the photo/video directly further down.
      let feedOk = false;
      let eventId: string | null = null;
      try {
        eventId = await this.userNotifications.create({
          userId: message.userId,
          type: 'broadcast',
          payload: { broadcastId, text, ...(title ? { title } : {}) },
          preRenderedText: telegramText || ' ',
          skipTelegram: true,
        });
        feedOk = true;
      } catch (err: unknown) {
        this.logger.warn(
          `Broadcast fanout failed for ${message.userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Direct media Telegram delivery (needs a local BOT_TOKEN).
      let mediaOk = false;
      let mediaMessageId: number | undefined;
      let mediaError: string | null = null;
      // Text Telegram message id captured from the reiwa bot fanout.
      let textMessageId: number | null = null;
      if (hasMedia && user.telegramId !== null) {
        if (botToken) {
          const result = await this.sendTelegramMessage(botToken, {
            chatId: user.telegramId.toString(),
            text: telegramText,
            mediaType: mediaType ?? 'none',
            mediaFileId,
            parseMode,
          });
          mediaOk = result.ok;
          mediaMessageId = result.messageId;
          mediaError = result.ok ? null : (result.error ?? 'Unknown error');
          await sleep(TELEGRAM_RATE_LIMIT_MS);
        } else {
          mediaError = 'BOT_TOKEN not configured for media delivery';
        }
      } else if (!hasMedia && user.telegramId !== null && eventId !== null) {
        // Text Telegram via the reiwa bot. Reuse the cabinet event id as the
        // notify idempotency key, and persist the returned message id so the
        // broadcast can be edited/deleted in Telegram later.
        textMessageId = await this.botNotifier.notifyUser({
          eventId,
          telegramId: user.telegramId.toString(),
          text: telegramText || ' ',
          parseMode: 'HTML',
        });
        await sleep(TELEGRAM_RATE_LIMIT_MS);
      }

      // SENT when delivered on at least one channel: the cabinet feed row is a
      // guaranteed in-app surface (and, for text, carries web-push + Telegram);
      // or the direct media Telegram send succeeded.
      if (feedOk || mediaOk) {
        const telegramMessageId =
          mediaMessageId !== undefined
            ? BigInt(mediaMessageId)
            : textMessageId !== null
              ? BigInt(textMessageId)
              : null;
        await this.prismaService.broadcastMessage.update({
          where: { id: message.id },
          data: {
            status: BroadcastMessageStatus.SENT,
            telegramMessageId,
            sentAt: new Date(),
          },
        });
        sent++;
      } else {
        await this.markFailed(message.id, mediaError ?? 'Delivery failed on all channels');
        failed++;
      }
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
    const botToken = await this.getBotToken();
    if (!botToken) return { edited: 0, failed: messageIds.length };
    // Determine if this is a media broadcast (use editMessageCaption)
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { payload: true },
    });
    const payload = broadcast?.payload as Record<string, unknown> | null;
    const isMedia = payload?.mediaType === 'photo' || payload?.mediaType === 'video';

    // Telegram can't render our custom-emoji images — substitute `:slug:` just
    // like the initial delivery: premium `<tg-emoji>` tags under parse_mode
    // HTML, otherwise the plain fallback glyph.
    const telegramText = this.customEmojiService
      ? parseMode === 'HTML'
        ? await this.customEmojiService.substituteTelegramHtml(newText)
        : await this.customEmojiService.substituteFallbacks(newText)
      : newText;

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
        body.caption = telegramText;
        if (parseMode) body.parse_mode = parseMode;
      } else {
        body.text = telegramText;
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
    const botToken = await this.getBotToken();
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

  /**
   * Compose the Telegram-bound message/caption from an optional operator title
   * and the body, substituting `:slug:` custom-emoji shortcodes:
   *   • `useHtmlEmoji` → premium `<tg-emoji>` tags; the title becomes a bold
   *     headline (`<b>…</b>`) above the body. The title is HTML-escaped first
   *     (it's plain text) before substitution; the body may carry operator HTML
   *     so it is substituted raw.
   *   • otherwise (plain-text media caption) → plain fallback glyphs and a
   *     plain (non-bold) title line, since HTML tags wouldn't be parsed.
   */
  private async composeTelegram(
    title: string | null,
    body: string,
    useHtmlEmoji: boolean,
  ): Promise<string> {
    const renderedBody = this.customEmojiService
      ? useHtmlEmoji
        ? await this.customEmojiService.substituteTelegramHtml(body)
        : await this.customEmojiService.substituteFallbacks(body)
      : body;
    const trimmedTitle = title?.trim() ?? '';
    if (trimmedTitle.length === 0) return renderedBody;
    if (useHtmlEmoji) {
      const renderedTitle = this.customEmojiService
        ? await this.customEmojiService.substituteTelegramHtml(escapeHtml(trimmedTitle))
        : escapeHtml(trimmedTitle);
      return renderedBody ? `<b>${renderedTitle}</b>\n\n${renderedBody}` : `<b>${renderedTitle}</b>`;
    }
    const renderedTitle = this.customEmojiService
      ? await this.customEmojiService.substituteFallbacks(trimmedTitle)
      : trimmedTitle;
    return renderedBody ? `${renderedTitle}\n\n${renderedBody}` : renderedTitle;
  }

  private async getBotToken(): Promise<string | null> {
    // Prefer the panel-managed (encrypted) token; fall back to the env var.
    // Returns null silently — each caller decides how to handle a missing
    // token (text broadcasts tolerate it; media/edit/delete report it).
    const stored = await this.settingsService.getDecryptedBotToken();
    if (stored) return stored;
    return this.configService.get<string>('BOT_TOKEN') ?? null;
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
    // Web-only users (no Telegram) are intentionally included now — broadcasts
    // reach them via web-push + the in-cabinet feed. `isBotBlocked` only
    // affects Telegram delivery; it does not exclude web-only users (whose
    // flag stays false).
    const where: Record<string, unknown> = {
      isBlocked: false,
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

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
