/**
 * Two sentences on the automations screen, against the facts they state.
 *
 * ── Why neither block pins a string to itself ────────────────────────────────
 *
 * Both sentences make a claim about behaviour, so both are checked against the
 * thing that decides it rather than against a copy of themselves:
 *
 *   • `hintCollision.body` interpolates a COUNT, and Russian agrees the
 *     adjective and the verb with it as well as the noun. So it is rendered
 *     through a real i18next at every CLDR rung — which form is reached at 22
 *     is i18next's business, not this file's — instead of being read out of the
 *     bundle and eyeballed.
 *   • `userHints.intro` describes what a hint LOOKS like, and the library it
 *     sits above holds both presentations. The mode split is therefore read
 *     out of `HINT_TEMPLATES` itself: a template flipped from TOAST to MODAL
 *     later must break this file loudly rather than leave the sentence quietly
 *     wrong again.
 *
 * `automations-copy-truth.test.ts` is the sibling of this file and covers the
 * rest of the same screen's copy; the two are split only so the automations
 * work and the i18n work stayed on separate files.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type i18n as I18nInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES } from '@/features/automations/hint-templates'

import { en } from './automations.en'
import { ru } from './automations.ru'

/** The lazy automations bundle over a real i18next, as the page loads it. */
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
const EN = instance('en')

// ─────────────────────────────────────────────────────────────────────────────
// The collision warning agrees with its own number
// ─────────────────────────────────────────────────────────────────────────────

