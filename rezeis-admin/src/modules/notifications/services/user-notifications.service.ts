import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { WebPushService } from '../../push/services/web-push.service';
import { CustomEmojiService } from '../../custom-emoji/services/custom-emoji.service';

import { BotNotifierClient, NotifyButton } from './bot-notifier.client';
import { NotificationTemplatesService } from './notification-templates.service';
import { isNotificationDeliveryEnabled, resolveToggleKey } from '../utils/notification-toggle.util';
import {
  coerceNotificationLocale,
  resolveTemplateButtons,
  resolveTemplateLocale,
  type NotificationLocale,
} from '../utils/notification-template-locale.util';
import { readPlatformBranding } from '../../settings/utils/platform-branding.util';

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
  /**
   * When true, the Telegram fanout is skipped (web-push + cabinet feed still
   * run). Used by the broadcast pipeline, which performs its own Telegram
   * delivery with media support and only needs the web-push + feed channels.
   */
  readonly skipTelegram?: boolean;
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
    private readonly customEmojiService: CustomEmojiService,
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
      skipTelegram: input.skipTelegram,
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
    skipTelegram?: boolean;
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
        select: { telegramId: true, isBotBlocked: true, name: true, language: true },
      });
      if (user === null) return;

      // Render the message once for both channels — keeps Telegram and
      // browser pushes in lockstep. `null` when no active template
      // matches the (canonical) type; preRenderedText short-circuits
      // template lookup for explicit operator sends.
      const locale = coerceNotificationLocale(user.language as string | null | undefined);
      const template =
        input.preRenderedText !== undefined ? null : await this.fetchTemplate(input.type);
      const rendered =
        input.preRenderedText !== undefined
          ? { title: 'Reiwa', body: input.preRenderedText, html: input.preRenderedText }
          : template === null || !template.isActive
            ? null
            : await this.renderFromTemplate(template, input.payload, user.name, locale);

      // Resolve operator-managed buttons from the same template (single
      // lookup — Phase 1 of the bot-studio-redesign moved expiry / referral
      // / partner button declarations from per-emitter constants into
      // NotificationTemplate.buttons). Caller-supplied `input.buttons`
      // still wins for ad-hoc sends.
      const buttons =
        input.buttons !== undefined
          ? input.buttons
          : template === null
            ? undefined
            : (() => {
                const resolved = resolveTemplateButtons(
                  { buttons: (template as { buttons?: unknown }).buttons ?? null },
                  locale,
                );
                return resolved.length > 0 ? resolved : undefined;
              })();

      // Telegram bot fanout — only for users who haven't blocked us.
      if (
        user.telegramId !== null &&
        !user.isBotBlocked &&
        rendered !== null &&
        input.skipTelegram !== true
      ) {
        await this.botNotifier.notifyUser({
          eventId: input.eventId,
          telegramId: user.telegramId.toString(),
          text: rendered.html,
          parseMode: 'HTML',
          buttons,
          bannerUrl:
            template !== null &&
            typeof template.bannerUrl === 'string' &&
            template.bannerUrl.trim().length > 0
              ? template.bannerUrl.trim()
              : undefined,
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
          // Deep-link the SW click to the page that lets the user act on
          // the notification (renewal / referrals / feed), mirroring the
          // cabinet's `resolveNotificationTarget` so PWA pushes and the
          // in-app bell agree on destinations.
          url: resolveNotificationPushUrl(input.type),
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
   * Admin-facing recent user-notification events feed — powers the
   * "Пользовательские события" tab of the Events page. Cursor-paginated
   * (createdAt+id desc). Joins the owning user's telegramId + name for
   * display. Read-only; never mutates.
   */
  public async listRecentEvents(input: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly userId: string;
      readonly telegramId: string | null;
      readonly userName: string | null;
      readonly payload: Record<string, unknown>;
      readonly readAt: string | null;
      readonly createdAt: string;
    }>;
    readonly nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    let seek: Prisma.UserNotificationEventWhereInput = {};
    if (input.cursor !== undefined && input.cursor.length > 0) {
      const last = await this.prismaService.userNotificationEvent.findUnique({
        where: { id: input.cursor },
        select: { id: true, createdAt: true },
      });
      if (last !== null) {
        seek = {
          OR: [
            { createdAt: { lt: last.createdAt } },
            { createdAt: last.createdAt, id: { lt: last.id } },
          ],
        };
      }
    }
    const rows = await this.prismaService.userNotificationEvent.findMany({
      where: seek,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { user: { select: { telegramId: true, name: true } } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((e) => ({
        id: e.id,
        type: e.type,
        userId: e.userId,
        telegramId: e.user.telegramId !== null ? e.user.telegramId.toString() : null,
        userName: e.user.name,
        payload:
          e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload)
            ? (e.payload as Record<string, unknown>)
            : {},
        readAt: e.readAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
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
  /**
   * Look up the template row matching `type` — first by canonical key
   * (so `subscription_expiring_3d` hits `expires_in_3_days`), then by
   * the raw type as a fallback. `null` when no row matches.
   */
  private async fetchTemplate(type: string): Promise<{
    readonly title: string;
    readonly body: string;
    readonly titleEn: string | null;
    readonly bodyEn: string | null;
    readonly buttons?: unknown;
    readonly bannerUrl?: string | null;
    readonly isActive: boolean;
  } | null> {
    const canonicalType = resolveToggleKey(type);
    const template =
      (await this.templatesService.getByType(canonicalType)) ??
      (await this.templatesService.getByType(type));
    if (template === null) return null;
    return template as never;
  }

  /**
   * Render `(title, body, html)` from an already-fetched template row +
   * locale + the user's payload. Pure substitution; the template lookup
   * happened upstream so we don't pay for it twice when the caller also
   * needs the row to resolve buttons.
   */
  private async renderFromTemplate(
    template: {
      readonly title: string;
      readonly body: string;
      readonly titleEn: string | null;
      readonly bodyEn: string | null;
    },
    payload: unknown,
    userName: string | null,
    locale: NotificationLocale,
  ): Promise<{ title: string; body: string; html: string }> {
    const projectName = await this.resolveProjectName();
    const ctx: Record<string, unknown> = {
      ...(payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}),
      name: userName ?? '',
      project_name: projectName,
      projectName,
    };
    const localized = resolveTemplateLocale(template, locale);
    const titleRaw = substitute(localized.title, ctx);
    const bodyRaw = substitute(localized.body, ctx);
    // Resolve `:slug:` custom-emoji pack tokens the operator inserted via the
    // notification editor's emoji picker — same premium treatment broadcasts
    // already get, so pack emoji render consistently everywhere:
    //   • Telegram (HTML): `<tg-emoji>` tags for premium-owner bots, else the
    //     fallback glyph;
    //   • cabinet feed / web-push (plain): the fallback glyph, never a raw
    //     `:slug:`.
    // Both helpers no-op when the text has no `:` so the common (token-less)
    // notification path stays a single allocation with no settings read.
    const html = `<b>${await this.customEmojiService.substituteTelegramHtml(
      escapeHtml(titleRaw),
    )}</b>\n\n${await this.customEmojiService.substituteTelegramHtml(bodyRaw)}`;
    const title = await this.customEmojiService.substituteFallbacks(titleRaw);
    const body = await this.customEmojiService.substituteFallbacks(bodyRaw);
    return { title, body, html };
  }

  /**
   * Reads the operator's configured project name from platform branding
   * (`Settings.platformPolicy`). Empty string when unset so `{{project_name}}`
   * collapses cleanly rather than leaking the placeholder.
   */
  private async resolveProjectName(): Promise<string> {
    try {
      const settings = await this.prismaService.settings.findUnique({
        where: { id: 1 },
        select: { platformPolicy: true },
      });
      return readPlatformBranding(settings?.platformPolicy ?? null).projectName ?? '';
    } catch {
      return '';
    }
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

/**
 * Resolve the cabinet route a web-push notification should deep-link to when
 * clicked, mirroring reiwa web's `resolveNotificationTarget` so the PWA push
 * and the in-app bell agree on destinations:
 *   • expiry / traffic-limit reminders → the renewal page
 *   • referral / partner program       → the referrals cabinet
 *   • broadcasts / news                 → the notifications feed
 *   • everything else                   → the dashboard
 */
function resolveNotificationPushUrl(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('support')) return '/support';
  if (t.includes('expir') || t.includes('limited')) return '/renew';
  if (t.includes('referral') || t.includes('partner')) return '/referrals';
  if (t.includes('broadcast') || t.includes('news')) return '/settings/notifications/feed';
  return '/dashboard';
}
