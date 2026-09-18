/**
 * The codes the SPA words, against the codes the server can write.
 *
 * ── Why this reads the server's source ───────────────────────────────────────
 *
 * `run-result-copy.test.ts` walks `RESULT_CODES` and checks each one has a
 * sentence — a real guard, and one that can only ever see the SPA's own list.
 * `audience_partial` shipped on the server while this list knew ten codes, so a
 * partly-failed audience run reached the operator in English twice: once as the
 * result's own message (the fallback), and once as the joined line the run log
 * suppresses only when EVERY failed action carries a code it knows.
 *
 * So the list is pinned to `AutomationActionResultCode` itself, read out of the
 * panel's source rather than restated. Reaching across the package boundary is
 * the established shape here — see `hint-templates-server-contract.test.ts` and
 * `i18n/features/automations-copy-truth.test.ts`. A parse that finds nothing
 * FAILS rather than passing on an empty set.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

import { RESULT_CODES, resultCodeText } from './run-result-copy'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `web/src/features/automations` → `web/src` → `web` → the repository root. */
const REPO = resolve(HERE, '..', '..', '..', '..')
const OUTCOME_PATH = resolve(REPO, 'src', 'modules', 'automations', 'actions', 'action-outcome.ts')

/** Every member of the server's `AutomationActionResultCode` union. */
function serverCodes(): string[] {
  const source = readFileSync(OUTCOME_PATH, 'utf8')
  const start = source.indexOf('export type AutomationActionResultCode =')
  expect(
    start,
    'AutomationActionResultCode is gone from action-outcome.ts — this parse needs rewriting, not deleting',
  ).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf(';', start))
  const found = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  expect(found.length, 'no union members parsed out of AutomationActionResultCode').toBeGreaterThan(5)
  return [...new Set(found)]
}

function translator(lng: 'en' | 'ru'): TFunction {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: en as unknown as Record<string, unknown> },
      ru: { translation: ru as unknown as Record<string, unknown> },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return i18n.t.bind(i18n) as TFunction
}

describe('the result codes this panel words', () => {
  it('are exactly the ones the server can write', () => {
    expect([...RESULT_CODES].sort()).toEqual(serverCodes().sort())
  })

  it('each have a sentence in both languages, by the server’s own list', () => {
    // Walked from the SERVER's list, so a code the SPA has never heard of shows
    // up here as a missing sentence rather than as English on the screen.
    for (const code of serverCodes()) {
      for (const lng of ['ru', 'en'] as const) {
        const text = resultCodeText(translator(lng), {
          index: 0,
          type: 'show_hint_to_audience',
          status: 'failed',
          message: 'english from the server',
          code,
          details: {
            hintKey: 'k',
            userId: 'u',
            audience: 'paid-not-connected',
            matched: 40,
            queued: 34,
            failed: 3,
            notAttempted: 3,
            stoppedEarly: true,
            capped: false,
            reason: 'r',
          },
        })
        expect(text, `${code} (${lng}) has no sentence`).not.toBeNull()
        expect(text, `${code} (${lng}) fell back to the server's message`).not.toBe('english from the server')
        expect(text, `${code} (${lng}) left a key path on screen`).not.toContain('automationsPage.')
        expect(text, `${code} (${lng}) left a placeholder unfilled`).not.toContain('{{')
      }
    }
  })
})
