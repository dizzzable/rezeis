const LOCALE_KEY: string = 'rezeis.admin.locale'

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export function getStoredLocale(): string {
  if (!canUseStorage()) {
    return 'en'
  }
  return window.localStorage.getItem(LOCALE_KEY) ?? 'en'
}

export function setStoredLocale(locale: string): void {
  if (!canUseStorage()) {
    return
  }
  window.localStorage.setItem(LOCALE_KEY, locale)
}
