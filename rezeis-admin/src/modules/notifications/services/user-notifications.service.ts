import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { WebPushService } from '../../push/services/web-push.service';

import { BotNotifierClient, NotifyButton } from './bot-notifier.client';
import { NotificationTemplatesService } from './notification-templates.service';
import { isNotificationDeliveryEnabled, resolveToggleKey } from '../utils/notification-toggle.util';

/**
 * Categories the user notifications fall under for topic routing when
 * mirrored into the operator chat. User notifications are inherently
 * about the user's account state, so they route to the `USER` topic
 * (falling back to the default topic / general chat).
 */
const USER_NOTIFICATION_CATEGORY = 'USER';

interface CreateUserNotificationInput {
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /**
   * When provided, supersedes `payload` for the bot text fanout. Used
   * by callers who already know the rendered text (e.g. broadcast
   * blast that doesn't want template lookup overhead).
   */
  readonly preRenderedText?: string;
  /**
   * Optional buttons to attach to the Telegram message. SPA's cabinet
   * feed ignores them — they live only on the bot side.
   */
  readonly buttons?: ReadonlyArray<NotifyButton>;
}

/**
 * UserNotificationsService
 * ────────────────────────
 * Single source of truth for "notify this user" — writes the
 * `UserNotificationEvent` row (cabinet feed always sees it) and, in
 * parallel, fires the bot fanout for users who have a `telegramId`
 * and haven't blocked the bot.
 *
 * Refactored entry point for the three legacy callsites that used to
 * call `prisma.userNotificationEvent.create` directly:
 *   - admin/users/admin-user-management.controller (operator-pushed alerts)
 *   - partners/services/partner-notifications.service (program lifecycle)
 *   - auto-renew/auto-renew.service (subscription expiry warnings)
 *
 * Identity model: the canonical id is `User.id` (CUID = reiwa_id).
 * Telegram delivery is opt-in by virtue of `telegramId` being set;
 * web-only users (no telegramId) silently skip the bot fanout and
 * rely solely on the cabinet feed + future web-push channel.
 *
 * Failure isolation: persistence is a single transaction, fanout is
 * fire-and-forget. If Telegram is down, the user still sees the
 * notification in the cabinet on next visit.
 */
