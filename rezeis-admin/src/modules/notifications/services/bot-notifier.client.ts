import { Injectable, Logger } from '@nestjs/common';

import { buildWebhookSignature } from '../../../common/http/webhook-signature.util';
import type { ReiwaRelayEvent } from '../reiwa-relay.constants';

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

/**
 * The panel's deadline has to OUTLAST the cabinet's, route by route
 * ═════════════════════════════════════════════════════════════════
 * This request is not a leaf. The cabinet answers it only after its own call
 * to the bot settles, and it gives that call a budget per route
 * (`reiwa/src/api/routes/webhooks.ts` -> `relayToBot`). The two deadlines are
 * therefore nested, and the rule the outer one must obey is:
 *
 *     panel deadline  >  cabinet deadline for the SAME route  +  network slack
 *
 * Break it and the panel walks away while the cabinet is still working. It
 * reads its own abort as `timeout`, `isRetryableRelayOutcome` calls that
 * transient, and the queue retries a delivery that never failed — while the
 * bot, which did finish, posts the message a second time. The panel's
 * impatience is the whole cause of the duplicate.
 *
 * One flat 10s budget used to cover every route while the cabinet allowed the
 * INLINE DOCUMENT routes 30s, so any dev/operator document that took more than
 * ten seconds to upload was guaranteed — not merely likely — to be read as a
 * timeout and sent again. Documents are precisely the payloads that take long.
 *
 * The slack covers what the cabinet's own clock never starts: TLS and the
 * panel -> cabinet hop in both directions, plus the cabinet's HMAC check and
 * zod parse, all of which run before its `AbortSignal.timeout` is armed.
 */

/**
 * Message routes: cabinet `BOT_RELAY_TIMEOUT_MS` = 8s, plus 2s of slack.
 *
 * Unchanged. It was already on the right side of the invariant, and the 4s ->
 * 10s move that produced it is still the reason it is not smaller: nothing on
 * these paths is inline with an operator request (`UserNotificationsService`
 * fires its fanout with `void`, broadcast delivery runs inside a BullMQ
 * processor, the durable relay runs in `ReiwaRelayProcessor`), so a longer
 * wait costs nothing an operator can see and buys back deliveries a short
 * abort was throwing away.
 */
const RELAY_MESSAGE_TIMEOUT_MS = 10_000;

/**
 * Inline-document routes: cabinet `BOT_RELAY_DOCUMENT_TIMEOUT_MS` = 30s, plus
 * 5s of slack.
 *
 * More slack than the message routes get, because the body is bigger: the
 * cabinet caps `documentContentSchema` at 1 MB, and that megabyte has to cross
 * the panel -> cabinet hop before the cabinet's own 30s clock even starts. 35s
 * is the smallest round number that clears 30s by more than the message
 * route's margin. The cost of the larger number is bounded — at worst
 * `RELAY_WORKER_CONCURRENCY` worker slots sitting on a wedged cabinet for 35s
 * instead of 10s, on the rarest events on the queue. The cost of a smaller one
 * is a duplicate document every single time an upload runs long.
 */
const RELAY_DOCUMENT_TIMEOUT_MS = 35_000;

/** Routes that carry the document bytes INLINE in the webhook body. */
const RELAY_DOCUMENT_EVENTS: ReadonlySet<string> = new Set([
  'reiwa.channel.broadcast.document',
  'reiwa.dev.notify.document',
]);

/**
 * Routes that get NO total deadline — today exactly one.
 *
 * `reiwa.backup.document` hands the bot a download token; the bot then streams
 * the backup out of rezeis and up to Telegram, and only then answers. That
 * file can be gigabytes, so the cabinet deliberately passes `null` instead of
 * a deadline and says why at the call site: a total deadline small enough to
 * be useful against a wedged bot is also small enough to cut a legitimate
 * upload, and the cut surfaces as the one status `BackupService` retries.
 *
 * A 10s cap on THIS side recreated exactly that harm one hop further out. The
 * panel aborts, records `timeout`, `isRetryableRelayOutcome` says retry, the
 * backup queue has `attempts: 3` — and one slow backup becomes two or three
 * multi-gigabyte copies in the operator's topic. Matching the cabinet's `null`
 * is what keeps the panel from causing the duplicate the cabinet refused to.
 *
 * `null` is not "unbounded": undici still applies its 300s headers/body IDLE
 * defaults, the same ceiling the cabinet is left with. An idle timeout is the
 * shape this call actually wants, and global `fetch` cannot express one.
 */
const RELAY_UNBOUNDED_EVENTS: ReadonlySet<string> = new Set(['reiwa.backup.document']);

/**
 * Total request deadline for one relay event, or `null` for "no total
 * deadline". Exported so the invariant above can be asserted against the
 * cabinet's own numbers instead of restated as prose.
 */
export function relayRequestTimeoutMs(event: string): number | null {
  if (RELAY_UNBOUNDED_EVENTS.has(event)) return null;
  if (RELAY_DOCUMENT_EVENTS.has(event)) return RELAY_DOCUMENT_TIMEOUT_MS;
  return RELAY_MESSAGE_TIMEOUT_MS;
}

