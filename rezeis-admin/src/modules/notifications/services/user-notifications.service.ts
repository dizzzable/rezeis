import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { WebPushService } from '../../push/services/web-push.service';

import { BotNotificationChannelsService } from './bot-notification-channels.service';
import { BotNotifierClient, NotifyButton } from './bot-notifier.client';
import { NotificationTemplatesService } from './notification-templates.service';
import { isNotificationDeliveryEnabled, resolveToggleKey } from '../utils/notification-toggle.util';

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
    private readonly channelsService: BotNotificationChannelsService,
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

      // Operator broadcast — push the same event to every active
      // BotNotificationChannel whose kindFilter accepts `input.type`.
      // Independent of the per-user delivery so an event with no
      // matched recipient (web-only user with bot blocked) still
      // reaches the operator-watching channels.
      if (rendered !== null) {
        await this.channelsService.broadcastToChannels({
          eventId: input.eventId,
          type: input.type,
          text: rendered.html,
          parseMode: 'HTML',
        });
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