@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly templatesService: NotificationTemplatesService,
    private readonly botNotifier: BotNotifierClient,
    private readonly webPushService: WebPushService,
  ) {}

  /**
   * Persist a notification + fan it out to bot.
   *
   * Returns the persisted `UserNotificationEvent.id` so callers can
   * correlate logs / audit trails. Throws only when the persistence
   * itself fails (FK violation etc.) — fanout failures are logged and
   * swallowed.
   */
  public async create(input: CreateUserNotificationInput): Promise<string> {
    const event = await this.prismaService.userNotificationEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: input.payload as Prisma.InputJsonObject,
      },
      select: { id: true, userId: true, type: true, payload: true },
    });

    // Fanout is best-effort. Don't block the create() return on
    // network round-trips; let the caller continue while the bot
    // delivery happens in the background.
    void this.fanout({
      eventId: event.id,
      userId: event.userId,
      type: event.type,
      payload: event.payload,
      preRenderedText: input.preRenderedText,
      buttons: input.buttons,
    });

    return event.id;
  }

  private async fanout(input: {
    eventId: string;
    userId: string;
    type: string;
    payload: unknown;
    preRenderedText?: string;
    buttons?: ReadonlyArray<NotifyButton>;
  }): Promise<void> {
    try {
      // Operator opt-out gate. `preRenderedText` callers (explicit
      // admin "send message to user" actions) bypass the toggle —
      // they're a deliberate one-off, not an automated notification
      // kind the operator would have toggled off. Automated kinds
      // (subscription expiry, referral, partner) honour the
      // `userNotifications` toggle map saved from the admin panel.
      if (input.preRenderedText === undefined) {
        const userToggles = await this.readUserNotificationToggles();
        if (!isNotificationDeliveryEnabled(userToggles, input.type)) {
          // Suppressed by operator — the cabinet-feed row already
          // exists (created in `create()`), so the user still sees it
          // in-app; we just skip the push channels.
          return;
        }
      }

      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { telegramId: true, isBotBlocked: true, name: true },
      });
      if (user === null) return;

      // Render the message once for both channels — keeps Telegram and
      // browser pushes in lockstep. `null` when no active template
      // matches the (canonical) type; preRenderedText short-circuits
      // template lookup for explicit operator sends.
      const rendered =
        input.preRenderedText !== undefined
          ? { title: 'Reiwa', body: input.preRenderedText, html: input.preRenderedText }
          : await this.renderMessage(input.type, input.payload, user.name);

      // Telegram bot fanout — only for users who haven't blocked us.
      if (
        user.telegramId !== null &&
        !user.isBotBlocked &&
        rendered !== null
      ) {
        await this.botNotifier.notifyUser({
          eventId: input.eventId,
          telegramId: user.telegramId.toString(),
          text: rendered.html,
          parseMode: 'HTML',
          buttons: input.buttons,
        });
      }

      // Web-push fanout — independent of Telegram; covers browser-only
      // users and gives Telegram-linked users a second channel for when
      // they're at their desktop.
      if (rendered !== null) {
        await this.webPushService.sendToUser({
          userId: input.userId,
          title: rendered.title,
          // Browsers render the body as plain text inside the OS
          // Notification surface, so send the stripped form.
          body: stripHtml(rendered.body),
        });
      }

      // Operator mirror — when the operator enabled "mirror user
      // notifications" in Telegram delivery settings, post a copy of
      // this notification into the operator chat (routed to the USER
      // topic when configured). Variant A: one Telegram delivery
      // surface instead of a separate broadcast-channels table.
      if (rendered !== null) {
        await this.mirrorToOperatorChat(input.eventId, rendered.html);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `User notification fanout failed for ${input.userId}/${input.type}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mirror a rendered user notification into the operator's Telegram
   * delivery chat when `mirrorUserNotifications` is enabled. Reads the
   * same `systemNotifications.telegram` config the system-events
   * firehose uses, routing the copy to the `USER` topic (or the
   * default topic / general chat). Fire-and-forget — never throws.
   */
  private async mirrorToOperatorChat(eventId: string, html: string): Promise<void> {
    const config = await this.readTelegramDeliveryConfig();
    if (!config.enabled || !config.mirror || config.chatId === null) return;
    const topicThreadId =
      config.topics[USER_NOTIFICATION_CATEGORY] ?? config.defaultTopicId ?? undefined;
    await this.botNotifier.notifyBroadcast({
      // Suffix so the bot's idempotency LRU treats the operator-mirror
      // copy as distinct from the per-user delivery of the same event.
      eventId: `${eventId}:operator-mirror`,
      chatId: config.chatId,
      topicThreadId: topicThreadId ?? undefined,
      text: html,
      parseMode: 'HTML',
    });
  }

  /**
   * Read the operator's `userNotifications` opt-out map from the
   * singleton `Settings` row. Empty object on any miss / parse failure
   * so the opt-out default (everything enabled) holds — a missing
   * settings row must never silently suppress every notification.
   */
  private async readUserNotificationToggles(): Promise<Record<string, unknown>> {
    try {
      const settings = await this.prismaService.settings.findUnique({
        where: { id: 1 },
        select: { userNotifications: true },
      });
      const raw = settings?.userNotifications;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
      return {};
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to read userNotifications toggles, defaulting to all-enabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {};
    }
  }

  /**
   * Read the Telegram delivery config (`systemNotifications.telegram`)
   * from the singleton `Settings` row. Mirrors the shape
   * `SettingsService.getTelegramDeliveryConfig` returns but read
   * directly via Prisma to avoid a cross-module dependency on
   * SettingsModule (which would create an import cycle through
   * AuthModule). Returns delivery-disabled defaults on any miss.
   */
  private async readTelegramDeliveryConfig(): Promise<{
    enabled: boolean;
    mirror: boolean;
    chatId: string | null;
    defaultTopicId: number | null;
    topics: Record<string, number | null>;
  }> {
    try {
      const settings = await this.prismaService.settings.findUnique({
        where: { id: 1 },
        select: { systemNotifications: true },
      });
      const sysRaw = settings?.systemNotifications;
      const sys =
        sysRaw !== null && typeof sysRaw === 'object' && !Array.isArray(sysRaw)
          ? (sysRaw as Record<string, unknown>)
          : {};
      const tgRaw = sys.telegram;
      const tg =
        tgRaw !== null && typeof tgRaw === 'object' && !Array.isArray(tgRaw)
          ? (tgRaw as Record<string, unknown>)
          : {};
      const topicsRaw = tg.topics;
      const topicsObj =
        topicsRaw !== null && typeof topicsRaw === 'object' && !Array.isArray(topicsRaw)
          ? (topicsRaw as Record<string, unknown>)
          : {};
      const topics: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(topicsObj)) {
        topics[key.toUpperCase()] = typeof value === 'number' ? value : null;
      }
      return {
        enabled: tg.enabled === true,
        mirror: tg.mirrorUserNotifications === true,
        chatId: typeof tg.chatId === 'string' && tg.chatId.length > 0 ? tg.chatId : null,
        defaultTopicId: typeof tg.topicId === 'number' ? tg.topicId : null,
        topics,
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to read Telegram delivery config, skipping operator mirror: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { enabled: false, mirror: false, chatId: null, defaultTopicId: null, topics: {} };
    }
  }

  /**
   * Resolve the template for `type` (via its canonical toggle key so
   * legacy aliases like `subscription_expiring_3d` still hit the
   * `expires_in_3_days` template) and substitute `{{placeholder}}`
   * tokens with values from the event payload + the user's `name`.
   *
   * Returns `{ title, body, html }`:
   *   - `title` — the rendered template title (web-push headline)
   *   - `body`  — the rendered template body
   *   - `html`  — `<b>title</b>\n\nbody`, ready for Telegram HTML mode
   *
   * `null` when no active template matches — the caller skips all push
   * channels (the cabinet feed row still exists).
   */
  private async renderMessage(
    type: string,
    payload: unknown,
    userName: string | null,
  ): Promise<{ title: string; body: string; html: string } | null> {
    const canonicalType = resolveToggleKey(type);
    // Prefer the canonical key; fall back to the raw type for any
    // template authored against the fired string directly.
    const template =
      (await this.templatesService.getByType(canonicalType)) ??
      (await this.templatesService.getByType(type));
    if (template === null || !template.isActive) return null;
    const ctx: Record<string, unknown> = {
      ...(payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}),
      name: userName ?? '',
    };
    const title = substitute(template.title, ctx);
    const body = substitute(template.body, ctx);
    const html = `<b>${escapeHtml(title)}</b>\n\n${body}`;
    return { title, body, html };
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Tiny Handlebars-style substitution. Matches `{{key}}` and replaces
 * with `String(ctx[key])`. Missing keys collapse to empty string —
 * the alternative (leaving `{{key}}` in the output) leaks template
 * internals into user-facing copy and looks broken.
 *
 * No expression eval, no sub-paths, no helpers — keep it cosmetically
 * compatible with the existing template authoring style without
 * inheriting any of Handlebars' attack surface.
 */
function substitute(template: string, ctx: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Drop every HTML tag from the input. Used for web-push notification
 * bodies because browsers don't render markup inside the OS-level
 * Notification surface — `<b>` etc. would just appear literally.
 */
function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}
