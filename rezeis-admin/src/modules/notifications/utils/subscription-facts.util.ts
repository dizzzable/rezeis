/**
 * The subscription facts a notification template can print.
 *
 * ── Why this is derived at RENDER time and not at emit time ──────────────
 *
 * Every one of these strings is locale-dependent — "Безлимит" and "Unlimited",
 * "28 августа" and "28 August" — and the locale is not known when the
 * notification is created. It is known when the template is rendered, once per
 * delivery. So the emitter stores raw facts (a number of gigabytes, an ISO
 * instant) and this file turns them into the words, for the locale in hand.
 *
 * The alternative — formatting at emit time — would freeze one language into
 * the payload and quietly send Russian to an English-speaking customer.
 *
 * ── Why the raw parts stay available too ─────────────────────────────────
 *
 * `{{traffic}}` composes a whole line the way the stock template wants it, and
 * an operator who wants a different arrangement gets `{{trafficUsed}}`,
 * `{{trafficLimit}}` and `{{trafficLeft}}` separately. A composed value that
 * cannot be taken apart forces the next operator to ask for a code change.
 *
 * ── Missing facts collapse, they never guess ─────────────────────────────
 *
 * The VPN panel can be unreachable when a notification is created, and then
 * there is no used-traffic figure. Every helper here answers `null` for that,
 * the caller drops the key, and `substitute` renders an empty string. A zero
 * would be a lie that reads as "you have used nothing".
 */

export type NotificationLocaleTag = 'ru' | 'en';

/** Raw facts an emitter puts in the payload. Everything is optional. */
export interface SubscriptionFactsInput {
  readonly expiresAt?: string | null;
  /** Gigabytes. `0` or negative means unlimited, matching the product rule. */
  readonly trafficLimitGb?: number | null;
  readonly trafficUsedGb?: number | null;
  /** `0` or negative means unlimited, matching the product rule. */
  readonly deviceLimit?: number | null;
  readonly devicesUsed?: number | null;
  /** IANA zone the operator configured. Falls back to UTC. */
  readonly timezone?: string | null;
}

const WORDS = {
  ru: {
    unlimited: 'Безлимит',
    used: 'использовано',
    left: 'осталось',
    of: 'из',
    devicesFree: 'доступно',
    gb: 'ГБ',
    at: 'в',
  },
  en: {
    unlimited: 'Unlimited',
    used: 'used',
    left: 'left',
    of: 'of',
    devicesFree: 'available',
    gb: 'GB',
    at: 'at',
  },
} as const;

/**
 * Traffic light for the traffic line.
 *
 * Green for unlimited or plenty left, amber past three quarters, red past
 * nine tenths. The thresholds are the point of the indicator: a customer
 * scanning a message sees the colour before they read the numbers, and a
 * single colour for every state would be decoration rather than information.
 */
function trafficLamp(usedRatio: number): string {
  if (usedRatio >= 0.9) return '🔴';
  if (usedRatio >= 0.75) return '🟡';
  return '🟢';
}

/**
 * The lamp for an allowance with nothing to measure against it.
 *
 * WHY NOT GREEN, which is what this used to be. `trafficLamp(null)` served
 * two states that are not the same fact: an UNLIMITED plan, where there is
 * genuinely nothing to run out of, and a KNOWN limit whose usage we could
 * not read because the VPN panel was unreachable. The second rendered as a
 * healthy quarter-full tank.
 *
 * It is worst on the message where it matters most. `limited` fires from a
 * panel webhook saying the allowance is EXHAUSTED, and the panel that sent
 * it is the same one the usage read goes to — so "webhook arrived, REST
 * call failed" is a strongly correlated pair, not a freak coincidence. The
 * customer would read: «Лимит трафика исчерпан» beside 🟢.
 *
 * Unlimited keeps its green — there really is nothing to warn about. An
 * unread measurement gets a lamp of its own, and the number it sits beside
 * is the limit rather than a usage, so the two cannot be confused.
 */
const UNKNOWN_LAMP = '⚪';

/** `0` / negative / null is the product's "unlimited". */
function isUnlimited(value: number | null | undefined): boolean {
  return value === null || value === undefined || value <= 0;
}

