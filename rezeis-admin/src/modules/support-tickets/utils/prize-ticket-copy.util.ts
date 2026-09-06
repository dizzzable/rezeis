import { coerceNotificationLocale } from '../../notifications/utils/notification-template-locale.util';

/**
 * The words the product writes into a customer's OWN support thread when a
 * prize is owed, handed over, or refused.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * Both the wheel and the contest wrote these in Russian only, while loading
 * `user.language` a few lines away and using it correctly for the notification
 * card that announces the very same event. So an English customer received an
 * English card that opened a Russian conversation — and the refusal, the one
 * message they might want to argue with, was the least readable of the three.
 *
 * `SupportTicket.subject` and `SupportTicketMessage.content` are single
 * columns with no locale, and rightly so: they normally hold human chat. That
 * means the language has to be chosen HERE, at write time, from the recipient.
 */
export type PrizeTicketLocale = 'ru' | 'en';

/** Resolve a stored `User.language` down to the two languages we write in. */
export function prizeTicketLocale(language: string | null | undefined): PrizeTicketLocale {
  return coerceNotificationLocale(language);
}

interface PrizeCopy {
  readonly ru: string;
  readonly en: string;
}

function pick(copy: PrizeCopy, locale: PrizeTicketLocale): string {
  return locale === 'en' ? copy.en : copy.ru;
}

/** Subject of the thread opened for a wheel prize. */
export function wheelPrizeSubject(title: string, locale: PrizeTicketLocale): string {
  return pick({ ru: `Приз с колеса: ${title}`, en: `Wheel prize: ${title}` }, locale);
}

/** The first message in that thread. */
export function wheelPrizeGreeting(title: string, locale: PrizeTicketLocale): string {
  return pick(
    {
      ru: `Вы выиграли на колесе: ${title}. Оператор свяжется с вами здесь, чтобы вручить приз.`,
      en: `You won on the wheel: ${title}. An operator will contact you here to hand it over.`,
    },
    locale,
  );
}

/** The operator handed it over. */
export function wheelPrizeSettled(title: string, locale: PrizeTicketLocale): string {
  return pick(
    { ru: `Приз с колеса вручён: ${title}.`, en: `Wheel prize handed over: ${title}.` },
    locale,
  );
}

/** The operator decided not to. */
export function wheelPrizeRefused(title: string, locale: PrizeTicketLocale): string {
  return pick(
    {
      ru: `По призу с колеса «${title}» принято решение отказать.`,
      en: `Your wheel prize "${title}" was declined.`,
    },
    locale,
  );
}

/** Subject of the thread opened for a contest prize. */
export function contestPrizeSubject(
  contest: string,
  prize: string,
  locale: PrizeTicketLocale,
): string {
  return pick(
    { ru: `Приз конкурса «${contest}»: ${prize}`, en: `Contest prize "${contest}": ${prize}` },
    locale,
  );
}

/** The first message in that thread. */
export function contestPrizeGreeting(
  contest: string,
  prize: string,
  locale: PrizeTicketLocale,
): string {
  return pick(
    {
      ru: `Вы выиграли в конкурсе «${contest}»: ${prize}. Оператор свяжется с вами здесь, чтобы вручить приз.`,
      en: `You won the "${contest}" contest: ${prize}. An operator will contact you here to hand it over.`,
    },
    locale,
  );
}

/** The operator handed it over. */
export function contestPrizeSettled(prize: string, locale: PrizeTicketLocale): string {
  return pick({ ru: `Приз вручён: ${prize}.`, en: `Prize handed over: ${prize}.` }, locale);
}

/** The operator decided not to. */
export function contestPrizeRefused(prize: string, locale: PrizeTicketLocale): string {
  return pick(
    {
      ru: `По призу «${prize}» принято решение отказать.`,
      en: `Your prize "${prize}" was declined.`,
    },
    locale,
  );
}
