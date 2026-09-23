import { PurchaseType } from '@prisma/client';

import type { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * The words a PAYER reads about a purchase on the provider's side — the line on
 * the payment page and in the bank statement, the item on a fiscal receipt
 * (MulenPay), the Telegram Stars invoice — built once here for the three
 * checkouts: a plan, a combined renewal, an add-on.
 *
 * It used to be the checkout's internals: `NEW Premium 30d`, `RENEW x2`,
 * `Add-on: …`, in English whatever the payer spoke. It is now a sentence in the
 * payer's language: «Премиум, 30 дней», «Продление: Премиум, 30 дней».
 *
 * ── Limits ────────────────────────────────────────────────────────────────
 *
 * Length. Each gateway cuts the text to its own field (`.slice` in
 * `PaymentProviderExecutionService`); the tightest description is Platega's
 * 64. The name is shortened here, with `...`, so the whole line fits 64 and no
 * gateway ever cuts off the term. Telegram Stars shows a separate `title` of
 * 1–32 characters: {@link PayerFacingText.title} is fitted to that on its own,
 * without the «Продление:» prefix, rather than being the line cut mid-word.
 *
 * Characters. The providers' own character rules are not documented to us and
 * cannot be verified from here, so the text keeps to what these gateways have
 * always been sent — the operator's plan name — and adds only letters, digits
 * and ASCII punctuation (no «—», no «»: a fiscal receipt's item name is CP866
 * on the register, which has neither). From the name it removes what a
 * receipt, a bank statement or a legacy 3-byte UTF-8 column cannot hold or show:
 * emoji and every other character outside the Basic Multilingual Plane (a lone
 * half of one is what cutting by `.slice` leaves behind), control and
 * zero-width characters, and it turns typographic dashes, quotes and the
 * ellipsis into their ASCII forms.
 */

export type PayerLocale = 'ru' | 'en';

export interface PayerFacingText {
  /** The provider's description line; never longer than {@link PAYER_DESCRIPTION_MAX_LENGTH}. */
  readonly description: string;
  /** A title, where a provider shows one (Telegram Stars); never longer than {@link PAYER_TITLE_MAX_LENGTH}. */
  readonly title: string;
}

/** Platega's description field, the tightest of the gateways'. */
export const PAYER_DESCRIPTION_MAX_LENGTH = 64;
/** Telegram Stars' invoice `title`: 1–32 characters. */
export const PAYER_TITLE_MAX_LENGTH = 32;

interface Copy {
  readonly renewalPrefix: string;
  readonly renewalOf: (count: number) => string;
  readonly addOnPrefix: string;
  readonly planFallback: string;
  readonly addOnFallback: string;
  readonly noExpiry: string;
  readonly days: (count: number) => string;
}

const COPY: Readonly<Record<PayerLocale, Copy>> = {
  ru: {
    renewalPrefix: 'Продление: ',
    renewalOf: (count) => `Продление подписок: ${count}`,
    addOnPrefix: 'Доп. опция: ',
    planFallback: 'Подписка',
    addOnFallback: 'Доп. опция',
    noExpiry: 'бессрочно',
    days: (count) => `${count} ${russianDays(count)}`,
  },
  en: {
    renewalPrefix: 'Renewal: ',
    renewalOf: (count) => `Renewal of ${count} subscriptions`,
    addOnPrefix: 'Add-on: ',
    planFallback: 'Subscription',
    addOnFallback: 'Add-on',
    noExpiry: 'no expiry',
    days: (count) => (count === 1 ? '1 day' : `${count} days`),
  },
};

/**
 * A plan bought, renewed or changed to: «Премиум, 30 дней»; a renewal says so,
 * «Продление: Премиум, 30 дней». `durationDays` -1 is a term with no end;
 * `null` (or anything that is not a whole number of days) leaves the term out.
 */
export function describePlanPurchase(input: {
  readonly purchaseType: PurchaseType;
  readonly planName: string | null;
  readonly durationDays: number | null;
  readonly locale: PayerLocale;
}): PayerFacingText {
  const copy = COPY[input.locale];
  const name = cleanPayerText(input.planName ?? '') || copy.planFallback;
  const term = describeTerm(input.durationDays, copy);
  const suffix = term === null ? '' : `, ${term}`;
  const prefix = input.purchaseType === PurchaseType.RENEW ? copy.renewalPrefix : '';
  return {
    description: `${prefix}${fitName(name, PAYER_DESCRIPTION_MAX_LENGTH - prefix.length - suffix.length)}${suffix}`,
    title: `${fitName(name, PAYER_TITLE_MAX_LENGTH - suffix.length)}${suffix}`,
  };
}

/** One combined renewal: the plan and its term for one subscription, a count for several. */
export function describeRenewal(input: {
  readonly items: ReadonlyArray<{ readonly planName: string; readonly durationDays: number }>;
  readonly locale: PayerLocale;
}): PayerFacingText {
  if (input.items.length === 1) {
    const [item] = input.items;
    return describePlanPurchase({
      purchaseType: PurchaseType.RENEW,
      planName: item.planName,
      durationDays: item.durationDays,
      locale: input.locale,
    });
  }
  const text = COPY[input.locale].renewalOf(input.items.length);
  return { description: text, title: text };
}

/** An add-on bought for a subscription: «Доп. опция: +50 ГБ». */
export function describeAddOn(input: { readonly name: string; readonly locale: PayerLocale }): PayerFacingText {
  const copy = COPY[input.locale];
  const name = cleanPayerText(input.name);
  if (name.length === 0) {
    return { description: copy.addOnFallback, title: copy.addOnFallback };
  }
  return {
    description: `${copy.addOnPrefix}${fitName(name, PAYER_DESCRIPTION_MAX_LENGTH - copy.addOnPrefix.length)}`,
    title: fitName(name, PAYER_TITLE_MAX_LENGTH),
  };
}

/**
 * The payer's language as `User.language` says it, when it says it: RU is
 * Russian and every other locale English (these lines exist in two languages,
 * as notifications do). Otherwise the operator's ({@link operatorDefaultPayerLocale}).
 *
 * The column is not always an answer. It defaults to EN, and only two things
 * write it: the bot, from Telegram's language on a user's first message, and
 * the cabinet's language setting. On an account with no Telegram, EN is as
 * likely the untouched default as a choice — a Russian-speaking web customer
 * who never opened the settings carries it — so there it says nothing.
 */
export function resolvePayerLocale(
  user: { readonly language?: string | null; readonly telegramId?: bigint | null } | null,
): PayerLocale {
  const language = typeof user?.language === 'string' ? user.language.trim().toUpperCase() : '';
  if (language.length === 0) {
    return operatorDefaultPayerLocale();
  }
  if (language === 'EN' && (user?.telegramId === null || user?.telegramId === undefined)) {
    return operatorDefaultPayerLocale();
  }
  return language === 'RU' ? 'ru' : 'en';
}

/** The operator's language (`REZEIS_DEFAULT_LOCALE`, `ru` when unset): Russian for `ru`, English otherwise. */
export function operatorDefaultPayerLocale(): PayerLocale {
  const configured = (process.env.REZEIS_DEFAULT_LOCALE ?? '').trim().toLowerCase();
  if (configured.length === 0) return 'ru';
  return configured.startsWith('ru') ? 'ru' : 'en';
}

/**
 * {@link resolvePayerLocale} for a user id. A line of text never refuses a
 * payment: when the row cannot be read, the operator's language.
 */
export async function readPayerLocale(
  prismaService: Pick<PrismaService, 'user'>,
  userId: string,
): Promise<PayerLocale> {
  try {
    const user = await prismaService.user.findUnique({
      where: { id: userId },
      select: { language: true, telegramId: true },
    });
    return resolvePayerLocale(user);
  } catch {
    return operatorDefaultPayerLocale();
  }
}

/**
 * An operator's name as a payer-facing provider field can carry it (see the
 * module note): typographic punctuation to ASCII, emoji, astral, control and
 * zero-width characters out, whitespace collapsed, and a separator the removed
 * emoji left stranded at either end dropped (`🔥 | Премиум` is «Премиум»).
 */
export function cleanPayerText(value: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[\u{2010}-\u{2015}\u{2212}]/gu, '-')
    .replace(/[\u{AB}\u{BB}\u{201C}-\u{201F}\u{2033}]/gu, '"')
    .replace(/[\u{2018}-\u{201B}\u{2032}]/gu, "'")
    .replace(/\u{2026}/gu, '...')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\u{10000}-\u{10FFFF}]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{20E3}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ');
  const isSeparator = (word: string) => /^[-|:;,.·•/\\]+$/.test(word);
  while (words.length > 0 && isSeparator(words[0])) words.shift();
  while (words.length > 0 && isSeparator(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function describeTerm(durationDays: number | null, copy: Copy): string | null {
  if (durationDays === -1) return copy.noExpiry;
  if (durationDays === null || !Number.isInteger(durationDays) || durationDays <= 0) return null;
  return copy.days(durationDays);
}

function fitName(name: string, room: number): string {
  if (name.length <= room) return name;
  return `${name.slice(0, Math.max(1, room - 3)).trimEnd()}...`;
}

function russianDays(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return 'день';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'дня';
  return 'дней';
}
