import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { getStoredLocale } from '@/lib/locale-storage'

const resources = {
  en: {
    translation: en,
  },
  ru: {
    translation: ru,
  },
} as const

const initialLocale: string = getStoredLocale() === 'ru' ? 'ru' : 'en'

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

export { i18n }
