import type { JSX, ReactNode } from 'react'
import { useEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useLocaleStore } from '@/stores/locale-store'

interface I18nProviderProps {
  readonly children: ReactNode
}

export function I18nProvider({ children }: I18nProviderProps): JSX.Element {
  const locale: string = useLocaleStore((state) => state.locale)
  useEffect((): void => {
    if (i18n.language === locale) {
      return
    }
    void i18n.changeLanguage(locale)
  }, [locale])
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
