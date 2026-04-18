import type { TFunction } from 'i18next'

export function translateErrorMessage(t: TFunction, message: string): string {
  const translatedMessage: string = t(message)
  return translatedMessage === message ? message : translatedMessage
}
