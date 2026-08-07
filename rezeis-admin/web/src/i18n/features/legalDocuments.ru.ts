/**
 * Lazy-loaded i18n feature bundle (ru): legalDocuments
 * Namespace: legalDocumentsPage
 */

export const ru = {
  legalDocumentsPage: {
    title: 'Документы',
    subtitle:
      'Пользовательское соглашение и оферта. Включённый документ показывается при регистрации, и без согласия с ним аккаунт не создаётся.',
    required: 'Требовать при регистрации',
    needsRussianBody: 'Сначала заполните русский заголовок и текст',
    loadFailed: 'Не удалось загрузить документы. Пока список не загружен, нельзя понять, требуется ли согласие при регистрации.',
    retry: 'Повторить',
    missingTranslation:
      'Английский текст пуст. Документ работает, но англоязычному посетителю покажется русская редакция.',
    plainTextOnly: 'Обычный текст без разметки. Переносы строк сохраняются как есть.',
    documentTitle: 'Заголовок',
    documentBody: 'Текст',
    save: 'Сохранить',
    saved: 'Документ сохранён',
    saveFailed: 'Не удалось сохранить документ',
    locales: {
      ru: 'Русский',
      en: 'English',
    },
    documents: {
      userAgreement: {
        title: 'Пользовательское соглашение',
        description: 'Условия использования сервиса.',
      },
      offer: {
        title: 'Оферта',
        description: 'Условия оплаты и предоставления услуги.',
      },
    },
  },
} as const
