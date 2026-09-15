/**
 * WHAT THESE SPECS PIN.
 *
 *   1. The kind table names exactly the contract's reference kinds, in the
 *      contract's order — asserted against a literal copy FIRST, so a table
 *      that drifted together with a list derived from it cannot pass.
 *   2. Which consequence each kind brings, and that only a transition leaves
 *      nothing behind. Those two columns decide what the operator is told the
 *      delete will do; they are written out here, not re-derived.
 *   3. Nothing is dropped: every row the server sent comes back, in its order,
 *      and a kind this build cannot name — including one spelled like a
 *      prototype member — becomes an unrecognised row, never a missing one.
 *   4. Both dictionaries word every kind: a plural set carrying `{{count}}`
 *      (English one/other, Russian one/few/many/other) or one sentence. A key
 *      missing here renders as its own path, which i18next does silently.
 *
 * NO DATE LITERALS anywhere below — see the note in
 * `plan-transition-targets.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { valueAt } from '@/test/i18n-key-paths'

import {
  describePlanReferences,
  describePlanReferencesAfterMove,
  isPlanAlreadyGone,
  PLAN_DELETE_CONSEQUENCE_I18N_KEYS,
  PLAN_DELETE_CONSEQUENCES,
  PLAN_REFERENCE_KIND_SPECS,
  PLAN_REFERENCE_KINDS,
  PLAN_REFERENCE_UNKNOWN_I18N_KEY,
} from './plan-delete'

/**
 * The kinds of `GET /admin/plans/:planId/references`, in the order the plan
 * deletion contract v2 lists them. A literal copy on purpose.
 */
const CONTRACT_KINDS = [
  'subscriptions',
  'scheduledTerms',
  'unsettledPayments',
  'recentCheckouts',
  'renewalItems',
  'trialReservations',
  'promocodes',
  'quests',
  'contests',
  'wheelSectors',
  'addOns',
  'adPlacements',
  'referralGift',
  'referralEligibility',
  'transitions',
  'replacementOrphans',
]

