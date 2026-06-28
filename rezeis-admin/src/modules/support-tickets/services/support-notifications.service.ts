import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { NotificationTemplatesService } from '../../notifications/services/notification-templates.service';
import type { NotifyButton } from '../../notifications/services/bot-notifier.client';
import {
  coerceNotificationLocale,
  resolveTemplateButtons,
  resolveTemplateLocale,
} from '../../notifications/utils/notification-template-locale.util';
import { SupportGuestService } from './support-guest.service';

/**
 * SupportNotificationsService
 * ───────────────────────────
 * Closes the operator→user delivery gap for support tickets. When an
 * operator replies, the user historically saw nothing until their next
 * cabinet poll. This routes the reply through `UserNotificationsService`
 * (the single "notify a user" source of truth), which fans out to:
 *   - the cabinet notification feed (always),
 *   - the bot DM (Telegram-linked users),
 *   - the user's web-push subscriptions.
 *
 * Best-effort by contract: a delivery failure must never block or fail the
 * operator's reply (which is already persisted). Guest-owned tickets (no
 * `User`) are skipped here and handled by the anonymous-support phase.
 */
@Injectable()
export class SupportNotificationsService {
  private readonly logger = new Logger(SupportNotificationsService.name);

  public constructor(
    private readonly userNotifications: UserNotificationsService,
    private readonly prismaService: PrismaService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly guestService: SupportGuestService,
    private readonly templatesService: NotificationTemplatesService,
  ) {}

