/**
 * The one lookup every server error in the panel goes through.
 *
 * ── What this file exists to stop happening again ────────────────────────────
 *
 * `translateServerSentence` looks a server sentence up as `errors.<sentence>`.
 * i18next's default `nsSeparator` is ':', so before the key is resolved it is
 * cut in two at the FIRST colon and the left half is taken for a namespace.
 * There is exactly ONE namespace in this app ('translation', registered in
 * `i18n/i18n.ts`) and no `t()` call anywhere names one, so that half can only
 * miss — and the miss does not hand the sentence back. It hands back the RIGHT
 * half. Every colon-bearing refusal in the panel reached the operator as a
 * fragment starting with a space:
 *
 *     'Missing permission: automations:create'  ->  ' automations.create'
 *     'Unknown action type: frobnicate'         ->  ' frobnicate'
 *
 * The guard inside the function could not catch it either: what comes back is
 * neither the key nor a translation, so `translated === key` is false and the
 * fragment is returned as if it were the answer.
 *
 * ── How the assertions avoid being vacuous ───────────────────────────────────
 *
 * Three deliberate choices, because a test that pinned a new string to itself
 * would guard nothing and this repository has a documented history of exactly
 * that:
 *
 *   1. The dictionary entries under test are READ OUT OF the real `ru`/`en`
 *      bundles rather than restated here. Delete the colon-bearing row and
 *      `the bundles still carry a colon-bearing entry` fails by name instead of
 *      quietly checking an empty list.
 *   2. Every "is it Russian?" assertion matches CYRILLIC. `fallbackLng` is
 *      'en', so a lookup that silently degraded to the English bundle would
 *      pass a bare `not.toBe(input)` — that trap has been walked into here
 *      before.
 *   3. `the namespace split is still a live hazard` renders the SAME sentences
 *      through a default-configured i18next. If a future i18next stops
 *      splitting on ':', that test fails and says the guard below has become
 *      decorative, rather than letting it pass on for ever.
 */
import { createInstance, type i18n as I18nInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

import {
  translateApiError,
  translateErrorMessage,
  translateServerMessage,
  translateServerSentence,
} from './translate-error'

/** The core dictionaries, over a real i18next — no fixture stands in. */
function instance(lng: 'en' | 'ru'): I18nInstance {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: en as unknown as Record<string, unknown> },
      ru: { translation: ru as unknown as Record<string, unknown> },
    },
    interpolation: { escapeValue: false },
  })
  return i18n
}

const RU = instance('ru')
const ruT = RU.t.bind(RU) as TFunction

/** A refusal exactly as axios hands one to a mutation's `onError`. */
function refusal(message: unknown): unknown {
  return {
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: { status: 400, data: { message } },
  }
}

/**
 * The sentence-shaped rows of the root `errors: {}` table, split by what the
 * two i18next separators do to them.
 *
 * A "sentence" is a key with whitespace in it — that is what tells a server
 * sentence apart from an ordinary key path like `errors.requestFailed`.
 */
const SENTENCE_KEYS = Object.entries(ru.errors as Record<string, unknown>)
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  .map(([key]) => key)
  .filter((key) => /\s/.test(key))

const COLON_ENTRIES = SENTENCE_KEYS.filter((key) => key.includes(':') && !key.includes('.'))
const PLAIN_ENTRIES = SENTENCE_KEYS.filter((key) => !key.includes(':') && !key.includes('.'))

/**
 * Colon-bearing sentences the dictionaries deliberately hold NO entry for.
 *
 * Three of the shapes the backend actually emits — a permission token, an
 * action type, a cron expression — all of them interpolated, so none of them
 * can ever be a dictionary key. Whole-and-unchanged is the only correct answer
 * for these, and a fragment is the failure mode being guarded.
 */
const UNTRANSLATABLE = [
  'Missing permission: automations:create',
  'Unknown action type: frobnicate',
  'Invalid cron expression: 99 * * * *',
] as const

