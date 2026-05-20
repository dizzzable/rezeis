import { create } from 'zustand'
import { getStoredLocale, setStoredLocale } from '@/lib/locale-storage'

export interface LocaleState {
  readonly locale: string
  setLocale: (locale: string) => void
}

function readInitialLocale(): string {
  const locale: string = getStoredLocale()
  return locale === 'ru' ? 'ru' : 'en'
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: readInitialLocale(),
  setLocale: (locale: string): void => {
    setStoredLocale(locale)
    set({ locale })
  },
}))
