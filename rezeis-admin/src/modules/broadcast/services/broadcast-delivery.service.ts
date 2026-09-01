import { Injectable, Logger, Optional } from '@nestjs/common';
import { BroadcastAudience, BroadcastMessageStatus, BroadcastStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import {
  BotNotifierClient,
  type NotifyDeliveryResult,
} from '../../notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../../notifications/services/reiwa-relay-queue.service';
import { isRelayDelivered } from '../../notifications/reiwa-relay.policy';
import { isRetryableRelayOutcome } from '../../backup/backup-delivery-retry.util';
import { SettingsService } from '../../settings/services/settings.service';
import { CustomEmojiService } from '../../custom-emoji/services/custom-emoji.service';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import {
  TELEGRAM_RATE_LIMIT_MS,
  BROADCAST_FEED_NOTIFICATION_TYPE,
  BROADCAST_PROMO_BUTTON_LABEL,
  RELAY_CIRCUIT_BREAKER_THRESHOLD,
} from '../broadcast.constants';
import { buildPromoButton } from '../utils/broadcast-promo.util';
import { buildAudienceWhere, normalizeAudienceFilter } from '../utils/broadcast-audience.util';

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
    private readonly relayQueue: ReiwaRelayQueueService,
    @Optional()
    private readonly customEmojiService?: CustomEmojiService,
    @Optional()
    private readonly emailDeliveryService?: EmailDeliveryService,
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
   * Text-only on the Telegram leg (the dev-DM relay carries no media).
   *
   * `ok` reports what the attempts proved, not what was tried
   * ────────────────────────────────────────────────────────
   * It used to report success for two things that are not evidence of one.
   * The Telegram leg went out through `notifyDev`, which returns
   * `Promise<void>`, and `deliver()` never throws — so a rejected payload, a
   * ten-second timeout and a delivered message all left the same trace, and
   * `relayed` was set to `true` immediately after the call regardless. The
   * cabinet leg counted DEV rows found in the database, while every `create()`
   * below sits inside a `catch` that logs and moves on. An operator pressing
   * "send test" could be told `{ ok: true }` with nothing having left the
   * building on either surface.
   *
   * Both legs now report an outcome. The Telegram leg makes ONE direct attempt
   * through `deliverRelayEvent` — the only entry point on the client that
   * returns what it proved — and reads the verdict from `isRelayDelivered`,
   * which is where the per-event bar lives (`/notify-dev` answers a bodiless
   * 204, so a 2xx is the strongest evidence this event can produce). Routing
   * it through the durable queue instead would turn the operator's answer into
   * "we wrote it down", which is exactly the claim being removed here; the
   * same reasoning, for the same reason, as
   * `ReiwaCacheInvalidatorService.invalidateNow`. The cabinet leg counts the
   * writes that actually landed.
   *
   * Returns `{ ok: false }` with a reason when the draft has no content, or
   * when neither surface delivered.
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
    let relayStatus: string | null = null;
    if (this.botNotifier.isEnabled) {
      const outcome = await this.botNotifier.deliverRelayEvent('reiwa.dev.notify', {
        text: composed || ' ',
        parseMode: 'HTML',
      });
      relayStatus = outcome.status;
      relayed = isRelayDelivered('reiwa.dev.notify', outcome);
      if (!relayed) {
        this.logger.warn(
          `Broadcast ${broadcastId} test preview: dev relay did not deliver (${outcome.status}` +
            `${outcome.detail === null ? '' : `: ${outcome.detail}`})`,
        );
      }
    }

    // 2) Web cabinet (feed + web-push) for every DEV-role user. `skipTelegram`
    //    avoids a duplicate Telegram DM (the relay leg above already covers the
    //    dev's Telegram); the cabinet feed row + web-push are what was missing.
    const devUsers = await this.prismaService.user.findMany({
      where: { role: 'DEV', isBlocked: false },
      select: { id: true },
    });
    let cabinetDelivered = 0;
    for (const dev of devUsers) {
      try {
        // No `broadcastMessageId`: a preview belongs to no `BroadcastMessage`,
        // and that absence is what keeps it out of the delivery-side lookup
        // below. A DEV-role user who previewed a broadcast and is then in its
        // audience must still get the real feed row.
        await this.userNotifications.create({
          userId: dev.id,
          type: BROADCAST_FEED_NOTIFICATION_TYPE,
          payload: { broadcastId, text, ...(title ? { title } : {}) },
          preRenderedText: composed || ' ',
          skipTelegram: true,
        });
        cabinetDelivered += 1;
      } catch (err: unknown) {
        this.logger.warn(
          `Test broadcast cabinet delivery failed for dev ${dev.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!relayed && cabinetDelivered === 0) {
      // Nothing was delivered on either surface. The reason distinguishes the
      // three ways that happens, because they need different operator action:
      // a relay that was tried and refused reports its own status, a relay
      // that was never configured keeps the `relay-disabled` reason the
      // controller turns into "configure REIWA_URL or set a DEV role", and a
      // deployment with DEV users whose cabinet writes all failed says so
      // rather than blaming the relay it never had.
      const reason =
        relayStatus !== null && relayStatus !== 'disabled'
          ? `relay-${relayStatus}`
          : devUsers.length > 0
            ? 'cabinet-failed'
            : 'relay-disabled';
      return { ok: false, reason };
    }
    this.logger.log(
      `Broadcast ${broadcastId} test preview: telegram=${relayed}` +
        `${relayStatus === null ? '' : ` (${relayStatus})`}` +
        ` devCabinet=${cabinetDelivered}/${devUsers.length}`,
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
      select: {
        id: true,
        status: true,
        audience: true,
        audienceFilter: true,
        payload: true,
        promoCode: true,
      },
    });
    if (broadcast === null) {
      this.logger.warn(`Broadcast ${broadcastId} not found`);
      return [];
    }
    if (broadcast.status !== BroadcastStatus.DRAFT) {
      // ── NOT AN EMPTY ANSWER: RESUME ────────────────────────────────────
      //
      // Staging is claim-once on purpose — a retry must not create a second set
      // of recipient rows or post to the channel twice. But the caller uses
      // this return value to decide WHICH BATCHES TO ENQUEUE, and that loop
      // lives outside the claim. So a throw partway through it (a Redis blip, a
      // container restart mid-deploy) used to end like this: the retry found
      // PROCESSING, returned nothing, and the start job reported success while
      // every batch it had not yet enqueued was lost for good. That is how a
      // 400-recipient broadcast reached 40 people with no error anywhere.
      //
      // Handing back the rows still PENDING makes the retry a RESUME: the ones
      // already dispatched are SENT or FAILED and are not in this list, so
      // nobody is written to twice.
      if (broadcast.status === BroadcastStatus.PROCESSING) {
        const outstanding = await this.prismaService.broadcastMessage.findMany({
          where: { broadcastId, status: BroadcastMessageStatus.PENDING },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        this.logger.warn(
          `Broadcast ${broadcastId} already claimed — resuming ${outstanding.length} undispatched recipients`,
        );
        return outstanding.map((m) => m.id);
      }
      this.logger.warn(`Broadcast ${broadcastId} not DRAFT (current: ${broadcast.status})`);
      return [];
    }

    // Atomically CLAIM the broadcast (DRAFT → PROCESSING) before doing any
    // side-effecting work. The start job runs with attempts:3, so a throw after
    // the channel post but before the status flip would otherwise let a retry
    // re-enter staging (status still DRAFT) and DOUBLE-post the channel /
    // duplicate recipient rows. Winning the claim (count === 1) guarantees this
    // body runs at most once; a retry sees PROCESSING and no-ops.
    const claim = await this.prismaService.broadcast.updateMany({
      where: { id: broadcastId, status: BroadcastStatus.DRAFT },
      data: { status: BroadcastStatus.PROCESSING, startedAt: new Date() },
    });
    if (claim.count === 0) {
      this.logger.warn(
        `Broadcast ${broadcastId} already claimed (concurrent send or retry) — skipping stage`,
      );
      return [];
    }

    // We now own the broadcast (status is PROCESSING). Any throw past this
    // point would otherwise leave it stuck in PROCESSING forever — a retry
    // no-ops on the claim. Wrap the side-effecting body so a failure is a
    // clean terminal FAILED instead of a silent stuck state.
    try {
      // Additive channel: a ONE-SHOT post to an operator-configured Telegram
      // channel/group, independent of (and in addition to) the per-recipient
      // fanout below. Never blocks recipient delivery. Runs once (guarded by
      // the atomic claim above) and is handed to the durable relay queue,
      // which owns every attempt after this line.
      const channelPost = await this.postToChannelIfConfigured(
        broadcastId,
        broadcast.payload,
        broadcast.promoCode,
      );
      if (channelPost === 'dropped' || channelPost === 'disabled') {
        // The operator asked for a channel copy and it never entered durable
        // delivery. That has to be visible somewhere they look: the previous
        // code's only record was a `logger.warn` into an in-memory ring
        // buffer, and on the failure path that mattered most it did not even
        // reach that (`notifyBroadcast` swallowed the outcome, so the `catch`
        // never fired). A WARNING event is durable in `AdminAuditLog` and on
        // the realtime stream.
        //
        // Its own type, not `system.broadcast_sent`. That one is presented as
        // 📢 «Рассылка отправлена», so this card arrived titled with the exact
        // claim its body denies — and it fired every subscriber to "broadcast
        // sent" (tick-boxes, automation rules) from the middle of staging, on
        // a failure. `system.broadcast_sent` stays the terminal, successful
        // one; this is the undelivered channel copy and says so.
        this.systemEventsService.warn(
          EVENT_TYPES.BROADCAST_CHANNEL_POST_UNDELIVERED,
          'SYSTEM',
          `Broadcast channel post not delivered (${channelPost})`,
          { broadcastId, channelPost },
        );
      }

      const recipientUserIds = await this.resolveRecipients(
        broadcast.audience,
        broadcast.audienceFilter,
      );
      if (recipientUserIds.length === 0) {
        await this.prismaService.broadcast.update({
          where: { id: broadcastId },
          data: { status: BroadcastStatus.COMPLETED, totalCount: 0, completedAt: new Date() },
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

      // Status is already PROCESSING and startedAt is set (atomic claim above);
      // here we only record the resolved recipient total.
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { totalCount: recipientUserIds.length },
      });

      // NOT `SYSTEM_BROADCAST_SENT`. This fires before a single message has
      // gone anywhere, and it used to raise the same 📢 "Рассылка отправлена"
      // card as the finaliser — so the operator got "sent" twice per broadcast,
      // the first time before delivery had started.
      this.systemEventsService.info(
        EVENT_TYPES.BROADCAST_STARTED,
        'SYSTEM',
        `Broadcast staging: ${messages.length} recipients`,
        { broadcastId, recipientCount: messages.length, channelPost },
      );

      return messages.map((m) => m.id);
    } catch (err: unknown) {
      this.logger.error(
        `Broadcast ${broadcastId} staging failed after claim: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Terminal FAILED so the broadcast never hangs in PROCESSING; a start-job
      // retry then no-ops on the claim (status is no longer DRAFT).
      await this.prismaService.broadcast
        .update({
          where: { id: broadcastId },
          data: { status: BroadcastStatus.FAILED, completedAt: new Date() },
        })
        .catch(() => undefined);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DELIVER BATCH (text + media)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a batch of messages. Supports text-only, photo, and video broadcasts.
   *
   * What `SENT` now means
   * ─────────────────────
   * It used to mean `feedOk` — that `userNotifications.create()` returned,
   * which it does after a local Prisma insert and a `void this.fanout(...)`.
   * So a broadcast reported success for writing a row in our own database,
   * whether or not anything crossed the network to the cabinet, let alone
   * reached Telegram. The evidence was already in hand and thrown away:
   * `notifyUser` returns the Telegram message id the bot echoes back.
   *
   * The rule now is that `SENT` never rests on an unproven attempt. It rests
   * on one of exactly two things:
   *
   *  - a proven Telegram delivery — a message id from the relay, or an `ok`
   *    from the direct media send; or
   *  - the cabinet-feed channel, where a Telegram delivery was never in play:
   *    the recipient has no usable `telegramId`, or the relay is not
   *    configured on this deployment at all. Nothing was attempted, so nothing
   *    is being claimed. `errorMessage` still records why the Telegram leg was
   *    skipped when the recipient could have received one.
   *
   * An attempt that was made and not proven is never `SENT`. Where another
   * attempt could still change that it stays `PENDING` and this method reports
   * it as unresolved so the caller can re-run the batch; where it could not,
   * it becomes `FAILED` with the relay status as the reason.
   *
   * `isFinalAttempt` is the caller's answer to "is a re-run coming?" — on the
   * last one, everything still unresolved is written down as failed so the
   * broadcast can finalize instead of hanging on rows nobody will revisit.
   */
  public async deliverBatch(
    broadcastId: string,
    messageIds: string[],
    options?: { readonly isFinalAttempt?: boolean },
  ): Promise<{
    sent: number;
    failed: number;
    unresolved: number;
    /** Recipients this batch had an address for; `0` means nobody was mailed. */
    emailAttempted: number;
    /** Of those, the ones SMTP accepted. */
    emailSent: number;
  }> {
    // BOT_TOKEN is only needed for DIRECT media delivery (sendPhoto/sendVideo).
    // Text broadcasts are delivered via the reiwa bot (notification path), so a
    // missing token must NOT fail the whole batch — web-push + cabinet feed +
    // text Telegram all still work. Prefer the panel-managed encrypted token,
    // falling back to the env var.
    const botToken = await this.getBotToken();

    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true, payload: true, promoCode: true },
    });
    if (!broadcast) return { sent: 0, failed: 0, unresolved: 0, emailAttempted: 0, emailSent: 0 };

    // If broadcast was canceled mid-flight, skip remaining
    if (broadcast.status === BroadcastStatus.CANCELED) {
      await this.prismaService.broadcastMessage.updateMany({
        where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
        data: { status: BroadcastMessageStatus.CANCELED },
      });
      return { sent: 0, failed: 0, unresolved: 0, emailAttempted: 0, emailSent: 0 };
    }

    const payload = broadcast.payload as Record<string, unknown> | null;
    const title = typeof payload?.title === 'string' ? payload.title : null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const mediaType = payload?.mediaType as string | undefined;
    const mediaFileId = typeof payload?.mediaFileId === 'string' ? payload.mediaFileId : null;
    const parseMode = (payload?.parseMode as string) ?? undefined;
    const emailEnabled = payload?.emailEnabled === true;

    if (!text && !mediaFileId) {
      await this.failBatch(messageIds, 'Empty broadcast: no text and no media');
      await this.checkAndFinalize(broadcastId);
      return {
        sent: 0,
        failed: messageIds.length,
        unresolved: 0,
        emailAttempted: 0,
        emailSent: 0,
      };
    }

    const hasMedia = mediaFileId !== null && (mediaType === 'photo' || mediaType === 'video');

    // Telegram-bound text. Custom-emoji `:slug:` shortcodes become Telegram
    // premium custom-emoji via `<tg-emoji>` HTML tags when sent with parse_mode
    // HTML (text broadcasts always are; media captions only when the operator
    // chose HTML). Otherwise we fall back to the plain glyph.
    //
    // `useHtmlEmoji` decides the FORMAT only. Whether a tag is built at all is
    // decided inside `CustomEmojiService.substituteTelegramHtml`, which reads
    // the operator's owner-premium switch from settings: Telegram rejects a bot
    // message carrying custom-emoji entities when the owner has no Premium — it
    // does not degrade to the glyph — so a non-premium operator gets the plain
    // carrier glyph here and keeps the broadcast.
    //
    // The cabinet feed keeps the raw `:slug:` text (rendered as inline images).
    // The operator title (when set) leads the message as a bold headline —
    // rendered through the same custom-emoji substitution so premium emoji in
    // the title show up in Telegram too (not just the cabinet).
    const useHtmlEmoji = hasMedia ? parseMode === 'HTML' : true;
    const telegramText = await this.composeTelegram(title, text, useHtmlEmoji);

    // Promo-tagged broadcast → append a Mini App "activate promo" button to
    // each delivered message (text path). The reiwa bot resolves the
    // `webAppPath` against its own miniAppUrl, deep-linking `/promo?code=…`.
    const promoButton =
      broadcast.promoCode && broadcast.promoCode.length > 0
        ? buildPromoButton(broadcast.promoCode, BROADCAST_PROMO_BUTTON_LABEL)
        : null;

    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
      select: { id: true, userId: true },
    });

    // Which of these recipients already HAS their cabinet-feed row for this
    // broadcast. Asked of the feed itself, once per batch — see
    // `loadMessagesWithFeedRow` for why no property of the `BroadcastMessage`
    // row can answer it.
    const messagesWithFeedRow = await this.loadMessagesWithFeedRow(broadcastId, messages);

    let sent = 0;
    let failed = 0;
    // Counted per batch and reported with it. The email channel had NO tally
    // of any kind: an operator could not tell fifty letters sent from zero,
    // and with SMTP switched off the panel still said the broadcast completed.
    let emailAttempted = 0;
    let emailSent = 0;
    let unresolved = 0;
    /**
     * Circuit breaker.
     * ────────────────
     * This loop awaits one relay call per recipient, so an unreachable cabinet
     * used to cost `recipients x timeout` — and the timeout just went from 4s
     * to 10s, which would have made it four times worse. Five consecutive
     * TRANSPORT failures is not a run of bad luck, it is the link being down;
     * grinding through the rest of the list proves nothing and delays the
     * retry that might actually work.
     *
     * Only transport failures count. A recipient who blocked the bot is a
     * normal per-recipient outcome, and a queue of them must not be mistaken
     * for an outage — so anything that is not a retryable transport failure
     * resets the run to zero.
     */
    let consecutiveTransportFailures = 0;
    let circuitOpen = false;

    for (const message of messages) {
      const user = await this.prismaService.user.findUnique({
        where: { id: message.userId },
        // `webAccount.email` comes along because `User.email` alone is NOT where
        // this codebase keeps an address. Every OAuth sign-up deliberately
        // leaves `User.email` unset (see `external-auth.service.ts`) and every
        // AltShop import writes to the web account only — so reading one column
        // silently skipped all of them, with no log line and no counter. The
        // canonical resolution is `User.email ?? WebAccount.email`, used by the
        // email bridge, support and the block flow alike.
        select: { telegramId: true, email: true, webAccount: { select: { email: true } } },
      });
      if (!user) {
        await this.markFailed(message.id, 'User not found');
        failed++;
        continue;
      }

      // ── Additive channel: email ──────────────────────────────────────
      //
      // Attempted BEFORE the Telegram circuit breaker is honoured, and outside
      // it. The breaker exists because the Telegram relay is unwell; SMTP is a
      // different transport with a different failure, and cutting it along with
      // Telegram left healthy mail unsent for the rest of every batch.
      //
      // Still best-effort for the message's own SENT/FAILED verdict — the app
      // fanout below decides that — but the attempt is now COUNTED, so an
      // operator can tell "no mail was sent" from "mail was sent".
      const emailAddress = user.email ?? user.webAccount?.email ?? null;
      if (emailEnabled && emailAddress && this.emailDeliveryService) {
        emailAttempted++;
        try {
          await this.emailDeliveryService.send({
            to: emailAddress,
            subject: title?.trim() || 'Уведомление',
            templateType: '__broadcast__',
            variables: {},
            rawHtml: renderBroadcastEmailHtml(title, text),
          });
          emailSent++;
        } catch (err: unknown) {
          this.logger.warn(
            `Broadcast email failed for ${message.userId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // The Telegram breaker is honoured HERE — after the email attempt above,
      // so a sick relay stops the Telegram fan-out and nothing else.
      if (circuitOpen) break;

      // Deliver via the notification fanout: cabinet feed (always) + web-push
      // (always). The fanout's Telegram leg is skipped here — for TEXT we send
      // the Telegram message ourselves right below so we can capture the
      // returned message id (needed for later edit/delete within Telegram's
      // 48h window). For MEDIA we send the photo/video directly further down.
      //
      // Retries changed the shape of this. Until the batch job could actually
      // retry, `deliverBatch` ran once per row and creating the feed row here
      // was unconditional. Now every re-run of this block would give the
      // subscriber a second copy of the same broadcast in their in-app feed —
      // for a message whose only problem was that the Telegram hop timed out.
      //
      // The guard reads the feed, not the message row. `errorMessage` used to
      // stand in for it and could not: `retryBatch` clears the field, so an
      // operator pressing "retry failed" made every already-delivered feed row
      // look absent and minted a second one — every press, one duplicate.
      const feedRowExists = messagesWithFeedRow.has(message.id);
      let feedOk = feedRowExists;
      if (!feedRowExists) {
        try {
          // `broadcastMessageId` is what makes the lookup above exact: one
          // `BroadcastMessage`, at most one feed row, whichever pass wrote it.
          //
          // The id this call RETURNS is deliberately not the relay dedup key.
          // It exists only on the pass that writes the row, so keying the
          // Telegram leg on it made that leg unreachable on exactly the passes
          // that needed it. `broadcast:${message.id}` below is stable across
          // attempts instead.
          await this.userNotifications.create({
            userId: message.userId,
            type: BROADCAST_FEED_NOTIFICATION_TYPE,
            payload: {
              broadcastId,
              broadcastMessageId: message.id,
              text,
              ...(title ? { title } : {}),
            },
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
      }

      // Direct media Telegram delivery (needs a local BOT_TOKEN).
      let mediaOk = false;
      let mediaMessageId: number | undefined;
      let mediaError: string | null = null;
      // Text Telegram message id captured from the reiwa bot fanout, plus the
      // outcome it came from — `messageId` alone collapses "the bot proved a
      // delivery" and "the hop timed out" into the same `null`.
      let textMessageId: number | null = null;
      let relayOutcome: NotifyDeliveryResult | null = null;
      if (hasMedia && user.telegramId !== null && user.telegramId > 0n) {
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
      } else if (!hasMedia && user.telegramId !== null && user.telegramId > 0n && feedOk) {
        // Text Telegram via the reiwa bot, keyed on the BroadcastMessage id
        // rather than the cabinet event id.
        //
        // The cabinet event id used to be the natural key: one feed row, one
        // notify, same CUID for both. It stops working the moment a batch can
        // be retried, because a re-run mints a NEW feed row and therefore a new
        // CUID — so the bot's idempotency cache, which is the only thing
        // standing between a false-negative timeout and a duplicate Telegram
        // message, would see an id it has never seen and deliver it again.
        //
        // `BroadcastMessage.id` is stable across every attempt at this row,
        // which is exactly the property the key needs.
        relayOutcome = await this.botNotifier.notifyUser({
          eventId: `broadcast:${message.id}`,
          telegramId: user.telegramId.toString(),
          text: telegramText || ' ',
          parseMode: 'HTML',
          buttons: promoButton ? [promoButton] : undefined,
        });
        textMessageId = relayOutcome.messageId;
        await sleep(TELEGRAM_RATE_LIMIT_MS);
      }

      // Verdict.
      // A Telegram delivery was in play for this recipient only if they have a
      // usable id AND something actually tried. A `disabled` relay status means
      // the client returned without a request because this deployment has no
      // REIWA_URL: nothing was attempted, so there is no unproven claim to
      // guard against, and the cabinet feed is the delivery.
      const telegramAddressable = user.telegramId !== null && user.telegramId > 0n;
      const relayAttempted = relayOutcome !== null && relayOutcome.status !== 'disabled';
      const telegramAttempted = hasMedia ? telegramAddressable && botToken !== null : relayAttempted;

      if (relayOutcome !== null) {
        // Breaker bookkeeping, before the verdict — a run of timeouts is about
        // the link, not about these five recipients.
        if (isRetryableRelayOutcome(relayOutcome)) {
          consecutiveTransportFailures += 1;
          if (consecutiveTransportFailures >= RELAY_CIRCUIT_BREAKER_THRESHOLD) {
            circuitOpen = true;
          }
        } else {
          consecutiveTransportFailures = 0;
        }
      }

      if (!telegramAttempted) {
        // No Telegram leg. The cabinet feed row + web-push ARE the delivery,
        // and `feedOk` is honest evidence of them. The reason the Telegram leg
        // was skipped is still written down when the recipient could have had
        // one, so a misconfigured relay does not hide behind a green row.
        if (feedOk) {
          const skipReason =
            telegramAddressable && relayOutcome !== null
              ? `telegram_skipped_${relayOutcome.status}`
              : telegramAddressable && hasMedia
                ? (mediaError ?? 'BOT_TOKEN not configured for media delivery')
                : null;
          await this.prismaService.broadcastMessage.update({
            where: { id: message.id },
            data: {
              status: BroadcastMessageStatus.SENT,
              telegramMessageId: null,
              sentAt: new Date(),
              errorMessage: skipReason,
            },
          });
          sent++;
        } else {
          await this.markFailed(message.id, 'Delivery failed on all channels');
          failed++;
        }
        continue;
      }

      // A Telegram delivery WAS attempted. From here SENT needs proof of it.
      const telegramProven = hasMedia ? mediaOk : relayOutcome?.status === 'confirmed';
      if (telegramProven) {
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
            errorMessage: null,
          },
        });
        sent++;
        continue;
      }

      // Attempted, not proven. Retryable failures stay PENDING so a re-run of
      // this batch picks them up (it re-reads PENDING rows, so a proven row is
      // never re-sent); everything else is final now.
      const reason = hasMedia
        ? (mediaError ?? 'Media delivery failed')
        : `telegram_relay_${relayOutcome?.status ?? 'failed'}`;
      const retryable = !hasMedia && relayOutcome !== null && isRetryableRelayOutcome(relayOutcome);
      if (retryable && options?.isFinalAttempt !== true) {
        await this.prismaService.broadcastMessage.update({
          where: { id: message.id },
          data: { errorMessage: reason.slice(0, 500) },
        });
        unresolved++;
        continue;
      }
      await this.markFailed(message.id, reason);
      failed++;
    }

    if (circuitOpen) {
      // Everything after the trip was never attempted and is still PENDING.
      const untouched = await this.prismaService.broadcastMessage.count({
        where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
      });
      this.logger.warn(
        `Broadcast ${broadcastId}: relay circuit opened after ` +
          `${RELAY_CIRCUIT_BREAKER_THRESHOLD} consecutive transport failures; ` +
          `${untouched} message(s) left for the next attempt`,
      );
      if (options?.isFinalAttempt === true) {
        const { count } = await this.prismaService.broadcastMessage.updateMany({
          where: { id: { in: messageIds }, status: BroadcastMessageStatus.PENDING },
          data: {
            status: BroadcastMessageStatus.FAILED,
            errorMessage: 'telegram_relay_circuit_open',
          },
        });
        failed += count;
      } else {
        // Assignment, not accumulation: the per-recipient branch above already
        // counted the rows that timed out before the trip, and they are still
        // PENDING — so the count includes them. Adding would report more
        // owed messages than the batch has.
        unresolved = untouched;
      }
    }

    await this.checkAndFinalize(broadcastId);
    return { sent, failed, unresolved, emailAttempted, emailSent };
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
    // like the initial delivery: `<tg-emoji>` tags under parse_mode HTML,
    // otherwise the plain fallback glyph. The premium gate that decides whether
    // a tag may be built at all lives inside the substitution, not here.
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
   *
   * Clearing `errorMessage` is right and is no longer load-bearing: the field
   * describes the LAST attempt, so carrying a stale reason into a fresh one
   * would misreport it. It used to double as delivery's "the cabinet-feed row
   * already exists" flag, which made this line the cause of a duplicate feed
   * entry on every press of "retry failed"; that question is now asked of the
   * feed itself (`loadMessagesWithFeedRow`).
   */
  public async retryBatch(
    broadcastId: string,
    messageIds: string[],
    options?: { readonly isFinalAttempt?: boolean },
  ): Promise<{ sent: number; failed: number; unresolved: number }> {
    // Reset failed messages back to PENDING
    await this.prismaService.broadcastMessage.updateMany({
      where: { id: { in: messageIds }, broadcastId, status: 'FAILED' },
      data: { status: BroadcastMessageStatus.PENDING, errorMessage: null },
    });

    // Re-deliver using the standard batch logic
    return this.deliverBatch(broadcastId, messageIds, options);
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

    // ── THE STATUS FOLLOWS THE OUTCOME ──────────────────────────────────
    //
    // COMPLETED used to be written unconditionally, and `FAILED` was reachable
    // only when audience resolution itself threw. So a broadcast that reached
    // 40 of 400 people showed the same green "Завершено" as one that reached
    // all of them, and announced itself with an INFO card titled "Рассылка
    // отправлена". That is why nobody was told: there was no path that could
    // tell them.
    const nothingArrived = sentCount === 0 && failedCount > 0;
    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: nothingArrived ? BroadcastStatus.FAILED : BroadcastStatus.COMPLETED,
        successCount: sentCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    this.logger.log(`Broadcast ${broadcastId} completed: ${sentCount} sent, ${failedCount} failed`);

    // And the announcement follows it. A partial delivery is a WARNING the
    // operator's Telegram actually surfaces, not an INFO card that reads as
    // success — the whole point of the report is to be seen without asking.
    if (nothingArrived) {
      this.systemEventsService.error(
        EVENT_TYPES.SYSTEM_BROADCAST_SENT,
        'SYSTEM',
        `Broadcast delivered to NOBODY: ${failedCount} recipients failed`,
        { broadcastId, sentCount, failedCount },
      );
    } else if (failedCount > 0) {
      this.systemEventsService.warn(
        EVENT_TYPES.SYSTEM_BROADCAST_SENT,
        'SYSTEM',
        `Broadcast partially delivered: ${sentCount} sent, ${failedCount} failed`,
        { broadcastId, sentCount, failedCount },
      );
    } else {
      this.systemEventsService.info(
        EVENT_TYPES.SYSTEM_BROADCAST_SENT,
        'SYSTEM',
        `Broadcast completed: ${sentCount} sent`,
        { broadcastId, sentCount, failedCount },
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Of these `BroadcastMessage` rows, which ones already have their cabinet-feed
   * row written.
   *
   * Why this is a query and not a field
   * ───────────────────────────────────
   * The question "has this recipient already been given this broadcast in the
   * cabinet?" is a question about the FEED, and until now it was answered from
   * the message row instead: a PENDING row carrying an `errorMessage` had been
   * through the retry branch, which is reachable only after the feed row was
   * written. True as far as it went, and it did not go far enough:
   *
   *  - `retryBatch` CLEARS `errorMessage` before re-delivering, so on the one
   *    path an operator drives by hand the proxy read "no feed row" for every
   *    row that had one. Each press of "retry failed" put another copy of the
   *    same broadcast in the subscriber's feed, and the press could not deliver
   *    anything in exchange — the bot dedups the stable relay key and answers
   *    204, which reads as `unconfirmed`, which is not retryable, so the row
   *    goes straight back to FAILED. Unbounded duplicates, zero deliveries.
   *  - `telegram_relay_circuit_open` is written by `updateMany` over rows the
   *    breaker never reached, i.e. rows that may have no feed row at all. A
   *    proxy keyed on the reason string (even on its `telegram_relay_` prefix)
   *    reads those as delivered and then SKIPS the feed row on the retry, so
   *    the subscriber gets the Telegram message and nothing in the cabinet.
   *
   * `payload.broadcastMessageId` is the exact identity instead: one
   * `BroadcastMessage`, at most one feed row, independent of which pass wrote
   * it, of what the message row's reason string says, and of whether an
   * operator cleared it. It also keeps the dev preview out — `sendTestToDev`
   * writes feed rows for the same `broadcastId` and stamps no message id, so a
   * DEV-role user who previewed a broadcast still gets the real row.
   *
   * One query per batch, narrowed to the batch's own recipients. Rows staged
   * before this key existed carry no `broadcastMessageId` and are not matched,
   * so a broadcast already in flight when this ships keeps exactly the previous
   * behaviour for its remaining retries; everything staged afterwards is exact.
   */
  private async loadMessagesWithFeedRow(
    broadcastId: string,
    messages: ReadonlyArray<{ readonly id: string; readonly userId: string }>,
  ): Promise<ReadonlySet<string>> {
    const written = new Set<string>();
    if (messages.length === 0) return written;

    const rows = await this.prismaService.userNotificationEvent.findMany({
      where: {
        userId: { in: [...new Set(messages.map((message) => message.userId))] },
        type: BROADCAST_FEED_NOTIFICATION_TYPE,
        payload: { path: ['broadcastId'], equals: broadcastId },
      },
      select: { payload: true },
    });

    const inThisBatch = new Set(messages.map((message) => message.id));
    for (const row of rows) {
      const payload = row.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const messageId = (payload as Record<string, unknown>)['broadcastMessageId'];
      if (typeof messageId === 'string' && inThisBatch.has(messageId)) written.add(messageId);
    }
    return written;
  }

  /**
   * Compose the Telegram-bound message/caption from an optional operator title
   * and the body, substituting `:slug:` custom-emoji shortcodes:
   *   • `useHtmlEmoji` → `<tg-emoji>` tags for a Premium owner, the plain
   *     carrier glyph otherwise (the gate lives in
   *     `CustomEmojiService.substituteTelegramHtml`, which reads the switch
   *     from settings — Telegram rejects the message rather than degrading it);
   *     the title becomes a bold headline (`<b>…</b>`) above the body. The
   *     title is HTML-escaped first (it's plain text) before substitution; the
   *     body may carry operator HTML so it is substituted raw.
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

  /**
   * Additive channel: post the broadcast ONCE to an operator-configured
   * Telegram channel/group (`payload.telegramChannelChatId`) through the
   * durable relay queue (`reiwa.channel.broadcast`). No-op when unconfigured
   * or when the relay is disabled. Never throws — failure here must never
   * block staging recipients.
   *
   * Why the queue and not `notifyBroadcast`
   * ─────────────────────────────────────
   * This used to call `BotNotifierClient.notifyBroadcast` directly, which made
   * it the one call site of a `durable` event — four attempts, ~105s of window
   * — that got exactly one. The other two producers of
   * `reiwa.channel.broadcast` (the operator mirror in
   * `UserNotificationsService`, the system-event card in
   * `SystemEventsService`) went through the queue; this one did not, and
   * nothing in the type system said so.
   *
   * The second half of that is worse than the missing retries. `notifyBroadcast`
   * returns `Promise<void>` and `deliver()` never throws, so the `catch` below
   * could not fire on a delivery failure at all: a refused, timed-out or
   * rejected channel post was byte-for-byte indistinguishable from a delivered
   * one. That is the exact failure the queue exists to remove.
   *
   * The atomic DRAFT→PROCESSING claim in `stageRecipients` is what makes this
   * safe to queue rather than an argument against it. The claim guarantees the
   * body runs at most once per broadcast, so exactly one job is enqueued; the
   * retries then belong to that job and not to the broadcast start job, and a
   * start-job retry that loses the claim never reaches this method. The
   * enqueue also carries a stable `eventId`, so the queue's derived `jobId`
   * collapses an accidental double-enqueue and the bot's idempotency cache
   * collapses a replayed attempt — a retry cannot become a second post.
   *
   * Reports what happened so the caller can record it. `queued` means the job
   * is on the queue and the queue owns the outcome from there (an exhausted
   * job raises `reiwa.relay_undelivered`); `dropped` means it never got there
   * and nothing else will try.
   */
  private async postToChannelIfConfigured(
    broadcastId: string,
    rawPayload: Prisma.JsonValue,
    promoCode: string | null,
  ): Promise<'skipped' | 'disabled' | 'queued' | 'dropped'> {
    const payload = rawPayload as Record<string, unknown> | null;
    const chatId =
      typeof payload?.telegramChannelChatId === 'string'
        ? payload.telegramChannelChatId.trim()
        : '';
    if (chatId.length === 0) return 'skipped';
    if (!this.relayQueue.isEnabled) {
      this.logger.warn(
        `Broadcast ${broadcastId}: telegramChannelChatId set but the reiwa relay is disabled`,
      );
      return 'disabled';
    }

    try {
      // Compose INSIDE the try — substituteTelegramHtml/buildPromoButton can
      // throw, and this method must never propagate (its failure must not abort
      // recipient staging).
      const title = typeof payload?.title === 'string' ? payload.title : null;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      const composed = await this.composeTelegram(title, text, true);
      const promoButton =
        promoCode && promoCode.length > 0
          ? buildPromoButton(promoCode, BROADCAST_PROMO_BUTTON_LABEL)
          : null;
      // The metadata has to stay JSON-serialisable (it becomes the BullMQ job
      // payload), so the optional button list is spread in rather than passed
      // as an explicit `undefined`.
      const queued = await this.relayQueue.enqueue('reiwa.channel.broadcast', {
        eventId: `broadcast-channel:${broadcastId}`,
        chatId,
        text: composed || ' ',
        parseMode: 'HTML',
        ...(promoButton !== null ? { buttons: [promoButton] } : {}),
      });
      if (!queued) {
        // `enqueue` answers `false` when the relay is unconfigured or when
        // Redis refused the job and its direct fallback ran instead. Either
        // way nothing durable is holding this post.
        this.logger.warn(
          `Broadcast ${broadcastId}: channel post to ${chatId} was not accepted for durable delivery`,
        );
        return 'dropped';
      }
      this.logger.log(`Broadcast ${broadcastId}: channel post to ${chatId} queued`);
      return 'queued';
    } catch (err: unknown) {
      this.logger.warn(
        `Broadcast ${broadcastId}: channel post to ${chatId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'dropped';
    }
  }

  private async resolveRecipients(
    audience: BroadcastAudience,
    audienceFilter: Prisma.JsonValue | null,
  ): Promise<string[]> {
    // Single shared where-builder (SAME as the audience-count preview) so the
    // recipients actually staged always match the previewed count — the two
    // used to diverge. Web-only users (no Telegram) are intentionally included:
    // broadcasts reach them via web-push + the in-cabinet feed. A structured
    // `audienceFilter` supersedes the `audience` enum preset when present.
    const where = buildAudienceWhere(audience, normalizeAudienceFilter(audienceFilter));
    const users = await this.prismaService.user.findMany({
      where,
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render the raw HTML body for a broadcast email. Plain text: the operator
 * composes for Telegram (HTML tags / custom-emoji shortcodes), so the email
 * body escapes the text and only preserves line breaks — no `:slug:` or
 * Telegram-only markup leaks into the inbox. Wrapped in the branded layout by
 * `EmailTemplateRendererService` when `rawHtml` is passed to `send()`.
 */
function renderBroadcastEmailHtml(title: string | null, text: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const trimmedTitle = title?.trim() ?? '';
  const bodyHtml = escape(text).replace(/\n/g, '<br>');
  const headingHtml =
    trimmedTitle.length > 0
      ? `<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">${escape(trimmedTitle)}</h2>`
      : '';
  return `${headingHtml}<div style="color:#374151;font-size:15px;line-height:1.6;">${bodyHtml}</div>`;
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