@Injectable()
export class BotNotifierClient {
  private readonly logger = new Logger(BotNotifierClient.name);
  private readonly endpoint: string | null;
  private readonly secret: string | null;

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
   *
   * Returns the full outcome, not the message id. It used to return
   * `number | null`, which collapsed six distinct results into one value — a
   * bot that proved a delivery, a recipient who blocked the bot, a payload the
   * bot refused, a four-second timeout and a relay that was never configured
   * all arrived as `null`. Both callers that survive need to tell those apart:
   * the relay processor decides retry-vs-give-up from the status, and
   * broadcast delivery decides SENT-vs-FAILED from it. A convenience wrapper
   * back to `number | null` is deliberately not provided — it is the shape
   * that made `SENT` mean "we wrote a row in our own database".
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
  }): Promise<NotifyDeliveryResult> {
    return this.deliver('reiwa.user.notify', {
      eventId: input.eventId,
      telegramId: input.telegramId,
      text: input.text,
      parseMode: input.parseMode,
      buttons: input.buttons,
      bannerUrl: input.bannerUrl,
    });
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
   * Deliver a text document to an operator chat or forum topic through the
   * reiwa bot. This keeps full error reports available on split deployments,
   * where Rezeis deliberately does not keep the Telegram bot token.
   */
  public async notifyBroadcastDocument(input: {
    readonly eventId: string;
    readonly chatId: string;
    readonly filename: string;
    readonly content: string;
    readonly caption?: string;
    readonly topicThreadId?: number;
    readonly parseMode?: 'MarkdownV2' | 'HTML';
  }): Promise<void> {
    await this.deliver('reiwa.channel.broadcast.document', {
      eventId: input.eventId,
      chatId: input.chatId,
      filename: input.filename,
      content: input.content,
      caption: input.caption,
      topicThreadId: input.topicThreadId,
      parseMode: input.parseMode,
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
  }): Promise<NotifyDeliveryResult> {
    return this.deliver('reiwa.backup.document', {
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

  /**
   * One attempt at an arbitrary relay event, reporting exactly what it proved.
   *
   * The entry point `ReiwaRelayProcessor` uses: the event kind travels in the
   * job payload, so the processor cannot pick a typed method per event without
   * a nine-arm switch that adds nothing. Metadata shaping stays with the
   * producer, which is where the caller's own types are.
   */
  public async deliverRelayEvent(
    event: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
  ): Promise<NotifyDeliveryResult> {
    return this.deliver(event, metadata);
  }

  private async deliver(
    event: string,
    metadata: Record<string, unknown>,
  ): Promise<NotifyDeliveryResult> {
    if (this.endpoint === null || this.secret === null) {
      return { status: 'disabled', messageId: null, httpStatus: null, detail: null };
    }
    // Per route, and always longer than the cabinet's budget for that same
    // route — see `relayRequestTimeoutMs`. `null` means "no total deadline",
    // which is not "no ceiling": undici's 300s idle defaults still apply.
    const timeoutMs = relayRequestTimeoutMs(event);
    const controller = timeoutMs === null ? null : new AbortController();
    let timedOut = false;
    const timeout =
      controller === null || timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
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
        ...(controller === null ? {} : { signal: controller.signal }),
      });
      if (!response.ok) {
        this.logger.warn(
          `Bot notify ${event} returned ${response.status} ${response.statusText}`,
        );
        return {
          status: 'rejected',
          messageId: null,
          httpStatus: response.status,
          detail: `HTTP ${response.status} ${response.statusText}`.trim(),
        };
      }
      // 204 carries no body, so it can never carry a message id: reiwa accepted
      // the relay instruction and told us nothing about what the bot did with it.
      if (response.status === 204) {
        return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
      }
      const json = (await response.json().catch(() => null)) as
        | { messageId?: unknown }
        | null;
      const messageId =
        json !== null && typeof json.messageId === 'number' ? json.messageId : null;
      // A message id is Telegram's own, echoed back through reiwa — the only
      // evidence in this exchange that anything actually reached Telegram.
      // A 2xx without one means "instruction accepted", which is not the same claim.
      return {
        status: messageId === null ? 'unconfirmed' : 'confirmed',
        messageId,
        httpStatus: response.status,
        detail: null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Bot notify ${event} threw: ${message}`);
      return {
        status: timedOut ? 'timeout' : 'failed',
        messageId: null,
        httpStatus: null,
        detail: timedOut ? `timed out after ${timeoutMs}ms` : message,
      };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}

/**
 * What a relay attempt actually proved.
 *
 * Only `confirmed` means the message reached Telegram. Everything else is a
 * distinct event with a distinct remedy, which is why they are not collapsed
 * into one boolean: `rejected` is terminal (the same payload will be rejected
 * again), `timeout` and `failed` are transient (worth retrying), `unconfirmed`
 * means the hop succeeded but told us nothing, and `disabled` means no attempt
 * was made at all.
 */
export type NotifyDeliveryStatus =
  | 'confirmed'
  | 'unconfirmed'
  | 'rejected'
  | 'timeout'
  | 'failed'
  | 'disabled';

export interface NotifyDeliveryResult {
  readonly status: NotifyDeliveryStatus;
  /** Telegram's message id when reiwa echoed one back; `null` otherwise. */
  readonly messageId: number | null;
  /** Response status for `rejected`/`unconfirmed`; `null` when no response arrived. */
  readonly httpStatus: number | null;
  /** Human-readable failure detail for `rejected`/`timeout`/`failed`. */
  readonly detail: string | null;
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
  /**
   * Optional Telegram Bot API 9.4 button color (`primary` / `success` /
   * `danger`). Only premium-owner bots render it; everyone else sees the
   * default button. `undefined` → default.
   */
  readonly style?: 'primary' | 'success' | 'danger';
  /**
   * Optional 0-based row index for inline-keyboard layout. Buttons sharing a
   * row render side-by-side; omitted → the bot lays each button on its own row
   * (historical behaviour).
   */
  readonly row?: number;
}
