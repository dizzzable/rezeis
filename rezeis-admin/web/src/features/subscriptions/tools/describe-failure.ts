import type { TFunction } from 'i18next'

import { translateApiError } from '@/lib/translate-error'

/**
 * What to show for a failed request in the «Инструменты» sheet.
 *
 * `expectArray` rejects with a DICTIONARY KEY (`errors.unexpectedResponsePayload`)
 * rather than a sentence, and `translateApiError` looks its input up under an
 * `errors.` prefix — handed that key it would search for
 * `errors.errors.unexpectedResponsePayload`, miss, and put the raw key on
 * screen. An already-qualified key is resolved first; everything else — the
 * server's own sentence, a dead host, a timeout — goes through the project's
 * one translator.
 */
export function describeFailure(t: TFunction, error: unknown): string {
  if (error instanceof Error && error.message.startsWith('errors.')) {
    const translated: string = t(error.message)
    if (translated !== error.message) return translated
  }
  return translateApiError(t, error)
}
