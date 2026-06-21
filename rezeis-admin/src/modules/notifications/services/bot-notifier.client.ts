import { Injectable, Logger } from '@nestjs/common';

import { buildWebhookSignature } from '../../../common/http/webhook-signature.util';

/**
 * BotNotifierClient
 * ─────────────────
 * Delivers per-user Telegram messages and channel broadcasts to reiwa as
 * signed webhooks (snoups/Remnawave-style — NOT a direct bot push):
 *
 *   admin → POST <REIWA_URL>/api/v1/webhooks/rezeis
 *           body   { event: "reiwa.user.notify" | "reiwa.channel.broadcast",
 *                    metadata: { eventId, telegramId|chatId, text, ... } }
 *           header X-Rezeis-Signature: t=<sec>,v1=<hmac> (WEBHOOK_SECRET_HEADER)
 *
 * reiwa-api verifies the signature (`REZEIS_WEBHOOK_SECRET`) and relays the
 * message to the bot process over its private docker hop — the bot is never
 * exposed publicly and admin only knows reiwa's public domain.
 *
 * Fire-and-forget: callers never await delivery confirmation. Persistence of
 * the notification (cabinet feed) is the caller's responsibility and runs
 * independently — a delivery failure never blocks cabinet UX.
 *
 * Idempotency: each call carries an `eventId` (the `UserNotificationEvent.id`
 * CUID). The bot keeps an LRU of delivered ids and no-ops on replays.
 *
 * Enabled only when BOTH `REIWA_URL` and `WEBHOOK_SECRET_HEADER` are set.
 */
@Injectable()
export class BotNotifierClient {
  private readonly logger = new Logger(BotNotifierClient.name);
  private readonly endpoint: string | null;
  private readonly secret: string | null;

  /** Per-call HTTP timeout — push paths run inline with admin requests. */
  private static readonly TIMEOUT_MS = 4_000;

  public constructor() {
    const baseUrl = (process.env.REIWA_URL ?? '').trim().replace(/\/+$/, '');
    this.secret = (process.env.WEBHOOK_SECRET_HEADER ?? '').trim() || null;
    this.endpoint = baseUrl.length > 0 ? `${baseUrl}/api/v1/webhooks/rezeis` : null;
    if (this.endpoint === null || this.secret === null) {
      this.logger.warn(
        'BotNotifierClient disabled — set REIWA_URL and WEBHOOK_SECRET_HEADER to enable',
      );
    }
  }

  /**
   * Deliver a per-user message to Telegram. `eventId` MUST be stable across
   * retries; reuse the source `UserNotificationEvent.id` CUID for free dedup.
   */
  public async notifyUser(input: {
    readonly eventId: string;
    readonly telegramId: string;
    readonly text: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
    readonly buttons?: ReadonlyArray<NotifyButton>;
    /**
     * Optional banner image (absolute URL or `/uploads/...`) delivered with the
     * message. reiwa sends it as a photo with the text as caption; relative
     * `/uploads/...` URLs are fetched from rezeis. Omitted → text-only message.
     */
    readonly bannerUrl?: string;
  }): Promise<number | null> {
    const { messageId } = await this.deliver('reiwa.user.notify', {
      eventId: input.eventId,
      telegramId: input.telegramId,
      text: input.text,
      parseMode: input.parseMode,
      buttons: input.buttons,
      bannerUrl: input.bannerUrl,
    });
    return messageId;
  }

  /**
   * Deliver a message to a Telegram chat or forum topic (operator-managed
   * broadcast channels).
   */
  public async notifyBroadcast(input: {
    readonly eventId: string;
    readonly chatId: string;
    readonly topicThreadId?: number;
    readonly text: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
    readonly buttons?: ReadonlyArray<NotifyButton>;
  }): Promise<void> {
    await this.deliver('reiwa.channel.broadcast', {
      eventId: input.eventId,
      chatId: input.chatId,
      topicThreadId: input.topicThreadId,
      text: input.text,
      parseMode: input.parseMode,
      buttons: input.buttons,
    });
  }

