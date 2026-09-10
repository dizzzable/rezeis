/**
 * The automations screen's copy, against the code it makes promises about.
 *
 * ── Why the assertions read the SOURCE ───────────────────────────────────────
 *
 * Every sentence checked here states something about behaviour: what the rule a
 * template opens is worth after Create, whether a save is guaranteed, whether a
 * re-applied template is already in front of customers, and whether the thing
 * being described is a window or a line. A test that pinned the new sentence to
 * itself would pass for ever and guard none of that — this repo has eight of
 * those and they are the reason the sentences drifted in the first place.
 *
 * So each block below reads the fact first — out of `automations-page.tsx`, out
 * of `automations.service.ts` on the server side of the same repository, or out
 * of `HINT_TEMPLATES` itself — and only then asks whether the copy agrees. When
 * a parse finds nothing it FAILS rather than skipping, because a rename over
 * there must break this file loudly instead of quietly checking nothing.
 *
 * Reaching across the package boundary is the established shape here — see
 * `features/automations/hint-templates-server-contract.test.ts` and
 * `features/rbac/rbac-catalog-parity.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type i18n as I18nInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES } from '@/features/automations/hint-templates'
import { buildTriggerMap } from '@/features/automations/trigger-map'
import type { AutomationRule } from '@/features/automations/automations-api'
import { en as coreEn } from '@/i18n/en'
import { ru as coreRu } from '@/i18n/ru'
import { translateApiError } from '@/lib/translate-error'

import { en } from './automations.en'
import { ru } from './automations.ru'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `web/src/i18n/features` → `web/src` → … → the repository root beside `src/`. */
const REPO = resolve(HERE, '..', '..', '..', '..')

const PAGE_PATH = resolve(HERE, '..', '..', 'features', 'automations', 'automations-page.tsx')
const SERVICE_PATH = resolve(REPO, 'src', 'modules', 'automations', 'automations.service.ts')

const PAGE = readFileSync(PAGE_PATH, 'utf8')
const SERVICE = readFileSync(SERVICE_PATH, 'utf8')

type Dict = Record<string, unknown>

/** `automationsPage.hintTemplates.created` out of one bundle, as a string. */
function copy(bundle: unknown, path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((node, step) => (node as Dict | undefined)?.[step], bundle)
  if (typeof value !== 'string') {
    throw new Error(`${path} is not a string in this bundle (got ${typeof value})`)
  }
  return value
}

const RU = (path: string): string => copy(ru, path)
const EN = (path: string): string => copy(en, path)

/** A real i18next over the given resources — plural choice is its job, not ours. */
function instance(lng: 'en' | 'ru', resources: { en: unknown; ru: unknown }): I18nInstance {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: resources.en as Record<string, unknown> },
      ru: { translation: resources.ru as Record<string, unknown> },
    },
    interpolation: { escapeValue: false },
  })
  return i18n
}

/** The lazy automations bundle, rendered the way the page renders it. */
const FEATURE_RU = instance('ru', { en, ru })

// ─────────────────────────────────────────────────────────────────────────────
// M13 — the rule a template opens is created SWITCHED OFF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `isEnabled` a fresh draft is seeded with, read out of `openDraft`.
 *
 * The template flow, the map's amber "text ready, no rule" button and the blank
 * "New rule" button all go through this one seed, so it decides what pressing
 * Create is worth on every path there is.
 */
function draftSeedIsEnabled(): boolean {
  const start = PAGE.indexOf('function openDraft(')
  expect(
    start,
    'openDraft is gone from automations-page.tsx — the copy about what a draft is worth has lost its subject',
  ).toBeGreaterThan(-1)
  const body = PAGE.slice(start, start + 1600)
  const match = /isEnabled:\s*(true|false)/.exec(body)
  expect(match, 'openDraft no longer seeds isEnabled with a literal').not.toBeNull()
  return match?.[1] === 'true'
}

