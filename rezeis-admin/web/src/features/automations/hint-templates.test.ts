import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES, buildHint, buildHintAction } from './hint-templates'
import { ru } from '@/i18n/features/automations.ru'
import { en } from '@/i18n/features/automations.en'

/**
 * The ready-made pop-ups.
 *
 * A pop-up is two rows that have to agree: a hint, and a rule whose action
 * names it by key. Every failure below is silent at the moment it is made and
 * loud much later — in an execution log, after the moment the pop-up was about
 * has passed.
 */

const copy = (bundle: Record<string, unknown>, id: string): Record<string, string> =>
  ((bundle.automationsPage as Record<string, unknown>).hintTemplates as Record<string, unknown>)[
    id
  ] as Record<string, string>

const text = (key: string): string => {
  const path = key.split('.').slice(1)
  let node: unknown = ru.automationsPage
  for (const step of path) node = (node as Record<string, unknown>)[step]
  return typeof node === 'string' ? node : key
}

describe('a template builds both halves', () => {
  it('points the rule at the hint it just created', () => {
    // The one way to get this wrong produces a rule that fails at run time,
    // naming a key nothing answers to — long after the operator left the page.
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)
      const [action] = buildHintAction(template)

      expect(hint.key).toBe(template.hintKey)
      expect(action.type).toBe('show_hint')
      expect((action.params as { hintKey: string }).hintKey).toBe(hint.key)
    }
  })

  it('fires only on events that name a customer', () => {
    // `show_hint` refuses an event with no `userId`, correctly — but the
    // operator only finds out after the rule has failed once. Every trigger
    // here is one where "who sees this?" is not a guess.
    const namesACustomer = /^(payment|subscription|user|promocode)\./
    for (const template of HINT_TEMPLATES) {
      expect(template.triggerSpec, template.id).toMatch(namesACustomer)
    }
  })

  it('gives every template a distinct key and a distinct trigger', () => {
    // Two templates sharing a key would have the second silently overwrite the
    // first's text; two sharing a trigger would show two pop-ups at once.
    expect(new Set(HINT_TEMPLATES.map((t) => t.hintKey)).size).toBe(HINT_TEMPLATES.length)
    expect(new Set(HINT_TEMPLATES.map((t) => t.triggerSpec)).size).toBe(HINT_TEMPLATES.length)
  })
})

describe('the pop-up an operator gets', () => {
  it('carries text in both languages, because it is shown to customers', () => {
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)

      for (const [field, value] of Object.entries({
        titleRu: hint.titleRu,
        bodyRu: hint.bodyRu,
        titleEn: hint.titleEn,
        bodyEn: hint.bodyEn,
      })) {
        expect((value ?? '').trim().length, `${template.id}.${field}`).toBeGreaterThan(0)
        expect(value, `${template.id}.${field} is an untranslated key`).not.toMatch(
          /^automationsPage\./,
        )
      }
    }
  })

  it('gives a button a target, and a pop-up without one no button', () => {
    // `ctaKind: ROUTE` with no target renders a button that goes nowhere.
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)

      if (template.route === null) {
        expect(hint.ctaKind, template.id).toBe('NONE')
        expect(hint.ctaTarget).toBeUndefined()
      } else {
        expect(hint.ctaKind, template.id).toBe('ROUTE')
        expect(hint.ctaTarget).toBe(template.route)
        expect((hint.ctaLabelRu ?? '').length, template.id).toBeGreaterThan(0)
      }
    }
  })

  it('only sends people to routes the cabinet actually has', () => {
    // A target is a cabinet path, and a typo here is a pop-up whose button
    // lands on the not-found screen — from a message the customer trusted.
    const known = new Set(['/plans', '/renew', '/upgrade', '/subscription', '/subscription/connect'])
    for (const template of HINT_TEMPLATES) {
      if (template.route === null) continue
      expect(known.has(template.route), `${template.id} → ${template.route}`).toBe(true)
    }
  })

  it('repeats what is about an event and not what is about a person', () => {
    // "Your payment failed" is about this payment. "Welcome" is about the
    // person, and showing it twice says the product forgot them.
    const once = HINT_TEMPLATES.filter((t) => !t.repeatable).map((t) => t.id)

    expect(once.sort()).toEqual(['trial_granted', 'welcome'])
  })
})

describe('the copy exists in both bundles', () => {
  it('has every field the builder reads, in ru and en', () => {
    // The bundle-parity test compares key sets, so a field missing from BOTH
    // bundles passes it and reaches an operator as the raw key.
    for (const template of HINT_TEMPLATES) {
      for (const bundle of [ru, en] as unknown as Array<Record<string, unknown>>) {
        const fields = copy(bundle, template.id)
        expect(fields, template.id).toBeDefined()
        for (const field of ['name', 'description', 'titleRu', 'bodyRu', 'titleEn', 'bodyEn']) {
          expect((fields[field] ?? '').trim().length, `${template.id}.${field}`).toBeGreaterThan(0)
        }
      }
    }
  })
})