/** Trims a trailing `.0` so whole numbers do not read as measurements. */
function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function buildSubscriptionFacts(
  input: SubscriptionFactsInput,
  locale: NotificationLocaleTag,
): Record<string, string> {
  const words = WORDS[locale];
  const out: Record<string, string> = {};

  // ── Traffic ────────────────────────────────────────────────────────────
  const limit = input.trafficLimitGb ?? null;
  const used = input.trafficUsedGb ?? null;

  if (isUnlimited(limit)) {
    // Green, and correctly so: an unlimited allowance cannot run low.
    out['traffic'] = `🟢 ${words.unlimited}`;
    out['trafficLimit'] = words.unlimited;
    if (used !== null) {
      out['trafficUsed'] = `${formatAmount(used)} ${words.gb}`;
      // Deliberately no `trafficLeft`: what remains of an unlimited allowance
      // is not a number, and printing one would invent a cap.
      out['traffic'] = `🟢 ${words.unlimited} · ${formatAmount(used)} ${words.gb} ${words.used}`;
    }
  } else if (used === null) {
    // The limit is known and the usage is not — the VPN panel was unreachable.
    // Say what we know, and say that we do not know the rest: see UNKNOWN_LAMP.
    out['trafficLimit'] = `${formatAmount(limit as number)} ${words.gb}`;
    out['traffic'] = `${UNKNOWN_LAMP} ${out['trafficLimit']}`;
  } else {
    const capped = limit as number;
    const left = Math.max(0, capped - used);
    // `capped > 0` is guaranteed by the branch — `isUnlimited` already took
    // every zero and negative limit — so there is no division by zero here and
    // no unmeasurable case left to represent. The old `capped <= 0 ? null` arm
    // was unreachable, and it was the only thing that made this lamp's argument
    // nullable; with it gone the type says what the code already guaranteed.
    const ratio = Math.min(1, used / capped);
    out['trafficLimit'] = `${formatAmount(capped)} ${words.gb}`;
    out['trafficUsed'] = `${formatAmount(used)} ${words.gb}`;
    out['trafficLeft'] = `${formatAmount(left)} ${words.gb}`;
    out['traffic'] =
      `${trafficLamp(ratio)} ${formatAmount(used)} ${words.of} ${formatAmount(capped)} ${words.gb}` +
      ` · ${words.left} ${formatAmount(left)} ${words.gb}`;
  }

  // ── Devices ────────────────────────────────────────────────────────────
  const deviceLimit = input.deviceLimit ?? null;
  const devicesUsed = input.devicesUsed ?? null;

  if (isUnlimited(deviceLimit)) {
    out['devices'] = words.unlimited;
    out['deviceLimit'] = words.unlimited;
  } else {
    const cap = deviceLimit as number;
    out['deviceLimit'] = String(cap);
    if (devicesUsed === null) {
      out['devices'] = String(cap);
    } else {
      const free = Math.max(0, cap - devicesUsed);
      out['devicesUsed'] = String(devicesUsed);
      out['devicesLeft'] = String(free);
      out['devices'] = `${free} ${words.devicesFree}`;
    }
  }

  // ── When it ends ───────────────────────────────────────────────────────
  const when = parseInstant(input.expiresAt);
  if (when !== null) {
    const zone = normaliseZone(input.timezone);
    out['expiresDate'] = formatDate(when, locale, zone);
    out['expiresTime'] = formatTime(when, zone);
    out['expiresDateTime'] = `${out['expiresDate']}, ${out['expiresTime']}`;
  }

  return out;
}

/**
 * Raw facts an add-on notice's payload carries (`AddOnExpiryNoticeService`):
 * the add-on's kind, its size — gigabytes for traffic, a count for devices —
 * and when it ends. Stored JSON, so every field is read as `unknown`.
 */
export interface AddOnFactsInput {
  readonly type: unknown;
  readonly total: unknown;
  readonly endsAt: unknown;
  /**
   * A traffic add-on that ends with Remnawave's traffic reset: the reset
   * instant itself (the epoch's `plannedEndsAt`), not the moment the panel
   * takes the add-on off half an hour later — the customer is told when their
   * counter goes back to zero. Absent for every other add-on.
   */
  readonly resetAt?: unknown;
  /** IANA zone the operator configured. Falls back to UTC. */
  readonly timezone?: string | null;
}

/** «устройство / устройства / устройств», «device / devices». */
function devicesWord(count: number, locale: NotificationLocaleTag): string {
  if (locale === 'en') return count === 1 ? 'device' : 'devices';
  switch (new Intl.PluralRules('ru-RU').select(count)) {
    case 'one':
      return 'устройство';
    case 'many':
      return 'устройств';
    default:
      return 'устройства';
  }
}

/**
 * The words an add-on notice prints, for the locale in hand — derived here
 * for the reason the subscription's are (see the header): «+2 устройства» and
 * «+2 devices», «28 сентября» and «28 September».
 *
 * `{{addonValue}}` is the add-on as it adds — «+10 ГБ», «+2 устройства»;
 * `{{addonAmount}}` the same without the plus, for a sentence that says by
 * how much; `{{endsDate}}`, `{{endsTime}}` and `{{endsDateTime}}` when it
 * ends. A payload without an add-on gives nothing, and each fact it cannot
 * read collapses, as the others do.
 *
 * An add-on that ends with the traffic reset also gets the reset:
 * `{{resetDate}}`, `{{resetTime}}`, `{{resetZone}}` — the zone named, «по
 * Москве» (the owner, 25.09.2026: a reset time is never printed without its
 * zone) — and `{{resetDateTime}}`, «1 октября в 03:20 по Москве».
 */