describe('M13: what an operator gets after pressing Create', () => {
  it('seeds the draft switched off, which is the fact the copy has to carry', () => {
    // Not an assumption: the sentence under the template library is only wrong
    // while this is false. If a later edit seeds `true`, the cases below stop
    // describing the product and this one says so first.
    expect(draftSeedIsEnabled()).toBe(false)
  })

  it('does not tell the operator that Create is the last step', () => {
    expect(draftSeedIsEnabled()).toBe(false)

    // The rule is saved DISABLED, so "nothing reaches a customer until you
    // press Create" reads as "and then it does", which is the opposite of what
    // happens. The copy has to name the switch.
    const subtitleRu = RU('automationsPage.hintTemplates.subtitle')
    expect(subtitleRu, 'the Russian subtitle never mentions switching the rule on').toMatch(
      /включ/,
    )
    expect(subtitleRu).toMatch(/выключен/)

    const subtitleEn = EN('automationsPage.hintTemplates.subtitle')
    expect(subtitleEn, 'the English subtitle never mentions switching the rule on').toMatch(
      /switch(ing)? it on/,
    )
    expect(subtitleEn).toMatch(/switched off/)
  })

  it('says the same thing in the toast that follows the press', () => {
    expect(draftSeedIsEnabled()).toBe(false)
    expect(RU('automationsPage.hintTemplates.created')).toMatch(/выключен/)
    expect(EN('automationsPage.hintTemplates.created')).toMatch(/switched off/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I6 — «правило сохранится» is a promise the server can refuse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every refusal `AutomationsService` can answer a save with, as an exact
 * sentence — but only the ones written as a single string literal.
 *
 * The rest are built by concatenation or interpolation (`Unknown action type:
 * ${…}`), which is a distinction that matters twice over: they cannot be listed
 * here, and they cannot be translated either — see the I12 block.
 */
function literalRefusals(): string[] {
  const found = [
    ...SERVICE.matchAll(/new (?:BadRequest|NotFound)Exception\(\s*'([^'\\]*)'\s*\)/g),
  ].map((match) => match[1])
  return [...new Set(found)]
}

describe('I6: the promise under an event that has never fired', () => {
  it('finds refusals in the service the sentence is about', () => {
    // The premise. If the server ever stops refusing a save outright, the
    // conditional wording below is over-cautious and somebody should revisit
    // it — which is what this failing here would mean.
    expect(
      literalRefusals().length,
      'no refusal literal found in automations.service.ts — either the parse broke or the save is now unconditional',
    ).toBeGreaterThan(0)
  })

  it('refuses a pop-up on an event that cannot carry one', () => {
    // The specific refusal the copy names, and the one an operator staring at
    // "this has never happened here" is most likely to walk into: a hint bound
    // to an event nothing emits or that names nobody.
    expect(SERVICE).toMatch(/action\.type === 'show_hint'[\s\S]{0,400}?canCarryPopup/)
  })

  it('makes the save conditional in every Russian plural form', () => {
    const forms = ['_one', '_few', '_many', '_other']
    for (const form of forms) {
      const sentence = RU(`automationsPage.config.triggerNeverFired${form}`)
      expect(sentence, `triggerNeverFired${form} promises a save outright`).toMatch(
        /только если|если панель/,
      )
      // The old sentence read «Правило сохранится, но …» — an unconditional
      // promise with a caveat about FIRING, not about saving.
      expect(sentence, `triggerNeverFired${form} still carries the flat promise`).not.toMatch(
        /Правило сохранится, но/,
      )
    }
  })

  it('makes the save conditional in English too', () => {
    for (const form of ['_one', '_other']) {
      const sentence = EN(`automationsPage.config.triggerNeverFired${form}`)
      expect(sentence, `triggerNeverFired${form} promises a save outright`).toMatch(/only if/)
      expect(sentence).not.toMatch(/The rule will save, but/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I7 — re-applying a template is live the moment it is pressed
// ─────────────────────────────────────────────────────────────────────────────

/** The `applyHintTemplate` mutation body, up to the point the toast is chosen. */
function applyMutationFn(): string {
  const start = PAGE.indexOf('const applyHintTemplate = useMutation({')
  expect(
    start,
    'applyHintTemplate is gone from automations-page.tsx — the template toasts have lost their subject',
  ).toBeGreaterThan(-1)
  const region = PAGE.slice(start)
  const end = region.indexOf('onSuccess:')
  expect(end, 'applyHintTemplate has no onSuccess handler any more').toBeGreaterThan(-1)
  return region.slice(0, end)
}

describe('I7: what happens when a template is applied a second time', () => {
  it('writes the hint before anything asks the operator to review it', () => {
    const body = applyMutationFn()
    // Both halves of the finding, read off the source rather than assumed: the
    // second branch is a PUT that lands immediately, and nothing in the write
    // path is gated on the draft the operator is then shown.
    expect(body, 'the update branch is gone').toMatch(/updateUserHint\(/)
    expect(
      body,
      'openDraft moved into the write path — the update is no longer unconditional and this copy needs rewriting',
    ).not.toMatch(/openDraft\(/)
  })

  it('keeps the operator aiming, so only the WORDS change', () => {
    const body = applyMutationFn()
    // The fields the update branch preserves are exactly what makes "only the
    // text changed" a true sentence. Drop one and the toast starts lying about
    // a setting that was silently reset.
    for (const field of ['mode', 'tone', 'ttlHours', 'isRepeatable', 'ctaTarget', 'isActive']) {
      expect(body, `the update branch no longer preserves ${field}`).toMatch(
        new RegExp(`${field}: existing\\.${field}`),
      )
    }
  })

  it('has copy of its own that says the change is already in front of customers', () => {
    const updatedRu = RU('automationsPage.hintTemplates.updated')
    const updatedEn = EN('automationsPage.hintTemplates.updated')
    expect(updatedRu, 'the Russian update toast does not say the text is live now').toMatch(
      /уже сейчас/,
    )
    expect(updatedEn, 'the English update toast does not say the text is live now').toMatch(
      /right now/,
    )
    // And it is not the create toast wearing a different name: the create
    // branch reaches nobody until a rule exists, the update branch reaches
    // whoever an enabled rule is already showing the hint to.
    expect(updatedRu).not.toBe(RU('automationsPage.hintTemplates.created'))
    expect(updatedEn).not.toBe(EN('automationsPage.hintTemplates.created'))
  })

  it('does not let the create toast claim the customer is waiting on Create', () => {
    // The create branch is live-on-arrival too, whenever a rule already names
    // the key and is on: the hint it writes turns a red "will not fire" path
    // green with no further press. `trigger-map.ts` calls that state
    // `missing-hint`, and the map offers the template on exactly those rows.
    expect(RU('automationsPage.hintTemplates.created')).toMatch(/уже у клиентов/)
    expect(EN('automationsPage.hintTemplates.created')).toMatch(/with customers already/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I10 — half the library is a toast, not a window
// ─────────────────────────────────────────────────────────────────────────────

const MODES = HINT_TEMPLATES.map((template) => template.mode)
const TOASTS = HINT_TEMPLATES.filter((template) => template.mode === 'TOAST')
const MODALS = HINT_TEMPLATES.filter((template) => template.mode === 'MODAL')

/**
 * Copy that covers the WHOLE library, or a template whose mode the caller does
 * not have in hand. None of it may name one presentation as if it were the
 * only one.
 */
const LIBRARY_COPY = [
  'automationsPage.hintTemplates.title',
  'automationsPage.hintTemplates.subtitle',
  'automationsPage.hintTemplates.created',
  'automationsPage.hintTemplates.updated',
  'automationsPage.hintTemplates.failed',
  'automationsPage.hintTemplates.needsBoth',
  'automationsPage.triggerMap.title',
  'automationsPage.triggerMap.subtitle',
  'automationsPage.triggerMap.offerHalfBuiltHint',
  'automationsPage.triggerMap.counts.unused_one',
  'automationsPage.triggerMap.counts.unused_other',
  'automationsPage.config.triggerPopupCapable',
  'automationsPage.hintCollision.title',
  // Named per plural FORM, the way `counts.unused_*` above already is: the
  // bare `body` was split into a `_one`/`_few`/`_many`/`_other` ladder (see
  // `automations-hint-copy.test.ts`) and there is no bare key left to read.
  'automationsPage.hintCollision.body_one',
  'automationsPage.hintCollision.body_other',
] as const

describe('I10: the noun the shared copy uses', () => {
  it('has templates of both presentations, which is why one noun cannot do', () => {
    // Read from the data, not restated. A library that became all-MODAL again
    // would make the rule below unnecessary, and this is where that shows up.
    expect(new Set(MODES)).toEqual(new Set(['MODAL', 'TOAST']))
    expect(TOASTS.length, 'no toast templates left').toBeGreaterThan(0)
    expect(MODALS.length, 'no modal templates left').toBeGreaterThan(0)
  })

  it('never calls the whole set a window in Russian', () => {
    for (const path of LIBRARY_COPY) {
      const sentence = RU(path)
      if (!/окн/i.test(sentence)) continue
      // Naming one form is allowed only while the other is named beside it —
      // that is the difference between explaining the split and asserting one
      // half of it over the whole library.
      expect(
        sentence,
        `${path} calls them windows and never mentions the ${TOASTS.length} that are a line`,
      ).toMatch(/строк/i)
    }
  })

  it('never calls the whole set a window in English', () => {
    for (const path of LIBRARY_COPY) {
      const sentence = EN(path)
      if (!/\bwindow|\bmodal|pop-up/i.test(sentence)) continue
      expect(
        sentence,
        `${path} calls them pop-up windows and never mentions the ${TOASTS.length} that are a line`,
      ).toMatch(/\bline\b|\btoast\b/i)
    }
  })

  it('agrees the new noun with the number on every rung of the ladder', () => {
    // The badge is drawn unconditionally, so ZERO is the first thing a new
    // operator sees. Russian sends 0, 5 and 11 to `_many`, 2 and 22 to `_few`,
    // 1 and 21 to `_one` — and the noun that just changed gender took the
    // adjective and the participle with it. Rendered through a real i18next
    // instance rather than read out of the file: which form is reached at 22
    // is i18next's business, not ours.
    const badge = (count: number): string =>
      FEATURE_RU.t('automationsPage.triggerMap.counts.unused', { count })
    expect(badge(0)).toBe('0 готовых подсказок не использовано')
    expect(badge(1)).toBe('1 готовая подсказка не использована')
    expect(badge(2)).toBe('2 готовые подсказки не использованы')
    expect(badge(5)).toBe('5 готовых подсказок не использовано')
    expect(badge(11)).toBe('11 готовых подсказок не использовано')
    expect(badge(21)).toBe('21 готовая подсказка не использована')
    expect(badge(22)).toBe('22 готовые подсказки не использованы')
    expect(badge(100)).toBe('100 готовых подсказок не использовано')
  })

  it('keeps every template description on the right side of its own mode', () => {
    // The per-template half, and the one that survives a mode being flipped:
    // a description that says "takes the screen" is a claim about MODAL, and
    // it stops being true the day the template becomes a TOAST.
    const CLAIMS_WINDOW = [/Показывает окно/, /Занимает экран/]
    const CLAIMS_LINE = [/не занимает экран/, /Одна строка/]
    for (const template of HINT_TEMPLATES) {
      const description = RU(`automationsPage.hintTemplates.${template.id}.description`)
      const forbidden = template.mode === 'TOAST' ? CLAIMS_WINDOW : CLAIMS_LINE
      for (const pattern of forbidden) {
        expect(
          description,
          `${template.id} is ${template.mode} and its description says otherwise`,
        ).not.toMatch(pattern)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I11 — `nothingHere` is NOT unreachable
// ─────────────────────────────────────────────────────────────────────────────

function wildcardRule(spec: string): AutomationRule {
  return {
    id: 'rule-wildcard',
    name: 'everything',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: spec,
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'anything' } }],
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as AutomationRule
}

describe('I11: the empty-state string on a trigger row', () => {
  /**
   * The card renders it on `paths.length === 0 && offers.length === 0`, and
   * that pair is reachable through the WILDCARD branch: a rule that matches a
   * trigger without naming it contributes no path, and `wildcardRuleIds` being
   * non-empty suppresses the offers. One `*` rule puts the string on every row
   * at once. So the key stays; deleting it would take the operator's only
   * explanation of a row that looks blank for a reason.
   */
  it('is reachable — a single wildcard rule empties every row', () => {
    const map = buildTriggerMap({ rules: [wildcardRule('*')], hints: [] })
    const nodes = map.lanes.flatMap((lane) => lane.triggers)
    const empty = nodes.filter((node) => node.paths.length === 0 && node.offers.length === 0)
    expect(nodes.length, 'the map drew no trigger rows at all').toBeGreaterThan(0)
    expect(empty.length, 'no row reaches the empty state any more').toBeGreaterThan(0)
  })

  it('is reachable through a namespace wildcard too', () => {
    const map = buildTriggerMap({ rules: [wildcardRule('payment.*')], hints: [] })
    const empty = map.lanes
      .flatMap((lane) => lane.triggers)
      .filter((node) => node.paths.length === 0 && node.offers.length === 0)
    expect(empty.map((node) => node.type).sort()).toEqual(['payment.completed', 'payment.failed'])
  })

  it('has the string it needs, in both languages', () => {
    expect(RU('automationsPage.triggerMap.nothingHere').length).toBeGreaterThan(0)
    expect(EN('automationsPage.triggerMap.nothingHere').length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I12 — the server's refusal, in the operator's language
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal exactly as axios hands it to a mutation's `onError`. */
function refusal(message: string): unknown {
  return {
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: { status: 400, data: { message } },
  }
}

describe('I12: an automations refusal reaching a Russian operator', () => {
  // The CORE dictionary, which is where `errors.<server sentence>` lives — the
  // automations bundle is lazy and a refusal can arrive before it is loaded.
  const RU_I18N = instance('ru', { en: coreEn, ru: coreRu })

  it('reads the refusals out of the service rather than restating them', () => {
    const refusals = literalRefusals()
    expect(
      refusals.length,
      'automations.service.ts no longer throws any single-literal refusal — the parse broke',
    ).toBeGreaterThanOrEqual(5)
    expect(refusals).toContain('At least one action is required')
    expect(refusals).toContain('Rule not found')
  })

  it('translates every refusal the dictionary is ABLE to reach', () => {
    // i18next splits a key on '.' and on ':' before it looks it up, so only a
    // sentence carrying neither can be a dictionary entry at all. Those are the
    // ones this asserts on; the rest are reported as a fix to
    // `lib/translate-error.ts`, not papered over here.
    const reachable = literalRefusals().filter(
      (sentence) => !sentence.includes('.') && !sentence.includes(':'),
    )
    expect(reachable.length, 'nothing in this module is dictionary-reachable').toBeGreaterThan(0)

    for (const sentence of reachable) {
      const shown = translateApiError(RU_I18N.t.bind(RU_I18N) as never, refusal(sentence))
      expect(shown, `"${sentence}" still reaches a Russian operator in English`).not.toBe(sentence)
      expect(shown, `"${sentence}" resolved to a key path`).not.toMatch(/^errors\./)
      // Cyrillic, not merely "different" — a lookup that lands on another
      // English sentence would pass a bare inequality.
      expect(shown, `"${sentence}" resolved to something that is not Russian`).toMatch(/[а-яА-Я]/)
    }
  })
})
