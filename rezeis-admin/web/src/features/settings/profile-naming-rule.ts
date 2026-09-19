/**
 * The Remnawave profile-naming rule as the settings page applies it.
 *
 * Remnawave accepts `^[A-Za-z0-9_-]+$` in a username and nothing else, on
 * every version, so each naming part is held to that alphabet — the same rule
 * as `ProfileNamingDto` on the server. The lengths are the ones the server
 * keeps (`readProfileNaming`).
 *
 * {@link effectiveNamingPart} is the SPA's copy of the repair the server makes
 * for a stored value (`readProfileNamingConfig` in
 * `remnawave-profile-naming.service.ts`). Nothing crosses the SPA/Nest boundary
 * but JSON, so it is a copy, and the server suite holds the two together:
 * `test/profile-naming-repair-contract.spec.ts` runs this file and the
 * server's reader over the same stored values. That spec transpiles this file
 * on its own, so it must stay free of imports.
 */

export const NAMING_ALPHABET = /^[A-Za-z0-9_-]+$/
export const NAMING_PREFIX = /^[A-Za-z0-9_-]{1,16}$/
export const NAMING_SEPARATOR = /^[A-Za-z0-9_-]{1,2}$/
export const NAMING_SUFFIX = /^[A-Za-z0-9_-]{1,32}$/

export type NamingPart = 'prefix' | 'separator' | 'suffixBase'

export const NAMING_DEFAULTS: Readonly<Record<NamingPart, string>> = {
  prefix: 'rz',
  separator: '_',
  suffixBase: 'sub',
}
export const NAMING_MAX_LENGTH: Readonly<Record<NamingPart, number>> = {
  prefix: 16,
  separator: 2,
  suffixBase: 32,
}

/**
 * The part the server actually puts into a NEW profile name for a stored
 * value. A value saved before the alphabet was checked is not sent to
 * Remnawave as it is (one bad character made the panel refuse every CREATE):
 * invalid runs become `_`, an invalid separator becomes the default, and a
 * part with nothing valid left falls back to the default.
 */
export function effectiveNamingPart(value: string | undefined, part: NamingPart): string {
  if (value === undefined || value.length === 0 || value.length > NAMING_MAX_LENGTH[part]) {
    return NAMING_DEFAULTS[part]
  }
  if (NAMING_ALPHABET.test(value)) return value
  if (part === 'separator') return NAMING_DEFAULTS.separator
  const repaired = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, NAMING_MAX_LENGTH[part])
  return repaired.length > 0 ? repaired : NAMING_DEFAULTS[part]
}