describe('the reference kind table', () => {
  it('names exactly the contract’s kinds, in the contract’s order', () => {
    expect(CONTRACT_KINDS).toHaveLength(16)
    expect([...PLAN_REFERENCE_KINDS]).toEqual(CONTRACT_KINDS)
    expect(Object.keys(PLAN_REFERENCE_KIND_SPECS).sort()).toEqual([...CONTRACT_KINDS].sort())
  })

  it('gives every kind its own dictionary key under the dialog’s references', () => {
    for (const kind of PLAN_REFERENCE_KINDS) {
      expect(PLAN_REFERENCE_KIND_SPECS[kind].i18nKey).toBe(`plansPage.deleteDialog.references.${kind}`)
    }
    const keys = PLAN_REFERENCE_KINDS.map((kind) => PLAN_REFERENCE_KIND_SPECS[kind].i18nKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain(PLAN_REFERENCE_UNKNOWN_I18N_KEY)
  })

  it('pins the consequence each kind brings', () => {
    expect(
      Object.fromEntries(PLAN_REFERENCE_KINDS.map((kind) => [kind, PLAN_REFERENCE_KIND_SPECS[kind].consequence])),
    ).toEqual({
      subscriptions: 'subscribers',
      scheduledTerms: 'subscribers',
      unsettledPayments: 'invoices',
      recentCheckouts: 'invoices',
      renewalItems: 'invoices',
      trialReservations: null,
      promocodes: 'grants',
      quests: 'grants',
      contests: 'grants',
      wheelSectors: 'grants',
      addOns: null,
      // Its own line: the server reports an ad placement only while its bonus
      // still grants the plan, which — unlike every other grant — stops when the
      // plan goes off sale. The shared grants line cannot speak for it.
      adPlacements: 'adBonuses',
      referralGift: 'grants',
      referralEligibility: null,
      transitions: null,
      replacementOrphans: 'renewalChoice',
    })
    expect([...PLAN_DELETE_CONSEQUENCES]).toEqual(['subscribers', 'invoices', 'grants', 'adBonuses', 'renewalChoice'])
  })

  // The delete strips the plan out of other plans' upgrade and replacement
  // lists before it decides, so a transition never keeps the row alive — and
  // an archived plan left with no replacement is something the delete does to
  // THAT plan's subscribers, not something that holds this one.
  it('lets only a transition and a replacement orphan leave nothing behind', () => {
    expect(PLAN_REFERENCE_KINDS.filter((kind) => !PLAN_REFERENCE_KIND_SPECS[kind].keepsPlan)).toEqual([
      'transitions',
      'replacementOrphans',
    ])
  })
})

describe('describePlanReferences', () => {
  it('keeps every row, in the server’s order, unknown kinds included', () => {
    expect(
      describePlanReferences([
        { kind: 'quests', count: 2 },
        { kind: 'loyaltyTiers', count: 4 },
        { kind: 'subscriptions', count: 7 },
      ]).rows,
    ).toEqual([
      { recognised: true, kind: 'quests', count: 2, i18nKey: 'plansPage.deleteDialog.references.quests' },
      { recognised: false, kind: 'loyaltyTiers', count: 4, i18nKey: PLAN_REFERENCE_UNKNOWN_I18N_KEY },
      {
        recognised: true,
        kind: 'subscriptions',
        count: 7,
        i18nKey: 'plansPage.deleteDialog.references.subscriptions',
      },
    ])
  })

  it('never returns fewer rows than it was given', () => {
    const all = [...CONTRACT_KINDS, 'loyaltyTiers', 'partnerLevels'].map((kind, index) => ({
      kind,
      count: index + 1,
    }))
    const { rows } = describePlanReferences(all)
    expect(rows).toHaveLength(all.length)
    expect(rows.map((row) => row.kind)).toEqual(all.map((reference) => reference.kind))
    expect(rows.map((row) => row.count)).toEqual(all.map((reference) => reference.count))
    expect(rows.filter((row) => !row.recognised).map((row) => row.kind)).toEqual(['loyaltyTiers', 'partnerLevels'])
  })

  it('states each consequence once, in a fixed order, and only for the kinds present', () => {
    expect(
      describePlanReferences([
        { kind: 'promocodes', count: 1 },
        { kind: 'renewalItems', count: 1 },
        { kind: 'quests', count: 3 },
        { kind: 'scheduledTerms', count: 1 },
      ]).consequences,
    ).toEqual(['subscribers', 'invoices', 'grants'])
    expect(describePlanReferences([{ kind: 'quests', count: 1 }]).consequences).toEqual(['grants'])
    expect(
      describePlanReferences([
        { kind: 'adPlacements', count: 1 },
        { kind: 'promocodes', count: 1 },
      ]).consequences,
    ).toEqual(['grants', 'adBonuses'])
    expect(describePlanReferences([{ kind: 'adPlacements', count: 2 }]).consequences).toEqual(['adBonuses'])
    expect(describePlanReferences([{ kind: 'addOns', count: 2 }]).consequences).toEqual([])
    expect(describePlanReferences([{ kind: 'loyaltyTiers', count: 2 }]).consequences).toEqual([])
  })

  it('reads a plan used only as a transition target as deleted for good', () => {
    const impact = describePlanReferences([{ kind: 'transitions', count: 2 }])
    expect(impact.keepsPlan).toBe(false)
    expect(impact.rows).toHaveLength(1)
  })

  // Nothing holds the plan, and still there is something to say: the renewal
  // of another plan's subscribers changes.
  it('states the renewal consequence of an orphaned archived plan without keeping the plan', () => {
    const impact = describePlanReferences([
      { kind: 'transitions', count: 1 },
      { kind: 'replacementOrphans', count: 1 },
    ])
    expect(impact.keepsPlan).toBe(false)
    expect(impact.consequences).toEqual(['renewalChoice'])
    expect(impact.rows.map((row) => row.recognised)).toEqual([true, true])
  })

  // The conservative reading: this build cannot know what an unknown kind
  // does, and "deleted for good" is the claim that must not be made wrongly.
  it('reads an unknown kind as keeping the plan', () => {
    expect(describePlanReferences([{ kind: 'loyaltyTiers', count: 1 }]).keepsPlan).toBe(true)
    expect(
      describePlanReferences([
        { kind: 'transitions', count: 1 },
        { kind: 'loyaltyTiers', count: 1 },
      ]).keepsPlan,
    ).toBe(true)
    expect(describePlanReferences([{ kind: 'addOns', count: 1 }]).keepsPlan).toBe(true)
  })

  it('says nothing uses a plan with no references', () => {
    expect(describePlanReferences([])).toEqual({ rows: [], consequences: [], keepsPlan: false })
  })

  it('renders a kind spelled like a prototype member as unknown, not as a crash', () => {
    for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(describePlanReferences([{ kind, count: 1 }]).rows).toEqual([
        { recognised: false, kind, count: 1, i18nKey: PLAN_REFERENCE_UNKNOWN_I18N_KEY },
      ])
    }
  })
})

