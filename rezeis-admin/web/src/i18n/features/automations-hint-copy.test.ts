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

import { en as coreEn } from '../en'
import { ru as coreRu } from '../ru'
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

// -----------------------------------------------------------------------------
// The explanations behind the (i)s state what the delivery service does
// -----------------------------------------------------------------------------

/**
 * Four sentences on the hints tab make claims an operator acts on, and each is
 * checked against the line in `user-hint-delivery.service.ts` that makes it
 * true — the same arrangement as the group field above. An anchor that stops
 * matching fails as its own case, so a server change forces the sentence to be
 * reread rather than leaving it quietly describing the old behaviour.
 */
describe('the hints tab explains the queue the server actually runs', () => {
  it('"once" counts ANY earlier delivery, and the copy says so, with the way to test again', () => {
    // No `shownAt`, `expiresAt` or `dismissedAt` in the count: a delivery never
    // shown, or lapsed, still counts. The owner's own-account test worked once
    // and never again, and nothing on the form said why.
    expect(
      /userHintDelivery\.count\(\{\s*where:\s*\{\s*userId:\s*input\.userId,\s*hintId:\s*hint\.id\s*\},?\s*\}\)/.test(
        DELIVERY,
      ),
      'the once-only count in raise() changed shape - reread userHints.fields.isRepeatableHint',
    ).toBe(true)

    const ru = RU.t('userHints.fields.isRepeatableHint')
    expect(ru).toMatch(/один раз на клиента/)
    expect(ru).toMatch(/любая прошлая выдача/)
    expect(ru).toMatch(/непоказанн/)
    expect(ru).toMatch(/истёкш/)
    expect(ru).toContain(`«${RU.t('automationsPage.editor.runNow')}»`)

    const en = EN.t('userHints.fields.isRepeatableHint')
    expect(en).toMatch(/once per customer/)
    expect(en).toMatch(/any earlier delivery counts/i)
    expect(en).toMatch(/never shown/)
    expect(en).toMatch(/lapsed/)
    expect(en).toContain(`"${EN.t('automationsPage.editor.runNow')}"`)
  })

  it('a switched-off hint is not queued and not drawn, and what was queued waits', () => {
    expect(/if \(!hint\.isActive\) return\b/.test(DELIVERY), 'raise() no longer refuses an inactive hint').toBe(
      true,
    )
    expect(
      /hint:\s*\{\s*isActive:\s*true/.test(DELIVERY),
      'nextFor() no longer reads isActive live - the "they wait and resume" half is no longer true',
    ).toBe(true)

    for (const key of ['userHints.fields.isActiveHint', 'userHints.reach.inactive']) {
      expect(RU.t(key), key).toMatch(/не ставит в очередь/)
      expect(RU.t(key), key).toMatch(/покажутся после включения/)
      expect(RU.t(key), key).toMatch(/срок годности не истёк/)
      expect(EN.t(key), key).toMatch(/queues nothing|does not queue/)
      expect(EN.t(key), key).toMatch(/appear once it is switched back on/)
      expect(EN.t(key), key).toMatch(/lifetime has not run out/)
    }
  })

  it('a save changes the text of hints already waiting, which the save tooltip says', () => {
    // The text is joined in when the hint is handed over, never copied at raise.
    expect(/include:\s*\{\s*hint:\s*true\s*\}/.test(DELIVERY)).toBe(true)
    expect(/this\.resolve\(row\.id,\s*row\.hint,/.test(DELIVERY)).toBe(true)

    expect(RU.t('userHints.tips.saveExisting')).toMatch(/уже ждёт в очереди/)
    expect(EN.t('userHints.tips.saveExisting')).toMatch(/already waiting for in the queue/)
  })

  it('a new lifetime reaches later firings only, which the lifetime field says', () => {
    // Resolved at raise and stored: lengthening the lifetime must not revive
    // deliveries that already lapsed.
    expect(/expiresAt:\s*new Date\(now\.getTime\(\) \+ hint\.ttlHours/.test(DELIVERY)).toBe(true)

    expect(RU.t('userHints.fields.ttlHint')).toMatch(/у уже ждущих он не меняется/)
    expect(EN.t('userHints.fields.ttlHint')).toMatch(/hints already waiting keep theirs/)
  })
})

// -----------------------------------------------------------------------------
// The limits the (i)s state are the ones the server enforces
// -----------------------------------------------------------------------------

const DTO = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'src',
    'modules',
    'user-hints',
    'dto',
    'user-hint.dto.ts',
  ),
  'utf8',
)

/** The `@Length(min, max)` directly above a DTO field, or `null`. */
function lengthOf(field: string): readonly [number, number] | null {
  const match = new RegExp(`@Length\\((\\d+),\\s*(\\d+)\\)\\s*${field}[!?]:`).exec(DTO)
  return match === null ? null : [Number(match[1]), Number(match[2])]
}

describe('the hints tab states the limits the DTO enforces', () => {
  // A limit the copy names and the server does not apply is a promise the
  // save button breaks: the refusal comes back in the server's English.
  const title = lengthOf('titleRu')
  const titleEn = lengthOf('titleEn')
  const body = lengthOf('bodyRu')
  const bodyEn = lengthOf('bodyEn')
  const label = lengthOf('ctaLabelRu')
  const labelEn = lengthOf('ctaLabelEn')
  const ttl = /@Min\((\d+)\)\s*@Max\(([\d\s*]+)\)\s*ttlHours\?:/.exec(DTO)

  it('parsed every limit, and each language has the same ceiling', () => {
    for (const [name, limit] of Object.entries({ title, titleEn, body, bodyEn, label, labelEn })) {
      expect(limit, `@Length for ${name} was not found in user-hint.dto.ts`).not.toBeNull()
    }
    expect(ttl, '@Min/@Max for ttlHours was not found in user-hint.dto.ts').not.toBeNull()
    expect(titleEn?.[1]).toBe(title?.[1])
    expect(bodyEn?.[1]).toBe(body?.[1])
    expect(labelEn?.[1]).toBe(label?.[1])
  })

  it('says the title, body and button label ceilings', () => {
    expect(RU.t('userHints.fields.titleHint')).toContain(`до ${title?.[1]} символов`)
    expect(EN.t('userHints.fields.titleHint')).toContain(`up to ${title?.[1]} characters`)
    expect(RU.t('userHints.fields.bodyHint')).toContain(`до ${body?.[1]} символов`)
    expect(EN.t('userHints.fields.bodyHint')).toContain(`up to ${body?.[1]} characters`)
    expect(RU.t('userHints.fields.ctaLabelHint')).toContain(`До ${label?.[1]} символов`)
    expect(EN.t('userHints.fields.ctaLabelHint')).toContain(`Up to ${label?.[1]} characters`)
  })

  it('says the lifetime range', () => {
    const min = Number(ttl?.[1])
    // Written as `24 * 90` in the DTO, so the factors are multiplied out.
    const max = (ttl?.[2] ?? '').split('*').reduce((product, factor) => product * Number(factor.trim()), 1)
    expect(Number.isFinite(max) && max > min, `could not read the ttlHours ceiling: ${ttl?.[2]}`).toBe(true)
    expect(RU.t('userHints.fields.ttlHint')).toContain(`От ${min} до ${max} часов`)
    expect(EN.t('userHints.fields.ttlHint')).toContain(`From ${min} to ${max} hours`)
  })
})

// -----------------------------------------------------------------------------
// The copy names only UI that exists, and samples look like samples
// -----------------------------------------------------------------------------

/** Every string leaf of a dictionary. */
function leaves(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (typeof node !== 'object' || node === null) return []
  return Object.values(node as Record<string, unknown>).flatMap(leaves)
}

const CORE_LEAVES = {
  ru: new Set([...leaves(ru), ...leaves(coreRu)]),
  en: new Set([...leaves(en), ...leaves(coreEn)]),
}

/**
 * The hints-tab and map sentences that name a button, tab, field or action.
 *
 * A name in quotes must be the label itself, character for character: an
 * operator looks for exactly those words on screen. Interpolations are skipped
 * (they are filled from data), and so are the quoted SAMPLES listed below —
 * a hint's own words, not a control.
 */
const NAMING_COPY = [
  'userHints.intro',
  'userHints.fields.toneHint',
  'userHints.fields.ctaKindHint',
  'userHints.fields.surfacesHint',
  'userHints.fields.isRepeatableHint',
  'userHints.tips.new',
  'userHints.tips.delete',
  'userHints.reach.info',
  'userHints.reach.whomManual',
  'userHints.reach.whomAudienceManual',
  'userHints.reach.noRule',
  'userHints.reach.noWorkingRule',
  'userHints.reach.onlyUnverified',
  'userHints.reach.inactive',
  'userHints.reach.gap',
  'automationsPage.triggerMap.offerHalfBuiltHint',
  'automationsPage.triggerMap.offerNew',
  'automationsPage.triggerMap.countsInfo',
  'automationsPage.triggerMap.pathPaused',
  'automationsPage.triggerMap.pathMissingHint',
  'automationsPage.triggerMap.pathHintInactive',
  'automationsPage.triggerMap.pathUnverified',
  'automationsPage.triggerMap.pathAudienceOnEvent',
  'automationsPage.triggerMap.pathScheduleNamesNobody',
  'automationsPage.triggerMap.pathAudienceInvalid',
  'automationsPage.triggerMap.ruleOffNote',
  'automationsPage.triggerMap.gap',
] as const

const SAMPLES = new Set(['установите приложение', 'install the app'])

function quotedNames(sentence: string, lng: 'ru' | 'en'): string[] {
  const pattern = lng === 'ru' ? /«([^«»]+)»/g : /"([^"]+)"/g
  return [...sentence.matchAll(pattern)]
    .map((match) => match[1] ?? '')
    .filter((name) => !name.includes('{{') && !SAMPLES.has(name))
}

