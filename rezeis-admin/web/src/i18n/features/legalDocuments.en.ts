/**
 * Lazy-loaded i18n feature bundle (en): legalDocuments
 * Namespace: legalDocumentsPage
 */

export const en = {
  legalDocumentsPage: {
    title: 'Legal documents',
    subtitle:
      'The user agreement and the public offer. An enabled document is shown at sign-up, and no account is created without accepting it.',
    required: 'Require at sign-up',
    needsRussianBody: 'Fill in the Russian title and text first',
    loadFailed: 'Could not load the documents. Until the list loads there is no way to tell whether sign-up asks for consent.',
    retry: 'Retry',
    missingTranslation:
      'The English text is empty. The document still works, but an English-speaking visitor is shown the Russian wording.',
    plainTextOnly: 'Plain text, no markup. Line breaks are preserved as written.',
    documentTitle: 'Title',
    documentBody: 'Text',
    save: 'Save',
    saved: 'Document saved',
    saveFailed: 'Could not save the document',
    locales: {
      ru: 'Русский',
      en: 'English',
    },
    documents: {
      userAgreement: {
        title: 'User agreement',
        description: 'Terms of using the service.',
      },
      privacyPolicy: {
        title: 'Privacy policy',
        description: 'What the service collects about visitors and why.',
      },
      offer: {
        title: 'Public offer',
        description: 'Payment and service delivery terms.',
      },
    },
  },
} as const