export function buildAddOnFacts(input: AddOnFactsInput, locale: NotificationLocaleTag): Record<string, string> {
  const out: Record<string, string> = {};
  const total = typeof input.total === 'number' && Number.isFinite(input.total) && input.total > 0 ? input.total : null;
  if (total !== null && (input.type === 'EXTRA_TRAFFIC' || input.type === 'EXTRA_DEVICES')) {
    const amount =
      input.type === 'EXTRA_TRAFFIC'
        ? `${formatAmount(total)} ${WORDS[locale].gb}`
        : `${formatAmount(total)} ${devicesWord(total, locale)}`;
    out['addonAmount'] = amount;
    out['addonValue'] = `+${amount}`;
  }
  const when = parseInstant(typeof input.endsAt === 'string' ? input.endsAt : null);
  if (when !== null) {
    const zone = normaliseZone(input.timezone);
    out['endsDate'] = formatDate(when, locale, zone);
    out['endsTime'] = formatTime(when, zone);
    out['endsDateTime'] = `${out['endsDate']}, ${out['endsTime']}`;
  }
  const reset = parseInstant(typeof input.resetAt === 'string' ? input.resetAt : null);
  if (reset !== null) {
    const zone = normaliseZone(input.timezone);
    out['resetDate'] = formatDate(reset, locale, zone);
    out['resetTime'] = formatTime(reset, zone);
    out['resetZone'] = zonePhrase(zone, reset, locale);
    out['resetDateTime'] = `${out['resetDate']} ${WORDS[locale].at} ${out['resetTime']} ${out['resetZone']}`;
  }
  return out;
}

/**
 * «по Москве» — a zone the way a Russian sentence names it, for the zones the
 * operators of this product set (Russia's, and the neighbours'). A city takes
 * the dative, which `Intl` does not give (its `shortGeneric` is «Москва»), so
 * these are written out; any other zone is named by its offset instead, which
 * needs no grammar.
 */
const ZONE_PHRASE_RU: Readonly<Record<string, string>> = {
  'Europe/Kaliningrad': 'по Калининграду',
  'Europe/Moscow': 'по Москве',
  'Europe/Samara': 'по Самаре',
  'Europe/Volgograd': 'по Волгограду',
  'Asia/Yekaterinburg': 'по Екатеринбургу',
  'Asia/Omsk': 'по Омску',
  'Asia/Novosibirsk': 'по Новосибирску',
  'Asia/Krasnoyarsk': 'по Красноярску',
  'Asia/Irkutsk': 'по Иркутску',
  'Asia/Yakutsk': 'по Якутску',
  'Asia/Vladivostok': 'по Владивостоку',
  'Asia/Magadan': 'по Магадану',
  'Asia/Kamchatka': 'по Камчатке',
  'Europe/Minsk': 'по Минску',
  'Europe/Kyiv': 'по Киеву',
  'Europe/Kiev': 'по Киеву',
  'Asia/Almaty': 'по Алматы',
  'Asia/Tashkent': 'по Ташкенту',
};

/**
 * The zone a reset time is read in: «по Москве» / "Moscow Time"; «по UTC» /
 * "UTC"; otherwise its offset at that instant, «(UTC+5)».
 */
function zonePhrase(zone: string, at: Date, locale: NotificationLocaleTag): string {
  const offset = zoneOffset(zone, at);
  if (offset === 'UTC') return locale === 'ru' ? 'по UTC' : 'UTC';
  if (locale === 'ru') return ZONE_PHRASE_RU[zone] ?? `(${offset})`;
  // English names a zone by itself: "Moscow Time", "Yekaterinburg Time".
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortGeneric' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  return name === undefined || name.startsWith('GMT') ? `(${offset})` : name;
}

/** `UTC`, `UTC+3`, `UTC+5:30`, `UTC-4` — the zone's offset at `at`. */
function zoneOffset(zone: string, at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (name === undefined || name === 'GMT') return 'UTC';
  // `GMT+05:00` → `UTC+5`, `GMT+05:30` → `UTC+5:30`.
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(name);
  if (match === null) return name.replace(/^GMT/u, 'UTC');
  // A zero offset is UTC's clock, whatever the zone is called.
  if (match[2] === '00' && match[3] === '00') return 'UTC';
  const hours = String(Number(match[2]));
  return `UTC${match[1]}${hours}${match[3] === '00' ? '' : `:${match[3]}`}`;
}

function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * An unusable zone falls back to UTC rather than throwing.
 *
 * `Intl` throws a `RangeError` on an unknown time zone, and this runs inside
 * notification rendering: a typo in the operator's settings would stop every
 * notification in the product rather than showing one wrong hour.
 */
function normaliseZone(timezone: string | null | undefined): string {
  const candidate = (timezone ?? '').trim();
  if (candidate.length === 0) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** "28 августа" / "28 August" — day and month, never the year. */
function formatDate(when: Date, locale: NotificationLocaleTag, zone: string): string {
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: zone,
  }).format(when);
}

/** 24-hour clock in both locales — the message shows a deadline, not a habit. */
function formatTime(when: Date, zone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zone,
  }).format(when);
}