describe('a rule on an event the panel has not checked is never called a certain miss', () => {
  /**
   * The server's list of events a pop-up is known to work on is closed, not
   * exhaustive: an unlisted event that names a customer works. So every sentence
   * about that state may say what is known — not checked, only if the event
   * arrives and names a customer, where to look — and never that the rule will
   * not show the hint or that customers will not see it.
   */
  const UNCHECKED_COPY = [
    'automationsPage.triggerMap.pathUnverified',
    'userHints.reach.whomUnverified',
    'userHints.reach.onlyUnverified',
    'userHints.reach.notChecked',
    'automationsPage.triggerMap.counts.unverified_one',
    'automationsPage.triggerMap.counts.unverified_other',
  ] as const

  it('says "not checked" and "only if", in Russian', () => {
    for (const key of UNCHECKED_COPY) {
      const sentence = RU.t(key, { event: 'support.ticket_created', count: 2 })
      expect(sentence, key).not.toMatch(/не покаж|ни разу|не увид|нельзя показать|не может показать/)
    }
    expect(RU.t('automationsPage.triggerMap.pathUnverified')).toMatch(/не проверяла/)
    expect(RU.t('automationsPage.triggerMap.pathUnverified')).toMatch(/только если событие приходит и в нём назван клиент/)
    expect(RU.t('userHints.reach.onlyUnverified')).toMatch(/только если такое событие приходит и в нём назван клиент/)
  })

  it('says "not checked" and "only if", in English', () => {
    for (const key of UNCHECKED_COPY) {
      const sentence = EN.t(key, { event: 'support.ticket_created', count: 2 })
      expect(sentence, key).not.toMatch(/never shows|will not see|cannot be shown|cannot show/i)
    }
    expect(EN.t('automationsPage.triggerMap.pathUnverified')).toMatch(/has not checked/)
    expect(EN.t('automationsPage.triggerMap.pathUnverified')).toMatch(/only if the event arrives and names a customer/)
    expect(EN.t('userHints.reach.onlyUnverified')).toMatch(/only if such an event arrives and names a customer/)
  })

  it('keeps the unchecked state out of the «Не сработает» legend and gives it its own', () => {
    const ru = RU.t('automationsPage.triggerMap.countsInfo')
    const brokenPart = ru.slice(ru.indexOf('Не сработает'), ru.indexOf('Не проверено'))
    expect(brokenPart.length, 'the legend lost one of its two sentences').toBeGreaterThan(0)
    expect(brokenPart).not.toMatch(/показать нельзя|не проверяла/)
    expect(ru).toMatch(/Не проверено — /)

    const en = EN.t('automationsPage.triggerMap.countsInfo')
    const brokenEn = en.slice(en.indexOf('Will not fire'), en.indexOf('Not checked'))
    expect(brokenEn.length, 'the legend lost one of its two sentences').toBeGreaterThan(0)
    expect(brokenEn).not.toMatch(/cannot be shown|has not checked/)
    expect(en).toMatch(/Not checked — /)
  })
})

