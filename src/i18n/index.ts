import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import ru from './locales/ru.json';
import en from './locales/en.json';
import ruAdmin from './locales/admin/ru.json';
import enAdmin from './locales/admin/en.json';
import { getTelegramLanguage } from '@/services/telegram';

// Get initial language from Telegram if available
const tgLanguage = getTelegramLanguage();

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ru: {
        translation: ru,
        admin: ruAdmin,
      },
      en: {
        translation: en,
        admin: enAdmin,
      },
    },
    lng: tgLanguage || undefined, // Use Telegram language if available
    fallbackLng: 'ru',
    debug: import.meta.env.DEV,

    detection: {
      order: tgLanguage ? ['localStorage'] : ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
    },

    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;