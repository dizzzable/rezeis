import type { NotificationLocaleTag } from './subscription-facts.util';

/**
 * A leaderboard's score as a reader says it: «3 друга», «1 250 ₽», «12,4 ГБ»,
 * «350 баллов».
 *
 * The score arrives in the metric's stored unit — friends, minor units of the
 * base currency, bytes, points — as a string, because it is a BigInt column
 * and JSON has no such thing. Anything unreadable gives `null`, and the
 * template's placeholder stays empty rather than saying «NaN ГБ».
 */
export function formatContestScore(
  metric: unknown,
  score: unknown,
  locale: NotificationLocaleTag,
  currency: unknown,
): string | null {
  const value = readScore(score);
  if (value === null) return null;
  const tag = locale === 'en' ? 'en-GB' : 'ru-RU';
  switch (metric) {
    case 'REFERRALS_PAID':
      return `${value.toLocaleString(tag)} ${locale === 'en' ? plural(value, 'friend', 'friends') : ruPlural(value, 'друг', 'друга', 'друзей')}`;
    case 'POINTS_EARNED':
      return `${value.toLocaleString(tag)} ${locale === 'en' ? plural(value, 'point', 'points') : ruPlural(value, 'балл', 'балла', 'баллов')}`;
    case 'TRAFFIC': {
      const gb = value / 1024 ** 3;
      const text = gb.toLocaleString(tag, { maximumFractionDigits: gb >= 100 ? 0 : 1 });
      return `${text} ${locale === 'en' ? 'GB' : 'ГБ'}`;
    }
    case 'PAYMENTS_SUM': {
      const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'RUB';
      const major = value / 100;
      try {
        return new Intl.NumberFormat(tag, {
          style: 'currency',
          currency: code,
          maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
        }).format(major);
      } catch {
        return `${major.toLocaleString(tag)} ${code}`;
      }
    }
    default:
      return null;
  }
}

/** What a leaderboard ranks by, as the end of «места — по …». */
export function contestMetricPhrase(metric: unknown, locale: NotificationLocaleTag): string | null {
  const phrases: Record<string, { readonly ru: string; readonly en: string }> = {
    REFERRALS_PAID: { ru: 'приглашённым друзьям, которые оплатили подписку', en: 'invited friends who paid' },
    PAYMENTS_SUM: { ru: 'сумме оплат', en: 'total payments' },
    TRAFFIC: { ru: 'потраченному трафику', en: 'traffic used' },
    POINTS_EARNED: { ru: 'заработанным баллам', en: 'points earned' },
  };
  const phrase = typeof metric === 'string' ? phrases[metric] : undefined;
  return phrase === undefined ? null : phrase[locale];
}

function readScore(score: unknown): number | null {
  if (typeof score === 'number') return Number.isFinite(score) ? score : null;
  if (typeof score === 'string' && /^-?\d+$/.test(score.trim())) return Number(score.trim());
  return null;
}

function plural(value: number, one: string, many: string): string {
  return value === 1 ? one : many;
}

function ruPlural(value: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(value));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
