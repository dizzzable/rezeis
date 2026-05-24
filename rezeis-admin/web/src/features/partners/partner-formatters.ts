/**
 * Shared formatters for the Partners feature. Kept module-private helpers
 * here so the page-level components can stay focused on layout.
 */

/** Convert minor units (kopecks) to a localized RUB string. */
export function formatKopecks(kopecks: number, locale = 'ru-RU'): string {
  if (!Number.isFinite(kopecks)) return '—'
  const major = kopecks / 100
  return `${major.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
}

/** Compact representation: 12.3K, 4.5M, etc. */
export function formatKopecksCompact(kopecks: number): string {
  if (!Number.isFinite(kopecks)) return '—'
  const major = kopecks / 100
  if (Math.abs(major) >= 1_000_000) return `${(major / 1_000_000).toFixed(2)}M ₽`
  if (Math.abs(major) >= 1_000) return `${(major / 1_000).toFixed(1)}K ₽`
  return `${major.toFixed(2)} ₽`
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(fractionDigits)}%`
}

export function formatNumber(value: number, locale = 'ru-RU'): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString(locale)
}

export function shortBucketLabel(iso: string, locale = 'ru-RU'): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return '—'
  if (seconds < 60) return `${seconds.toFixed(0)} с`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} мин`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ч`
  return `${(seconds / 86400).toFixed(1)} д`
}
