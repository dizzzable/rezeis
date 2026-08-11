import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100)
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date))
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
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
