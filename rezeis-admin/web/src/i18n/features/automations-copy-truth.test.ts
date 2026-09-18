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

const AUDIENCES_PATH = resolve(REPO, 'src', 'modules', 'user-hints', 'services', 'hint-audience.service.ts')

const PAGE = readFileSync(PAGE_PATH, 'utf8')
const SERVICE = readFileSync(SERVICE_PATH, 'utf8')

/**
 * The service's source with the two things that hide a sentence from a plain
 * search undone: adjacent string literals joined ('a ' + 'b' → 'a b'), and the
 * interpolations whose values are fixed put in.
 *
 * The three hint refusals are written as template literals across two lines,
 * carrying `${action.type}` and the audience list — so nothing that reads the
 * source for quoted sentences could see them, and the dictionary entries for
 * them sat unguarded. `HINT_AUDIENCES` is read from the panel's own source, so
 * adding an audience there turns the sentence into one the dictionary no longer
 * has, and this file says so.
 */
const HINT_AUDIENCES = (() => {
  const source = readFileSync(AUDIENCES_PATH, 'utf8')
  const list = /HINT_AUDIENCES\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1])
})()

const SERVICE_SENTENCES = SERVICE.replace(/['`]\s*\+\s*[\r\n\s]*['`]/g, '')
  .replace(/\$\{action\.type\}/g, 'show_hint_to_audience')
  .replace(/\$\{HINT_AUDIENCES\.join\(', '\)\}/g, HINT_AUDIENCES.join(', '))

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

  it('says it for every rule «Создать» saves when the draft brings companions', () => {
    // «Первое появление» for everyone: one press of «Создать», two rules, both
    // saved from the same seed — so both switched off, and the sibling sentence
    // has to say so in every plural form it can reach.
    expect(draftSeedIsEnabled()).toBe(false)
    for (const form of ['_one', '_few', '_many', '_other']) {
      expect(RU(`automationsPage.hintTemplates.createdWithCompanions${form}`)).toMatch(/выключен/)
    }
    for (const form of ['_one', '_other']) {
      expect(EN(`automationsPage.hintTemplates.createdWithCompanions${form}`)).toMatch(/switched off/)
    }
    // The count the page passes is the draft plus its companions.
    expect(PAGE).toMatch(/createdWithCompanions'[\s\S]{0,120}count: 1 \+ companions\.length/)
    expect(
      FEATURE_RU.t('automationsPage.hintTemplates.createdWithCompanions', { title: 'x', count: 2 }),
    ).toContain('сохранит 2 правила выключенными')
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

  it('says the same on the refresh branch of a draft with companions, in every form', () => {
    for (const form of ['_one', '_few', '_many', '_other']) {
      const sentence = RU(`automationsPage.hintTemplates.updatedWithCompanions${form}`)
      expect(sentence).toMatch(/уже сейчас/)
      expect(sentence).not.toBe(RU(`automationsPage.hintTemplates.createdWithCompanions${form}`))
    }
    for (const form of ['_one', '_other']) {
      const sentence = EN(`automationsPage.hintTemplates.updatedWithCompanions${form}`)
      expect(sentence).toMatch(/right now/)
      expect(sentence).not.toBe(EN(`automationsPage.hintTemplates.createdWithCompanions${form}`))
    }
  })

  it('does not let the create toast claim the customer is waiting on Create', () => {
    // The create branch is live-on-arrival too, whenever a rule already names
    // the key and is on: the hint it writes turns a red "will not fire" path
    // green with no further press. `trigger-map.ts` calls that state
    // `missing-hint`, and the map offers the template on exactly those rows.
    //
    // Live, but not "already with customers": a hint is queued when that rule
    // next FIRES, so the sentence says no Create is needed and when the text
    // goes out — not that anybody has it yet.
    const noCreateRu = /«Создать» для него не нужно: текст пойдёт клиентам при его следующем срабатывании/
    const noCreateEn = /it needs no Create: the text goes out the next time it fires/
    for (const path of ['automationsPage.hintTemplates.created', 'automationsPage.hintTemplates.subtitle']) {
      expect(RU(path), path).toMatch(noCreateRu)
      expect(RU(path), path).not.toMatch(/уже у клиентов|уйдёт клиентам сразу/)
      expect(EN(path), path).toMatch(noCreateEn)
      expect(EN(path), path).not.toMatch(/with customers already|reaches customers at once/)
    }
    for (const form of ['_one', '_few', '_many', '_other']) {
      expect(RU(`automationsPage.hintTemplates.createdWithCompanions${form}`)).toMatch(noCreateRu)
    }
    for (const form of ['_one', '_other']) {
      expect(EN(`automationsPage.hintTemplates.createdWithCompanions${form}`)).toMatch(noCreateEn)
    }
  })

  it('does not let the button tooltip promise customers wait on the rule either', () => {
    // «Использовать» on a ready-made hint takes the same two branches, and the
    // refresh one needs no Create when an enabled rule already shows the hint.
    expect(RU('automationsPage.tips.useHintTemplate')).toMatch(/или без «Создать», если включённое правило с этой подсказкой уже есть/)
    expect(EN('automationsPage.tips.useHintTemplate')).toMatch(/or without Create, if a switched-on rule already shows this hint/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R1 — what the rule editor's buttons and switches say they do
// ─────────────────────────────────────────────────────────────────────────────

/** A method's body out of a source file, from its signature to the next `public`. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `${signature} is gone — the copy about it has lost its subject`).toBeGreaterThan(-1)
  const rest = source.slice(start + signature.length)
  const end = rest.search(/\n\s{2}(?:public|private|protected) /)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('R1: the editor tells the operator what its controls do', () => {
  it('says «Удалить» leaves the hint text, which is what the service deletes', () => {
    // The rule row goes; its executions go with it (cascade in the schema); the
    // hint is a row in another table that this method never names.
    const body = methodBody(SERVICE, 'public async deleteRule(')
    expect(body).toMatch(/automationRule\.delete\(/)
    expect(body).not.toMatch(/userHint/i)
    expect(RU('automationsPage.tips.delete')).toMatch(/Текст подсказки на вкладке «Подсказки» остаётся/)
    expect(EN('automationsPage.tips.delete')).toMatch(/hint text on the Hints tab stays/)
  })

  it('says the editor switch changes the draft and the list switch acts at once, which is what each one calls', () => {
    // The editor's switch writes into the draft only; «Сохранить» sends it.
    expect(PAGE).toMatch(/onCheckedChange=\{\(v\) => setDraft\(\{ \.\.\.draft, isEnabled: v \}\)\}/)
    // The list's switch calls the toggle endpoint straight away.
    expect(PAGE).toMatch(/onCheckedChange=\{\(v\) => onToggle\(rule\.id, v\)\}/)
    expect(PAGE).toMatch(/onToggle=\{\(id, enabled\) => \{\s*void toggleRule\(id, enabled\)/)
    expect(RU('automationsPage.editor.enabledInfo')).toMatch(/меняет черновик[\s\S]*«Сохранить»[\s\S]*в списке слева действует сразу/)
    expect(EN('automationsPage.editor.enabledInfo')).toMatch(/changes the draft[\s\S]*Save[\s\S]*list on the left acts at once/)
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
// I11 — every row the map draws says something
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

/**
 * The card used to carry an empty-state string («ничего не настроено») for a row
 * with no paths and no offers, and this guard proved that state reachable: one
 * `*` rule contributed no path to any row and suppressed every offer.
 *
 * It is not reachable any more. A wildcard now gets a row of its own, and the
 * rows it covers keep a cross-reference line («плюс N правил по маске») in the
 * place the empty state used to occupy — which is why the card's condition
 * grew `wildcardRuleIds.length === 0` and stopped ever being true. The string,
 * its branch and the old premise are gone; what stays is the invariant they
 * existed to keep, so a row that can be blank fails HERE rather than rendering
 * an empty cell to an operator.
 */
describe('I11: no trigger row is left blank', () => {
  const rowsOf = (map: ReturnType<typeof buildTriggerMap>) =>
    map.lanes.flatMap((lane) => lane.triggers)

  const blankRows = (map: ReturnType<typeof buildTriggerMap>) =>
    rowsOf(map)
      .filter(
        (row) =>
          row.paths.length === 0 && row.offers.length === 0 && row.wildcardRuleIds.length === 0,
      )
      .map((row) => row.type)

  it('says something on every row when one rule covers them all', () => {
    const map = buildTriggerMap({ rules: [wildcardRule('*')], hints: [] })

    expect(rowsOf(map).length, 'the map drew no trigger rows at all').toBeGreaterThan(0)
    expect(blankRows(map)).toEqual([])
  })

  it('marks the rows a namespace wildcard covers, and leaves none of them blank', () => {
    const map = buildTriggerMap({ rules: [wildcardRule('payment.*')], hints: [] })

    const covered = rowsOf(map)
      .filter((row) => row.wildcardRuleIds.length > 0)
      .map((row) => row.type)
      .sort()
    expect(covered).toEqual(['payment.completed', 'payment.failed'])
    expect(blankRows(map)).toEqual([])
  })

  it('keeps no copy for the state that cannot happen', () => {
    // Dead copy is worse than none: it reads as a state somebody can reach, and
    // the next reader writes code to produce it.
    expect(() => RU('automationsPage.triggerMap.nothingHere')).toThrow()
    expect(() => EN('automationsPage.triggerMap.nothingHere')).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I14 — a run that got no answer is not a run that happened
// ─────────────────────────────────────────────────────────────────────────────

describe('I14: what the panel says when a manual run gets no answer', () => {
  // `runHadNoAnswer` covers two states axios cannot tell apart: a request that
  // never reached the panel, and one whose bytes went out and whose answer was
  // cut off. The copy used to settle it for the operator — «запускать ещё раз
  // не нужно» — which is false for half of them: nothing may have run at all.
  //
  // Both sentences are checked in BOTH languages, because the page tests read
  // whichever bundle the test instance is on, and a claim broken in Russian
  // alone slipped through them.
  const SENTENCES = [
    ['automationsPage.toast.runNoAnswer', 'the toast after an immediate run'],
    ['automationsPage.runDialog.noAnswer', 'the note inside the run dialog'],
  ] as const

  it.each(SENTENCES)('%s admits the run may not have started', (path) => {
    expect(copy(ru, path), 'the Russian sentence no longer admits the run may not have started').toMatch(
      /мог не начаться/,
    )
    expect(copy(en, path), 'the English sentence no longer admits the run may not have started').toMatch(
      /may not have started/,
    )
  })

  it.each(SENTENCES)('%s sends the operator to the run log to find out', (path) => {
    expect(copy(ru, path), 'the Russian sentence no longer names «Запуски»').toContain('«Запуски»')
    expect(copy(en, path), 'the English sentence no longer names the Executions tab').toContain('Executions')
  })

  it.each(SENTENCES)('%s never settles it outright', (path) => {
    const ruText = copy(ru, path)
    // The old wording, and anything that reassures without the condition: what
    // makes the sentence true is «если новый запуск там появился».
    expect(ruText, 'the Russian sentence reassures with no condition attached').not.toMatch(
      /^(?:(?!если|посмотрите|прежде).)*(?:не нужно|не требуется)/s,
    )
    expect(copy(en, path), 'the English sentence reassures with no condition attached').not.toMatch(
      /^(?:(?!if |see whether|check ).)*no need/s,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I13 — what «Подписка оформлена» actually fires on
// ─────────────────────────────────────────────────────────────────────────────

describe('I13: the template that rides subscription.created', () => {
  const PROFILE_SYNC = readFileSync(
    resolve(REPO, 'src', 'modules', 'profile-sync', 'profile-sync.processor.ts'),
    'utf8',
  )

  it('is emitted on more paths than a purchase — including a profile built again', () => {
    // The premise, read off the emitter. `subscription.created` goes out of the
    // CREATE job, and one of its two sites is the branch that LINKS a panel
    // profile that already existed — a resync, or two accounts merged. The
    // card copy used to name a purchase, a trial and an import and stop there,
    // which reads as a closed list and is not one.
    const emits = [...PROFILE_SYNC.matchAll(/EVENT_TYPES\.SUBSCRIPTION_CREATED/g)]
    expect(emits.length, 'profile-sync.processor.ts no longer emits it — the copy needs rereading').toBeGreaterThanOrEqual(2)
    expect(PROFILE_SYNC).toMatch(/Remnawave profile linked[\s\S]{0,400}?EVENT_TYPES\.SUBSCRIPTION_CREATED|EVENT_TYPES\.SUBSCRIPTION_CREATED[^\n]*Remnawave profile linked/)
  })

  it('says so in both languages, instead of listing three of the paths', () => {
    const ruText = copy(ru, 'automationsPage.hintTemplates.subscription_created.description')
    const enText = copy(en, 'automationsPage.hintTemplates.subscription_created.description')
    expect(ruText, 'the Russian card still names only the three obvious paths').toMatch(
      /заново|пересинхронизац|объединен/,
    )
    expect(enText, 'the English card still names only the three obvious paths').toMatch(
      /again|resync|merged/,
    )
    // And the claim it makes is about the PROFILE appearing, not about a purchase.
    expect(ruText).toMatch(/профил/)
    expect(enText).toMatch(/profile/)
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
    // A COLON IS REACHABLE. `translateServerSentence` looks the key up with
    // `nsSeparator: false`, so ':' no longer cuts the sentence in half — this
    // filter used to drop those, and «…needs an audience, one of: …» was
    // skipped in silence rather than checked. A FULL STOP still splits the key
    // (`keySeparator` stays on for the nested `errors: {…}`), so sentences
    // carrying one cannot be entries at all and are left out here.
    const reachable = literalRefusals().filter((sentence) => !sentence.includes('.'))
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

  /**
   * The three refusals about hints, which no parser of quoted literals can
   * find: each is a template literal split across two lines. They are the ones
   * an operator building a pop-up rule actually walks into, and each is the
   * dictionary KEY, so a reworded server sentence must break this rather than
   * quietly reach the operator in English.
   */
  const HINT_REFUSALS = [
    'Action "show_hint_to_audience" picks its own recipients, so it cannot run on an event — use a scheduled trigger',
    `Action "show_hint_to_audience" needs an audience, one of: ${HINT_AUDIENCES.join(', ')}`,
    'A pop-up needs somebody to show it to, and a schedule names nobody — bind this rule to an event about a customer, or run it manually with a user id',
  ]

  it.each(HINT_REFUSALS)('is still the sentence the server sends: %s', (sentence) => {
    expect(HINT_AUDIENCES.length, 'no audience parsed out of hint-audience.service.ts').toBeGreaterThan(0)
    expect(
      SERVICE_SENTENCES,
      'automations.service.ts no longer composes this sentence — the dictionary entry is now dead',
    ).toContain(sentence)
  })

  it.each(HINT_REFUSALS)('reaches a Russian operator in Russian: %s', (sentence) => {
    const shown = translateApiError(RU_I18N.t.bind(RU_I18N) as never, refusal(sentence))
    expect(shown, `"${sentence}" still reaches a Russian operator in English`).not.toBe(sentence)
    expect(shown, `"${sentence}" resolved to a key path`).not.toMatch(/^errors\./)
    expect(shown, `"${sentence}" resolved to something that is not Russian`).toMatch(/[а-яА-Я]/)
  })
})
