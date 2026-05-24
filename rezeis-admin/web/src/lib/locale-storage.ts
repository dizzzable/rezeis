import { safeGetItem, safeSetItem } from './safe-storage'

const LOCALE_KEY: string = 'rezeis.admin.locale'

export function getStoredLocale(): string {
  return safeGetItem(LOCALE_KEY) ?? 'en'
}

export function setStoredLocale(locale: string): void {
  safeSetItem(LOCALE_KEY, locale)
}