describe('the hints tab and the map name real controls', () => {
  // The raw templates, not `t()`: an interpolated value is data, not a name.
  const raw = (bundle: unknown, path: string): string => {
    const value = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle)
    expect(typeof value, `${path} is not a string in the bundle`).toBe('string')
    return value as string
  }

  it('finds names to check', () => {
    // Anti-vacuity: a pattern that matched nothing would pass every case below.
    expect(NAMING_COPY.flatMap((path) => quotedNames(raw(ru, path), 'ru')).length).toBeGreaterThan(15)
    expect(NAMING_COPY.flatMap((path) => quotedNames(raw(en, path), 'en')).length).toBeGreaterThan(15)
  })

  it('quotes in Russian only labels that exist in the Russian bundles', () => {
    for (const path of NAMING_COPY) {
      for (const name of quotedNames(raw(ru, path), 'ru')) {
        expect(CORE_LEAVES.ru.has(name), `${path} names «${name}», which no Russian label reads`).toBe(true)
      }
    }
  })

  it('quotes in English only labels that exist in the English bundles', () => {
    for (const path of NAMING_COPY) {
      for (const name of quotedNames(raw(en, path), 'en')) {
        expect(CORE_LEAVES.en.has(name), `${path} names "${name}", which no English label reads`).toBe(true)
      }
    }
  })

  it('gives samples, not values, as placeholders', () => {
    // A grey `subscription-ready` in «Ключ» and `purchase` in «Группа» were
    // read as fields already filled in.
    const fields = (bundle: unknown) =>
      Object.entries((bundle as { userHints: { fields: Record<string, unknown> } }).userHints.fields)
        .filter(([key]) => key.endsWith('Placeholder'))
        .map(([key, value]) => [key, String(value)] as const)

    expect(fields(ru).length, 'no placeholder keys found').toBeGreaterThanOrEqual(3)
    for (const [key, value] of fields(ru)) expect(value, key).toMatch(/^например: \S/)
    for (const [key, value] of fields(en)) expect(value, key).toMatch(/^for example: \S/)
  })
})
