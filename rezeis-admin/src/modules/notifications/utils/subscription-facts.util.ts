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
  },
  en: {
    unlimited: 'Unlimited',
    used: 'used',
    left: 'left',
    of: 'of',
    devicesFree: 'available',
    gb: 'GB',
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