describe('automationsPage.hintCollision.body', () => {
  const body = (i18n: I18nInstance, count: number): string =>
    i18n.t('automationsPage.hintCollision.body', { count })

  it('is a plural ladder, not one form with a number dropped into it', () => {
    // Read from the bundle: the defect was a single `body` key, and a fix that
    // only added `_one` while leaving the bare key would still read
    // "Ещё 2 включённое правило" at every other rung.
    // Typed off the bundles themselves rather than cast: a renamed
    // `hintCollision` is then a compile error here, not a silent empty list.
    const collision: Readonly<Record<string, unknown>> = ru.automationsPage.hintCollision
    const english: Readonly<Record<string, unknown>> = en.automationsPage.hintCollision
    expect(Object.keys(collision).filter((key) => key.startsWith('body')).sort()).toEqual([
      'body_few',
      'body_many',
      'body_one',
      'body_other',
    ])
    expect(Object.keys(english).filter((key) => key.startsWith('body')).sort()).toEqual([
      'body_one',
      'body_other',
    ])
    // A bare `body` left behind is dead copy that drifts: i18next prefers the
    // suffixed form whenever `count` is passed, and the only caller
    // (`automations-page.tsx`, the `<Alert>` under the editor) always passes it.
    expect(collision).not.toHaveProperty('body')
    expect(english).not.toHaveProperty('body')
  })

  it('agrees the adjective, the noun and the verb on every Russian rung', () => {
    // 1 and 21 land on `_one`, 2 and 22 on `_few`, 0 / 5 / 11 / 100 on
    // `_many`. Rendered rather than read: the mapping is i18next's.
    expect(body(RU, 1)).toBe(
      'Ещё 1 включённое правило показывает подсказку на событии, которое приходит вместе с этим. Одна покупка — несколько событий за пару секунд, и человек получит подсказку за подсказкой.',
    )
    expect(body(RU, 21)).toMatch(/^Ещё 21 включённое правило показывает /)
    expect(body(RU, 2)).toMatch(/^Ещё 2 включённых правила показывают /)
    expect(body(RU, 22)).toMatch(/^Ещё 22 включённых правила показывают /)
    // Zero is unreachable through the UI — the alert returns null at zero —
    // but it is the rung a careless `_other`-only ladder gets wrong first.
    expect(body(RU, 0)).toMatch(/^Ещё 0 включённых правил показывают /)
    expect(body(RU, 5)).toMatch(/^Ещё 5 включённых правил показывают /)
    expect(body(RU, 11)).toMatch(/^Ещё 11 включённых правил показывают /)
    expect(body(RU, 100)).toMatch(/^Ещё 100 включённых правил показывают /)
  })

  it('agrees the noun and the verb on every English rung', () => {
    expect(body(EN, 1)).toMatch(/^1 other enabled rule shows /)
    expect(body(EN, 21)).toMatch(/^21 other enabled rules show /)
    for (const count of [0, 2, 5, 11, 22, 100]) {
      expect(body(EN, count), `English at ${count}`).toMatch(
        new RegExp(`^${count} other enabled rules show `),
      )
    }
  })

  it('keeps the number in every form of both languages', () => {
    // A form that lost `{{count}}` renders a sentence with a hole where the
    // number was, and reads perfectly well while saying nothing.
    for (const count of [0, 1, 2, 5, 11, 21, 22, 100]) {
      expect(body(RU, count), `ru at ${count}`).toContain(String(count))
      expect(body(EN, count), `en at ${count}`).toContain(String(count))
      expect(body(RU, count), `ru at ${count} left a placeholder`).not.toContain('{{')
      expect(body(EN, count), `en at ${count} left a placeholder`).not.toContain('{{')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The hints library is not all windows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The presentations the template library actually creates, out of the data.
 *
 * `HINT_TEMPLATES` is imported rather than parsed so a renamed field is a
 * compile error instead of a regex that quietly matches nothing.
 */
const MODES = HINT_TEMPLATES.map((template) => template.mode)
const TOASTS = MODES.filter((mode) => mode === 'TOAST')
const MODALS = MODES.filter((mode) => mode === 'MODAL')

describe('userHints.intro', () => {
  it('sits above a library that holds more than one presentation', () => {
    // The premise, read from the data. Observed on 2026-09-10: 21 templates,
    // 12 MODAL and 9 TOAST. If the library ever became single-mode again the
    // sentence below would be over-explaining rather than wrong, and this is
    // where that shows up — as a named failure, not a silent pass.
    expect(HINT_TEMPLATES.length, 'the template library is empty').toBeGreaterThan(0)
    expect(new Set(MODES)).toEqual(new Set(['MODAL', 'TOAST']))
    expect(TOASTS.length, 'no toast templates left').toBeGreaterThan(0)
    expect(MODALS.length, 'no modal templates left').toBeGreaterThan(0)
  })

  it('names both presentations in Russian', () => {
    const intro = RU.t('userHints.intro')
    expect(intro, 'the intro no longer mentions the window').toMatch(/окн/i)
    expect(
      intro,
      `the intro calls every hint a window and never mentions the ${TOASTS.length} templates that are a line`,
    ).toMatch(/строк/i)
  })

  it('names both presentations in English', () => {
    const intro = EN.t('userHints.intro')
    expect(intro, 'the intro no longer mentions the window').toMatch(/\bwindow\b/i)
    expect(
      intro,
      `the intro calls every hint a window and never mentions the ${TOASTS.length} templates that are a line`,
    ).toMatch(/\bline\b|\btoast\b/i)
  })

  it('does not assert one presentation over the whole library', () => {
    // The exact shape of the old sentence: a definition that equates a hint
    // with a window, full stop. Naming the window is fine — the rule above
    // requires it — but only while the other form is named beside it.
    expect(RU.t('userHints.intro')).not.toMatch(/Подсказка\s+—\s+это окно/i)
    expect(EN.t('userHints.intro')).not.toMatch(/\bA hint is a window\b/i)
  })
})

// -----------------------------------------------------------------------------
// The group field describes the rule the server actually applies
// -----------------------------------------------------------------------------

/**
 * Supersession is a SERVER rule, and the operator types the group key by hand
 * into a free-text field. So this block does not read the sentence and nod at
 * it: it reads the delivery service and requires the sentence to describe the
 * rule that is running there, in both directions.
 *
 *   - While the service lapses sub-groups, the field must say so.
 *   - If that ever comes out of the service, the field must stop saying so.
 *
 * The second half is the one that matters. A hint describing a rule the server
 * no longer applies is worse than no hint at all: the operator names a group
 * with a hyphen on purpose, and nothing happens.
 */
const DELIVERY = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'src',
    'modules',
    'user-hints',
    'services',
    'user-hint-delivery.service.ts',
  ),
  'utf8',
)

describe('userHints.fields.groupKeyHint', () => {
  /** Both halves: the prefix is computed AND a query actually filters on it. */
  const lapsesSubGroups =
    /export function subGroupPrefix\(/.test(DELIVERY) &&
    /groupKey:\s*\{\s*startsWith/.test(DELIVERY)

  it('is checked against a delivery service that still has the rule', () => {
    // Anti-vacuous anchor. Every case below states what the copy must say
    // BECAUSE the server does this; a rename that made this false would leave
    // them asserting the copy against nothing at all.
    expect(
      lapsesSubGroups,
      'user-hint-delivery.service.ts no longer computes a sub-group prefix, or no longer filters on it - decide which way the copy goes and rewrite this block deliberately',
    ).toBe(true)
  })

  it('names the sub-group rule in Russian while the server applies it', () => {
    const hint = RU.t('userHints.fields.groupKeyHint')
    expect(hint).toMatch(/подгруппа/i)
    expect(hint).toMatch(/дефис/i)
    // One-way, and the direction is the whole value of the rule.
    expect(hint).toMatch(/наоборот/i)
  })

  it('names it in English too', () => {
    const hint = EN.t('userHints.fields.groupKeyHint')
    expect(hint).toMatch(/sub-group/i)
    expect(hint).toMatch(/hyphen/i)
    expect(hint).toMatch(/never the other way round/i)
  })

  it('carries a worked example whose child really is a child of its parent', () => {
    // The example is the part an operator copies. Run it through the server's
    // own boundary rule rather than trusting the sentence: `payment-attempt`
    // must be the parent of `payment-attempt-method`, and not the reverse.
    for (const [lng, i18n] of [
      ['ru', RU],
      ['en', EN],
    ] as const) {
      const hint = i18n.t('userHints.fields.groupKeyHint')
      const quoted = [...hint.matchAll(/[«“]([a-z][a-z-]*)[»”]/g)].map(
        (match) => match[1] ?? '',
      )
      expect(quoted.length, `${lng}: the sentence lost its worked example`).toBe(2)
      const parent = quoted[0] ?? ''
      const child = quoted[1] ?? ''
      expect(child.startsWith(`${parent}-`), `${lng}: ${child} is not below ${parent}`).toBe(true)
      expect(parent.startsWith(`${child}-`), `${lng}: the example runs backwards`).toBe(false)
    }
  })

  it('does not promise the group leaves a window, which nine templates do not', () => {
    // The same defect as `userHints.intro` above: this field sits over a
    // library holding both presentations, so it may not name only one.
    expect(RU.t('userHints.fields.groupKeyHint')).not.toMatch(/одно окно/i)
    expect(EN.t('userHints.fields.groupKeyHint')).not.toMatch(/one window/i)
  })
})