describe('translateServerSentence: a colon must not mutilate the sentence', () => {
  it('the sentences under test really do carry a colon', () => {
    // The anchor. Without it a later edit that dropped the colons would leave
    // every assertion below passing while testing nothing at all.
    for (const sentence of UNTRANSLATABLE) {
      expect(sentence, `${sentence} has no colon to split on`).toContain(':')
      expect(ru.errors, `${sentence} is unexpectedly IN the dictionary`).not.toHaveProperty(sentence)
    }
  })

  it('the namespace split is still a live hazard in this i18next', () => {
    // What the function did before the fix, reproduced against the same real
    // instance: `t(key)` with i18next's defaults. If this ever stops mangling,
    // the guard below is decorative and this failure says so out loud.
    for (const sentence of UNTRANSLATABLE) {
      const key = `errors.${sentence}`
      const raw: string = ruT(key)
      expect(raw, `i18next no longer splits "${key}" on its namespace separator`).not.toBe(key)
      expect(raw, `i18next no longer mangles "${key}"`).not.toBe(sentence)
    }
  })

  it('hands an untranslatable colon-bearing sentence back whole and unchanged', () => {
    for (const sentence of UNTRANSLATABLE) {
      expect(translateServerSentence(ruT, sentence)).toBe(sentence)
    }
  })

  it('never answers with the tail of a sentence', () => {
    // The signature of the defect, stated as a property rather than as three
    // pinned strings: the fragment always begins at the character after the
    // colon, which in a written sentence is a space.
    for (const sentence of UNTRANSLATABLE) {
      const shown = translateServerSentence(ruT, sentence)
      expect(shown, `"${sentence}" came back as a fragment`).not.toMatch(/^\s/)
      expect(shown.length, `"${sentence}" lost its head`).toBe(sentence.length)
    }
  })

  it('reaches the same answer through every public entry point', () => {
    // `translateApiError` (the panel's own path, off an axios rejection),
    // `translateServerMessage` (the sign-in form) and `translateErrorMessage`
    // all delegate here. A fix applied to one of three lookups is the shape
    // this module was written to prevent.
    for (const sentence of UNTRANSLATABLE) {
      expect(translateApiError(ruT, refusal(sentence))).toBe(sentence)
      expect(translateServerMessage(ruT, sentence)).toBe(sentence)
      expect(translateErrorMessage(ruT, sentence)).toBe(sentence)
    }
  })

  it('joins a ValidationPipe array without mangling any line of it', () => {
    const lines = [UNTRANSLATABLE[0], UNTRANSLATABLE[1]]
    expect(translateApiError(ruT, refusal(lines))).toBe(lines.join(' '))
  })
})

describe('translateServerSentence: the dictionary entries it must reach', () => {
  it('the bundles still carry a colon-bearing entry', () => {
    // Read from the data, not restated. This is `errors['Exactly one
    // identifier must be provided: userId, telegramId, email, login, or
    // referralCode']`, which had never resolved once since it was written.
    expect(
      COLON_ENTRIES.length,
      'no colon-bearing entry left in errors: {} — this suite now proves nothing',
    ).toBeGreaterThan(0)
    for (const key of COLON_ENTRIES) {
      expect(en.errors, `${key} is missing from the English bundle`).toHaveProperty(key)
    }
  })

  it('resolves every colon-bearing entry into Russian', () => {
    for (const key of COLON_ENTRIES) {
      const shown = translateServerSentence(ruT, key)
      expect(shown, `"${key}" still reaches a Russian operator in English`).not.toBe(key)
      expect(shown, `"${key}" resolved to a key path`).not.toMatch(/^errors\./)
      // Cyrillic, not merely "different from the input": `fallbackLng` is 'en',
      // so landing on the English value would pass a bare inequality.
      expect(shown, `"${key}" resolved to something that is not Russian`).toMatch(/[а-яА-ЯёЁ]/)
      expect(shown, `"${key}" resolved to the English value`).not.toBe(
        (en.errors as Record<string, string>)[key],
      )
    }
  })

  it('still resolves the entries that never had a colon', () => {
    // `keySeparator` must stay ON. These entries live NESTED, under an
    // `errors: {…}` object, so the '.' in the `errors.` prefix is load-bearing:
    // turning the key separator off alongside the namespace one would make
    // `errors.Invalid login or password` a single flat key that exists in
    // neither bundle, and every lookup here — including the ones that have
    // always worked — would start missing.
    expect(PLAIN_ENTRIES.length, 'no plain sentence entries left to check').toBeGreaterThan(0)
    for (const key of PLAIN_ENTRIES) {
      expect(translateServerSentence(ruT, key), `"${key}" stopped resolving`).toMatch(/[а-яА-ЯёЁ]/)
    }
  })

  it('still resolves an ordinary nested key path', () => {
    // The deepest `keySeparator` dependency in this module: the generic used
    // when a rejection carries no readable body at all.
    expect(translateApiError(ruT, { isAxiosError: true, response: { status: 500, data: {} } })).toBe(
      (ru.errors as Record<string, string>).requestFailed,
    )
  })
})
