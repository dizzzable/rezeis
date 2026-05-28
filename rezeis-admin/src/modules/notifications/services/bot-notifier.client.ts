import { Injectable, Logger } from '@nestjs/common';

/**
 * BotNotifierClient
 * ─────────────────
 * Outbound HTTP client that punches per-user notifications and channel
 * broadcasts at reiwa-bot's internal listener (`POST /notify`,
 * `POST /notify-broadcast`). Auth: shared secret in `X-Auth-Token`.
 *
 * Fire-and-forget: callers never await delivery confirmation. The bot
 * acknowledges with 204 on success or 502 on transient failure; we
 * log the result and move on. Persistence of the notification (so the
 * user sees it in the cabinet feed) is the caller's responsibility
 * and runs independently of this delivery — failure to push to
 * Telegram never blocks cabinet UX.
 *
 * Idempotency: each call carries an `eventId` (typically the
 * `UserNotificationEvent.id` CUID). The bot keeps an LRU of recently
 * delivered ids and no-ops on replays. Safe to retry on transport
 * errors without producing duplicate Telegram messages.
 *
 * Disabled when `REIWA_BOT_URL` (or `REZEIS_INTERNAL_SHARED_SECRET`)
 * is unset — calls become no-ops so dev/test stacks don't need the
 * bot container running.
 */
@Injectable()
export class BotNotifierClient {
  private readonly logger = new Logger(BotNotifierClient.name);
  private readonly baseUrl: string | null;
  private readonly secret: string | null;

  /**
   * Per-call HTTP timeout. Push paths run inline with admin requests
   * (e.g. payment webhook → notify) so we cap aggressively to avoid
   * piling up connections when the bot is degraded. The bot's own
   * sendMessage timeout is 10s; 4s here gives the network ~3s of
   * round-trip headroom.
   */
  private static readonly TIMEOUT_MS = 4_000;

  public constructor() {
    this.baseUrl = (process.env.REIWA_BOT_URL ?? '').trim() || null;
    this.secret = (process.env.REZEIS_INTERNAL_SHARED_SECRET ?? '').trim() || null;
    if (this.baseUrl === null || this.secret === null) {
      this.logger.warn(
        'BotNotifierClient disabled — set REIWA_BOT_URL and REZEIS_INTERNAL_SHARED_SECRET to enable',
      );
    }
  }

  /**
   * Deliver a per-user message to Telegram. `eventId` MUST be stable
   * across retries; reuse the source `UserNotificationEvent.id` CUID
   * to get free deduplication.
   */
  public async notifyUser(input: {
    readonly eventId: string;
    readonly telegramId: string;
    readonly text: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
    readonly buttons?: ReadonlyArray<NotifyButton>;
  }): Promise<void> {
    if (this.baseUrl === null || this.secret === null) return;
    await this.post('/notify', {
      eventId: input.eventId,
      telegramId: input.telegramId,
      text: input.text,
      parseMode: input.parseMode,
      buttons: input.buttons,
    });
  }

  /**
   * Deliver a message to a Telegram chat or forum topic. Used for
   * operator-managed broadcast channels (admin event feed, partner
   * channel, etc.) configured through the BotNotificationChannel UI.
   */
  public async notifyBroadcast(input: {
    readonly eventId: string;
    readonly chatId: string;
    readonly topicThreadId?: number;
    readonly text: string;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
    readonly buttons?: ReadonlyArray<NotifyButton>;
  }): Promise<void> {
    if (this.baseUrl === null || this.secret === null) return;
    await this.post('/notify-broadcast', {
      eventId: input.eventId,
      chatId: input.chatId,
      topicThreadId: input.topicThreadId,
      text: input.text,
      parseMode: input.parseMode,
      buttons: input.buttons,
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    if (this.baseUrl === null || this.secret === null) return;
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BotNotifierClient.TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.secret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 204) {
        this.logger.warn(
          `Bot notify ${path} returned ${response.status} ${response.statusText}`,
        );
      }
    } catch (err: unknown) {
      // Bot unavailable / network blip / timeout — swallow because
      // the cabinet feed already has the notification persisted.
      this.logger.warn(
        `Bot notify ${path} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NotifyButton {
  readonly text: string;
  readonly url?: string;
  readonly callbackData?: string;
}
