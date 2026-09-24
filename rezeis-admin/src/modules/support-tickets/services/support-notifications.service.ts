import { Injectable, Logger, Optional } from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';

import { resolveCabinetSiteUrl } from '../../../common/config/public-site-url.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { literalCardText, literalPlainText } from '../../../common/utils/operator-card-text.util';
import { ReiwaAdvertisingLinkConfigService } from '../../advertising/services/reiwa-advertising-link-config.service';
import type { SendEmailPayload } from '../../email/interfaces/email.interface';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { NotificationTemplatesService } from '../../notifications/services/notification-templates.service';
import type { NotifyButton } from '../../notifications/services/bot-notifier.client';
import {
  coerceNotificationLocale,
  resolveTemplateButtons,
  resolveTemplateLocale,
} from '../../notifications/utils/notification-template-locale.util';
import {
  GUEST_LANGUAGE_LOOKBACK,
  guestLetterLanguage,
  type GuestLetterLanguage,
} from '../utils/guest-letter-language.util';
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

  /**
   * Pauses between the guest letter's attempts: three attempts over about half
   * a minute, standing in for the mail queue's retries. The letter carries a
   * live link and is never queued, so the retries happen here, in memory.
   */
  private readonly guestLetterRetryDelaysMs: readonly number[] = [5_000, 30_000];

  public constructor(
    private readonly userNotifications: UserNotificationsService,
    private readonly prismaService: PrismaService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly guestService: SupportGuestService,
    private readonly templatesService: NotificationTemplatesService,
    /**
     * THE resolver of the cabinet's address — the ad links' and the letter
     * footer's — for the guest reply's «Открыть переписку». Last and
     * `@Optional()` so positional construction in the specs keeps working;
     * `ReiwaPublicLinksModule` provides it, and without it the address falls
     * back to the .env part of the same chain.
     */
    @Optional()
    private readonly cabinetLinks?: ReiwaAdvertisingLinkConfigService,
  ) {}

  /**
   * Notify the ticket owner that an operator replied. `preRenderedText`
   * deliberately bypasses the notification-template + opt-out gate: a human
   * operator reply is an explicit, one-off send the user always wants.
   */
  public async notifyAdminReply(input: TicketOwnerNotification): Promise<void> {
    await this.deliverTicketCard('support_reply', SUPPORT_REPLY_COPY, input);
  }

  /**
   * Notify the client that an operator OPENED a conversation with them.
   *
   * Same delivery, different words. "There is a new reply to your ticket" is
   * simply false for a thread the client never started, and it is the first
   * sentence they read — hence a second, separately editable template.
   *
   * ── Why the EVENT type stays `support_reply` ──────────────────────────
   *
   * The cabinet counts its support badge by `type === 'support_reply'`
   * (`use-support-unread.ts`), clears it by matching `payload.ticketId`, and
   * deep-links from those same rows. Panel and cabinet ship as separate
   * images and the panel goes first, so a NEW event type would land in a
   * cabinet that ignores it: no badge, no clearing, a feed row nothing
   * counts. The TEMPLATE type is a panel-side lookup and is free to be new;
   * the EVENT type is a cross-image contract and must not be.
   */
  public async notifyAdminOpenedTicket(input: TicketOwnerNotification): Promise<void> {
    await this.deliverTicketCard('support_ticket_opened', SUPPORT_OPENED_COPY, input);
  }

  /**
   * The shared body of both notifications above: resolve the operator's
   * template (falling back to the shipped copy), render it, and hand it to
   * the one "notify a user" service.
   */
  private async deliverTicketCard(
    templateType: string,
    fallbackCopy: Record<SupportLang, SupportCardCopy>,
    input: TicketOwnerNotification,
  ): Promise<void> {
    // Guest tickets (no account user) are delivered in the anonymous-support
    // phase via the guest channel; nothing to push to a cabinet/bot here.
    if (input.user === null) return;

    try {
      const locale = coerceNotificationLocale(input.user.language);
      // The feed's copy: the cabinet draws the operator's `:slug:` in it — and
      // would draw the client's too, so their subject goes in as typed
      // (`literalPlainText`).
      const substHtml = makeSubstitution({ subject: literalPlainText(input.subject), ticketId: input.ticketId }, true);
      const substRaw = makeSubstitution({ subject: input.subject, ticketId: input.ticketId }, false);

      // The operator-editable, seeded template supplies the copy + buttons
      // (label/emoji/target) — so the notification is visible on the bot map
      // and editable in the admin (incl. premium custom-emoji on the button
      // label, which the bot promotes to icon_custom_emoji_id). We still
      // deliver via the preRenderedText path so it bypasses the notification
      // opt-out toggle: a human operator message must always reach the user.
      // The built-in copy is the fallback when the row is absent.
      const template = await this.templatesService.getByType(templateType).catch(() => null);

      let title: string;
      let body: string;
      // The Telegram message — the client's, and the operator's copy of it
      // (`mirrorToOperatorChat`). The subject in it is the client's own words,
      // so it goes in as typed (`literalCardText`): the bot resolves the
      // operator's emoji tokens across the whole message, and a subject
      // «ключ {{SUB_ID}} не работает» came out «ключ • не работает».
      let html: string;
      let buttons: NotifyButton[];
      if (template !== null) {
        const loc = resolveTemplateLocale(template, locale);
        title = substHtml(loc.title);
        body = substHtml(loc.body);
        html = `<b>${fillForTelegram(loc.title, subjectOf(input), false)}</b>\n\n${fillForTelegram(loc.body, subjectOf(input), true)}`;
        buttons = resolveTemplateButtons(template, locale).map((button) =>
          applyTicketDeepLink(button, substRaw, input.ticketId),
        );
      } else {
        const copy = fallbackCopy[locale === 'ru' ? 'ru' : 'en'];
        title = copy.title;
        body = copy.body(escapeHtml(literalPlainText(input.subject)));
        html = `<b>${escapeHtml(title)}</b>\n\n${copy.body(literalCardText(input.subject))}`;
        buttons = [{ text: copy.openButton, webAppPath: `/support?ticket=${input.ticketId}` }];
      }

      // `title` and `body` are the cabinet feed's copy: the feed strips the
      // markup and reads `&amp;`, `&lt;`, `&gt;` — not the numeric references
      // the Telegram message writes the subject with.
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
      // Never surface to the operator; the message itself is already saved.
      this.logger.warn(
        `Support notification (${templateType}) failed for ticket ${input.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * What an operator's reply means for a GUEST ticket. First, the guest's
   * access runs for another TTL from now (the owner's rule: each operator
   * reply extends it — `extendAccessOnOperatorReply`), whether or not a
   * letter follows. Then email-continuity: when the visitor left an email,
   * a "you have a reply" email with a resume link, so they can return from
   * any device. Best-effort — a missing email, missing SMTP, or send failure
   * never blocks the reply.
   *
   * Sent directly, never through the mail queue: the link is a way into the
   * conversation, and a BullMQ job would keep it readable in Redis for a day
   * (a week when it fails) — the reason `sendPasswordResetLink` is direct too.
   * What the queue gave besides — retries — is done here, in-process
   * ({@link deliverGuestLetter}). The caller does not wait for it (`void` in
   * the reply handler).
   *
   * The new link becomes THE letter link only after its letter went out
   * (`activateEmailResumeToken`): there is one letter link per guest, and a
   * letter that never arrived must not retire the one the guest still has.
   */
  public async notifyGuestReply(ticketId: string): Promise<void> {
    try {
      // Before anything else — above all before the letter mints its link, so
      // that link opens: a reply on day 4 used to go out with no button, the
      // access having ended 72 h after the conversation OPENED. A failure here
      // leaves the access as it was; the letter below then says what is true.
      await this.guestService.extendAccessOnOperatorReply(ticketId).catch((err: unknown) => {
        this.logger.warn(
          `Guest access not extended for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      });

      const ticket = await this.prismaService.supportTicket.findUnique({
        where: { id: ticketId },
        select: {
          subject: true,
          status: true,
          guestId: true,
          guest: { select: { id: true, email: true, expiresAt: true } },
          // The guest's own messages, newest first: the letter is in the
          // language the guest last wrote in (`guestLetterLanguage`).
          messages: {
            where: { authorType: 'USER' },
            orderBy: { createdAt: 'desc' },
            take: GUEST_LANGUAGE_LOOKBACK,
            select: { metadata: true },
          },
        },
      });
      const email = ticket?.guest?.email?.trim();
      if (!ticket || !ticket.guest || !email) return; // no contact → polling only
      const language = guestLetterLanguage(ticket.messages);
      const copy = GUEST_REPLY_EMAIL[language];

      // SMTP off — the default install: there is no letter to send, so there is
      // nothing to mint a link for, nothing to write and nothing to warn about
      // on every reply. `sendImmediate` refuses on exactly this condition.
      const smtp = await this.emailDelivery.getSmtpSettings();
      if (!smtp.enabled || !smtp.host) return;

      // Past the guest's access (`expiresAt`: the TTL from the conversation's
      // start, renewed from each operator reply — this one included, above)
      // or on a CLOSED conversation, every way in opens nothing — this
      // letter's link, a device credential, the guest's own code. The letter
      // then says so instead of offering a button into a dead end. After the
      // renewal that leaves a closed conversation, or a renewal that failed.
      const reachable =
        ticket.guest.expiresAt.getTime() >= Date.now() && ticket.status !== SupportTicketStatus.CLOSED;

      // The cabinet: its `/support/guest?resume=<token>` page restores this
      // conversation from the token on any device. The address used to come
      // from `brandingSettings.websiteUrl`, which nothing writes, so no guest
      // ever got the button; it is now the one the ad links use (what the
      // cabinet publishes, then .env). No cabinet address → no button; never
      // the panel's.
      const base = !reachable
        ? null
        : this.cabinetLinks
          ? await this.cabinetLinks.resolveCabinetWebBaseUrl()
          : resolveCabinetSiteUrl();
      // Each ATTEMPT gets its own link, minted as it starts, and its letter is
      // dated with that link's stamp. A guest's inbox then orders the letters
      // the way the links are ordered, by `Date` and by arrival alike: a
      // retried older reply that goes out after a newer reply's letter is the
      // newer link as well. Minted once per reply, its retry — the last
      // letter to arrive, and dated last — lost to the newer reply's link and
      // opened nothing, while the page sends the guest to «самое новое письмо».
      // Minting writes nothing; a link opens anything only once activated.
      const compose = (): GuestLetterAttempt => {
        const token = base === null ? null : this.guestService.newEmailResumeToken();
        const link = token === null ? null : `${base}/support/guest?resume=${encodeURIComponent(token)}`;
        const way: GuestLetterWay = !reachable
          ? { kind: 'none' }
          : link === null
            ? { kind: 'chat' }
            : { kind: 'button', href: link };
        const date = token === null ? null : this.guestService.letterTokenIssuedAt(token);
        return {
          token,
          payload: {
            to: email,
            subject: copy.subject,
            templateType: '__support_guest_reply__',
            variables: {},
            rawHtml: buildGuestReplyEmail(ticket.subject, way, copy),
            // The letter's `lang`, for the reader's mail client and screen reader.
            locale: language,
            ...(date === null ? {} : { date }),
          },
        };
      };
      const sent = await this.deliverGuestLetter(ticketId, compose);
      if (sent === null || sent.token === null) return;
      const token = sent.token;

      // Only now, with the letter out, does its link replace the previous one —
      // and never a NEWER letter's, which a slower send of this one would.
      // `superseded` is that ordinary case; only a failed write is news.
      const activation = await this.guestService.activateEmailResumeToken(ticket.guest.id, token);
      if (activation === 'failed') {
        this.logger.warn(
          `Guest reply email for ticket ${ticketId} went out, but its link could not be stored: it opens ` +
            "nothing, and the guest's previous letter link stays the valid one.",
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Guest reply email failed for ticket ${ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Send the guest letter, retrying a failed or thrown attempt; every attempt
   * is composed afresh by `compose` (its own link and date). The attempt that
   * went out, or `null`, with ONE warning, when none did.
   */
  private async deliverGuestLetter(
    ticketId: string,
    compose: () => GuestLetterAttempt,
  ): Promise<GuestLetterAttempt | null> {
    let lastError = 'unknown error';
    for (let attempt = 0; attempt <= this.guestLetterRetryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await pause(this.guestLetterRetryDelaysMs[attempt - 1]);
      const letter = compose();
      try {
        const result = await this.emailDelivery.sendImmediate(letter.payload);
        if (result.success) return letter;
        lastError = result.error ?? lastError;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.logger.warn(
      `Guest reply email not sent for ticket ${ticketId} after ${this.guestLetterRetryDelaysMs.length + 1} ` +
        `attempts: ${lastError}. The guest's previous letter link still works.`,
    );
    return null;
  }
}

/** One attempt at the guest letter: the link minted for it (if any), and the letter. */
interface GuestLetterAttempt {
  readonly token: string | null;
  readonly payload: SendEmailPayload;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SupportLang = 'ru' | 'en';

/** Who to notify about which ticket. `user === null` means a guest thread. */
interface TicketOwnerNotification {
  readonly ticketId: string;
  readonly subject: string;
  readonly user: { readonly id: string; readonly language: string | null } | null;
}

/** Shipped copy used when the operator's template row is missing. */
interface SupportCardCopy {
  readonly title: string;
  readonly body: (subject: string) => string;
  readonly openButton: string;
}

/**
 * The words for a thread the OPERATOR started.
 *
 * Deliberately not "поддержка ответила": nobody asked anything yet, and a
 * client told they have a reply to a ticket they never wrote will look for
 * the ticket they never wrote.
 */
const SUPPORT_OPENED_COPY: Record<SupportLang, SupportCardCopy> = {
  ru: {
    title: '💬 Поддержка написала вам',
    body: (subject) =>
      `Поддержка открыла обращение «${subject}» и ждёт вашего ответа. Откройте раздел «Поддержка», чтобы прочитать и ответить.`,
    openButton: '💬 Открыть обращение',
  },
  en: {
    title: '💬 Support started a conversation',
    body: (subject) =>
      `Support opened the ticket "${subject}" and is waiting for your reply. Open the Support section to read and answer.`,
    openButton: '💬 Open ticket',
  },
};

const SUPPORT_REPLY_COPY: Record<SupportLang, SupportCardCopy> = {
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

/** What a ticket card's placeholders are filled with. */
function subjectOf(input: { readonly subject: string; readonly ticketId: string }): {
  readonly subject: string;
  readonly ticketId: string;
} {
  return { subject: input.subject, ticketId: input.ticketId };
}

/**
 * A template line for the Telegram message, its `{{subject}}`/`{{ticketId}}`
 * filled AS TYPED (`literalCardText`), so the bot's emoji pass cannot read the
 * client's subject as the operator's tokens. The operator's own words stay as
 * they were: a body is HTML the operator wrote (`templateIsHtml`), a title is
 * text and escaped.
 */
function fillForTelegram(
  template: string,
  ctx: { readonly subject: string; readonly ticketId: string },
  templateIsHtml: boolean,
): string {
  const words = (text: string): string => (templateIsHtml ? text : escapeHtml(text));
  let out = '';
  let last = 0;
  for (const match of template.matchAll(/\{\{\s*(subject|ticketId)\s*\}\}/g)) {
    out += words(template.slice(last, match.index));
    out += literalCardText(match[1] === 'ticketId' ? ctx.ticketId : ctx.subject);
    last = (match.index ?? 0) + match[0].length;
  }
  return out + words(template.slice(last));
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

/** The words of the guest reply letter, in one language. */
interface GuestReplyEmailCopy {
  readonly subject: string;
  readonly button: string;
  readonly body: (subject: string) => string;
  /** No cabinet address, so no button: the letter says where the reply is instead. */
  readonly bodyWithoutButton: (subject: string) => string;
  /**
   * The guest's access has ended (`expiresAt`) or the conversation is closed:
   * no link, code or credential opens it any more. The letter does not carry
   * the reply itself, so all it can honestly do is say so.
   */
  readonly bodyUnreachable: (subject: string) => string;
}

/**
 * In the language the guest last wrote in (`guestLetterLanguage`): the guest
 * page sends its own. A conversation from a cabinet that sends none, or a
 * language the letter is not written in, gets the Russian letter, which was the
 * only one there was. The English words are the ones the cabinet's guest page
 * uses: «Open conversation», a «request».
 */
const GUEST_REPLY_EMAIL: Readonly<Record<GuestLetterLanguage, GuestReplyEmailCopy>> = {
  ru: {
    subject: 'Поддержка ответила на ваше обращение',
    button: 'Открыть переписку',
    body: (subject) =>
      `По вашему обращению «${subject}» есть новый ответ от поддержки. ` +
      `Нажмите кнопку ниже, чтобы вернуться к переписке.`,
    bodyWithoutButton: (subject) =>
      `По вашему обращению «${subject}» есть новый ответ от поддержки. ` +
      `Он ждёт вас в чате поддержки на сайте.`,
    bodyUnreachable: (subject) =>
      `По вашему обращению «${subject}» есть новый ответ от поддержки, ` +
      `но открыть переписку на сайте больше нельзя. ` +
      `Чтобы продолжить, напишите в поддержку на сайте ещё раз.`,
  },
  en: {
    subject: 'Support replied to your request',
    button: 'Open conversation',
    body: (subject) =>
      `There is a new reply from support to your request “${subject}”. ` +
      `Press the button below to return to the conversation.`,
    bodyWithoutButton: (subject) =>
      `There is a new reply from support to your request “${subject}”. ` +
      `It is waiting for you in the support chat on the site.`,
    bodyUnreachable: (subject) =>
      `There is a new reply from support to your request “${subject}”, ` +
      `but the conversation can no longer be opened on the site. ` +
      `To continue, write to support on the site again.`,
  },
};

/**
 * What a guest reply letter can offer: the button into the conversation, the
 * chat on the site (no cabinet address to build a link on), or nothing — the
 * guest can no longer open the conversation at all.
 */
type GuestLetterWay =
  | { readonly kind: 'button'; readonly href: string }
  | { readonly kind: 'chat' }
  | { readonly kind: 'none' };

/**
 * Compose the guest reply email body, with the resume button when there is a
 * link. The text is chosen HERE, next to the button, so the two cannot part:
 * the letter used to say «Нажмите кнопку ниже» on every install while no
 * install ever had the button.
 */
function buildGuestReplyEmail(subject: string, way: GuestLetterWay, copy: GuestReplyEmailCopy): string {
  const body =
    way.kind === 'button'
      ? copy.body(subject)
      : way.kind === 'chat'
        ? copy.bodyWithoutButton(subject)
        : copy.bodyUnreachable(subject);
  const button =
    way.kind !== 'button'
      ? ''
      : `<p style="margin:24px 0;text-align:center;"><a href="${way.href}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${escapeHtml(copy.button)}</a></p>`;
  return `<p style="margin:0 0 8px 0;">${escapeHtml(body)}</p>${button}`;
}