  /**
   * Deliver a system-event card to the bot's developer/operator
   * (`BOT_DEV_ID`) — the automatic fallback used when no operator
   * group/topic is configured. reiwa relays it to the bot, which knows
   * its own dev id; rezeis never needs to. Best-effort, fire-and-forget.
   */
  public async notifyDev(input: {
    readonly text: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
  }): Promise<void> {
    await this.deliver('reiwa.dev.notify', {
      text: input.text,
      parseMode: input.parseMode,
    });
  }

  /**
   * Deliver an `.txt` error report (e.g. `error_0.txt`) to the bot's
   * developer/operator (`BOT_DEV_ID`) as a Telegram document, with the
   * sectioned error card carried as the document caption. The dev-DM analogue
   * of the operator group's error report. reiwa relays it to the bot (which
   * knows its own dev id) and the bot attaches a Close button. Best-effort,
   * fire-and-forget.
   */
  public async notifyDevDocument(input: {
    readonly filename: string;
    readonly content: string;
    readonly caption?: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
  }): Promise<void> {
    await this.deliver('reiwa.dev.notify.document', {
      filename: input.filename,
      content: input.content,
      caption: input.caption,
      parseMode: input.parseMode,
    });
  }

  /**
   * Relay a backup file to a Telegram chat/topic via the reiwa bot. rezeis
   * does NOT push the bytes — it hands the bot a signed, short-lived download
   * URL token; the bot fetches the file from rezeis (docker hop) and uploads
   * it. Used when rezeis has no local bot token (split deployment).
   */
  public async relayBackupDocument(input: {
    readonly recordId: string;
    readonly token: string;
    readonly filename: string;
    readonly caption: string;
    readonly chatId: string;
    readonly topicThreadId?: number;
  }): Promise<void> {
    await this.deliver('reiwa.backup.document', {
      recordId: input.recordId,
      token: input.token,
      filename: input.filename,
      caption: input.caption,
      chatId: input.chatId,
      ...(typeof input.topicThreadId === 'number' ? { topicThreadId: input.topicThreadId } : {}),
    });
  }

  /** Whether the reiwa relay is configured (REIWA_URL + WEBHOOK_SECRET_HEADER). */
  public get isEnabled(): boolean {
    return this.endpoint !== null && this.secret !== null;
  }

  private async deliver(
    event: string,
    metadata: Record<string, unknown>,
  ): Promise<{ messageId: number | null }> {
    if (this.endpoint === null || this.secret === null) return { messageId: null };
    if (this.endpoint === null || this.secret === null) return { messageId: null };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BotNotifierClient.TIMEOUT_MS);
    try {
      const body = JSON.stringify({
        event,
        category: 'REIWA',
        severity: 'INFO',
        message: event,
        metadata,
        timestamp: new Date().toISOString(),
      });
      const { header } = buildWebhookSignature({ secret: this.secret, body });
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rezeis-Event': event,
          'X-Rezeis-Signature': header,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 204) {
        this.logger.warn(
          `Bot notify ${event} returned ${response.status} ${response.statusText}`,
        );
        return { messageId: null };
      }
      if (response.status === 204) return { messageId: null };
      const json = (await response.json().catch(() => null)) as
        | { messageId?: unknown }
        | null;
      const messageId =
        json !== null && typeof json.messageId === 'number' ? json.messageId : null;
      return { messageId };
    } catch (err: unknown) {
      this.logger.warn(
        `Bot notify ${event} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { messageId: null };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NotifyButton {
  readonly text: string;
  readonly url?: string;
  readonly callbackData?: string;
  /**
   * Relative path into the reiwa Mini App (e.g. `/renew`). The bot resolves
   * it against its own `miniAppUrl` and renders a Telegram `web_app` inline
   * button — opening the Mini App directly at that route. rezeis never needs
   * to know the bot username / public Mini App URL. Ignored when the bot has
   * no Mini App URL configured (falls back to a plain URL button when the
   * bot also knows its public web URL, otherwise dropped).
   */
  readonly webAppPath?: string;
}
