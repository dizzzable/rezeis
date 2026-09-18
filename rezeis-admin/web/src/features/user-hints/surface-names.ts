import type { TFunction } from 'i18next'

/**
 * Names inside a sentence, each in the quotes of the operator's language —
 * «Браузер», «Приложение» / "Browser", "App".
 *
 * The quotes come from the bundle (`userHints.reach.quoted`) rather than from
 * this file, so a Russian sentence never ends up with English straight quotes
 * around the names it lists.
 */
export function quotedList(t: TFunction, values: readonly string[]): string {
  return values.map((value) => String(t('userHints.reach.quoted', { value }))).join(', ')
}

/**
 * The operator's words for hint surfaces, quoted — the same words the
 * «Где показывать» toggles carry, so a warning names exactly what to press.
 * A surface the bundle has no word for is shown as it is stored.
 */
export function surfaceNames(t: TFunction, surfaces: readonly string[]): string {
  return quotedList(
    t,
    surfaces.map((surface) => String(t(`userHints.surfaces.${surface}`, { defaultValue: surface }))),
  )
}
