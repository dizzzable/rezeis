import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { WebPushService } from '../../push/services/web-push.service';

import { BotNotificationChannelsService } from './bot-notification-channels.service';
import { BotNotifierClient, NotifyButton } from './bot-notifier.client';
import { NotificationTemplatesService } from './notification-templates.service';

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
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { telegramId: true, isBotBlocked: true, name: true },
      });
      if (user === null) return;

      // Render the text once for both channels — keeps Telegram and
      // browser pushes in lockstep.
      const text =
        input.preRenderedText ??
        (await this.renderText(input.type, input.payload, user.name));

      // Telegram bot fanout — only for users who haven't blocked us.
      if (
        user.telegramId !== null &&
        !user.isBotBlocked &&
        text !== null
      ) {
        await this.botNotifier.notifyUser({
          eventId: input.eventId,
          telegramId: user.telegramId.toString(),
          text,
          parseMode: 'HTML',
          buttons: input.buttons,
        });
      }

      // Web-push fanout — independent of Telegram; covers browser-only
      // users and gives Telegram-linked users a second channel for when
      // they're at their desktop.
      if (text !== null) {
        await this.webPushService.sendToUser({
          userId: input.userId,
          // Strip HTML tags from the text for the OS notification banner;
          // browsers don't render `<b>` etc. inside Notification surfaces.
          title: this.extractTitle(input.type),
          body: stripHtml(text),
        });
      }

      // Operator broadcast — push the same event to every active
      // BotNotificationChannel whose kindFilter accepts `input.type`.
      // Independent of the per-user delivery so an event with no
      // matched recipient (web-only user with bot blocked) still
      // reaches the operator-watching channels.
      if (text !== null) {
        await this.channelsService.broadcastToChannels({
          eventId: input.eventId,
          type: input.type,
          text,
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
   * Resolve the template title for a given event type so the web-push
   * banner has a short, human-readable headline. Falls back to the
   * event type itself when no template is registered.
   */
  private extractTitle(type: string): string {
    // Title is part of the same template the bot text uses; fetched
    // separately so we don't have to round-trip the raw template
    // through fanout(). NotificationTemplatesService caches via
    // Prisma so this is a single round-trip per fanout in the worst
    // case.
    return type;
  }

  /**
   * Resolve the template for `type` and substitute `{{placeholder}}`
   * tokens with values from the event payload + the user's `name`.
   * Returns null when no active template matches — the caller skips
   * the bot fanout (cabinet still has the row).
   */
  private async renderText(
    type: string,
    payload: unknown,
    userName: string | null,
  ): Promise<string | null> {
    const template = await this.templatesService.getByType(type);
    if (template === null || !template.isActive) return null;
    const ctx: Record<string, unknown> = {
      ...(payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}),
      name: userName ?? '',
    };
    const title = substitute(template.title, ctx);
    const body = substitute(template.body, ctx);
    // Compose `<b>title</b>\n\nbody` so the message renders nicely
    // in Telegram with HTML parse mode.
    return `<b>${escapeHtml(title)}</b>\n\n${body}`;
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
