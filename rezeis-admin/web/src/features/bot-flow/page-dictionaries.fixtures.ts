/**
 * The dictionaries «Карта бота» renders with, for tests that check its words.
 *
 * The route loads the core dictionary before first paint and its own `botMap`
 * bundle with the page (`withFeatureBundle('botMap')`), and i18next merges the
 * bundle in deep (`addResourceBundle(…, deep)`). Part of `botFlow` — the
 * built-in screens, the system buttons, the texts listed per screen, the main
 * menu's routes and additions — lives in the bundle alone, off the eager
 * payload. A test that asks whether a key the map shows has its words reads
 * the merged pair here, as the page has it: not `ru.ts` / `en.ts` alone.
 */
import { en } from '@/i18n/en'
import { en as botMapEn } from '@/i18n/features/botMap.en'
import { ru as botMapRu } from '@/i18n/features/botMap.ru'
import { ru } from '@/i18n/ru'

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merged(core: Record<string, unknown>, bundle: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...core }
  for (const [key, value] of Object.entries(bundle)) {
    const existing = out[key]
    out[key] = isNode(existing) && isNode(value) ? merged(existing, value) : value
  }
  return out
}

export const BOT_MAP_RU = merged(ru, botMapRu)
export const BOT_MAP_EN = merged(en, botMapEn)

/** `[language, dictionary]` pairs, for `it.each`. */
export const BOT_MAP_DICTIONARIES = [
  ['ru', BOT_MAP_RU],
  ['en', BOT_MAP_EN],
] as const
