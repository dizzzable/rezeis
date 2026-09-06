import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// The bare i18next singleton, NOT `@/i18n/i18n`. `utils` is imported by
// virtually every module, so pulling the bootstrap in here drags
// `initReactI18next` along with it and breaks any test that mocks
// `react-i18next`. Same instance, none of the side effects.
import i18n from 'i18next'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The BCP-47 tag every `Intl` call in the panel should be given.
 *
 * One place, because the alternative is what this codebase had: the same
 * ternary written out by hand in a dozen files, `'ru-RU'` pinned in twenty-one
 * more, and sixty-odd `toLocale*()` calls with no argument at all — which
 * follow the BROWSER's language, not the one the operator picked in the panel.
 * On a single screen a translated column header could sit above a date in a
 * third language.
 *
 * `formatDate` and `formatDateTime` below are imported by fifteen pages, and
 * every one of them printed `Sep 6, 2026, 01:30 PM` to a Russian operator.
 */
export function activeLocale(): string {
  return i18n.language?.startsWith('ru') === true ? 'ru-RU' : 'en-US'
}

/**
 * A byte size in the operator's own units.
 *
 * One implementation, because there were six: `backup-page`, `broadcast-page`,
 * `support-tickets-page`, `dashboard-system-health` and two in the Remnawave
 * tree, all of them spelling the units in Latin while the dictionary spells
 * them in Cyrillic in three dozen other places. The support ticket one fed its
 * result into `{{size}}` of a translated toast, so half the sentence changed
 * language and half did not.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '\u2014'
  const unit = (key: string) => i18n.t(`common.units.${key}`)
  if (bytes < 1024) return `${bytes} ${unit('b')}`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} ${unit('kb')}`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} ${unit('mb')}`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} ${unit('gb')}`
  return `${(bytes / 1024 ** 4).toFixed(2)} ${unit('tb')}`
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100)
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat(activeLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date))
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat(activeLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date))
}

/**
 * Cuts `value` to `maxLength` characters for a narrow cell or a preview line.
 *
 * The single implementation for the whole SPA. There used to be four
 * near-identical copies (this one, `previewIdentifier` in user-detail-panel,
 * `idPreview` in payments-page, a private `truncate` in bot-texts-tab) and they
 * did not agree with each other: this one appended the ASCII `...`, the rest a
 * real `…`, so the same id read differently depending on which screen showed
 * it. One glyph, one place.
 *
 * Two rules the copies learned the hard way and that callers depend on:
 *   • the ellipsis is appended ONLY when something was actually cut — an
 *     unconditional one makes a short value (a 3.x numeric panel id, a short
 *     gateway payment id) read as a truncated long one;
 *   • absent and empty both render `empty`, never a bare `…` or a blank cell.
 * The full value belongs on `title`/Copy wherever the caller offers them.
 */
export function truncate(
  value: string | null | undefined,
  maxLength: number,
  empty = '—',
): string {
  if (value === null || value === undefined || value === '') return empty
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}