// The delete that follows a move: the subscriptions are the move's, everything else is said as before.
describe('describePlanReferencesAfterMove', () => {
  it('leaves out the subscriptions and what their subscribers are told, and keeps every other kind', () => {
    const impact = describePlanReferencesAfterMove([
      { kind: 'subscriptions', count: 12 },
      { kind: 'promocodes', count: 2 },
      { kind: 'scheduledTerms', count: 1 },
      { kind: 'unsettledPayments', count: 1 },
      { kind: 'adPlacements', count: 1 },
      { kind: 'replacementOrphans', count: 1 },
      { kind: 'loyaltyTiers', count: 3 },
    ])
    expect(impact.rows.map((row) => row.kind)).toEqual([
      'promocodes',
      'scheduledTerms',
      'unsettledPayments',
      'adPlacements',
      'replacementOrphans',
      'loyaltyTiers',
    ])
    expect(impact.rows.at(-1)).toMatchObject({ recognised: false, kind: 'loyaltyTiers', count: 3 })
    expect(impact.consequences).toEqual(['invoices', 'grants', 'adBonuses', 'renewalChoice'])
    expect(impact.keepsPlan).toBe(true)
    // Before any other delete, the same references say more.
    expect(describePlanReferences([{ kind: 'subscriptions', count: 12 }, { kind: 'promocodes', count: 2 }])).toMatchObject({
      consequences: ['subscribers', 'grants'],
    })
  })

  it('does not keep a plan only its moved subscriptions kept', () => {
    expect(describePlanReferencesAfterMove([{ kind: 'subscriptions', count: 3 }])).toEqual({
      rows: [],
      consequences: [],
      keepsPlan: false,
    })
    expect(
      describePlanReferencesAfterMove([
        { kind: 'subscriptions', count: 3 },
        { kind: 'transitions', count: 1 },
      ]),
    ).toMatchObject({ keepsPlan: false, consequences: [] })
  })
})

describe('isPlanAlreadyGone', () => {
  it('is true for a 404 response and for nothing else', () => {
    expect(isPlanAlreadyGone({ response: { status: 404 } })).toBe(true)
    for (const status of [400, 401, 403, 409, 500, 503]) {
      expect(isPlanAlreadyGone({ response: { status } })).toBe(false)
    }
    expect(isPlanAlreadyGone(new Error('Network Error'))).toBe(false)
    expect(isPlanAlreadyGone({ response: null })).toBe(false)
    expect(isPlanAlreadyGone({ status: 404 })).toBe(false)
    expect(isPlanAlreadyGone(null)).toBe(false)
    expect(isPlanAlreadyGone('404')).toBe(false)
  })
})

describe('the dictionaries', () => {
  const DICTIONARIES = { en: en as unknown, ru: ru as unknown }
  const PLURAL_FORMS = { en: ['one', 'other'], ru: ['one', 'few', 'many', 'other'] }

  it.each(['en', 'ru'] as const)('%s words every kind as a plural set with its count, or as one sentence', (lng) => {
    const dictionary = DICTIONARIES[lng]
    let pluralKinds = 0
    for (const kind of PLAN_REFERENCE_KINDS) {
      const key = PLAN_REFERENCE_KIND_SPECS[kind].i18nKey
      const sentence = valueAt(dictionary, key)
      const forms = PLURAL_FORMS[lng].map((form) => valueAt(dictionary, `${key}_${form}`))
      if (typeof sentence === 'string') {
        expect(sentence.trim(), `${lng}: ${key}`).not.toBe('')
        expect(forms, `${lng}: ${key} is a sentence and a plural set at once`).toEqual(
          PLURAL_FORMS[lng].map(() => undefined),
        )
        continue
      }
      expect(sentence, `${lng}: ${key}`).toBeUndefined()
      pluralKinds += 1
      PLURAL_FORMS[lng].forEach((form, index) => {
        expect(typeof forms[index], `${lng}: ${key}_${form}`).toBe('string')
        expect(forms[index], `${lng}: ${key}_${form}`).toContain('{{count}}')
      })
    }
    // Anti-vacuity: the counted kinds really went through the plural branch.
    expect(pluralKinds).toBeGreaterThanOrEqual(12)
  })

  it.each(['en', 'ru'] as const)('%s words the unknown kind and every consequence', (lng) => {
    const dictionary = DICTIONARIES[lng]
    const unknown = valueAt(dictionary, PLAN_REFERENCE_UNKNOWN_I18N_KEY)
    expect(typeof unknown).toBe('string')
    expect(unknown).toContain('{{kind}}')
    expect(unknown).toContain('{{count}}')
    for (const consequence of PLAN_DELETE_CONSEQUENCES) {
      const sentence = valueAt(dictionary, PLAN_DELETE_CONSEQUENCE_I18N_KEYS[consequence])
      expect(typeof sentence, `${lng}: ${consequence}`).toBe('string')
    }
    expect(typeof valueAt(dictionary, 'plansPage.deleteDialog.consequences.cleanup')).toBe('string')
    // Anti-vacuity for the loop above: the ad-bonus line is one of the consequences it read.
    expect(PLAN_DELETE_CONSEQUENCES).toContain('adBonuses')
    // Both unused leads name the plan: removed for good (off sale), or hidden
    // now and removed by the nightly cleanup (still on sale).
    for (const lead of ['unused', 'unusedOnSale']) {
      expect(valueAt(dictionary, `plansPage.deleteDialog.${lead}`), `${lng}: ${lead}`).toContain('{{name}}')
    }
  })
})