  /**
   * Notify the ticket owner that an operator replied. `preRenderedText`
   * deliberately bypasses the notification-template + opt-out gate: a human
   * operator reply is an explicit, one-off send the user always wants.
   */
  public async notifyAdminReply(input: {
    readonly ticketId: string;
    readonly subject: string;
    readonly user: { readonly id: string; readonly language: string | null } | null;
  }): Promise<void> {
    // Guest tickets (no account user) are delivered in the anonymous-support
    // phase via the guest channel; nothing to push to a cabinet/bot here.
    if (input.user === null) return;

    try {
      const locale = coerceNotificationLocale(input.user.language);
      const substHtml = makeSubstitution({ subject: input.subject, ticketId: input.ticketId }, true);
      const substRaw = makeSubstitution({ subject: input.subject, ticketId: input.ticketId }, false);

      // Operator-editable, seeded `support_reply` template supplies the copy +
      // buttons (label/emoji/target) — so the notification is visible on the
      // bot map and editable in the admin (incl. premium custom-emoji on the
      // button label, which the bot promotes to icon_custom_emoji_id). We
      // still deliver via the preRenderedText path so it bypasses the
      // notification opt-out toggle: a human reply must always reach the user.
      // The built-in copy is the fallback when the row is absent.
      const template = await this.templatesService.getByType('support_reply').catch(() => null);

      let title: string;
      let body: string;
      let buttons: NotifyButton[];
      if (template !== null) {
        const loc = resolveTemplateLocale(template, locale);
        title = substHtml(loc.title);
        body = substHtml(loc.body);
        buttons = resolveTemplateButtons(template, locale).map((button) =>
          applyTicketDeepLink(button, substRaw, input.ticketId),
        );
      } else {
        const copy = SUPPORT_REPLY_COPY[locale === 'ru' ? 'ru' : 'en'];
        title = copy.title;
        body = copy.body(escapeHtml(input.subject));
        buttons = [{ text: copy.openButton, webAppPath: `/support?ticket=${input.ticketId}` }];
      }

      // Title is HTML-escaped; injected values inside the body are escaped by
      // the substitutor while operator markup is preserved (matches the
      // template fanout convention). The cabinet feed strips HTML on display.
      const html = `<b>${escapeHtml(title)}</b>\n\n${body}`;
      await this.userNotifications.create({
        userId: input.user.id,
        type: 'support_reply',
        // Title + text live in the payload too (not just preRenderedText, which
        // only feeds the bot/push fanout) so the cabinet notification feed —
        // which renders from the persisted event payload — shows real copy and
        // a ticket reference instead of "text unavailable".
        payload: {
          ticketId: input.ticketId,
          subject: input.subject,
          title,
          text: body,
        },
        preRenderedText: html,
        buttons: buttons.length > 0 ? buttons : undefined,
      });
    } catch (err: unknown) {
      // Never surface to the operator; the reply itself is already saved.
      this.logger.warn(
        `Support reply notification failed for ticket ${input.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Email-continuity for a GUEST ticket: when an operator replies and the
   * visitor left an email, send a localized "you have a reply" email with a
   * one-time resume link so they can return from any device. Best-effort —
   * a missing email, missing SMTP, or send failure never blocks the reply.
   */
  public async notifyGuestReply(ticketId: string): Promise<void> {
    try {
      const ticket = await this.prismaService.supportTicket.findUnique({
        where: { id: ticketId },
        select: {
          subject: true,
          guestId: true,
          guest: { select: { id: true, email: true } },
        },
      });
      const email = ticket?.guest?.email?.trim();
      if (!ticket || !ticket.guest || !email) return; // no contact → polling only

      const token = await this.guestService.issueEmailResumeToken(ticket.guest.id);
      const base = await this.resolvePublicBase();
      const link = token && base ? `${base}/support/guest?resume=${encodeURIComponent(token)}` : base;

      const copy = GUEST_REPLY_EMAIL;
      const html = buildGuestReplyEmail(copy.body(ticket.subject), link, copy.button);
      await this.emailDelivery.send({
        to: email,
        subject: copy.subject,
        templateType: '__support_guest_reply__',
        variables: {},
        rawHtml: html,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Guest reply email failed for ticket ${ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Public base URL for guest resume links (branding website → null). */
  private async resolvePublicBase(): Promise<string | null> {
    const settings = await this.prismaService.settings.findFirst({
      select: { brandingSettings: true },
    });
    const json = (settings?.brandingSettings ?? {}) as Record<string, unknown>;
    const website = typeof json.websiteUrl === 'string' ? json.websiteUrl.trim() : '';
    if (website.length === 0) return null;
    return website.replace(/\/+$/, '');
  }
}

type SupportLang = 'ru' | 'en';

const SUPPORT_REPLY_COPY: Record<SupportLang, { title: string; body: (subject: string) => string; openButton: string }> = {
  ru: {
    title: '💬 Поддержка ответила',
    body: (subject) =>
      `По вашему обращению «${subject}» есть новый ответ от поддержки. Откройте раздел «Поддержка», чтобы прочитать.`,
    openButton: '💬 Открыть обращение',
  },
  en: {
    title: '💬 Support replied',
    body: (subject) =>
      `There is a new reply to your ticket "${subject}". Open the Support section to read it.`,
    openButton: '💬 Open ticket',
  },
};

/** Build a `{{subject}}` / `{{ticketId}}` substitutor. When `escape` is set the
 *  injected values are HTML-escaped (the subject is user-controlled, so it must
 *  be safe inside Telegram HTML mode); operator-authored markup around the
 *  placeholder is left intact. `:slug:` emoji tokens are never touched. */
function makeSubstitution(
  ctx: { subject: string; ticketId: string },
  escape: boolean,
): (input: string) => string {
  const subject = escape ? escapeHtml(ctx.subject) : ctx.subject;
  const ticketId = escape ? escapeHtml(ctx.ticketId) : ctx.ticketId;
  return (input: string): string =>
    input.replace(/\{\{\s*(subject|ticketId)\s*\}\}/g, (_match, key: string) =>
      key === 'ticketId' ? ticketId : subject,
    );
}

/**
 * Substitute `{{subject}}`/`{{ticketId}}` placeholders in a resolved button and
 * auto-append the ticket id to a bare `/support` Mini App deep-link so the
 * cabinet opens the exact ticket. `:slug:` premium-emoji tokens in the label
 * are left untouched (the bot promotes them to `icon_custom_emoji_id`). An
 * operator who repoints the button or adds their own `?ticket=` is respected.
 */
function applyTicketDeepLink(
  button: NotifyButton,
  subst: (input: string) => string,
  ticketId: string,
): NotifyButton {
  let webAppPath = button.webAppPath !== undefined ? subst(button.webAppPath) : undefined;
  if (
    webAppPath !== undefined &&
    webAppPath.split('?')[0] === '/support' &&
    !/[?&]ticket=/.test(webAppPath)
  ) {
    webAppPath = `${webAppPath}?ticket=${encodeURIComponent(ticketId)}`;
  }
  return {
    text: subst(button.text),
    url: button.url !== undefined ? subst(button.url) : undefined,
    callbackData: button.callbackData !== undefined ? subst(button.callbackData) : undefined,
    webAppPath,
    style: button.style,
    row: button.row,
  };
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Guest email continuity ─────────────────────────────────────────────────

const GUEST_REPLY_EMAIL = {
  subject: 'Поддержка ответила на ваше обращение',
  button: 'Открыть переписку',
  body: (subject: string): string =>
    `По вашему обращению «${subject}» есть новый ответ от поддержки. ` +
    `Нажмите кнопку ниже, чтобы вернуться к переписке.`,
};

/** Compose the guest reply email body (optionally with a resume button). */
function buildGuestReplyEmail(body: string, link: string | null, buttonLabel: string): string {
  const button =
    link === null
      ? ''
      : `<p style="margin:24px 0;text-align:center;"><a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${escapeHtml(buttonLabel)}</a></p>`;
  return `<p style="margin:0 0 8px 0;">${escapeHtml(body)}</p>${button}`;
}
